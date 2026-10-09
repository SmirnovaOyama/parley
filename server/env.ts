// Server configuration, read once from the environment (.env is loaded by `node --env-file-if-exists`).

const secret = process.env.KEY_ENCRYPTION_SECRET ?? "";
if (secret.length < 32) {
  console.error(
    "KEY_ENCRYPTION_SECRET is missing or shorter than 32 characters.\n" +
      "Run `npm run setup` to create a .env with a random secret.",
  );
  process.exit(1);
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  isProd: process.env.NODE_ENV === "production",
  databasePath: process.env.DATABASE_PATH ?? "data/chat.db",
  keyEncryptionSecret: secret,
  /** The site's name, shared with the web app; used in emails. */
  appName: process.env.VITE_APP_NAME?.trim() || "Parley",
  /** Outgoing mail for verification codes, e.g. smtps://user:password@smtp.example.com:465. */
  smtpUrl: process.env.SMTP_URL?.trim() || null,
  /** The sender; defaults to the SMTP account itself. */
  mailFrom: process.env.MAIL_FROM?.trim() || null,
};
