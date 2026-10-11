import { Hono } from "hono";
import { requireAdmin, type AppEnv } from "../auth.ts";
import { baseSpendLimit, MAX_DOLLARS, SPEND_LIMIT_MODES } from "../allowance.ts";
import { DOMAIN_RE, rewardDomain } from "../bonus.ts";
import { DECLINED_SQL, getConversation, tx, viewPath } from "../chat-store.ts";
import { encryptSecret, decryptSecret, hashPassword } from "../crypto.ts";
import { audit, db, getSettings, nowIso, saveSettings, SHARING_MODES, startOfMonthIso, type Settings } from "../db.ts";
import { EFFORT_LABELS, OFF_BY_DEFAULT, PROVIDERS, SERVICES, featuresOf, findModel, findProvider, modelLabel, serviceName } from "../providers/catalog.ts";
import { mailMode } from "../mail.ts";
import { sweepCredentials } from "../mcp.ts";
import { getProvider } from "../providers/index.ts";
import {
  allowedModels,
  endpointOf,
  keyModel,
  keyModelLabel,
  modelsOf,
  providerLabelOf,
  type Endpoint,
  type EndpointModel,
  type KeyRow,
} from "../keys.ts";
import { clearFailures, MIN_PASSWORD } from "./auth.ts";
import { enforceRetention, purgeConversations } from "../retention.ts";
import { endSessionByRef, keepEveryoneWithinLimit, sessionsOf, spreadOf } from "../sessions.ts";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireAdmin);

/**
 * The models a key may offer, from what the admin ticked: only ones the key can run, and always the
 * one new chats start on. Undefined keeps the default (every model but the expensive ones).
 */
function parseModels(value: unknown, known: string[], startModel: string): string | null | { error: string } {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return { error: "Pick which models people can use" };
  const list = [...new Set([startModel, ...value.map(String).filter((id) => known.includes(id))])];
  return JSON.stringify(list);
}

/** At most this many models on another service's key. */
const MAX_ENDPOINT_MODELS = 40;

/** A price per million tokens from the form: empty is none. */
function parsePrice(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : undefined;
}

/** Another service's address and models from the form, or a sentence saying what's wrong. */
function parseEndpoint(value: unknown): Endpoint | { error: string } {
  const v = (value ?? {}) as { baseUrl?: unknown; models?: unknown; images?: unknown };
  const baseUrl = String(v.baseUrl ?? "").trim().replace(/\/+$/, "");
  let url: URL | null = null;
  try {
    url = new URL(baseUrl);
  } catch {
    // Not an address.
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return { error: "Type the service's address, starting with https://" };
  }
  const models: EndpointModel[] = [];
  for (const raw of Array.isArray(v.models) ? (v.models as Record<string, unknown>[]) : []) {
    const id = String(raw?.id ?? "").trim().slice(0, 200);
    if (!id || models.some((m) => m.id === id)) continue;
    const input = parsePrice(raw.input);
    const output = parsePrice(raw.output);
    if (input === undefined || output === undefined) return { error: `Write ${id}'s prices in dollars per million tokens, like 0.5` };
    models.push({ id, input, output });
  }
  if (!models.length) return { error: "Add the name of at least one model it serves" };
  if (models.length > MAX_ENDPOINT_MODELS) return { error: `A key can list up to ${MAX_ENDPOINT_MODELS} models` };
  return { baseUrl, models, images: v.images === true };
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

function verifyMessage(err: unknown, baseUrl?: string): string {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : "";
  if (status === 401 || status === 403) return "The provider rejected this key";
  if (status === 404) return "This key can't use the selected model";
  if (!status && /connection|timed? ?out|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    return baseUrl ? `Couldn't reach ${serviceName(baseUrl)}. Check the address and try again` : "Couldn't reach the provider. Try again";
  }
  // Some providers answer a bad key with a 400 that says so.
  if ((status === 400 || status === 422) && message) return `The provider turned it down: ${message.replace(/^\d{3}\s+/, "")}`;
  if (message && !status) return message;
  return "Couldn't check the key with the provider. Try again";
}

/** A backup key must exist and be a different key. Returns an error sentence, or null when fine. */
function badFallback(fallbackKeyId: number | null, selfId?: number): string | null {
  if (fallbackKeyId == null) return null;
  if (fallbackKeyId === selfId) return "A key can't be its own backup";
  if (!db.prepare("SELECT 1 FROM api_keys WHERE id = ?").get(fallbackKeyId)) return "That backup key doesn't exist";
  return null;
}

const parseFallback = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

// ── Catalog ─────────────────────────────────────────────────────────

adminRoutes.get("/catalog", (c) =>
  c.json({
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      detail: p.detail,
      features: featuresOf(p),
      custom: !!p.custom,
      reads: p.reads,
      defaultModel: p.defaultModel,
      models: p.models.map((m) => ({
        id: m.id,
        label: m.label,
        defaultEffort: m.defaultEffort,
        efforts: m.efforts.map((e) => ({ id: e, label: EFFORT_LABELS[e] ?? e })),
        // Left unticked on a new key; the price per million tokens, in and out, tells why.
        offByDefault: OFF_BY_DEFAULT.has(m.id),
        price: { input: m.input, output: m.output },
      })),
    })),
    // Starting points for another service's address.
    services: SERVICES,
  }),
);

// ── API keys ────────────────────────────────────────────────────────

adminRoutes.get("/keys", (c) => {
  const rows = db
    .prepare(
      `SELECT k.*,
         (SELECT COUNT(*) FROM users u WHERE u.api_key_id = k.id) AS bound_users,
         (SELECT COUNT(*) FROM user_keys uk WHERE uk.api_key_id = k.id) AS granted_users,
         f.label AS fallback_label, f.provider AS fallback_provider, f.model AS fallback_model
       FROM api_keys k LEFT JOIN api_keys f ON f.id = k.fallback_key_id
       ORDER BY k.is_default DESC, k.created_at`,
    )
    .all() as (KeyRow & {
    bound_users: number;
    granted_users: number;
    fallback_label: string | null;
    fallback_provider: string | null;
    fallback_model: string | null;
  })[];
  return c.json({
    keys: rows.map((k) => ({
      id: k.id,
      label: k.label,
      provider: k.provider,
      providerLabel: providerLabelOf(k),
      model: k.model,
      modelLabel: keyModelLabel(k, k.model),
      effort: k.effort,
      effortLabel: EFFORT_LABELS[k.effort] ?? k.effort,
      last4: k.last4,
      endpoint: endpointOf(k),
      isDefault: !!k.is_default,
      shared: !!k.shared || !!k.is_default,
      fallbackKeyId: k.fallback_key_id,
      fallbackLabel: k.fallback_label,
      fallbackModelLabel: k.fallback_model ? modelLabel(k.fallback_provider, k.fallback_model) : null,
      webSearch: !!k.web_search,
      codeExecution: !!k.code_execution,
      models: allowedModels(k),
      boundUsers: k.bound_users,
      grantedUsers: k.granted_users,
      createdAt: k.created_at,
    })),
  });
});

adminRoutes.post("/keys", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const label = String(body.label ?? "").trim().slice(0, 80);
  const provider = findProvider(String(body.provider ?? ""));
  const model = String(body.model ?? "").trim();
  const effort = String(body.effort ?? "");
  const apiKey = String(body.apiKey ?? "").trim();

  if (!label) return c.json({ error: "Give the key a name" }, 400);
  if (!provider) return c.json({ error: "Pick a provider" }, 400);
  // Another service brings its own address and models.
  let endpoint: Endpoint | null = null;
  if (provider.custom) {
    const parsed = parseEndpoint(body.endpoint);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    endpoint = parsed;
  }
  const draft = { provider: provider.id, endpoint: endpoint && JSON.stringify(endpoint) };
  const modelInfo = keyModel(draft, model);
  if (!modelInfo) return c.json({ error: "Pick the model new chats start on" }, 400);
  if (!modelInfo.efforts.includes(effort)) return c.json({ error: "Pick a thinking level this model supports" }, 400);
  // A service on the server itself (Ollama, say) may need no key.
  if (!provider.custom && apiKey.length < 12) return c.json({ error: "Paste the full API key" }, 400);

  try {
    await getProvider(provider.id).verify(apiKey, model, endpoint?.baseUrl);
  } catch (err) {
    return c.json({ error: verifyMessage(err, endpoint?.baseUrl) }, 400);
  }

  const fallbackKeyId = parseFallback(body.fallbackKeyId);
  const fallbackError = badFallback(fallbackKeyId);
  if (fallbackError) return c.json({ error: fallbackError }, 400);

  const first = !(db.prepare("SELECT 1 FROM api_keys LIMIT 1").get());
  const makeDefault = first || !!body.isDefault;
  // The default key is everyone's, so it's always shared.
  const shared = makeDefault || body.shared !== false;
  // Claude and OpenAI search with their own tool; other models through the site's search service, once it's set up.
  const webSearch = body.webSearch === true;
  // Only Claude and OpenAI make files.
  const codeExecution = !!provider.tools && body.codeExecution === true;
  // Another service offers every model listed for it.
  const known = modelsOf(draft).map((m) => m.id);
  const models = parseModels(endpoint ? known : body.models, known, model);
  if (models && typeof models === "object") return c.json({ error: models.error }, 400);
  if (makeDefault) db.prepare("UPDATE api_keys SET is_default = 0").run();
  const result = db
    .prepare(
      `INSERT INTO api_keys (label, provider, model, effort, encrypted_key, last4, is_default, shared, fallback_key_id,
         web_search, code_execution, models, endpoint, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(label, provider.id, model, effort, encryptSecret(apiKey), apiKey.slice(-4), makeDefault ? 1 : 0, shared ? 1 : 0, fallbackKeyId,
      webSearch ? 1 : 0, codeExecution ? 1 : 0, models, draft.endpoint, c.var.user!.id, nowIso());
  audit(c.var.user!.id, "add_key", label);
  return c.json({ id: Number(result.lastInsertRowid) });
});

adminRoutes.patch("/keys/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const key = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as KeyRow | undefined;
  if (!key) return c.json({ error: "This key doesn't exist" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const provider = findProvider(key.provider)!;

  const label = body.label !== undefined ? String(body.label).trim().slice(0, 80) : key.label;
  const model = body.model !== undefined ? String(body.model).trim() : key.model;
  const effort = body.effort !== undefined ? String(body.effort) : key.effort;
  const newKey = body.apiKey ? String(body.apiKey).trim() : null;

  if (!label) return c.json({ error: "Give the key a name" }, 400);
  let endpoint = endpointOf(key);
  if (provider.custom && body.endpoint !== undefined) {
    const parsed = parseEndpoint(body.endpoint);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    endpoint = parsed;
  }
  const draft = { provider: provider.id, endpoint: endpoint && JSON.stringify(endpoint) };
  const modelInfo = keyModel(draft, model);
  if (!modelInfo) return c.json({ error: "Pick the model new chats start on" }, 400);
  if (!modelInfo.efforts.includes(effort)) return c.json({ error: "Pick a thinking level this model supports" }, 400);

  const moved = endpoint?.baseUrl !== endpointOf(key)?.baseUrl;
  if (newKey || model !== key.model || moved) {
    try {
      await getProvider(provider.id).verify(newKey ?? decryptSecret(key.encrypted_key), model, endpoint?.baseUrl);
    } catch (err) {
      return c.json({ error: verifyMessage(err, endpoint?.baseUrl) }, 400);
    }
  }

  const fallbackKeyId = body.fallbackKeyId !== undefined ? parseFallback(body.fallbackKeyId) : key.fallback_key_id;
  const fallbackError = badFallback(fallbackKeyId, id);
  if (fallbackError) return c.json({ error: fallbackError }, 400);
  const isDefault = body.isDefault === true || !!key.is_default;
  const shared = isDefault || (body.shared !== undefined ? body.shared !== false : !!key.shared);
  const webSearch = body.webSearch !== undefined ? body.webSearch === true : !!key.web_search;
  const codeExecution = !!provider.tools && (body.codeExecution !== undefined ? body.codeExecution === true : !!key.code_execution);
  // A new starting model joins the list even when the list itself wasn't sent. Another service
  // offers every model listed for it.
  const known = modelsOf(draft).map((m) => m.id);
  const ticked = endpoint ? known : body.models !== undefined ? body.models : allowedModels({ ...key, model });
  const models = parseModels(ticked, known, model);
  if (models && typeof models === "object") return c.json({ error: models.error }, 400);

  if (body.isDefault === true) db.prepare("UPDATE api_keys SET is_default = 0").run();
  db.prepare(
    `UPDATE api_keys SET label = ?, model = ?, effort = ?, encrypted_key = ?, last4 = ?,
       is_default = ?, shared = ?, fallback_key_id = ?, web_search = ?, code_execution = ?, models = ?, endpoint = ? WHERE id = ?`,
  ).run(
    label,
    model,
    effort,
    newKey ? encryptSecret(newKey) : key.encrypted_key,
    newKey ? newKey.slice(-4) : key.last4,
    isDefault ? 1 : 0,
    shared ? 1 : 0,
    fallbackKeyId,
    webSearch ? 1 : 0,
    codeExecution ? 1 : 0,
    models,
    draft.endpoint,
    id,
  );
  audit(c.var.user!.id, newKey ? "replace_key" : "edit_key", label);
  return c.json({ ok: true });
});

adminRoutes.delete("/keys/:id", (c) => {
  const id = Number(c.req.param("id"));
  const key = db.prepare("SELECT label, is_default FROM api_keys WHERE id = ?").get(id) as
    | { label: string; is_default: number }
    | undefined;
  if (!key) return c.json({ error: "This key doesn't exist" }, 404);
  db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
  // Keep a default in place if any key is left.
  if (key.is_default) db.prepare("UPDATE api_keys SET is_default = 1 WHERE id = (SELECT MIN(id) FROM api_keys)").run();
  audit(c.var.user!.id, "delete_key", key.label);
  return c.json({ ok: true });
});

// ── Users ───────────────────────────────────────────────────────────

adminRoutes.get("/users", (c) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.email, u.role, u.api_key_id, u.monthly_token_limit, u.disabled, u.created_at, u.bonus_email,
         u.spend_limit_mode, u.monthly_spend_limit,
         k.label AS key_label,
         (SELECT COALESCE(SUM(e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_tokens), 0)
            FROM usage_events e WHERE e.user_id = u.id AND e.created_at >= ?1) AS tokens_this_month,
         (SELECT COALESCE(SUM(e.cost_usd), 0) FROM usage_events e WHERE e.user_id = u.id AND e.created_at >= ?1) AS spent_this_month,
         (SELECT COUNT(*) FROM conversations cv WHERE cv.user_id = u.id) AS conversations
       FROM users u LEFT JOIN api_keys k ON k.id = u.api_key_id
       ORDER BY u.created_at`,
    )
    .all(startOfMonthIso()) as {
    id: number;
    email: string;
    role: string;
    api_key_id: number | null;
    monthly_token_limit: number | null;
    disabled: number;
    created_at: string;
    bonus_email: string | null;
    spend_limit_mode: string;
    monthly_spend_limit: number | null;
    key_label: string | null;
    tokens_this_month: number;
    spent_this_month: number;
    conversations: number;
  }[];
  const { bonusDomains, bonusTokens, bonusSpend, spendLimit: siteLimit } = getSettings();
  const grants = db.prepare("SELECT user_id, api_key_id FROM user_keys").all() as { user_id: number; api_key_id: number }[];
  const memberships = db.prepare("SELECT user_id, group_id FROM group_members").all() as { user_id: number; group_id: number }[];
  return c.json({
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      apiKeyId: u.api_key_id,
      keyIds: grants.filter((g) => g.user_id === u.id).map((g) => g.api_key_id),
      groupIds: memberships.filter((m) => m.user_id === u.id).map((m) => m.group_id),
      keyLabel: u.key_label,
      monthlyTokenLimit: u.monthly_token_limit,
      /** Whose spending limit they follow, and their own amount (kept while they follow the site's). */
      spendLimitMode: u.spend_limit_mode,
      monthlySpendLimit: u.monthly_spend_limit,
      /** The limit they're held to this month before any reward; null for none. */
      spendLimit: baseSpendLimit(u, siteLimit),
      spentThisMonth: u.spent_this_month,
      disabled: !!u.disabled,
      tokensThisMonth: u.tokens_this_month,
      conversations: u.conversations,
      createdAt: u.created_at,
      // An address they proved they own; it earns the reward while its domain is listed.
      bonusEmail: u.bonus_email,
      bonusActive: !!u.bonus_email && !!rewardDomain(u.bonus_email, bonusDomains),
      /** Tokens the email reward adds to their monthly limit right now. */
      bonusTokens: u.bonus_email && rewardDomain(u.bonus_email, bonusDomains) ? bonusTokens : null,
      bonusSpend: u.bonus_email && rewardDomain(u.bonus_email, bonusDomains) ? bonusSpend : null,
      /** How many devices they're signed in on, the networks this week's came from, and how many aren't browsers. */
      ...spreadOf(sessionsOf(u.id)),
    })),
  });
});

adminRoutes.post("/users", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const role = body.role === "admin" ? "admin" : "user";
  if (!EMAIL_RE.test(email)) return c.json({ error: "Enter a valid email address" }, 400);
  if (password.length < MIN_PASSWORD) return c.json({ error: `Use at least ${MIN_PASSWORD} characters for the password` }, 400);
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
    return c.json({ error: "An account with this email already exists" }, 409);
  }
  const result = db
    .prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
    .run(email, await hashPassword(password), role, nowIso());
  audit(c.var.user!.id, "add_user", email);
  return c.json({ id: Number(result.lastInsertRowid) });
});

adminRoutes.patch("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const target = db.prepare("SELECT id, email, role, disabled FROM users WHERE id = ?").get(id) as
    | { id: number; email: string; role: string; disabled: number }
    | undefined;
  if (!target) return c.json({ error: "This person doesn't exist" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const self = id === c.var.user!.id;

  const role = body.role === undefined ? target.role : body.role === "admin" ? "admin" : "user";
  const disabled = body.disabled === undefined ? !!target.disabled : !!body.disabled;
  if (self && (role !== "admin" || disabled)) {
    return c.json({ error: "You can't remove your own admin access or turn off your own account" }, 400);
  }
  if (target.role === "admin" && (role !== "admin" || disabled)) {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number };
    if (n <= 1) return c.json({ error: "Keep at least one active admin" }, 400);
  }

  let keyIds: number[] | undefined;
  if (body.keyIds !== undefined) {
    if (!Array.isArray(body.keyIds)) return c.json({ error: "Pick the models this person can use" }, 400);
    keyIds = [...new Set((body.keyIds as unknown[]).map(Number))];
    const known = new Set((db.prepare("SELECT id FROM api_keys").all() as { id: number }[]).map((k) => k.id));
    if (keyIds.some((k) => !known.has(k))) return c.json({ error: "One of those keys doesn't exist" }, 400);
  }

  // The model new chats start with must be one this person can use.
  let apiKeyId: number | null | undefined;
  if (body.apiKeyId !== undefined) {
    apiKeyId = body.apiKeyId === null ? null : Number(body.apiKeyId);
    if (apiKeyId !== null) {
      const k = db.prepare("SELECT shared, is_default FROM api_keys WHERE id = ?").get(apiKeyId) as
        | { shared: number; is_default: number }
        | undefined;
      const granted = keyIds
        ? keyIds.includes(apiKeyId)
        : !!db.prepare("SELECT 1 FROM user_keys WHERE user_id = ? AND api_key_id = ?").get(id, apiKeyId);
      if (!k) return c.json({ error: "That key doesn't exist" }, 400);
      if (!k.shared && !k.is_default && !granted) return c.json({ error: "Let this person use that model first" }, 400);
    }
  }
  let limit: number | null | undefined;
  if (body.monthlyTokenLimit !== undefined) {
    limit = body.monthlyTokenLimit === null || body.monthlyTokenLimit === "" ? null : Math.max(0, Math.floor(Number(body.monthlyTokenLimit)));
    if (limit !== null && !Number.isFinite(limit)) return c.json({ error: "Enter the limit as a number of tokens" }, 400);
  }
  // Their spending limit: the site's for members, their own amount, or none.
  const spendMode = body.spendLimitMode === undefined ? undefined : SPEND_LIMIT_MODES.find((m) => m === body.spendLimitMode);
  if (body.spendLimitMode !== undefined && !spendMode) return c.json({ error: "Choose which spending limit applies" }, 400);
  let ownSpend: number | null | undefined;
  if (body.monthlySpendLimit !== undefined) {
    ownSpend = parseDollars(body.monthlySpendLimit);
    if (ownSpend === undefined) return c.json({ error: "Enter the spending limit in dollars, like 5 or 2.50" }, 400);
  }
  if (spendMode === "own" && ownSpend == null) return c.json({ error: "Enter their monthly spending limit in dollars" }, 400);

  db.prepare(
    `UPDATE users SET role = ?, disabled = ?,
       api_key_id = CASE WHEN ? THEN ? ELSE api_key_id END,
       monthly_token_limit = CASE WHEN ? THEN ? ELSE monthly_token_limit END,
       spend_limit_mode = COALESCE(?, spend_limit_mode),
       monthly_spend_limit = CASE WHEN ? THEN ? ELSE monthly_spend_limit END
     WHERE id = ?`,
  ).run(
    role,
    disabled ? 1 : 0,
    apiKeyId !== undefined ? 1 : 0,
    apiKeyId ?? null,
    limit !== undefined ? 1 : 0,
    limit ?? null,
    spendMode ?? null,
    ownSpend !== undefined ? 1 : 0,
    ownSpend ?? null,
    id,
  );
  if (Array.isArray(body.groupIds)) {
    const known = new Set((db.prepare("SELECT id FROM user_groups").all() as { id: number }[]).map((g) => g.id));
    db.prepare("DELETE FROM group_members WHERE user_id = ?").run(id);
    const join = db.prepare("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)");
    for (const g of new Set((body.groupIds as unknown[]).map(Number))) if (known.has(g)) join.run(g, id);
  }
  if (keyIds) {
    db.prepare("DELETE FROM user_keys WHERE user_id = ?").run(id);
    const grant = db.prepare("INSERT INTO user_keys (user_id, api_key_id) VALUES (?, ?)");
    for (const k of keyIds) grant.run(id, k);
  }
  if (disabled) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  // Turned off, or out of a group: their own accounts on servers they can't use now are forgotten.
  sweepCredentials();
  audit(c.var.user!.id, "edit_user", target.email);
  return c.json({ ok: true });
});

// Someone who can't sign in, on a site that can't email them a reset link, asks an admin: the admin
// sets a new password here and passes it on. Whoever had the old one is signed out everywhere.
adminRoutes.post("/users/:id/password", async (c) => {
  const id = Number(c.req.param("id"));
  const target = db.prepare("SELECT email FROM users WHERE id = ?").get(id) as { email: string } | undefined;
  if (!target) return c.json({ error: "This person doesn't exist" }, 404);
  // Your own is changed under Account, which asks for the current one and keeps you signed in.
  if (id === c.var.user!.id) return c.json({ error: "Change your own password under Account" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const password = String(body.password ?? "");
  if (password.length < MIN_PASSWORD) return c.json({ error: `Use at least ${MIN_PASSWORD} characters for the password` }, 400);

  const hash = await hashPassword(password);
  tx(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    // A reset link they asked for before can't change it again behind the admin's back.
    db.prepare("DELETE FROM password_resets WHERE user_id = ?").run(id);
  });
  // Guesses at the old password don't keep them out of the new one.
  clearFailures(target.email);
  audit(c.var.user!.id, "set_password", target.email);
  return c.json({ ok: true });
});

// Where someone is signed in: their devices, the address each was last used from, and when. An
// admin can sign them out of one or all. Your own are under Account, which keeps this one.
adminRoutes.get("/users/:id/sessions", (c) => {
  const id = Number(c.req.param("id"));
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) return c.json({ error: "This person doesn't exist" }, 404);
  const sessions = sessionsOf(id, c.var.sessionId);
  return c.json({ sessions, ...spreadOf(sessions), limit: getSettings().maxSessions });
});

adminRoutes.delete("/users/:id/sessions", (c) => {
  const id = Number(c.req.param("id"));
  const target = db.prepare("SELECT email FROM users WHERE id = ?").get(id) as { email: string } | undefined;
  if (!target) return c.json({ error: "This person doesn't exist" }, 404);
  if (id === c.var.user!.id) return c.json({ error: "Sign out your own devices under Account" }, 400);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  audit(c.var.user!.id, "sign_out_user", target.email);
  return c.json({ ok: true });
});

adminRoutes.delete("/users/:id/sessions/:session", (c) => {
  const id = Number(c.req.param("id"));
  const target = db.prepare("SELECT email FROM users WHERE id = ?").get(id) as { email: string } | undefined;
  if (!target) return c.json({ error: "This person doesn't exist" }, 404);
  if (id === c.var.user!.id) return c.json({ error: "Sign out your own devices under Account" }, 400);
  if (!endSessionByRef(id, c.req.param("session"))) return c.json({ error: "That device is already signed out" }, 404);
  audit(c.var.user!.id, "sign_out_device", target.email);
  return c.json({ ok: true });
});

// ── Conversations (read-only, every view is logged) ─────────────────

adminRoutes.get("/conversations", (c) => {
  const userId = c.req.query("userId");
  const q = (c.req.query("q") ?? "").trim();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (userId) {
    where.push("cv.user_id = ?");
    params.push(Number(userId));
  }
  if (q) {
    where.push(
      "(u.email LIKE ? OR cv.title LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = cv.id AND m.text LIKE ?))",
    );
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = db
    .prepare(
      `SELECT cv.id, cv.title, cv.updated_at, cv.deleted_at, u.email,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id) AS message_count,
         EXISTS (SELECT 1 FROM shares s WHERE s.conversation_id = cv.id) AS shared
       FROM conversations cv JOIN users u ON u.id = cv.user_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY cv.updated_at DESC LIMIT 300`,
    )
    .all(...params) as {
    id: string;
    title: string;
    updated_at: string;
    deleted_at: string | null;
    email: string;
    message_count: number;
    shared: number;
  }[];
  // How many declined replies wait for review, for the "Declined" switch. Counts only, no content.
  const toReview = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
       WHERE ${DECLINED_SQL} AND m.reviewed_at IS NULL${userId ? " AND cv.user_id = ?" : ""}`,
    )
    .get(...(userId ? [Number(userId)] : [])) as { n: number };
  return c.json({
    declinedToReview: toReview.n,
    conversations: rows.map((r) => ({
      id: r.id,
      title: r.title,
      email: r.email,
      messageCount: r.message_count,
      updatedAt: r.updated_at,
      deletedByUser: !!r.deleted_at,
      shared: !!r.shared,
    })),
  });
});

adminRoutes.get("/conversations/:id", (c) => {
  const conv = getConversation(c.req.param("id"));
  if (!conv) return c.json({ error: "This chat doesn't exist" }, 404);
  const owner = db.prepare("SELECT email FROM users WHERE id = ?").get(conv.user_id) as { email: string };
  // Browsing another branch (?via=) of a chat already open isn't logged again. Opening it at a
  // declined reply (?at=, from the review list) is a fresh open: it's logged, on that reply's branch.
  const via = c.req.query("via");
  const at = c.req.query("at");
  if (!via) audit(c.var.user!.id, "view_conversation", `${owner.email}: ${conv.title}`);
  const declined = at
    ? (db
        .prepare(`${DECLINED_SELECT} WHERE m.id = ? AND m.conversation_id = ? AND ${DECLINED_SQL}`)
        .get(Number(at), conv.id) as DeclinedRow | undefined)
    : undefined;
  const branch = via ?? at;
  return c.json({
    declined: declined ? declinedOut(declined) : null,
    conversation: {
      id: conv.id,
      title: conv.title,
      email: owner.email,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      deletedByUser: !!conv.deleted_at,
      shared: !!db.prepare("SELECT 1 FROM shares WHERE conversation_id = ?").get(conv.id),
    },
    messages: viewPath(conv, branch ? Number(branch) : undefined),
  });
});

adminRoutes.delete("/conversations/:id", (c) => {
  const conv = getConversation(c.req.param("id"));
  if (!conv) return c.json({ error: "This chat doesn't exist" }, 404);
  // Its files go with it: the ones replies made and the ones people attached.
  purgeConversations([conv.id]);
  audit(c.var.user!.id, "delete_conversation", conv.title);
  return c.json({ ok: true });
});

// ── Declined replies: what the AI refused, reviewable without reading every chat ──

type DeclinedRow = {
  id: number;
  conversation_id: string;
  provider: string | null;
  model: string | null;
  declined_by: string | null;
  created_at: string;
  reviewed_at: string | null;
  reviewer: string | null;
  prompt: string | null;
  email: string;
  title: string;
  deleted_at: string | null;
};

const DECLINED_SELECT = `SELECT m.id, m.conversation_id, m.provider, m.model, m.declined_by, m.created_at, m.reviewed_at,
    r.email AS reviewer, p.text AS prompt, u.email, cv.title, cv.deleted_at
  FROM messages m
  JOIN conversations cv ON cv.id = m.conversation_id
  JOIN users u ON u.id = cv.user_id
  LEFT JOIN messages p ON p.id = m.parent_id
  LEFT JOIN users r ON r.id = m.reviewed_by`;

function declinedOut(r: DeclinedRow) {
  // Refused outright: the reply's own model gave no answer. Otherwise one Claude model declined
  // and the reply's model answered in its place.
  const answered = r.declined_by != null;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    title: r.title,
    email: r.email,
    prompt: r.prompt ?? "",
    declinedBy: answered ? modelLabel("anthropic", r.declined_by) : modelLabel(r.provider, r.model),
    answeredBy: answered ? modelLabel(r.provider, r.model) : null,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    reviewer: r.reviewed_at ? r.reviewer ?? "Deleted account" : null,
    deletedByUser: !!r.deleted_at,
  };
}

adminRoutes.get("/declined", (c) => {
  const userId = c.req.query("userId");
  // Waiting ones first, newest first in each part.
  const rows = db
    .prepare(
      `${DECLINED_SELECT} WHERE ${DECLINED_SQL}${userId ? " AND cv.user_id = ?" : ""}
       ORDER BY m.reviewed_at IS NOT NULL, m.id DESC LIMIT 300`,
    )
    .all(...(userId ? [Number(userId)] : [])) as DeclinedRow[];
  // The list shows what people wrote, so looking at it is logged like opening a chat.
  if (rows.length) {
    const n = `${rows.length} ${rows.length === 1 ? "message" : "messages"}`;
    audit(c.var.user!.id, "view_declined", userId ? `${rows[0].email}: ${n}` : n);
  }
  return c.json({ declined: rows.map(declinedOut) });
});

adminRoutes.post("/declined/review", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger).slice(0, 500) : [];
  if (!ids.length) return c.json({ error: "Choose at least one message" }, 400);
  const reviewed = body.reviewed !== false;
  const at = reviewed ? nowIso() : null;
  const by = reviewed ? c.var.user!.id : null;
  const mark = db.prepare(`UPDATE messages AS m SET reviewed_at = ?, reviewed_by = ? WHERE m.id = ? AND ${DECLINED_SQL}`);
  const changed = tx(() => ids.reduce((n, id) => n + Number(mark.run(at, by, id).changes), 0));
  if (!changed) return c.json({ error: "Those messages aren't declined replies" }, 404);
  return c.json({ reviewedAt: at, reviewer: reviewed ? c.var.user!.email : null });
});

// ── Overview: the admin home, at a glance ──────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** What caching saved at list prices: cheaper reads, less the extra paid to write the cache. */
function cacheSaving(m: { input: number; cacheRead: number; cacheWrite: number }, read: number, write: number) {
  return (read * (m.input - m.cacheRead) - write * (m.cacheWrite - m.input)) / 1_000_000;
}

/** Days of token volume the overview charts; the headline counts the last 7. */
const VOLUME_DAYS = 14;

adminRoutes.get("/overview", (c) => {
  const monthStart = startOfMonthIso();
  const weekAgo = new Date(Date.now() - 7 * DAY_MS).toISOString();

  const month = db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS replies FROM usage_events WHERE created_at >= ?")
    .get(monthStart) as { cost: number; replies: number };

  const people = db
    .prepare(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS joined,
         (SELECT COUNT(DISTINCT user_id) FROM usage_events WHERE created_at >= ?) AS active
       FROM users`,
    )
    .get(monthStart, monthStart) as { total: number; joined: number | null; active: number };

  // Prompt caching over the last 7 days: the share of input read from the cache, and what it
  // saved at list prices (cheaper reads, less the extra paid to write the cache).
  const caching = db
    .prepare(
      `SELECT provider, model, SUM(input_tokens) AS input, SUM(cache_read_tokens) AS read, SUM(cache_write_tokens) AS write
       FROM usage_events WHERE created_at >= ? GROUP BY provider, model`,
    )
    .all(weekAgo) as { provider: string; model: string; input: number; read: number; write: number }[];
  let read = 0;
  let allInput = 0;
  let saved = 0;
  for (const r of caching) {
    read += r.read;
    allInput += r.input + r.read + r.write;
    const m = findModel(r.provider, r.model);
    if (m) saved += cacheSaving(m, r.read, r.write);
  }

  // Per day in the server's local time, oldest first, empty days included: tokens for the volume
  // chart, and cost, people and the caching saving for the trend lines on the cards above it.
  const since = new Date(Date.now() - (VOLUME_DAYS - 1) * DAY_MS);
  since.setHours(0, 0, 0, 0);
  type DayRow = { day: string; tokens: number; cost: number; people: number };
  const byDay = new Map(
    (
      db
        .prepare(
          `SELECT date(created_at, 'localtime') AS day,
             SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
             SUM(cost_usd) AS cost, COUNT(DISTINCT user_id) AS people
           FROM usage_events WHERE created_at >= ? GROUP BY day`,
        )
        .all(since.toISOString()) as DayRow[]
    ).map((r) => [r.day, r]),
  );
  // The saving is priced per model, so it's summed in here rather than in SQL. A quiet day saves
  // nothing, so the line runs along the baseline instead of breaking off.
  const savedByDay = new Map<string, number>();
  const cacheByDay = db
    .prepare(
      `SELECT date(created_at, 'localtime') AS day, provider, model, SUM(cache_read_tokens) AS read, SUM(cache_write_tokens) AS write
       FROM usage_events WHERE created_at >= ? GROUP BY day, provider, model`,
    )
    .all(since.toISOString()) as { day: string; provider: string; model: string; read: number; write: number }[];
  for (const r of cacheByDay) {
    const m = findModel(r.provider, r.model);
    if (m) savedByDay.set(r.day, (savedByDay.get(r.day) ?? 0) + cacheSaving(m, r.read, r.write));
  }
  const volume = Array.from({ length: VOLUME_DAYS }, (_, i) => {
    const d = new Date(since.getTime() + i * DAY_MS);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const r = byDay.get(day);
    return {
      day,
      tokens: r?.tokens ?? 0,
      cost: r?.cost ?? 0,
      people: r?.people ?? 0,
      saved: savedByDay.get(day) ?? 0,
    };
  });

  const keys = db
    .prepare(
      `SELECT k.id, k.label, k.provider, k.model, k.effort, k.is_default, k.shared, k.web_search, k.models, k.endpoint,
         (SELECT COUNT(*) FROM user_keys uk WHERE uk.api_key_id = k.id) AS granted,
         (SELECT COUNT(*) FROM usage_events e WHERE e.api_key_id = k.id AND e.created_at >= ?) AS replies
       FROM api_keys k ORDER BY k.is_default DESC, k.created_at`,
    )
    .all(monthStart) as {
    id: number;
    label: string;
    provider: string;
    model: string;
    effort: string;
    is_default: number;
    shared: number;
    web_search: number;
    models: string | null;
    endpoint: string | null;
    granted: number;
    replies: number;
  }[];

  const settings = getSettings();
  const lastAudit = db
    .prepare("SELECT action, created_at FROM audit_log ORDER BY id DESC LIMIT 1")
    .get() as { action: string; created_at: string } | undefined;

  return c.json({
    spend: { cost: month.cost, replies: month.replies, monthStart },
    people: { total: people.total, joined: people.joined ?? 0, active: people.active, allowSignup: settings.allowSignup },
    caching: { hitRate: allInput ? read / allInput : null, saved },
    volume,
    models: keys.map((k) => ({
      id: k.id,
      label: k.label,
      provider: k.provider,
      model: k.model,
      modelLabel: keyModelLabel(k, k.model),
      providerLabel: providerLabelOf(k),
      modelCount: allowedModels(k).length,
      effortLabel: EFFORT_LABELS[k.effort] ?? k.effort,
      isDefault: !!k.is_default,
      everyone: !!k.shared || !!k.is_default,
      granted: k.granted,
      webSearch: !!k.web_search,
      replies: k.replies,
    })),
    shortcuts: {
      declinedToReview: (
        db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${DECLINED_SQL} AND m.reviewed_at IS NULL`).get() as { n: number }
      ).n,
      shared: (db.prepare("SELECT COUNT(*) AS n FROM shares").get() as { n: number }).n,
      sharing: settings.sharing,
      lastAudit: lastAudit ? { action: lastAudit.action, createdAt: lastAudit.created_at } : null,
    },
  });
});

// ── Usage ───────────────────────────────────────────────────────────

adminRoutes.get("/usage", (c) => {
  const range = c.req.query("range") ?? "month";
  const since =
    range === "all" ? "" : range === "30d" ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() : startOfMonthIso();

  const totals = `COUNT(*) AS replies, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
    SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(web_searches) AS searches,
    SUM(cost_usd) AS cost`;
  const byUser = db
    .prepare(
      `SELECT COALESCE(u.email, 'Deleted account') AS name, ${totals}
       FROM usage_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.created_at >= ? GROUP BY e.user_id ORDER BY cost DESC`,
    )
    .all(since);
  const byKey = db
    .prepare(
      `SELECT e.key_label AS name, e.provider,
         (SELECT e2.model FROM usage_events e2 WHERE e2.api_key_id IS e.api_key_id AND e2.key_label = e.key_label
          ORDER BY e2.id DESC LIMIT 1) AS model,
         ${totals}
       FROM usage_events e WHERE e.created_at >= ? GROUP BY e.api_key_id, e.key_label ORDER BY cost DESC`,
    )
    .all(since) as { provider: string; model: string | null }[];
  return c.json({
    byUser,
    byKey: byKey.map((k) => ({ ...k, modelLabel: k.model ? modelLabel(k.provider, k.model) : null })),
    series: usageSeries(range, since),
  });
});

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localMonth = (d: Date) => localDay(d).slice(0, 7);

/**
 * The period over time, in the server's local time with empty days included: by day, or by month
 * when "all time" spans more than two months. Tokens are split by what they cost: read from the
 * cache (cheap), sent fresh (input and cache writes), and written by the model.
 */
function usageSeries(range: string, since: string) {
  const now = new Date();
  let start: Date;
  if (range === "30d") start = new Date(now.getTime() - 29 * DAY_MS);
  else if (range === "all") {
    const first = (db.prepare("SELECT MIN(created_at) AS t FROM usage_events").get() as { t: string | null }).t;
    start = first ? new Date(first) : now;
  } else start = new Date(now.getFullYear(), now.getMonth(), 1);
  start.setHours(0, 0, 0, 0);
  const unit: "day" | "month" = range === "all" && now.getTime() - start.getTime() > 62 * DAY_MS ? "month" : "day";

  const bucketSql = unit === "day" ? "date(created_at, 'localtime')" : "strftime('%Y-%m', created_at, 'localtime')";
  const rows = db
    .prepare(
      `SELECT ${bucketSql} AS bucket, SUM(cost_usd) AS cost, COUNT(*) AS replies, SUM(cache_read_tokens) AS cached,
         SUM(input_tokens + cache_write_tokens) AS sent, SUM(output_tokens) AS written
       FROM usage_events WHERE created_at >= ? GROUP BY bucket`,
    )
    .all(since) as { bucket: string; cost: number; replies: number; cached: number; sent: number; written: number }[];
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));

  const keys: string[] = [];
  const cursor = new Date(start);
  if (unit === "day") {
    for (; cursor <= now; cursor.setDate(cursor.getDate() + 1)) keys.push(localDay(cursor));
  } else {
    cursor.setDate(1);
    for (; cursor <= now; cursor.setMonth(cursor.getMonth() + 1)) keys.push(localMonth(cursor));
  }
  return {
    unit,
    buckets: keys.map((key) => {
      const r = byBucket.get(key);
      return { key, cost: r?.cost ?? 0, replies: r?.replies ?? 0, cached: r?.cached ?? 0, sent: r?.sent ?? 0, written: r?.written ?? 0 };
    }),
  };
}

// ── Settings and audit log ──────────────────────────────────────────

/** A dollar amount from a form: null for empty, undefined when it isn't one. Kept to the cent. */
function parseDollars(value: unknown): number | null | undefined {
  if (value === null || value === "") return null;
  const n = Number(typeof value === "string" ? value.replace(/^\s*\$|[,\s]/g, "") : value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_DOLLARS) return undefined;
  return Math.round(n * 100) / 100;
}

adminRoutes.get("/settings", (c) => c.json({ settings: getSettings(), mail: mailMode }));

adminRoutes.patch("/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const next: Partial<Settings> = {};
  if (body.allowSignup !== undefined) next.allowSignup = !!body.allowSignup;
  if (body.signupCode !== undefined) next.signupCode = body.signupCode === null ? null : !!body.signupCode;
  if (body.sharing !== undefined) {
    const mode = SHARING_MODES.find((m) => m === body.sharing);
    if (!mode) return c.json({ error: "Choose who can open shared links" }, 400);
    next.sharing = mode;
  }
  if (body.showThinking !== undefined) next.showThinking = !!body.showThinking;
  if (body.bonusDomains !== undefined) {
    // One per line or a list; "@school.edu" and "*.school.edu" mean the same as "school.edu".
    const raw: unknown[] = Array.isArray(body.bonusDomains) ? body.bonusDomains : String(body.bonusDomains).split(/[\s,]+/);
    const domains = [...new Set(raw.map((d) => String(d).trim().toLowerCase().replace(/^(\*\.|@)/, "").replace(/\.$/, "")).filter(Boolean))];
    const bad = domains.find((d) => !DOMAIN_RE.test(d));
    if (bad) return c.json({ error: `“${bad}” isn't a domain. Write it like example.edu` }, 400);
    if (domains.length > 100) return c.json({ error: "List at most 100 domains" }, 400);
    next.bonusDomains = domains;
  }
  if (body.bonusTokens !== undefined) {
    const tokens = body.bonusTokens === null || body.bonusTokens === "" ? null : Number(body.bonusTokens);
    if (tokens !== null && (!Number.isInteger(tokens) || tokens < 0 || tokens > 1e12)) {
      return c.json({ error: "Extra tokens must be a whole number, or empty for none" }, 400);
    }
    next.bonusTokens = tokens || null;
  }
  if (body.bonusSpend !== undefined) {
    const spend = parseDollars(body.bonusSpend);
    if (spend === undefined) return c.json({ error: "Enter the extra spending in dollars, or leave it empty for none" }, 400);
    next.bonusSpend = spend || null;
  }
  if (body.spendLimit !== undefined) {
    const spend = parseDollars(body.spendLimit);
    if (spend === undefined) return c.json({ error: "Enter the spending limit in dollars, like 5 or 2.50, or leave it empty for none" }, 400);
    next.spendLimit = spend;
  }
  if (body.bonusKeyIds !== undefined) {
    const ids = Array.isArray(body.bonusKeyIds) ? body.bonusKeyIds.map(Number) : [];
    const known = new Set((db.prepare("SELECT id FROM api_keys").all() as { id: number }[]).map((k) => k.id));
    if (ids.some((id: number) => !known.has(id))) return c.json({ error: "One of those models no longer exists" }, 400);
    next.bonusKeyIds = [...new Set<number>(ids)];
  }
  if (body.systemPrompt !== undefined) {
    const prompt = String(body.systemPrompt).trim();
    if (prompt.length > 20_000) return c.json({ error: "The instructions are too long" }, 400);
    next.systemPrompt = prompt;
  }
  if (body.memory !== undefined) next.memory = !!body.memory;
  if (body.privacyNotice !== undefined) next.privacyNotice = !!body.privacyNotice;
  // Days to keep chats: a whole number, or empty to keep them for good.
  for (const field of ["retainChatsDays", "retainDeletedDays"] as const) {
    if (body[field] === undefined) continue;
    const raw = body[field];
    const n = raw === null || raw === "" ? null : Number(raw);
    if (n !== null && (!Number.isInteger(n) || n < (field === "retainChatsDays" ? 1 : 0) || n > 36500)) {
      return c.json({ error: field === "retainChatsDays" ? "Keep chats for at least a day, or for good" : "Enter a number of days, 0 or more, or leave it empty" }, 400);
    }
    next[field] = n;
  }
  // Devices one account can be signed in on: a whole number, or empty for no limit.
  if (body.maxSessions !== undefined) {
    const n = body.maxSessions === null || body.maxSessions === "" ? null : Number(body.maxSessions);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 100)) {
      return c.json({ error: "Allow from 1 to 100 devices for each account, or leave it empty for no limit" }, 400);
    }
    next.maxSessions = n;
  }
  saveSettings(next);
  // A lower limit signs people out of their devices used longest ago now, not at their next sign-in.
  if (next.maxSessions != null) keepEveryoneWithinLimit(c.var.sessionId);
  // A shorter time to keep chats takes effect now, not at the next hourly pass.
  if (next.retainChatsDays !== undefined || next.retainDeletedDays !== undefined) enforceRetention();
  audit(c.var.user!.id, "edit_settings");
  return c.json({ settings: getSettings(), mail: mailMode });
});

adminRoutes.get("/audit", (c) => {
  const rows = db
    .prepare(
      `SELECT a.id, a.action, a.target, a.created_at, COALESCE(u.email, 'Deleted account') AS admin
       FROM audit_log a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT 100`,
    )
    .all() as { id: number; action: string; target: string | null; created_at: string; admin: string }[];
  return c.json({ entries: rows.map((r) => ({ id: r.id, action: r.action, target: r.target, createdAt: r.created_at, admin: r.admin })) });
});
