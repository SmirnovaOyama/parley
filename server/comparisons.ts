// Comparison columns are normal chats with independent histories. Their first question and the
// answer made from the comparison are kept here, so continuing a chat never changes the comparison.
import { db } from "./db.ts";
import { getConversation, getMessage, toPublic, type ConversationRow } from "./chat-store.ts";
import { allowedModels, availableKeys, keyModel, type KeyRow } from "./keys.ts";

export type ComparisonChoice = { keyId: number; model: string; effort: string };
export type ComparisonRow = { id: string; user_id: number; title: string; text: string; created_at: string; updated_at: string };
export type ComparisonRunRow = {
  comparison_id: string;
  position: number;
  conversation_id: string;
  prompt_message_id: number;
  answer_message_id: number | null;
  key_id: number;
  model: string;
  effort: string;
  label: string;
};

/** A comparison must use the model that was picked, never the default substituted by withChoice. */
export function exactChoice(userId: number, choice: unknown): KeyRow | null {
  if (!choice || typeof choice !== "object") return null;
  const { keyId, model, effort } = choice as Partial<ComparisonChoice>;
  if (!Number.isInteger(keyId) || typeof model !== "string" || typeof effort !== "string") return null;
  const key = availableKeys(userId).find((k) => k.id === keyId);
  if (!key || !allowedModels(key).includes(model) || !keyModel(key, model)?.efforts.includes(effort)) return null;
  return { ...key, model, effort };
}

export function ownComparison(id: string, userId: number): ComparisonRow | undefined {
  return db.prepare("SELECT * FROM comparisons WHERE id = ? AND user_id = ?").get(id, userId) as ComparisonRow | undefined;
}

export function comparisonRun(conversationId: string): ComparisonRunRow | undefined {
  return db.prepare("SELECT * FROM comparison_runs WHERE conversation_id = ?").get(conversationId) as ComparisonRunRow | undefined;
}

/** Retrying the original answer must not move the visible head away from a continued chat. */
export function continuedRun(run: ComparisonRunRow, conv: ConversationRow): boolean {
  return conv.head_id !== run.prompt_message_id && conv.head_id !== run.answer_message_id;
}

export function comparisonOut(row: ComparisonRow, active: (id: string, comparisonId: string) => { generating: boolean; asks: unknown[] }) {
  const runs = db.prepare("SELECT * FROM comparison_runs WHERE comparison_id = ? ORDER BY position").all(row.id) as ComparisonRunRow[];
  return {
    id: row.id,
    title: row.title,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runs: runs.map((run) => {
      const conv = getConversation(run.conversation_id);
      const deleted = !conv || !!conv.deleted_at || conv.user_id !== row.user_id;
      const prompt = !deleted ? getMessage(run.prompt_message_id) : undefined;
      const answer = !deleted && run.answer_message_id ? getMessage(run.answer_message_id) : undefined;
      return {
        conversationId: run.conversation_id,
        promptMessageId: run.prompt_message_id,
        choice: { keyId: run.key_id, model: run.model, effort: run.effort },
        label: run.label,
        deleted,
        continued: !deleted && continuedRun(run, conv!),
        messages: [prompt, answer].filter((m) => !!m).map((m) => toPublic(m!)),
        ...(deleted ? { generating: false, asks: [] } : active(run.conversation_id, row.id)),
      };
    }),
  };
}
