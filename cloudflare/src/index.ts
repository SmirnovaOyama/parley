// Parley on Cloudflare: this Worker answers on the site's domain and hands every request to one
// container running Parley (../Dockerfile, with what ./Dockerfile adds). One container, named
// "parley", so there's one database and one writer.
import { Container } from "@cloudflare/containers";

type Env = {
  PARLEY: DurableObjectNamespace<Parley>;
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
