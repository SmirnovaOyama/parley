// Settings › Two-step verification (server/two-step.ts): what's set up, and adding or removing an
// authenticator app, passkeys and recovery codes. Each change takes the person's password again,
// so someone who only has a signed-in browser can't add a way in of their own or take one away.
import { Hono } from "hono";
import { requireUser, type AppEnv } from "../auth.ts";
import { t } from "../i18n.ts";
import { deviceOf } from "../sessions.ts";
import {
  addPasskey,
  confirmTotp,
  newRecoveryCodes,
  passkeyOptions,
  removePasskey,
  removeTotp,
  startTotp,
  totpPending,
  twoStepOf,
  twoStepOn,
} from "../two-step.ts";
import { confirmPassword } from "./auth.ts";

export const twoStepRoutes = new Hono<AppEnv>();
twoStepRoutes.use("*", requireUser);

twoStepRoutes.get("/", (c) => c.json(twoStepOf(c.var.user!.id)));

/** A new secret for an authenticator app: scanned or typed in, then confirmed with its first code. */
twoStepRoutes.post("/totp/start", async (c) => {
  const user = c.var.user!;
  const body = await c.req.json().catch(() => ({}));
  const wrong = await confirmPassword(user.id, body.password);
  if (wrong) return c.json({ error: wrong, field: "password" }, 400);
  if (twoStepOf(user.id).totp) return c.json({ error: t("An authenticator app is set up already. Remove it first to use another") }, 409);
  return c.json(await startTotp(user.id, user.email));
});

twoStepRoutes.post("/totp/confirm", async (c) => {
  const userId = c.var.user!.id;
  const body = await c.req.json().catch(() => ({}));
  if (!totpPending(userId)) return c.json({ error: t("That took too long. Start again") }, 410);
  const result = confirmTotp(userId, String(body.code ?? ""));
  if (!result.ok) return c.json({ error: t("That code isn't right. Check the app's clock, then type the code it shows now"), field: "code" }, 400);
  return c.json({ ok: true, recoveryCodes: result.recoveryCodes, twoStep: twoStepOf(userId) });
});

twoStepRoutes.post("/totp/remove", async (c) => {
  const userId = c.var.user!.id;
  const body = await c.req.json().catch(() => ({}));
  const wrong = await confirmPassword(userId, body.password);
  if (wrong) return c.json({ error: wrong, field: "password" }, 400);
  removeTotp(userId);
  return c.json({ ok: true, twoStep: twoStepOf(userId) });
});

/** What the browser needs to make a passkey for this site. */
twoStepRoutes.post("/passkeys/options", async (c) => {
  const user = c.var.user!;
  const body = await c.req.json().catch(() => ({}));
  const wrong = await confirmPassword(user.id, body.password);
  if (wrong) return c.json({ error: wrong, field: "password" }, 400);
  return c.json({ options: await passkeyOptions(c, user.id, user.email) });
});

/** The passkey the browser made, named for the browser and system it was made in. */
twoStepRoutes.post("/passkeys", async (c) => {
  const userId = c.var.user!.id;
  const body = await c.req.json().catch(() => ({}));
  const { device, browser } = deviceOf(c.req.header("user-agent") ?? null);
  const result = await addPasskey(c, userId, body.response, browser ? t("Passkey made in {device}", { device }) : t("Passkey"));
  if (!result.ok) return c.json({ error: t("That passkey couldn't be added. Try again") }, 400);
  return c.json({ ok: true, recoveryCodes: result.recoveryCodes, twoStep: twoStepOf(userId) });
});

twoStepRoutes.post("/passkeys/:id/remove", async (c) => {
  const userId = c.var.user!.id;
  const body = await c.req.json().catch(() => ({}));
  const wrong = await confirmPassword(userId, body.password);
  if (wrong) return c.json({ error: wrong, field: "password" }, 400);
  if (!removePasskey(userId, c.req.param("id"))) return c.json({ error: t("That passkey is gone already") }, 404);
  return c.json({ ok: true, twoStep: twoStepOf(userId) });
});

/** Ten new recovery codes; the ones before stop working. */
twoStepRoutes.post("/recovery-codes", async (c) => {
  const userId = c.var.user!.id;
  const body = await c.req.json().catch(() => ({}));
  const wrong = await confirmPassword(userId, body.password);
  if (wrong) return c.json({ error: wrong, field: "password" }, 400);
  if (!twoStepOn(userId)) return c.json({ error: t("Set up an authenticator app or a passkey first") }, 409);
  return c.json({ recoveryCodes: newRecoveryCodes(userId), twoStep: twoStepOf(userId) });
});
