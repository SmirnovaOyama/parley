import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import { pathTo } from "../chat-store.ts";
import { db, getSettings } from "../db.ts";
import { fileHeaders, storedFile } from "../files.ts";
import { sharedMessages, type ShareRow } from "../shares.ts";

/** Opening a shared chat link. Depending on the site setting, no account is needed. */
export const sharedRoutes = new Hono<AppEnv>();

sharedRoutes.get("/:token", (c) => {
  // Links are secrets; keep them out of search engines and shared caches.
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Cache-Control", "private, no-store");

  const { sharing } = getSettings();
  if (sharing === "off") return c.json({ error: "Sharing is turned off on this site" }, 404);
  if (sharing === "signed-in" && !c.var.user) return c.json({ error: "Sign in to read this chat", signIn: true }, 401);

  const share = db
    .prepare(
      `SELECT s.* FROM shares s JOIN conversations cv ON cv.id = s.conversation_id
       WHERE s.id = ? AND cv.deleted_at IS NULL`,
    )
    .get(c.req.param("token")) as ShareRow | undefined;
  if (!share) return c.json({ error: "This link doesn't work any more. The chat may have been unshared or deleted" }, 404);

  return c.json({ title: share.title, sharedAt: share.updated_at, messages: sharedMessages(share.leaf_id) });
});

/** A file made by a reply on the shared branch, for whoever may open the link. */
sharedRoutes.get("/:token/files/:fileId", (c) => {
  const { sharing } = getSettings();
  if (sharing === "off") return c.json({ error: "Sharing is turned off on this site" }, 404);
  if (sharing === "signed-in" && !c.var.user) return c.json({ error: "Sign in to read this chat", signIn: true }, 401);
  const share = db
    .prepare(
      `SELECT s.* FROM shares s JOIN conversations cv ON cv.id = s.conversation_id
       WHERE s.id = ? AND cv.deleted_at IS NULL`,
    )
    .get(c.req.param("token")) as ShareRow | undefined;
  const file = storedFile(c.req.param("fileId"));
  // Only files on the branch the link shows, up to the message it was shared at.
  const onBranch = share && file && pathTo(share.leaf_id).some((m) => m.id === file.message_id);
  if (!share || !file || !onBranch || !existsSync(file.path)) return c.json({ error: "This file isn't here any more" }, 404);
  c.header("X-Robots-Tag", "noindex, nofollow");
  for (const [name, value] of Object.entries(fileHeaders(file, c.req.query("inline") === "1"))) c.header(name, value);
  return c.body(readFileSync(file.path));
});
