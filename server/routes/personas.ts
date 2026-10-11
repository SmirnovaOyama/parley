// A person's personas: up to five ways to present themselves to the AI, each a name with what it
// should know about them and how it should answer. New chats start as the one picked for that;
// a chat's settings can switch to another, which copies its words into that chat.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { requireUser, type AppEnv } from "../auth.ts";
import { tx } from "../chat-store.ts";
import { db, nowIso } from "../db.ts";
import { t } from "../i18n.ts";
import { MAX_INSTRUCTION_CHARS, personasOf } from "../instructions.ts";

export const personaRoutes = new Hono<AppEnv>();
personaRoutes.use("*", requireUser);

export const MAX_PERSONAS = 5;

const persona = (userId: number, id: string) => personasOf(userId).find((p) => p.id === id);

/** A persona's fields from a form, or a sentence saying what's wrong. */
function parsePersona(body: Record<string, unknown>, partial: boolean) {
  const out: { name?: string; aboutMe?: string; answerStyle?: string; forNewChats?: boolean } = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!name) return { error: t("Give the persona a name") };
    out.name = name;
  }
  for (const key of ["aboutMe", "answerStyle"] as const) {
    if (body[key] === undefined) continue;
    const text = String(body[key] ?? "").trim();
    if (text.length > MAX_INSTRUCTION_CHARS) return { error: t("Keep each one under {MAX_INSTRUCTION_CHARS} characters", { MAX_INSTRUCTION_CHARS }) };
    out[key] = text;
  }
  if (body.forNewChats !== undefined) out.forNewChats = !!body.forNewChats;
  return out;
}

/** Points new chats at this persona, or away from it. */
function setForNewChats(userId: number, id: string, on: boolean) {
  if (on) db.prepare("UPDATE users SET persona_id = ? WHERE id = ?").run(id, userId);
  else db.prepare("UPDATE users SET persona_id = NULL WHERE id = ? AND persona_id = ?").run(userId, id);
}

personaRoutes.get("/personas", (c) => c.json({ personas: personasOf(c.var.user!.id), max: MAX_PERSONAS }));

personaRoutes.post("/personas", async (c) => {
  const userId = c.var.user!.id;
  const parsed = parsePersona(await c.req.json().catch(() => ({})), false);
  if ("error" in parsed) return c.json(parsed, 400);
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM personas WHERE user_id = ?").get(userId) as { n: number };
  if (n >= MAX_PERSONAS) return c.json({ error: t("You can have up to five personas. Delete one to make another") }, 400);
  const id = randomUUID();
  const now = nowIso();
  tx(() => {
    db.prepare("INSERT INTO personas (id, user_id, name, about_me, answer_style, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id, userId, parsed.name!, parsed.aboutMe ?? "", parsed.answerStyle ?? "", now, now,
    );
    if (parsed.forNewChats) setForNewChats(userId, id, true);
  });
  return c.json({ persona: persona(userId, id) });
});

personaRoutes.get("/personas/:id", (c) => {
  const p = persona(c.var.user!.id, c.req.param("id"));
  if (!p) return c.json({ error: t("This persona doesn't exist") }, 404);
  return c.json({ persona: p });
});

/** Changes a persona. Chats already started as it keep the words they copied. */
personaRoutes.patch("/personas/:id", async (c) => {
  const userId = c.var.user!.id;
  const p = persona(userId, c.req.param("id"));
  if (!p) return c.json({ error: t("This persona doesn't exist") }, 404);
  const parsed = parsePersona(await c.req.json().catch(() => ({})), true);
  if ("error" in parsed) return c.json(parsed, 400);
  tx(() => {
    db.prepare(
      "UPDATE personas SET name = COALESCE(?, name), about_me = COALESCE(?, about_me), answer_style = COALESCE(?, answer_style), updated_at = ? WHERE id = ?",
    ).run(parsed.name ?? null, parsed.aboutMe ?? null, parsed.answerStyle ?? null, nowIso(), p.id);
    if (parsed.forNewChats !== undefined) setForNewChats(userId, p.id, parsed.forNewChats);
  });
  return c.json({ persona: persona(userId, p.id) });
});

/** Deletes a persona. If new chats started as it, they start as none until another is picked. */
personaRoutes.delete("/personas/:id", (c) => {
  const p = persona(c.var.user!.id, c.req.param("id"));
  if (!p) return c.json({ error: t("This persona doesn't exist") }, 404);
  db.prepare("DELETE FROM personas WHERE id = ?").run(p.id);
  return c.json({ ok: true });
});
