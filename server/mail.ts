// Outgoing email. With SMTP_URL set, mail goes out through that server. Without it, development
// prints messages to the server log instead (so codes and links can be read there), and
// production can't send at all.
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "./env.ts";

export type MailMode = "smtp" | "dev" | "off";

export const mailMode: MailMode = env.smtpUrl ? "smtp" : env.isProd ? "off" : "dev";

let transport: Transporter | null = null;

function sender(): string {
  if (env.mailFrom) return env.mailFrom;
  // The SMTP account's own address, when its user name is one.
  const user = decodeURIComponent(new URL(env.smtpUrl!).username);
  return user.includes("@") ? `${env.appName} <${user}>` : `${env.appName} <no-reply@localhost>`;
}

export async function sendMail(message: { to: string; subject: string; text: string }) {
  if (mailMode === "off") throw new Error("Email isn't set up on this site");
  if (mailMode === "dev") {
    console.log(`[mail] to ${message.to}: ${message.subject}\n${message.text}`);
    return;
  }
  transport ??= nodemailer.createTransport(env.smtpUrl!);
  await transport.sendMail({ from: sender(), ...message });
}
