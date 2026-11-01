// A key goes only to its provider's own address (server/providers/clients.ts), whatever the
// environment says: the SDKs would otherwise follow ANTHROPIC_BASE_URL or OPENAI_BASE_URL to a
// reverse proxy, and send ANTHROPIC_AUTH_TOKEN or OPENAI_ORG_ID along with the key.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { anthropicProvider } from "../server/providers/anthropic.ts";
import { deepseekProvider } from "../server/providers/deepseek.ts";
import { openaiProvider } from "../server/providers/openai.ts";
import { opencodeProvider } from "../server/providers/opencode.ts";
import { json, mockServer } from "./helpers/mock-server.ts";

// The address the environment points at, listening for whatever is sent there.
const relay = await mockServer(() => json({ error: { message: "Caught" } }, 401));
process.env.ANTHROPIC_BASE_URL = relay.url;
process.env.OPENAI_BASE_URL = `${relay.url}/v1`;
process.env.ANTHROPIC_AUTH_TOKEN = "someone-elses-token";
process.env.OPENAI_ORG_ID = "org-someone-else";
process.env.OPENAI_PROJECT_ID = "proj-someone-else";

// The providers' own addresses, answered here; the relay (on this machine) is still reachable.
const real = getGlobalDispatcher();
const agent = new MockAgent();
agent.disableNetConnect();
agent.enableNetConnect(new URL(relay.url).host);
setGlobalDispatcher(agent);
after(async () => {
  setGlobalDispatcher(real);
  await agent.close();
  await relay.close();
});

type Seen = { origin: string; path: string; headers: Record<string, string> };
const seen: Seen[] = [];

/** Answers `path` at `origin` with `body`, noting the request's headers (lower-cased). */
function answer(origin: string, path: string, body: unknown) {
  agent
    .get(origin)
    .intercept({ path, method: "GET" })
    .reply((req) => {
      const raw = req.headers;
      const pairs: [string, string][] = Array.isArray(raw)
        ? raw.reduce<[string, string][]>((all, v, i, list) => (i % 2 ? all : [...all, [String(v), String(list[i + 1])]]), [])
        : Object.entries((raw ?? {}) as Record<string, string>);
      seen.push({ origin, path, headers: Object.fromEntries(pairs.map(([k, v]) => [k.toLowerCase(), v])) });
      return { statusCode: 200, data: JSON.stringify(body), responseOptions: { headers: { "content-type": "application/json" } } };
    });
}

test("Claude's key goes to api.anthropic.com alone, without the environment's token", async () => {
  answer("https://api.anthropic.com", "/v1/models/claude-test", { type: "model", id: "claude-test", display_name: "Test", created_at: "2026-01-01T00:00:00Z" });
  await anthropicProvider.verify("sk-ant-test", "claude-test");
  const req = seen.find((s) => s.origin === "https://api.anthropic.com");
  assert.ok(req, "the request reached Anthropic");
  assert.equal(req.headers["x-api-key"], "sk-ant-test");
  assert.equal(req.headers.authorization, undefined);
  assert.equal(relay.requests.length, 0);
});

test("OpenAI's key goes to api.openai.com alone, without the environment's organization", async () => {
  answer("https://api.openai.com", "/v1/models", { object: "list", data: [{ id: "gpt-test", object: "model", created: 0, owned_by: "openai" }] });
  await openaiProvider.verify("sk-test", "gpt-test");
  const req = seen.find((s) => s.origin === "https://api.openai.com");
  assert.ok(req, "the request reached OpenAI");
  assert.equal(req.headers.authorization, "Bearer sk-test");
  assert.equal(req.headers["openai-organization"], undefined);
  assert.equal(req.headers["openai-project"], undefined);
  assert.equal(relay.requests.length, 0);
});

test("A service in OpenAI's format gets no OpenAI organization either", async () => {
  answer("https://api.deepseek.com", "/models", { object: "list", data: [{ id: "deepseek-test", object: "model", created: 0, owned_by: "deepseek" }] });
  await deepseekProvider.verify("sk-ds-test", "deepseek-test");
  const req = seen.find((s) => s.origin === "https://api.deepseek.com");
  assert.ok(req, "the request reached DeepSeek");
  assert.equal(req.headers["openai-organization"], undefined);
  assert.equal(relay.requests.length, 0);
});

test("OpenCode's key goes to opencode.ai alone, where it lists its models", async () => {
  answer("https://opencode.ai", "/inference/v1/models", { object: "list", data: [{ id: "kimi-k3", object: "model", created: 0, owned_by: "opencode" }] });
  await opencodeProvider.verify("oc_sk_test", "kimi-k3");
  const req = seen.find((s) => s.origin === "https://opencode.ai");
  assert.ok(req, "the request reached OpenCode");
  assert.equal(req.headers.authorization, "Bearer oc_sk_test");
  assert.equal(req.headers["openai-organization"], undefined);
  assert.equal(relay.requests.length, 0);
});
