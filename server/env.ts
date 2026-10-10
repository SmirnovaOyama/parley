// Server configuration, read once from the environment (.env is loaded by `node --env-file-if-exists`).

const secret = process.env.KEY_ENCRYPTION_SECRET ?? "";
if (secret.length < 32) {
  console.error(
    "KEY_ENCRYPTION_SECRET is missing or shorter than 32 characters.\n" +
      "Run `npm run setup` to create a .env with a random secret.",
  );
  process.exit(1);
}

/** PUBLIC_URL as an origin (https://chat.example.com), or null when it's unset or isn't one. */
function publicUrl(): string | null {
  const raw = process.env.PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // Reported below.
  }
  console.error(`PUBLIC_URL isn't a web address (${raw}), so it's ignored`);
  return null;
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  /**
   * The address people reach the site at, for links that leave it and come back (an MCP server's
   * sign-in page returns to it). Unset, it's taken from the request, which works unless a proxy
   * in front changes the address.
   */
  publicUrl: publicUrl(),
  isProd: process.env.NODE_ENV === "production",
  databasePath: process.env.DATABASE_PATH ?? "data/chat.db",
  keyEncryptionSecret: secret,
  /** The site's name, written into the web app's page and used in emails. */
  appName: process.env.VITE_APP_NAME?.trim() || "Parley",
  /** Outgoing mail for verification codes, e.g. smtps://user:password@smtp.example.com:465. */
  smtpUrl: process.env.SMTP_URL?.trim() || null,
  /** The sender; defaults to the SMTP account itself. */
  mailFrom: process.env.MAIL_FROM?.trim() || null,
  /** The server reaches the web through a proxy that hands out 198.18.x.x addresses (server/web-tools.ts). */
  allowFakeIp: /^(1|true|yes|on)$/i.test(process.env.ALLOW_FAKE_IP?.trim() ?? ""),
};
