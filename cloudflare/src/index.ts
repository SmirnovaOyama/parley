// Parley on Cloudflare: this Worker answers on the site's domain and hands every request to one
// container running Parley (../Dockerfile, with what ./Dockerfile adds). One container, named
// "parley", so there's one database and one writer.
import { Container } from "@cloudflare/containers";

type Env = {
  PARLEY: DurableObjectNamespace<Parley>;
  /** Which version of this Worker is running: a new one with each deploy or change of secret. */
  CF_VERSION_METADATA: WorkerVersionMetadata;
  /** Set by the deploy (.github/workflows/cloudflare.yml): https:// and the site's domain. */
  PUBLIC_URL: string;
  VITE_APP_NAME: string;
  MAIL_FROM: string;
  /** Where the database and the files are kept, in R2 (cloudflare/README.md). */
  R2_ACCOUNT_ID: string;
  DB_BUCKET: string;
  FILES_BUCKET: string;
  // Secrets.
  KEY_ENCRYPTION_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  SMTP_URL?: string;
};

export class Parley extends Container<Env> {
  defaultPort = 8787;
  // Asleep after an hour without a request, when it costs nothing. The first request after that
  // waits a few seconds while it starts and the database comes back from R2.
  sleepAfter = "1h";
  enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      KEY_ENCRYPTION_SECRET: env.KEY_ENCRYPTION_SECRET,
      PUBLIC_URL: env.PUBLIC_URL,
      VITE_APP_NAME: env.VITE_APP_NAME,
      MAIL_FROM: env.MAIL_FROM,
      SMTP_URL: env.SMTP_URL ?? "",
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
      DB_BUCKET: env.DB_BUCKET,
      FILES_BUCKET: env.FILES_BUCKET,
      AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    };
  }

  /**
   * Settles, once per version of this Worker, that the container runs with this version's
   * settings. A deploy swaps the container's image but starts it again with the settings it had
   * before, so a secret added or changed (SMTP_URL, say) wouldn't reach it. A container started
   * under another version is stopped, the usual way (Litestream makes its last copy), and the
   * request that follows starts it again with these.
   */
  private current: Promise<void> | undefined;

  override async fetch(request: Request): Promise<Response> {
    // Should the check itself fail, the site still answers, on the settings it has.
    await (this.current ??= this.restartIfStale().catch((err) => console.error("Couldn't check the container's settings:", err)));
    return super.fetch(request);
  }

  override async onStart(): Promise<void> {
    await this.ctx.storage.put("startedUnder", this.env.CF_VERSION_METADATA.id);
  }

  private async restartIfStale(): Promise<void> {
    if (!this.ctx.container?.running) return;
    if ((await this.ctx.storage.get("startedUnder")) === this.env.CF_VERSION_METADATA.id) return;
    console.log("The container was started under another version of the Worker; restarting it with this one's settings");
    const exited = this.ctx.container.monitor().catch(() => {});
    await this.stop();
    // Its last copy to R2 takes a moment; it's killed if it takes longer than this.
    const timedOut = await Promise.race([exited.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 60_000))]);
    if (timedOut) await this.destroy();
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    // Parley sees the request as this Worker passes it on, so it's told who sent it and where to,
    // replacing anything the visitor sent under those names (the image sets TRUST_PROXY).
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") ?? "");
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
    return env.PARLEY.getByName("parley").fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
