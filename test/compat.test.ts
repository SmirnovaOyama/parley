// The OpenAI chat-completions dialects (server/providers/compat.ts), against a mock service. Most
// tests use "Another service" (custom.ts), which takes its address from the key.
import assert from "node:assert/strict";
import { after, describe, test, type TestContext } from "node:test";
import { compatProvider, type Dialect } from "../server/providers/compat.ts";
import { customProvider } from "../server/providers/custom.ts";
import type { ChatRequest } from "../server/providers/types.ts";
import { chatRequest, fileFolder, PNG, turn } from "./helpers/chat.ts";
import { chunk, completionStream, json, mockServer, modelList, usageChunk, type Received, type Reply } from "./helpers/mock-server.ts";

const files = fileFolder();
after(files.remove);

/** A mock service for one test, closed when the test ends. */
async function service(t: TestContext, handle: (req: Received) => Reply) {
  const api = await mockServer(handle);
  t.after(() => api.close());
  return api;
}

/** One streamed reply from a service sending these chunks, and what the provider made of it. */
async function reply(t: TestContext, chunks: unknown[], overrides: Partial<ChatRequest> = {}, provider = customProvider) {
  const api = await service(t, () => completionStream(chunks));
  const { req, seen } = chatRequest({ baseUrl: `${api.url}/v1`, ...overrides });
  const result = await provider.chat(req);
  return { result, seen, sent: api.requests[0].body };
}

/** A dialect like custom.ts, with the parts a test changes. */
const dialect = (parts: Partial<Dialect>) =>
  compatProvider({ baseURL: null, thinking: () => ({}), quick: () => ({}), systemMidChat: false, thinkTags: true, ...parts });

describe("compat: streaming a reply", () => {
  test("streams the answer and sends the conversation", async (t) => {
    const { result, seen, sent } = await reply(t, [
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({}, "stop"),
    ]);
    assert.equal(seen.text, "Hello");
    assert.deepEqual(seen.statuses, ["writing"]);
    assert.equal(result.text, "Hello");
    assert.equal(result.thinking, "");
    assert.equal(result.stopReason, "stop");
    assert.equal(result.refused, false);
    assert.equal(result.model, "test-model");
    assert.equal(sent.model, "test-model");
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.stream_options, { include_usage: true });
    assert.deepEqual(sent.messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ]);
    // Another service gets nothing beyond the common core: no length limit, no thinking setting.
    assert.equal(sent.max_tokens, undefined);
  });

  test("reads reasoning sent as reasoning_content", async (t) => {
    const { result, seen } = await reply(t, [
      chunk({ reasoning_content: "Weighing " }),
      chunk({ reasoning_content: "it up." }),
      chunk({ reasoning_content: null, content: "Done." }),
      chunk({}, "stop"),
    ]);
    assert.equal(seen.thinking, "Weighing it up.");
    assert.equal(result.thinking, "Weighing it up.");
    assert.equal(result.text, "Done.");
    assert.deepEqual(seen.statuses, ["thinking", "writing"]);
  });

  test("reads reasoning sent as reasoning", async (t) => {
    const { result, seen } = await reply(t, [chunk({ reasoning: "Short think." }), chunk({ content: "Yes." }), chunk({}, "stop")]);
    assert.equal(seen.thinking, "Short think.");
    assert.equal(result.thinking, "Short think.");
    assert.equal(result.text, "Yes.");
  });

  test("keeps the reasoning to itself when thinking isn't shown", async (t) => {
    const { result, seen } = await reply(t, [chunk({ reasoning_content: "Private." }), chunk({ content: "Yes." })], { showThinking: false });
    assert.equal(seen.thinking, "");
    assert.equal(result.thinking, "");
    assert.deepEqual(seen.statuses, ["thinking", "writing"]);
  });

  test("splits <think> tags cut across chunks", async (t) => {
    const { result, seen } = await reply(t, [
      chunk({ content: " \n<thi" }),
      chunk({ content: "nk>Plan" }),
      chunk({ content: " the re" }),
      chunk({ content: "ply.</th" }),
      chunk({ content: "ink>\n\nThe answer" }),
      chunk({ content: " is 4." }),
      chunk({}, "stop"),
    ]);
    assert.equal(seen.thinking, "Plan the reply.");
    assert.equal(result.text, "The answer is 4.");
    assert.equal(seen.text, "The answer is 4.");
    assert.deepEqual(seen.statuses, ["thinking", "writing"]);
  });

  test("splits Gemini's <thought> tags", async (t) => {
    const { result, seen } = await reply(t, [chunk({ content: "<thought>" }), chunk({ content: "Looking closely" }), chunk({ content: "</thought>Answer" })]);
    assert.equal(seen.thinking, "Looking closely");
    assert.equal(result.text, "Answer");
  });

  test("leaves text that only starts like a tag alone", async (t) => {
    const { result, seen } = await reply(t, [chunk({ content: "<" }), chunk({ content: "b>Bold</b> move" })]);
    assert.equal(seen.thinking, "");
    assert.equal(result.text, "<b>Bold</b> move");
  });

  test("keeps thinking whose closing tag never came as thinking", async (t) => {
    const { result, seen } = await reply(t, [chunk({ content: "<think>Still go" }), chunk({ content: "ing" }), chunk({}, "length")]);
    assert.equal(seen.thinking, "Still going");
    assert.equal(result.text, "");
    assert.equal(result.stopReason, "length");
  });

  test("passes <think> tags through where the dialect doesn't split them", async (t) => {
    const { result } = await reply(t, [chunk({ content: "<think>x</think>y" })], {}, dialect({ thinkTags: false }));
    assert.equal(result.text, "<think>x</think>y");
  });

  test("reads Gemini's thought flag", async (t) => {
    const { result, seen } = await reply(t, [
      chunk({ content: "Considering the date.", extra_content: { google: { thought: true } } }),
      chunk({ content: "It's Friday." }),
    ]);
    assert.equal(seen.thinking, "Considering the date.");
    assert.equal(result.text, "It's Friday.");
  });

  test("reads Mistral's thinking chunks", async (t) => {
    const { result, seen } = await reply(t, [
      chunk({ content: [{ type: "thinking", thinking: [{ type: "text", text: "Checking " }, { type: "text", text: "units. " }] }] }),
      chunk({ content: [{ type: "thinking", thinking: "Metres." }] }),
      chunk({ content: [{ type: "text", text: "5 km." }] }),
    ]);
    assert.equal(seen.thinking, "Checking units. Metres.");
    assert.equal(result.text, "5 km.");
    assert.deepEqual(seen.statuses, ["thinking", "writing"]);
  });

  test("marks a filtered reply as refused", async (t) => {
    const { result } = await reply(t, [chunk({ content: "" }, "content_filter")]);
    assert.equal(result.refused, true);
    assert.equal(result.stopReason, "content_filter");
  });
});

describe("compat: usage", () => {
  const usageOf = async (t: TestContext, usage: Record<string, unknown>) =>
    (await reply(t, [chunk({ content: "Hi" }, "stop"), usageChunk(usage)])).result.usage;

  test("counts cached tokens apart from fresh input", async (t) => {
    const usage = await usageOf(t, { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 600 } });
    assert.deepEqual(usage, { input: 400, output: 200, cacheRead: 600, cacheWrite: 0 });
  });

  test("takes DeepSeek's own cache hit and miss counts", async (t) => {
    const usage = await usageOf(t, { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 300 });
    assert.deepEqual(usage, { input: 300, output: 50, cacheRead: 700, cacheWrite: 0 });
  });

  test("counts reasoning that total_tokens has and completion_tokens leaves out", async (t) => {
    // Gemini and xAI: 50 tokens of reasoning only show in the total.
    const usage = await usageOf(t, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 170 });
    assert.deepEqual(usage, { input: 100, output: 70, cacheRead: 0, cacheWrite: 0 });
  });

  test("goes by completion_tokens when there's no total", async (t) => {
    const usage = await usageOf(t, { prompt_tokens: 100, completion_tokens: 30 });
    assert.deepEqual(usage, { input: 100, output: 30, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("compat: mid-chat notes", () => {
  const note = "The person changed this chat's instructions.";

  test("fold into the user message they follow where system messages only go first", async (t) => {
    const { sent } = await reply(t, [chunk({ content: "OK" })], {
      history: [turn("user", "First"), turn("assistant", "Reply"), turn("user", "Second"), turn("system", note)],
    });
    assert.deepEqual(sent.messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "First" },
      { role: "assistant", content: "Reply" },
      { role: "user", content: `Second\n\n<system_note>\n${note}\n</system_note>` },
    ]);
  });

  test("go in as a user message of their own after a reply", async (t) => {
    const { sent } = await reply(t, [chunk({ content: "OK" })], {
      history: [turn("user", "First"), turn("assistant", "Reply"), turn("system", note), turn("user", "Next")],
    });
    assert.deepEqual(sent.messages.slice(2), [
      { role: "assistant", content: "Reply" },
      { role: "user", content: `<system_note>\n${note}\n</system_note>` },
      { role: "user", content: "Next" },
    ]);
  });

  test("join a message with a picture as a text part", async (t) => {
    const pixel = files.add("pixel.png", "image", "image/png", PNG);
    const { sent } = await reply(t, [chunk({ content: "OK" })], {
      reads: ["image", "text"],
      history: [turn("user", "Look", [pixel]), turn("system", note)],
    });
    const parts = sent.messages[1].content;
    assert.deepEqual(parts.at(-2), { type: "text", text: "Look" });
    assert.deepEqual(parts.at(-1), { type: "text", text: `<system_note>\n${note}\n</system_note>` });
  });

  test("stay system messages where the service takes them mid-chat", async (t) => {
    const { sent } = await reply(t, [chunk({ content: "OK" })], { history: [turn("user", "First"), turn("system", note)] }, dialect({ systemMidChat: true }));
    assert.deepEqual(sent.messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "First" },
      { role: "system", content: note },
    ]);
  });
});

describe("compat: files", () => {
  test("inlines text, sends pictures as data URLs and names what it can't open", async (t) => {
    const notes = files.add("notes.txt", "text", "text/plain", "﻿Line one\nLine two");
    const pixel = files.add("pixel.png", "image", "image/png", PNG);
    const data = files.add("data.bin", "other", "application/octet-stream", Buffer.from([0, 1, 2]));
    const pdf = files.add("report.pdf", "pdf", "application/pdf", "%PDF-1.4\n");
    const gone = files.missing("gone.txt", "text", "text/plain");
    const { sent } = await reply(t, [chunk({ content: "OK" })], {
      reads: ["image", "text"],
      history: [turn("user", "What's in these?", [notes, pixel, data, pdf, gone])],
    });
    assert.deepEqual(sent.messages[1].content, [
      { type: "text", text: "Image: pixel.png" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } },
      {
        type: "text",
        text: [
          '<file name="notes.txt">\nLine one\nLine two\n</file>',
          "(The person attached data.bin, which this model can't open.)",
          // Another service doesn't take PDFs.
          "(The person attached report.pdf, which this model can't open.)",
          "(The person attached gone.txt, which is no longer available.)",
          "What's in these?",
        ].join("\n\n"),
      },
    ]);
  });

  test("names a picture to a model that reads text only, in a plain string", async (t) => {
    const pixel = files.add("pixel.png", "image", "image/png", PNG);
    const quoted = files.add('my "draft".txt', "text", "text/plain", "Draft");
    const { sent } = await reply(t, [chunk({ content: "OK" })], { history: [turn("user", "Look", [pixel, quoted])] });
    assert.equal(
      sent.messages[1].content,
      `(The person attached pixel.png, which this model can't open.)\n\n<file name="my 'draft'.txt">\nDraft\n</file>\n\nLook`,
    );
  });

  test("sends a PDF as the dialect says where it reads them", async (t) => {
    const pdf = files.add("report.pdf", "pdf", "application/pdf", "%PDF-1.4\n");
    const reader = dialect({ pdf: (file, base64) => ({ type: "file", file: { filename: file.name, file_data: `data:application/pdf;base64,${base64}` } }) });
    const { sent } = await reply(t, [chunk({ content: "OK" })], { reads: ["pdf", "text"], history: [turn("user", "", [pdf])] }, reader);
    assert.deepEqual(sent.messages[1].content, [
      { type: "file", file: { filename: "report.pdf", file_data: `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n").toString("base64")}` } },
    ]);
  });
});

describe("compat: checking a key", () => {
  test("accepts a key whose model is listed", async (t) => {
    const api = await service(t, () => modelList(["other-model", "test-model"]));
    await customProvider.verify("sk-check", "test-model", `${api.url}/v1`);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].method, "GET");
    assert.equal(api.requests[0].path, "/v1/models");
    assert.equal(api.requests[0].headers.authorization, "Bearer sk-check");
  });

  test("says what the key offers when the model isn't listed", async (t) => {
    const api = await service(t, () => modelList(["alpha", "beta"]));
    await assert.rejects(customProvider.verify("sk", "test-model", `${api.url}/v1`), { message: "This key can't use test-model. It offers alpha, beta" });
  });

  test("shortens a long list of models", async (t) => {
    const api = await service(t, () => modelList(Array.from({ length: 14 }, (_, i) => `m${i + 1}`)));
    await assert.rejects(customProvider.verify("sk", "test-model", `${api.url}/v1`), {
      message: "This key can't use test-model. It offers m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12 and 2 more",
    });
  });

  test("reads Gemini's model names without their models/ prefix", async (t) => {
    const api = await service(t, () => modelList(["models/gemini-3.8-flash"]));
    await customProvider.verify("sk", "gemini-3.8-flash", `${api.url}/v1`);
  });

  test("asks the model itself when the service has no model list", async (t) => {
    const api = await service(t, (req) =>
      req.path === "/v1/models"
        ? json({ error: { message: "Not found" } }, 404)
        : json({ id: "c", object: "chat.completion", created: 0, model: "test-model", choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }] }),
    );
    await customProvider.verify("sk", "test-model", `${api.url}/v1`);
    assert.deepEqual(
      api.requests.map((r) => `${r.method} ${r.path}`),
      ["GET /v1/models", "POST /v1/chat/completions"],
    );
    assert.deepEqual(api.requests[1].body, { model: "test-model", messages: [{ role: "user", content: "Hi" }], max_tokens: 16 });
  });

  test("fails when that question fails too", async (t) => {
    const api = await service(t, () => json({ error: { message: "No such model" } }, 404));
    await assert.rejects(customProvider.verify("sk", "test-model", `${api.url}/v1`), { status: 404 });
    assert.equal(api.requests.length, 2);
  });

  test("doesn't ask the model at a service with its own fixed address", async (t) => {
    const api = await service(t, () => json({ error: { message: "Not found" } }, 404));
    await assert.rejects(dialect({ baseURL: `${api.url}/v1` }).verify("sk", "test-model"), { status: 404 });
    assert.equal(api.requests.length, 1);
  });
});

describe("compat: one-off answers", () => {
  const completion = (content: string, finish = "stop") =>
    json({
      id: "c",
      object: "chat.completion",
      created: 0,
      model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content, refusal: null }, finish_reason: finish }],
      usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
    });

  test("answers without the reasoning it opened with", async (t) => {
    const api = await service(t, () => completion("<think>Short.</think>\nWeekend plans"));
    const result = await customProvider.complete({ apiKey: "sk", baseUrl: `${api.url}/v1`, model: "test-model", system: "Name it.", prompt: "Chat" });
    assert.deepEqual(result, { text: "Weekend plans", model: "test-model", usage: { input: 40, output: 12, cacheRead: 0, cacheWrite: 0 } });
    assert.equal(api.requests[0].body.max_tokens, 1000);
    assert.equal(api.requests[0].body.stream, undefined);
  });

  test("returns nothing when the answer was filtered", async (t) => {
    const api = await service(t, () => completion("", "content_filter"));
    assert.equal(await customProvider.complete({ apiKey: "sk", baseUrl: `${api.url}/v1`, model: "test-model", system: "Name it.", prompt: "Chat" }), null);
  });
});
