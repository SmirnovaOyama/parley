// The chat list in groups: pinned chats first, then by when each was last active.
import type { ConversationSummary } from "./api.ts";

export type ChatGroup = { label: string; chats: ConversationSummary[] };

const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long" });
const monthYearFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const DAY_MS = 24 * 60 * 60 * 1000;

/** "Pinned", "Today", "Yesterday", "Previous 7 days", "Previous 30 days", then each month ("September", "August 2025"). */
export function groupChats(chats: ConversationSummary[], now = new Date()): ChatGroup[] {
  const groups: ChatGroup[] = [];
  const add = (label: string, chat: ConversationSummary) => {
    const last = groups[groups.length - 1];
    if (last?.label === label) last.chats.push(chat);
    else {
      const same = groups.find((g) => g.label === label);
      if (same) same.chats.push(chat);
      else groups.push({ label, chats: [chat] });
    }
  };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const pinned = chats.filter((c) => c.pinnedAt);
  for (const c of pinned) add("Pinned", c);
  const rest = chats.filter((c) => !c.pinnedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const c of rest) {
    const d = new Date(c.updatedAt);
    const t = d.getTime();
    if (t >= today) add("Today", c);
    else if (t >= today - DAY_MS) add("Yesterday", c);
    else if (t >= today - 7 * DAY_MS) add("Previous 7 days", c);
    else if (t >= today - 30 * DAY_MS) add("Previous 30 days", c);
    else add(d.getFullYear() === now.getFullYear() ? monthFmt.format(d) : monthYearFmt.format(d), c);
  }
  return groups;
}
