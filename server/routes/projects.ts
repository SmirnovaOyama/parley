// A person's projects: folders of chats with their own instructions and knowledge bases.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { requireUser, type AppEnv } from "../auth.ts";
import { tx } from "../chat-store.ts";
import { db, nowIso } from "../db.ts";
import { canUse, getBase } from "../knowledge.ts";
import { MAX_PROJECT_INSTRUCTIONS, MAX_PROJECTS, ownProject, type ProjectRow } from "../projects.ts";

export const projectRoutes = new Hono<AppEnv>();
projectRoutes.use("*", requireUser);

function projectOut(p: ProjectRow) {
  const counts = db
    .prepare("SELECT COUNT(*) AS chats, MAX(updated_at) AS last FROM conversations WHERE project_id = ? AND deleted_at IS NULL")
    .get(p.id) as { chats: number; last: string | null };
  return {
    id: p.id,
    name: p.name,
    instructions: p.instructions,
    knowledgeIds: (db.prepare("SELECT kb_id FROM project_knowledge WHERE project_id = ?").all(p.id) as { kb_id: string }[]).map((r) => r.kb_id),
    chats: counts.chats,
    updatedAt: counts.last && counts.last > p.updated_at ? counts.last : p.updated_at,
  };
}

/** A name and instructions from a form, or a sentence saying what's wrong. */
function parseProject(body: Record<string, unknown>, partial: boolean): { name?: string; instructions?: string } | { error: string } {
  const out: { name?: string; instructions?: string } = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name) return { error: "Give the project a name" };
    out.name = name;
  }
  if (body.instructions !== undefined) {
    const instructions = String(body.instructions ?? "").trim();
    if (instructions.length > MAX_PROJECT_INSTRUCTIONS) return { error: `Keep the instructions under ${MAX_PROJECT_INSTRUCTIONS} characters` };
    out.instructions = instructions;
  }
  return out;
}

projectRoutes.get("/projects", (c) => {
  const rows = db.prepare("SELECT * FROM projects WHERE user_id = ?").all(c.var.user!.id) as ProjectRow[];
  const projects = rows.map(projectOut).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json({ projects });
});

projectRoutes.post("/projects", async (c) => {
  const user = c.var.user!;
  const parsed = parseProject(await c.req.json().catch(() => ({})), false);
  if ("error" in parsed) return c.json(parsed, 400);
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?").get(user.id) as { n: number };
  if (n >= MAX_PROJECTS) return c.json({ error: `You can have up to ${MAX_PROJECTS} projects` }, 400);
  const id = randomUUID();
  const now = nowIso();
  db.prepare("INSERT INTO projects (id, user_id, name, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    user.id,
    parsed.name!,
    parsed.instructions ?? "",
    now,
    now,
  );
  return c.json({ project: projectOut(ownProject(id, user.id)!) });
});

projectRoutes.get("/projects/:id", (c) => {
  const p = ownProject(c.req.param("id"), c.var.user!.id);
  if (!p) return c.json({ error: "This project doesn't exist" }, 404);
  return c.json({ project: projectOut(p) });
});

/** Renames a project or changes its instructions; chats in it hear of the change with their next message. */
projectRoutes.patch("/projects/:id", async (c) => {
  const user = c.var.user!;
  const p = ownProject(c.req.param("id"), user.id);
  if (!p) return c.json({ error: "This project doesn't exist" }, 404);
  const parsed = parseProject(await c.req.json().catch(() => ({})), true);
  if ("error" in parsed) return c.json(parsed, 400);
  db.prepare("UPDATE projects SET name = COALESCE(?, name), instructions = COALESCE(?, instructions), updated_at = ? WHERE id = ?").run(
    parsed.name ?? null,
    parsed.instructions ?? null,
    nowIso(),
    p.id,
  );
  return c.json({ project: projectOut(ownProject(p.id, user.id)!) });
});

projectRoutes.put("/projects/:id/knowledge", async (c) => {
  const user = c.var.user!;
  const p = ownProject(c.req.param("id"), user.id);
  if (!p) return c.json({ error: "This project doesn't exist" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body.knowledgeIds) ? [...new Set((body.knowledgeIds as unknown[]).map(String))] : null;
  if (!ids) return c.json({ error: "Pick the knowledge bases for this project" }, 400);
  if (ids.some((id) => !canUse(getBase(id), user.id))) return c.json({ error: "One of those knowledge bases isn't yours to use" }, 400);
  tx(() => {
    db.prepare("DELETE FROM project_knowledge WHERE project_id = ?").run(p.id);
    const add = db.prepare("INSERT INTO project_knowledge (project_id, kb_id) VALUES (?, ?)");
    for (const id of ids) add.run(p.id, id);
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(nowIso(), p.id);
  });
  return c.json({ project: projectOut(ownProject(p.id, user.id)!) });
});

/** Deletes a project. Its chats stay, moved out of it. */
projectRoutes.delete("/projects/:id", (c) => {
  const p = ownProject(c.req.param("id"), c.var.user!.id);
  if (!p) return c.json({ error: "This project doesn't exist" }, 404);
  db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
  return c.json({ ok: true });
});
