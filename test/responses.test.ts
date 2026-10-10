// The Responses API (server/providers/responses.ts) as OpenAI and Grok use it, against a mock API.
import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { openaiProvider } from "../server/providers/openai.ts";
import { responsesProvider } from "../server/providers/responses.ts";
import type { ChatProvider, ChatRequest } from "../server/providers/types.ts";
import { chatRequest, fileFolder, PNG, turn } from "./helpers/chat.ts";
import { json, mockServer, modelList, responseStream, type Received, type Reply } from "./helpers/mock-server.ts";

let answer: (req: Received) => Reply = () => {
  throw new Error("The test set no answer");
};
const api = await mockServer((req) => answer(req));
after(() => api.close());
beforeEach(() => {
  api.requests.length = 0;
});

// OpenAI's provider names no address, so the SDK reads OPENAI_BASE_URL each time it makes a client.
process.env.OPENAI_BASE_URL = `${api.url}/v1`;
// Grok as xai.ts sets it up, at the mock's address.
const grokProvider = responsesProvider({
  provider: "xai",
  baseURL: `${api.url}/v1`,
  pdf: false,
  imageTypes: ["image/jpeg", "image/png"],
  noteRole: "system",
  summaries: (model) => model.startsWith("grok-4.7"),
});

const files = fileFolder();
after(files.remove);

const created = { type: "response.created", response: { id: "resp_1", object: "response", created_at: 1_700_000_000, status: "in_progress", output: [] } };
const reasoningItem = { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } };
const summaryPart = (i: number) => ({
  type: "response.reasoning_summary_part.added",
  item_id: "rs_1",
  output_index: 0,
  summary_index: i,
  part: { type: "summary_text", text: "" },
});
const summaryDelta = (i: number, delta: string) => ({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: i, delta });
const messageItem = {
  type: "response.output_item.added",
  output_index: 1,
  item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
};
const textDelta = (delta: string) => ({ type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta });
const textDone = (text: string) => ({ type: "response.output_text.done", item_id: "msg_1", output_index: 1, content_index: 0, text });
const usage = (input: number, cached: number, output: number, total = input + output) => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: cached },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: total,
});
const completed = (u = usage(10, 0, 2)) => ({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: u } });
/** The shortest reply: "OK". */
const ok = [created, messageItem, textDelta("OK"), textDone("OK"), completed()];

async function chat(provider: ChatProvider, overrides: Partial<ChatRequest>) {
  const { req, seen } = chatRequest({ model: "gpt-6.1-sol", effort: "low", ...overrides });
  const result = await provider.chat(req);
  return { result, seen, sent: api.requests.at(-1)!.body };
}

describe("responses: OpenAI", () => {
  test("streams reasoning summaries as thinking and the answer as text", async () => {
    answer = () =>
      responseStream([
        created,
        reasoningItem,
        summaryPart(0),
        summaryDelta(0, "Weighing the "),
        summaryDelta(0, "options."),
        summaryPart(1),
        summaryDelta(1, "Settling on blue."),
        messageItem,
        textDelta("Blue"),
        textDelta(" it is."),
        textDone("Blue it is."),
        { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [] } },
        completed(usage(500, 100, 80)),
      ]);
    const { result, seen, sent } = await chat(openaiProvider, { cacheKey: "chat-1" });
    assert.equal(seen.thinking, "Weighing the options.\n\nSettling on blue.");
    assert.equal(result.thinking, "Weighing the options.\n\nSettling on blue.");
    assert.equal(seen.text, "Blue it is.");
    assert.equal(result.text, "Blue it is.");
    assert.deepEqual(seen.statuses, ["thinking", "writing"]);
    assert.equal(result.stopReason, "stop");
    assert.equal(result.refused, false);
    assert.deepEqual(result.usage, { input: 400, output: 80, cacheRead: 100, cacheWrite: 0 });

    assert.equal(api.requests[0].path, "/v1/responses");
    assert.equal(sent.model, "gpt-6.1-sol");
    assert.equal(sent.instructions, "Be brief.");
    assert.deepEqual(sent.input, [{ role: "user", content: "Hi" }]);
    assert.deepEqual(sent.reasoning, { effort: "low", summary: "auto" });
    assert.equal(sent.store, false);
    assert.equal(sent.stream, true);
    assert.equal(sent.max_output_tokens, 64000);
    assert.equal(sent.prompt_cache_key, "chat-1");
    // No tools unless the chat declares them and the key allows them.
    assert.equal(sent.tools, undefined);
  });

  test("asks for no summary when thinking is off or not shown", async () => {
    answer = () => responseStream(ok);
    assert.deepEqual((await chat(openaiProvider, { model: "gpt-6-luna", effort: "off" })).sent.reasoning, { effort: "none" });
    assert.deepEqual((await chat(openaiProvider, { showThinking: false })).sent.reasoning, { effort: "low" });
  });

  test("asks again without summaries when the organisation must be verified", async () => {
    answer = (req) =>
      req.body.reasoning.summary
        ? json({ error: { message: "Your organization must be verified to generate reasoning summaries.", type: "invalid_request_error", param: "reasoning.summary", code: "unsupported_value" } }, 400)
        : responseStream(ok);
    const { result, seen } = await chat(openaiProvider, {});
    assert.equal(result.text, "OK");
    assert.equal(seen.thinking, "");
    assert.deepEqual(
      api.requests.map((r) => r.body.reasoning),
      [{ effort: "low", summary: "auto" }, { effort: "low" }],
    );
  });

  test("doesn't ask again when the request was turned down for something else", async () => {
    answer = () => json({ error: { message: "Invalid value for 'model'.", type: "invalid_request_error" } }, 400);
    await assert.rejects(chat(openaiProvider, {}), { status: 400 });
    assert.equal(api.requests.length, 1);
  });

  test("marks a refusal", async () => {
    answer = () =>
      responseStream([
        created,
        messageItem,
        { type: "response.refusal.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "I can't help with that." },
        completed(),
      ]);
    const { result, seen } = await chat(openaiProvider, {});
    assert.equal(result.refused, true);
    assert.equal(result.stopReason, "content_filter");
    assert.equal(result.text, "");
    assert.equal(seen.text, "");
  });

  test("ends a reply cut short at max_output_tokens with max_tokens", async () => {
    answer = () =>
      responseStream([
        created,
        messageItem,
        textDelta("A long"),
        textDelta(" answer"),
        { type: "response.incomplete", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: usage(30, 0, 64000) } },
      ]);
    const { result } = await chat(openaiProvider, {});
    assert.equal(result.stopReason, "max_tokens");
    assert.equal(result.refused, false);
    assert.equal(result.text, "A long answer");
    assert.deepEqual(result.usage, { input: 30, output: 64000, cacheRead: 0, cacheWrite: 0 });
  });

  test("marks a reply cut short by the content filter as refused", async () => {
    answer = () =>
      responseStream([created, { type: "response.incomplete", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "content_filter" }, usage: usage(30, 0, 1) } }]);
    const { result } = await chat(openaiProvider, {});
    assert.equal(result.refused, true);
    assert.equal(result.stopReason, "content_filter");
  });

  test("throws a failed response with the status it would have had", async () => {
    for (const [code, status] of [["rate_limit_exceeded", 429], ["invalid_prompt", 400], ["server_error", 500]] as const) {
      answer = () => responseStream([created, { type: "response.failed", response: { id: "resp_1", status: "failed", error: { code, message: `Failed with ${code}` } } }]);
      await assert.rejects(chat(openaiProvider, {}), { status, message: `Failed with ${code}` });
    }
  });

  test("sends pictures and PDFs as parts, text files inline, and notes as developer messages", async () => {
    answer = () => responseStream(ok);
    const webp = Buffer.from("RIFF\0\0\0\0WEBPVP8 ");
    const history = [
      turn("user", "What are these?", [
        files.add("photo.webp", "image", "image/webp", webp),
        files.add("photo.png", "image", "image/png", PNG),
        files.add("report.pdf", "pdf", "application/pdf", "%PDF-1.4\n"),
        files.add("notes.txt", "text", "text/plain", "Notes"),
      ]),
      turn("assistant", "Four files."),
      turn("system", "Answers are now in French."),
    ];
    const { sent } = await chat(openaiProvider, { reads: ["image", "pdf", "text"], history });
    assert.deepEqual(sent.input, [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Image: photo.webp" },
          { type: "input_image", image_url: `data:image/webp;base64,${webp.toString("base64")}`, detail: "auto" },
          { type: "input_text", text: "Image: photo.png" },
          { type: "input_image", image_url: `data:image/png;base64,${PNG.toString("base64")}`, detail: "auto" },
          { type: "input_file", filename: "report.pdf", file_data: `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n").toString("base64")}` },
          { type: "input_text", text: '<file name="notes.txt">\nNotes\n</file>\n\nWhat are these?' },
        ],
      },
      { role: "assistant", content: "Four files." },
      { role: "developer", content: "Answers are now in French." },
    ]);
  });

  test("makes a cited link a marker after the words, however many spaces came before them", async () => {
    // 200 KB of spaces that words follow took 25 seconds with /[ \t]+$/.
    const words = `Blue${" ".repeat(200_000)}it is `;
    const link = "([example.com](https://example.com/?utm_source=openai))";
    const annotation = { type: "url_citation", start_index: words.length, end_index: words.length + link.length, url: "https://example.com/?utm_source=openai", title: "Example" };
    answer = () =>
      responseStream([
        created,
        messageItem,
        textDelta(`${words}${link}.`),
        { type: "response.output_text.annotation.added", item_id: "msg_1", output_index: 1, content_index: 0, annotation_index: 0, annotation },
        textDone(`${words}${link}.`),
        completed(),
      ]);
    const started = Date.now();
    const { result } = await chat(openaiProvider, {});
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    assert.equal(result.text, `Blue${" ".repeat(200_000)}it is[1](https://example.com/).`);
    assert.deepEqual(result.sources, [{ url: "https://example.com/", title: "Example" }]);
  });

  test("keeps a sandbox link's words, and isn't slowed by brackets that never close", async () => {
    // 200 KB of "[" that nothing closes took 25 seconds when the link's pattern looked past them.
    const text = `See [the chart](sandbox:/mnt/data/chart.png). ${"[".repeat(200_000)}`;
    answer = () => responseStream([created, messageItem, textDelta(text), textDone(text), completed()]);
    const started = Date.now();
    const { result } = await chat(openaiProvider, {});
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    assert.equal(result.text, `See the chart. ${"[".repeat(200_000)}`);
  });

  test("names a chat at the model's lowest thinking level", async () => {
    answer = () =>
      json({
        id: "resp_2",
        object: "response",
        created_at: 1_700_000_000,
        status: "completed",
        output: [{ type: "message", id: "msg_2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Paint colours", annotations: [] }] }],
        usage: usage(60, 0, 4),
      });
    const ask = (model: string) => openaiProvider.complete({ apiKey: "sk", model, system: "Name it.", prompt: "Chat" });
    assert.deepEqual(await ask("gpt-6.1-sol"), { text: "Paint colours", model: "gpt-6.1-sol", usage: { input: 60, output: 4, cacheRead: 0, cacheWrite: 0 } });
    assert.deepEqual(api.requests[0].body.reasoning, { effort: "low" });
    await ask("gpt-6-luna");
    assert.deepEqual(api.requests[1].body.reasoning, { effort: "none" });
  });
});

describe("responses: Grok", () => {
  test("sends only the picture formats Grok reads, and notes as system messages", async () => {
    answer = () => responseStream(ok);
    const history = [
      turn("user", "What are these?", [
        files.add("photo.webp", "image", "image/webp", Buffer.from("RIFF\0\0\0\0WEBPVP8 ")),
        files.add("photo.png", "image", "image/png", PNG),
        files.add("report.pdf", "pdf", "application/pdf", "%PDF-1.4\n"),
        files.add("notes.txt", "text", "text/plain", "Notes"),
      ]),
      turn("system", "Answers are now in French."),
    ];
    const { sent } = await chat(grokProvider, { model: "grok-4.7", reads: ["image", "text"], history });
    assert.deepEqual(sent.input, [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Image: photo.png" },
          { type: "input_image", image_url: `data:image/png;base64,${PNG.toString("base64")}`, detail: "auto" },
          {
            type: "input_text",
            text: [
              "(The person attached photo.webp, which this model can't open.)",
              "(The person attached report.pdf, which this model can't open.)",
              '<file name="notes.txt">\nNotes\n</file>',
              "What are these?",
            ].join("\n\n"),
          },
        ],
      },
      { role: "system", content: "Answers are now in French." },
    ]);
  });

  test("asks for summaries only from the model that writes them", async () => {
    answer = () => responseStream(ok);
    assert.deepEqual((await chat(grokProvider, { model: "grok-4.7" })).sent.reasoning, { effort: "low", summary: "auto" });
    assert.deepEqual((await chat(grokProvider, { model: "grok-4.3" })).sent.reasoning, { effort: "low" });
  });

  test("counts reasoning that only the total has", async () => {
    answer = () => responseStream([created, messageItem, textDelta("OK"), completed(usage(100, 0, 20, 170))]);
    const { result } = await chat(grokProvider, { model: "grok-4.3" });
    assert.deepEqual(result.usage, { input: 100, output: 70, cacheRead: 0, cacheWrite: 0 });
  });

  test("accepts a model by any of its names", async () => {
    answer = () => modelList([{ id: "grok-4.7-0709", aliases: ["grok-4.7", "grok-4.7-latest"] }, "grok-4.3"]);
    await grokProvider.verify("sk", "grok-4.7");
    await grokProvider.verify("sk", "grok-4.7-0709");
    await grokProvider.verify("sk", "grok-4.3");
    await assert.rejects(grokProvider.verify("sk", "grok-9"), { status: 404, message: "This key can't use grok-9" });
    assert.equal(api.requests[0].path, "/v1/models");
    assert.equal(api.requests[0].headers.authorization, "Bearer sk");
  });
});
