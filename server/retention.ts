// The site's data retention: chats nobody has touched for a set number of days are deleted, and
// chats people deleted (kept for admins until then) go after their own number of days. Their files
// go with them. Usage records stay, so monthly limits and reports remain right.
import { pathsOfConversation, removeUnused } from "./attachments.ts";
import { db, getSettings } from "./db.ts";
import { clearOrphanedKnowledge } from "./knowledge.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes chats for good, with every file in them. */
export function purgeConversations(ids: string[]) {
  for (const id of ids) {
    const paths = pathsOfConversation(id);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    removeUnused(paths);
  }
}

/** Applies the retention rules now. Runs at start-up and every hour; returns how many chats went. */
export function enforceRetention(): number {
  const { retainChatsDays, retainDeletedDays } = getSettings();
  const ids = new Set<string>();
  if (retainChatsDays != null && retainChatsDays > 0) {
    const before = new Date(Date.now() - retainChatsDays * DAY_MS).toISOString();
    for (const r of db.prepare("SELECT id FROM conversations WHERE updated_at < ?").all(before) as { id: string }[]) ids.add(r.id);
  }
  if (retainDeletedDays != null) {
    const before = new Date(Date.now() - retainDeletedDays * DAY_MS).toISOString();
    for (const r of db.prepare("SELECT id FROM conversations WHERE deleted_at IS NOT NULL AND deleted_at <= ?").all(before) as { id: string }[]) ids.add(r.id);
  }
  purgeConversations([...ids]);
  clearOrphanedKnowledge();
  if (ids.size) console.log(`[retention] deleted ${ids.size} ${ids.size === 1 ? "chat" : "chats"}`);
  return ids.size;
}
