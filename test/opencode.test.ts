// OpenCode (server/providers/opencode.ts), its dialect of OpenAI's chat format, against a mock of its
// API. The mock stands at a local address; clients.test.ts checks that keys go to opencode.ai itself.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { compatProvider } from "../server/providers/compat.ts";
import { opencodeDialect } from "../server/providers/opencode.ts";
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
  async function toolTurn(t: TestContext, model: string) {
    const { api, provider } = await opencode(t, () =>
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
});

describe("opencode: one-off answers", () => {
  const completion = json({
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "Weekend plans", refusal: null }, finish_reason: "stop" }],
  });

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
