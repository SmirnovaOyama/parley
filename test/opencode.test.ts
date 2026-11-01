// OpenCode (server/providers/opencode.ts), its dialect of OpenAI's chat format on both its plans,
// against a mock of its API. The mock stands at a local address; clients.test.ts checks that keys go
// to opencode.ai itself.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { compatProvider } from "../server/providers/compat.ts";
import { opencodeDialect, opencodeGoDialect } from "../server/providers/opencode.ts";
import type { ChatRequest } from "../server/providers/types.ts";
import { chatRequest } from "./helpers/chat.ts";
import { chunk, completionStream, json, mockServer, modelList, usageChunk, type Received, type Reply } from "./helpers/mock-server.ts";

/** OpenCode set up as it is, with its two addresses at a mock that answers as `handle` says. */
async function opencode(t: TestContext, handle: (req: Received) => Reply) {
  const api = await mockServer(handle);
  t.after(() => api.close());
  const provider = compatProvider({ ...opencodeDialect, baseURL: `${api.url}/inference/openai/v1`, modelsBaseURL: `${api.url}/inference/v1` });
  return { api, provider };
}

/** Its Go plan the same way, at Go's two addresses. */
async function go(t: TestContext, handle: (req: Received) => Reply) {
  const api = await mockServer(handle);
  t.after(() => api.close());
  const provider = compatProvider({ ...opencodeGoDialect, baseURL: `${api.url}/inference/go/openai/v1`, modelsBaseURL: `${api.url}/inference/go/v1` });
  return { api, provider };
}

/** A whole answer to a one-off request, such as naming a chat. */
const completion = json({
  id: "c",
  object: "chat.completion",
  created: 0,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "Weekend plans", refusal: null }, finish_reason: "stop" }],
});

/** One reply streamed from these chunks, and the request that asked for it. */
async function reply(t: TestContext, chunks: unknown[], overrides: Partial<ChatRequest>) {
  const { api, provider } = await opencode(t, () => completionStream(chunks));
  const { req, seen } = chatRequest({ apiKey: "oc_sk_test", ...overrides });
  const result = await provider.chat(req);
  return { result, seen, sent: api.requests[0] };
}

describe("opencode: chatting", () => {
  test("sends the chat's session and its thinking level", async (t) => {
    const { result, sent } = await reply(t, [chunk({ content: "Hi" }, "stop")], { model: "kimi-k3", effort: "high", cacheKey: "chat-1" });
    assert.equal(result.text, "Hi");
    assert.equal(sent.path, "/inference/openai/v1/chat/completions");
    assert.equal(sent.headers.authorization, "Bearer oc_sk_test");
    assert.equal(sent.headers["x-opencode-session"], "chat-1");
    assert.equal(sent.body.reasoning_effort, "high");
    // OpenCode picks how long a reply can be, model by model.
    assert.equal(sent.body.max_tokens, undefined);
  });

  test("turns thinking off as none, and leaves it alone where it can't be set", async (t) => {
    const off = await reply(t, [chunk({ content: "Hi" }, "stop")], { model: "mistral-large-4", effort: "off" });
    assert.equal(off.sent.body.reasoning_effort, "none");
    const fixed = await reply(t, [chunk({ content: "Hi" }, "stop")], { model: "minimax-m3", effort: "default" });
    assert.equal("reasoning_effort" in fixed.sent.body, false);
  });

  test("says it's Parley, by name and version, to the chat and the model list alike", async (t) => {
    const { api, provider } = await opencode(t, (req) => (req.method === "GET" ? modelList(["glm-5.3"]) : completionStream([chunk({ content: "Hi" }, "stop")])));
    await provider.chat(chatRequest({ apiKey: "oc_sk_test", model: "glm-5.3", effort: "low" }).req);
    await provider.verify("oc_sk_test", "glm-5.3");
    assert.equal(api.requests.length, 2);
    for (const r of api.requests) assert.match(r.headers["user-agent"] ?? "", /^Parley\/\d+\.\d+\.\d+$/);
  });

  test("sends no session without a chat to tie it to", async (t) => {
    const { sent } = await reply(t, [chunk({ content: "Hi" }, "stop")], { model: "glm-5.3", effort: "low" });
    assert.equal(sent.headers["x-opencode-session"], undefined);
  });

  test("shows the reasoning OpenCode sends as reasoning_content", async (t) => {
    const { result, seen } = await reply(t, [chunk({ reasoning_content: "Weighing it" }), chunk({ content: "Yes" }, "stop")], {
      model: "deepseek-v4.1-flash",
      effort: "low",
    });
    assert.equal(seen.thinking, "Weighing it");
    assert.equal(result.text, "Yes");
  });

  test("counts usage as OpenCode billed it, cache writes included", async (t) => {
    const { result } = await reply(
      t,
      [
        chunk({ content: "Hi" }, "stop"),
        usageChunk({
          prompt_tokens: 9200,
          completion_tokens: 300,
          cost: 0.0123,
          opencode: {
            billing_source: "balance",
            list_cost: 0.0123,
            tokens: { input: 200, output: 300, reasoning: 120, cache_read: 8000, cache_write_5m: 900, cache_write_1h: 100 },
          },
        }),
      ],
      { model: "claude-sonnet-5-5", effort: "low" },
    );
    assert.deepEqual(result.usage, { input: 200, output: 300, cacheRead: 8000, cacheWrite: 1000 });
    assert.equal(result.contextTokens, 9500);
  });
});

describe("opencode: tools", () => {
  const knowledge = { name: "search_knowledge", description: "Search the documents", parameters: { type: "object", properties: {} } };

  /** A reply that reasons, asks for a tool, then answers; and the second request, which carries the turn back. */
  async function toolTurn(t: TestContext, model: string, setup = opencode) {
    const { api, provider } = await setup(t, () =>
      completionStream(
        api.requests.length === 1
          ? [
              chunk({ reasoning_content: "I should look it up" }),
              chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search_knowledge", arguments: "{}" } }] }),
              chunk({}, "tool_calls"),
            ]
          : [chunk({ content: "Found it" }, "stop")],
      ),
    );
    const { req } = chatRequest({ apiKey: "oc_sk_test", model, effort: "low", functions: [knowledge], runTool: async () => ({ content: "A result" }) });
    const result = await provider.chat(req);
    assert.equal(result.text, "Found it");
    return api.requests[1].body.messages.find((m: { tool_calls?: unknown }) => m.tool_calls);
  }

  test("gives an open model its reasoning back with the tool call", async (t) => {
    assert.equal((await toolTurn(t, "kimi-k3")).reasoning_content, "I should look it up");
  });

  test("leaves the reasoning out for a model OpenCode translates", async (t) => {
    assert.equal("reasoning_content" in (await toolTurn(t, "claude-sonnet-5-5")), false);
  });

  test("on Go, gives its own open models their reasoning back, but not MiniMax M3, which Go translates", async (t) => {
    assert.equal((await toolTurn(t, "kimi-k3.1-pro", go)).reasoning_content, "I should look it up");
    assert.equal("reasoning_content" in (await toolTurn(t, "minimax-m3", go)), false);
  });
});

describe("opencode: one-off answers", () => {
  test("think as little as each model allows", async (t) => {
    const { api, provider } = await opencode(t, () => completion);
    for (const model of ["claude-haiku-5-5", "gpt-6-luna", "deepseek-v4-pro", "minimax-m3"]) {
      await provider.complete({ apiKey: "oc_sk_test", model, system: "Name it.", prompt: "Chat" });
    }
    assert.deepEqual(
      api.requests.map((r) => r.body.reasoning_effort),
      ["low", "none", "high", undefined],
    );
  });
});

describe("opencode: checking a key", () => {
  test("looks for the model in the list a level up from the chat", async (t) => {
    const { api, provider } = await opencode(t, () => modelList(["glm-5.3", "kimi-k3"]));
    await provider.verify("oc_sk_check", "kimi-k3");
    assert.deepEqual(
      api.requests.map((r) => `${r.method} ${r.path} ${r.headers.authorization}`),
      ["GET /inference/v1/models Bearer oc_sk_check"],
    );
  });

  test("turns down a key the list refuses, without asking a model", async (t) => {
    const { api, provider } = await opencode(t, () => json({ error: { type: "server_error", message: "Invalid credential" } }, 401));
    await assert.rejects(provider.verify("oc_sk_bad", "kimi-k3"), { status: 401 });
    assert.equal(api.requests.length, 1);
  });

  test("says what the key offers when the model isn't in its list", async (t) => {
    const { provider } = await opencode(t, () => modelList(["glm-5.3"]));
    await assert.rejects(provider.verify("oc_sk_check", "kimi-k3"), { message: "This key can't use kimi-k3. It offers glm-5.3" });
  });
});

describe("opencode go", () => {
  test("ties every chat to a session at Go's address, the chat's own or one made for it", async (t) => {
    const { api, provider } = await go(t, () => completionStream([chunk({ content: "Hi" }, "stop")]));
    await provider.chat(chatRequest({ apiKey: "oc_sk_go", model: "glm-5.3-flash", effort: "low", cacheKey: "chat-7" }).req);
    await provider.chat(chatRequest({ apiKey: "oc_sk_go", model: "glm-5.3-flash", effort: "low" }).req);
    assert.deepEqual(api.requests.map((r) => r.path), ["/inference/go/openai/v1/chat/completions", "/inference/go/openai/v1/chat/completions"]);
    assert.equal(api.requests[0].headers["x-opencode-session"], "chat-7");
    // Go turns away a request with no session, so a reply outside a chat gets one of its own.
    assert.match(String(api.requests[1].headers["x-opencode-session"]), /^[0-9a-f-]{36}$/);
  });

  test("names a chat under the chat's session, thinking as little as each model allows", async (t) => {
    const { api, provider } = await go(t, () => completion);
    for (const model of ["kimi-k3.1-pro", "kimi-k3", "gpt-6-luna", "minimax-m3"]) {
      await provider.complete({ apiKey: "oc_sk_go", model, system: "Name it.", prompt: "Chat", cacheKey: "chat-7" });
    }
    assert.deepEqual(
      api.requests.map((r) => r.headers["x-opencode-session"]),
      ["chat-7", "chat-7", "chat-7", "chat-7"],
    );
    // On Go, Kimi K3 thinks only at its most.
    assert.deepEqual(
      api.requests.map((r) => r.body.reasoning_effort),
      ["low", "max", "none", undefined],
    );
  });

  test("checks a key against Go's own model list", async (t) => {
    const { api, provider } = await go(t, () => modelList(["glm-5.3-flash", "kimi-k3.1-pro"]));
    await provider.verify("oc_sk_go", "kimi-k3.1-pro");
    assert.deepEqual(
      api.requests.map((r) => `${r.method} ${r.path} ${r.headers.authorization}`),
      ["GET /inference/go/v1/models Bearer oc_sk_go"],
    );
  });
});
