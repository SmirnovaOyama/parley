// Knowledge bases: a person's own, and ones admins share with everyone. Documents go up one at a
// time, as the raw bytes with the name in X-File-Name (like files on a message).
import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireUser, type AppEnv } from "../auth.ts";
import { audit, db, nowIso } from "../db.ts";
import { fileHeaders } from "../files.ts";
import {
  addDocument,
  canEdit,
  canUse,
  createBase,
  deleteBase,
  deleteDoc,
  docsOf,
  getBase,
  MAX_DOC_BYTES,
  usableBases,
  type KnowledgeBaseRow,
  type KnowledgeDocRow,
} from "../knowledge.ts";

export const knowledgeRoutes = new Hono<AppEnv>();
knowledgeRoutes.use("*", requireUser);

const MAX_BASES = 100;
const UPLOADS_PER_MINUTE = 30;
const recent = new Map<number, number[]>();

function baseOut(kb: KnowledgeBaseRow, user: { id: number; role: string }) {
  const stats = db.prepare("SELECT COUNT(*) AS docs, COALESCE(SUM(size), 0) AS bytes FROM knowledge_docs WHERE kb_id = ?").get(kb.id) as {
    docs: number;
    bytes: number;
  };
  const owner = kb.user_id === user.id ? null : (db.prepare("SELECT email FROM users WHERE id = ?").get(kb.user_id) as { email: string } | undefined)?.email ?? null;
  return {
    id: kb.id,
    name: kb.name,
    description: kb.description,
    shared: !!kb.shared,
    mine: kb.user_id === user.id,
    canEdit: canEdit(kb, user),
    /** Who made it, when it isn't you (an admin's shared one). */
    owner,
    docs: stats.docs,
    bytes: stats.bytes,
    updatedAt: kb.updated_at,
  };
}

const docOut = (d: KnowledgeDocRow) => ({ id: d.id, name: d.name, mime: d.mime, size: d.size, chars: d.chars, parts: d.parts, createdAt: d.created_at });

function parseBase(body: Record<string, unknown>, partial: boolean): { name?: string; description?: string } | { error: string } {
  const out: { name?: string; description?: string } = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name) return { error: "Give the knowledge base a name" };
    out.name = name;
  }
  if (body.description !== undefined) out.description = String(body.description ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return out;
}

knowledgeRoutes.get("/knowledge", (c) => {
  const user = c.var.user!;
  return c.json({ knowledge: usableBases(user.id).map((kb) => baseOut(kb, user)) });
});

/** A new knowledge base. Admins can share one with everyone. */
knowledgeRoutes.post("/knowledge", async (c) => {
  const user = c.var.user!;
  const body = await c.req.json().catch(() => ({}));
  const parsed = parseBase(body, false);
  if ("error" in parsed) return c.json(parsed, 400);
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM knowledge_bases WHERE user_id = ?").get(user.id) as { n: number };
  if (n >= MAX_BASES) return c.json({ error: `You can have up to ${MAX_BASES} knowledge bases` }, 400);
  const shared = user.role === "admin" && body.shared === true;
  const kb = createBase(user.id, parsed.name!, parsed.description ?? "", shared);
  if (shared) audit(user.id, "share_knowledge", kb.name);
  return c.json({ knowledge: baseOut(kb, user) });
});

knowledgeRoutes.get("/knowledge/:id", (c) => {
  const user = c.var.user!;
  const kb = getBase(c.req.param("id"));
  if (!canUse(kb, user.id)) return c.json({ error: "This knowledge base doesn't exist" }, 404);
  return c.json({ knowledge: baseOut(kb!, user), docs: docsOf(kb!.id).map(docOut) });
});

knowledgeRoutes.patch("/knowledge/:id", async (c) => {
  const user = c.var.user!;
  const kb = getBase(c.req.param("id"));
  if (!canUse(kb, user.id)) return c.json({ error: "This knowledge base doesn't exist" }, 404);
  if (!canEdit(kb, user)) return c.json({ error: "Only its owner can change it" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const parsed = parseBase(body, true);
  if ("error" in parsed) return c.json(parsed, 400);
  const shared = body.shared !== undefined && user.role === "admin" ? (body.shared === true ? 1 : 0) : kb!.shared;
  db.prepare("UPDATE knowledge_bases SET name = COALESCE(?, name), description = COALESCE(?, description), shared = ?, updated_at = ? WHERE id = ?").run(
    parsed.name ?? null,
    parsed.description ?? null,
    shared,
    nowIso(),
    kb!.id,
  );
  if (shared !== kb!.shared) audit(user.id, shared ? "share_knowledge" : "unshare_knowledge", parsed.name ?? kb!.name);
  return c.json({ knowledge: baseOut(getBase(kb!.id)!, user) });
});

knowledgeRoutes.delete("/knowledge/:id", (c) => {
  const user = c.var.user!;
  const kb = getBase(c.req.param("id"));
  if (!canUse(kb, user.id)) return c.json({ error: "This knowledge base doesn't exist" }, 404);
  if (!canEdit(kb, user)) return c.json({ error: "Only its owner can delete it" }, 403);
  deleteBase(kb!.id);
  if (kb!.shared) audit(user.id, "delete_knowledge", kb!.name);
  return c.json({ ok: true });
});

/** Adds a document: the raw bytes as the body, the name in X-File-Name (URI-encoded). */
knowledgeRoutes.put(
  "/knowledge/:id/docs",
  bodyLimit({ maxSize: MAX_DOC_BYTES, onError: (c) => c.json({ error: `Documents can be up to ${MAX_DOC_BYTES / (1024 * 1024)} MB` }, 413) }),
  async (c) => {
    const user = c.var.user!;
    const kb = getBase(c.req.param("id"));
    if (!canUse(kb, user.id)) return c.json({ error: "This knowledge base doesn't exist" }, 404);
    if (!canEdit(kb, user)) return c.json({ error: "Only its owner can add documents" }, 403);
    const now = Date.now();
    const times = (recent.get(user.id) ?? []).filter((t) => now - t < 60_000);
    times.push(now);
    recent.set(user.id, times);
    if (times.length > UPLOADS_PER_MINUTE) return c.json({ error: "You're adding documents quickly. Wait a moment and try again" }, 429);
    let name = "document";
    try {
      name = decodeURIComponent(c.req.header("x-file-name") ?? "") || name;
    } catch {
      // Keep the plain name.
    }
    const added = await addDocument(kb!, name, Buffer.from(await c.req.arrayBuffer()));
    if ("error" in added) return c.json(added, 400);
    return c.json({ doc: docOut(added) });
  },
);

function docOf(c: { req: { param: (k: string) => string } }, userId: number) {
  const kb = getBase(c.req.param("id"));
  if (!canUse(kb, userId)) return null;
  const doc = db.prepare("SELECT * FROM knowledge_docs WHERE id = ? AND kb_id = ?").get(c.req.param("docId"), kb!.id) as KnowledgeDocRow | undefined;
  return doc ? { kb: kb!, doc } : null;
}

knowledgeRoutes.get("/knowledge/:id/docs/:docId", (c) => {
  const found = docOf(c, c.var.user!.id);
  if (!found || !existsSync(found.doc.path)) return c.json({ error: "This document isn't here any more" }, 404);
  const headers = fileHeaders({ id: found.doc.id, message_id: null, owner_id: found.kb.user_id, name: found.doc.name, mime: found.doc.mime, size: found.doc.size, path: found.doc.path }, false);
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.body(readFileSync(found.doc.path));
});

knowledgeRoutes.delete("/knowledge/:id/docs/:docId", (c) => {
  const user = c.var.user!;
  const found = docOf(c, user.id);
  if (!found) return c.json({ error: "This document isn't here any more" }, 404);
  if (!canEdit(found.kb, user)) return c.json({ error: "Only its owner can remove documents" }, 403);
  deleteDoc(found.doc);
  return c.json({ ok: true });
});
