// A person's own data: what the AI remembers about them, taking everything away (export) and
// bringing chats in (import), and the site's rules that touch their data.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireUser, type AppEnv } from "../auth.ts";
import { db, getSettings, nowIso } from "../db.ts";
import { cleanMemory, deleteMemory, memoriesOf, memoryOn, saveMemory } from "../memory.ts";
import { exportFor, importFor, MAX_IMPORT_BYTES } from "../transfer.ts";

export const meRoutes = new Hono<AppEnv>();
meRoutes.use("*", requireUser);

function memoryState(userId: number) {
  const titles = db.prepare("SELECT title FROM conversations WHERE id = ? AND deleted_at IS NULL");
  const off = (db.prepare("SELECT memory_off FROM users WHERE id = ?").get(userId) as { memory_off: number }).memory_off;
  return {
    /** The site allows memory at all. */
    site: getSettings().memory,
    /** This person has it on (and the site allows it). */
    on: memoryOn(userId),
    personOff: !!off,
    memories: memoriesOf(userId)
      .reverse()
      .map((m) => {
        const chat = m.conversation_id ? (titles.get(m.conversation_id) as { title: string } | undefined) : undefined;
        return { id: m.id, text: m.text, createdAt: m.created_at, chat: chat && m.conversation_id ? { id: m.conversation_id, title: chat.title } : null };
      }),
  };
}

meRoutes.get("/memory", (c) => c.json(memoryState(c.var.user!.id)));

meRoutes.put("/memory/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  db.prepare("UPDATE users SET memory_off = ? WHERE id = ?").run(body.on === false ? 1 : 0, c.var.user!.id);
  return c.json(memoryState(c.var.user!.id));
});

meRoutes.post("/memory", async (c) => {
  const userId = c.var.user!.id;
  const text = cleanMemory((await c.req.json().catch(() => ({}))).text);
  if (!text) return c.json({ error: "Write something to remember" }, 400);
  const saved = saveMemory(userId, text, null);
  if ("error" in saved) return c.json(saved, 400);
  return c.json(memoryState(userId));
});

meRoutes.patch("/memory/:id", async (c) => {
  const userId = c.var.user!.id;
  const text = cleanMemory((await c.req.json().catch(() => ({}))).text);
  if (!text) return c.json({ error: "Write something to remember, or delete it" }, 400);
  const changed = db.prepare("UPDATE memories SET text = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(text, nowIso(), Number(c.req.param("id")), userId);
  if (!changed.changes) return c.json({ error: "That note isn't here any more" }, 404);
  return c.json(memoryState(userId));
});

meRoutes.delete("/memory/:id", (c) => {
  const userId = c.var.user!.id;
  deleteMemory(userId, Number(c.req.param("id")));
  return c.json(memoryState(userId));
});

/** Forgets everything. */
meRoutes.delete("/memory", (c) => {
  const userId = c.var.user!.id;
  db.prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
  return c.json(memoryState(userId));
});

/** Everything the person keeps here, as a JSON file to download. */
meRoutes.get("/export", (c) => {
  const user = c.var.user!;
  const data = exportFor(user.id, user.email);
  const day = new Date().toISOString().slice(0, 10);
  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="parley-export-${day}.json"`);
  c.header("Cache-Control", "private, no-store");
  return c.body(JSON.stringify(data, null, 1));
});

/** Brings chats in: a Parley export, or a ChatGPT or Claude export (the .zip or its conversations.json). */
meRoutes.put(
  "/import",
  bodyLimit({ maxSize: MAX_IMPORT_BYTES, onError: (c) => c.json({ error: `Exports can be up to ${MAX_IMPORT_BYTES / (1024 * 1024)} MB` }, 413) }),
  async (c) => {
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (!bytes.length) return c.json({ error: "This file is empty" }, 400);
    try {
      return c.json(importFor(c.var.user!.id, bytes));
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      console.error("[import] failed:", err);
      return c.json({ error: /^(That|There|An import)/.test(message) ? message : "That file couldn't be imported" }, 400);
    }
  },
);

/** The site's rules that touch a person's data and what they can use: how long chats are kept, memory. */
meRoutes.get("/policy", (c) => {
  const s = getSettings();
  return c.json({ retainChatsDays: s.retainChatsDays, retainDeletedDays: s.retainDeletedDays, memory: s.memory });
});
