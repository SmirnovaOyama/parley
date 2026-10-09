// Which keys a person may use, and the models they unlock. A key is a provider credential: people
// pick any of its allowed models and that model's thinking levels, chat by chat.
import { bonusOf } from "./bonus.ts";
import { db } from "./db.ts";
import { EFFORT_LABELS, findModel, findProvider, modelLabel, OFF_BY_DEFAULT } from "./providers/catalog.ts";

export type KeyRow = {
  id: number;
  label: string;
  provider: string;
  model: string;
  effort: string;
  encrypted_key: string;
  last4: string;
  is_default: number;
  shared: number;
  fallback_key_id: number | null;
  /** Claude: its chats may search the web. */
  web_search: number;
  /** Claude: its chats may run code and make files. */
  code_execution: number;
  /** JSON list of the model ids people may pick; null means every model but the expensive ones. */
  models: string | null;
  created_at: string;
};

/** The models a key offers, in catalog order. Its starting model is always among them. */
export function allowedModels(k: Pick<KeyRow, "provider" | "model" | "models">): string[] {
  const all = findProvider(k.provider)?.models.map((m) => m.id) ?? [];
  let picked = all.filter((id) => !OFF_BY_DEFAULT.has(id));
  if (k.models) {
    try {
      const list = JSON.parse(k.models);
      if (Array.isArray(list)) picked = all.filter((id) => list.includes(id));
    } catch {
      // Keep the default list.
    }
  }
  return all.filter((id) => id === k.model || picked.includes(id));
}

/**
 * The key as one chat runs it: the model and thinking level asked for when the key allows them,
 * else its starting model, and that model's own default level where the key's doesn't apply.
 */
export function withChoice(key: KeyRow, model?: string | null, effort?: string | null): KeyRow {
  const m = model && allowedModels(key).includes(model) ? model : key.model;
  const efforts = findModel(key.provider, m)?.efforts ?? [];
  const e =
    effort && efforts.includes(effort)
      ? effort
      : m === key.model && efforts.includes(key.effort)
        ? key.effort
        : (findModel(key.provider, m)?.defaultEffort ?? key.effort);
  return { ...key, model: m, effort: e };
}

export function keyById(id: number | null | undefined): KeyRow | undefined {
  if (id == null) return undefined;
  return db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as KeyRow | undefined;
}

/** Shared keys, the site default, keys granted to this person and the key bound to them. */
export function availableKeys(userId: number): KeyRow[] {
  // A verified address on a rewarded domain also unlocks the reward's keys.
  const bonus = bonusOf(userId);
  return db
    .prepare(
      `SELECT k.* FROM api_keys k
       WHERE k.shared = 1 OR k.is_default = 1
          OR k.id IN (SELECT api_key_id FROM user_keys WHERE user_id = ?)
          OR k.id = (SELECT api_key_id FROM users WHERE id = ?)
          OR k.id IN (SELECT value FROM json_each(?))
       ORDER BY k.is_default DESC, k.created_at`,
    )
    .all(userId, userId, JSON.stringify(bonus.eligible ? bonus.keyIds : [])) as KeyRow[];
}

/** What new chats start with: the person's own default, else the site default, else the first. */
export function startingKey(userId: number, available = availableKeys(userId)): KeyRow | undefined {
  const own = (db.prepare("SELECT api_key_id FROM users WHERE id = ?").get(userId) as { api_key_id: number | null })
    .api_key_id;
  return available.find((k) => k.id === own) ?? available.find((k) => k.is_default) ?? available[0];
}

/**
 * What the picker lists: every model each usable key offers, with its thinking levels and the one
 * a new chat would start on. People see the model; the key's name only tells two keys apart.
 */
export function pickerChoices(keys: KeyRow[]) {
  const entries = keys.flatMap((key) => allowedModels(key).map((model) => ({ key, model })));
  const twice = (model: string) => entries.filter((e) => e.model === model).length > 1;
  return entries.map(({ key, model }) => {
    const start = withChoice(key, model);
    return {
      keyId: key.id,
      model,
      label: twice(model) ? `${modelLabel(key.provider, model)} on ${key.label}` : modelLabel(key.provider, model),
      efforts: (findModel(key.provider, model)?.efforts ?? []).map((id) => ({ id, label: EFFORT_LABELS[id] ?? id })),
      defaultEffort: start.effort,
    };
  });
}
