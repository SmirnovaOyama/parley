// Which keys a person may use, and the models they unlock. A key is a provider credential: people
// pick any of its allowed models and that model's thinking levels, chat by chat.
import { bonusOf } from "./bonus.ts";
import { db } from "./db.ts";
import { EFFORT_LABELS, findProvider, hasTools, OFF_BY_DEFAULT, readsOf, serviceName, type FileKind, type ModelInfo } from "./providers/catalog.ts";

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
  /** Claude, OpenAI: its chats may search the web. */
  web_search: number;
  /** Claude, OpenAI: its chats may run code and make files. */
  code_execution: number;
  /** JSON list of the model ids people may pick; null means every model but the expensive ones. */
  models: string | null;
  /** Another service's key: JSON Endpoint, where the service is and the models it serves. */
  endpoint: string | null;
  created_at: string;
};

/** A model on another service, as the admin listed it. Prices are dollars per million tokens. */
export type EndpointModel = { id: string; input: number | null; output: number | null };
/** Another service: its address, its models, and whether they look at pictures. */
export type Endpoint = { baseUrl: string; models: EndpointModel[]; images: boolean };

export function endpointOf(k: Pick<KeyRow, "endpoint">): Endpoint | null {
  if (!k.endpoint) return null;
  try {
    const e = JSON.parse(k.endpoint) as Endpoint;
    return typeof e?.baseUrl === "string" && Array.isArray(e.models) ? e : null;
  } catch {
    return null;
  }
}

/**
 * The models a key can run: its provider's from the catalog, or the ones the admin listed for
 * another service. Those are named by their ids, think at the service's default, and are priced as
 * the admin said (cache reads at the full input price, since services differ); no price is free.
 */
export function modelsOf(k: Pick<KeyRow, "provider" | "endpoint">): ModelInfo[] {
  const provider = findProvider(k.provider);
  if (!provider?.custom) return provider?.models ?? [];
  const e = endpointOf(k);
  return (e?.models ?? []).map((m) => ({
    id: m.id,
    label: m.id,
    input: m.input ?? 0,
    output: m.output ?? 0,
    cacheRead: m.input ?? 0,
    cacheWrite: m.input ?? 0,
    efforts: ["default"],
    defaultEffort: "default",
    reads: e?.images ? ["image", "text"] : ["text"],
  }));
}

export function keyModel(k: Pick<KeyRow, "provider" | "endpoint">, model: string): ModelInfo | undefined {
  return modelsOf(k).find((m) => m.id === model);
}

export function keyModelLabel(k: Pick<KeyRow, "provider" | "endpoint">, model: string): string {
  return keyModel(k, model)?.label ?? model;
}

/** The provider's name, or for another service the service's: "OpenRouter", "llm.example.com". */
export function providerLabelOf(k: Pick<KeyRow, "provider" | "endpoint">): string {
  const e = endpointOf(k);
  return e ? serviceName(e.baseUrl) : (findProvider(k.provider)?.label ?? k.provider);
}

/** The kinds of file this key's model opens itself. */
export function opensOf(k: Pick<KeyRow, "provider" | "model" | "endpoint">): FileKind[] {
  return keyModel(k, k.model)?.reads ?? readsOf(k.provider, k.model);
}

/**
 * What a person can attach for this key's model: what it opens, and for Claude and OpenAI anything
 * else too in a chat that runs code (`codeTool`) while its key may.
 */
export function readsFor(k: Pick<KeyRow, "provider" | "model" | "endpoint" | "code_execution">, codeTool: boolean): (FileKind | "other")[] {
  const reads: (FileKind | "other")[] = opensOf(k);
  return hasTools(k.provider) && codeTool && k.code_execution ? [...reads, "other"] : reads;
}

/** The models a key offers, in catalog order. Its starting model is always among them. */
export function allowedModels(k: Pick<KeyRow, "provider" | "model" | "models" | "endpoint">): string[] {
  const all = modelsOf(k).map((m) => m.id);
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
  const info = keyModel(key, m);
  const efforts = info?.efforts ?? [];
  const e =
    effort && efforts.includes(effort)
      ? effort
      : m === key.model && efforts.includes(key.effort)
        ? key.effort
        : (info?.defaultEffort ?? key.effort);
  return { ...key, model: m, effort: e };
}

export function keyById(id: number | null | undefined): KeyRow | undefined {
  if (id == null) return undefined;
  return db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as KeyRow | undefined;
}

/** Shared keys, the site default, keys granted to this person or their groups, and the key bound to them. */
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
          OR k.id IN (SELECT gk.api_key_id FROM group_keys gk JOIN group_members gm ON gm.group_id = gk.group_id WHERE gm.user_id = ?)
       ORDER BY k.is_default DESC, k.created_at`,
    )
    .all(userId, userId, JSON.stringify(bonus.eligible ? bonus.keyIds : []), userId) as KeyRow[];
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
    const label = keyModelLabel(key, model);
    return {
      keyId: key.id,
      model,
      label: twice(model) ? `${label} on ${key.label}` : label,
      efforts: (keyModel(key, model)?.efforts ?? []).map((id) => ({ id, label: EFFORT_LABELS[id] ?? id })),
      defaultEffort: start.effort,
      // What it can open: images, PDFs and text, or less; Claude and OpenAI also anything else in
      // chats where they can run code.
      reads: readsFor(start, true),
      /** Tokens it reads at once; null where it isn't known (another service's model). */
      context: keyModel(key, model)?.context ?? null,
    };
  });
}
