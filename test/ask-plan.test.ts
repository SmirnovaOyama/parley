// Asking and planning (server/tools.ts: ask_person, propose_plan, update_plan) through the real chat
// route, with Claude, OpenAI's Responses API and DeepSeek's chat completions each played by a local
// mock. The SDKs reach their fixed addresses through fetch, which is pointed at the mock here, so
// nothing leaves the machine. A scripted model calls the tools; the test answers on the asks route
// as a person would, or doesn't, and checks what the model was told and what the reply keeps.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { after, afterEach, before, describe, test } from "node:test";
import { Hono } from "hono";
import { sameOriginGuard, sessionMiddleware, type AppEnv } from "../server/auth.ts";
import { PLAN_FIRST_NOTE } from "../server/chat-store.ts";
import { encryptSecret, hashToken } from "../server/crypto.ts";
import { db, nowIso } from "../server/db.ts";
import { chatRoutes } from "../server/routes/chat.ts";
import { taskRoutes, tickTasks, waitForTaskRuns } from "../server/tasks.ts";
import type { Moment } from "../server/tools.ts";
import { chunk, completionStream, json, mockServer, responseStream, type MockServer, type Received, type Reply } from "./helpers/mock-server.ts";

const app = new Hono<AppEnv>();
app.use("*", sameOriginGuard, sessionMiddleware);
app.route("/api", chatRoutes);
app.route("/api", taskRoutes);

/** One turn of the scripted model: some words, then the tool calls it makes (none: it's done). */
type Turn = { thinking?: string; text?: string; calls?: { name: string; input: Record<string, unknown> }[] };
/** What the model does, turn by turn: its nth turn comes after n rounds of tool results. */
let script: Turn[] = [];
let service: MockServer;
const realFetch = globalThis.fetch;

/** Rounds of tool results in a request to the services that send history as text. */
function roundOf(req: Received): number {
  if (req.path.endsWith("/responses")) return countBy(req.body.input, (i) => i.type === "function_call_output");
  return countBy(req.body.messages, (m) => m.role === "tool");
}
const countBy = (list: Record<string, unknown>[], match: (item: Record<string, unknown>) => boolean) => {
  // Several calls in one turn come back together: a round is a run of results.
  let rounds = 0;
  let inRun = false;
  for (const item of list) {
    const hit = match(item);
    if (hit && !inRun) rounds++;
    inRun = hit;
  }
  return rounds;
};
/** Claude's rounds: user turns that carry tool results, after the latest message the person wrote. */
const countRounds = (messages: { role: string; content: unknown }[]) => {
  let rounds = 0;
  for (const m of messages) {
    const results = Array.isArray(m.content) && m.content.some((b: { type?: string }) => b.type === "tool_result");
    if (m.role === "user" && !results) rounds = 0;
    else if (results) rounds++;
  }
  return rounds;
};
/** The rounds since the person's latest message, for the services that send history as text. */
function latestRound(req: Received): number {
  if (req.path.endsWith("/messages")) return countRounds(req.body.messages);
  const list: Record<string, unknown>[] = req.path.endsWith("/responses") ? req.body.input : req.body.messages;
  const last = list.findLastIndex((m) => m.role === "user");
  return roundOf({ ...req, body: req.path.endsWith("/responses") ? { input: list.slice(last) } : { messages: list.slice(last) } });
}

let callId = 0;
const nextId = () => `call_${++callId}`;

/** Claude's stream for one turn. */
function claudeTurn(turn: Turn): Reply {
  return (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (data: Record<string, unknown>) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    send({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    let index = 0;
    if (turn.text) {
      send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index, delta: { type: "text_delta", text: turn.text } });
      send({ type: "content_block_stop", index: index++ });
    }
    for (const call of turn.calls ?? []) {
      send({ type: "content_block_start", index, content_block: { type: "tool_use", id: nextId(), name: call.name, input: {} } });
      send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } });
      send({ type: "content_block_stop", index: index++ });
    }
    send({ type: "message_delta", delta: { stop_reason: turn.calls?.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    send({ type: "message_stop" });
    res.end();
  };
}

/** The Responses API's stream for one turn. */
function responsesTurn(turn: Turn): Reply {
  const events: ({ type: string } & Record<string, unknown>)[] = [
    { type: "response.created", response: { id: "resp_1", object: "response", created_at: 1_700_000_000, status: "in_progress", output: [] } },
  ];
  let index = 0;
  if (turn.text) {
    const item = { type: "message", id: "msg_1", role: "assistant" };
    events.push(
      { type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: index, content_index: 0, delta: turn.text },
      { type: "response.output_text.done", item_id: "msg_1", output_index: index, content_index: 0, text: turn.text },
      { type: "response.output_item.done", output_index: index++, item: { ...item, status: "completed", content: [{ type: "output_text", text: turn.text, annotations: [] }] } },
    );
  }
  for (const call of turn.calls ?? []) {
    const item = { type: "function_call", id: `fc_${callId}`, call_id: nextId(), name: call.name, arguments: JSON.stringify(call.input) };
    events.push(
      { type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress" } },
      { type: "response.output_item.done", output_index: index++, item: { ...item, status: "completed" } },
    );
  }
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 };
  events.push({ type: "response.completed", response: { id: "resp_1", status: "completed", usage } });
  return responseStream(events);
}

/** DeepSeek's chat-completions stream for one turn. */
function completionsTurn(turn: Turn): Reply {
  const calls = (turn.calls ?? []).map((call, index) => ({ index, id: nextId(), type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }));
  return completionStream([
    ...(turn.thinking ? [chunk({ reasoning_content: turn.thinking })] : []),
    ...(turn.text ? [chunk({ content: turn.text })] : []),
    ...(calls.length ? [chunk({ tool_calls: calls })] : []),
    chunk({}, calls.length ? "tool_calls" : "stop"),
  ]);
}

before(async () => {
  service = await mockServer((req) => {
    // Naming a chat: a short answer, not streamed.
    if (req.path.endsWith("/messages") && !req.body.stream) {
      return json({ id: "msg_t", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "A title" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (req.path.endsWith("/chat/completions") && !req.body.stream) return json({ choices: [{ message: { content: "A title" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    if (req.path.endsWith("/responses") && !req.body.stream) {
      return json({ id: "resp_t", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "A title", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    }
    const turn = script[latestRound(req)] ?? { text: "That's all." };
    if (req.path.endsWith("/messages")) return claudeTurn(turn);
    if (req.path.endsWith("/responses")) return responsesTurn(turn);
    return completionsTurn(turn);
  });
  // The SDKs call fetch with their providers' own addresses; here those lead to the mock.
  const hosts = ["https://api.anthropic.com", "https://api.openai.com", "https://api.deepseek.com"];
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = hosts.find((h) => url.startsWith(h));
    return realFetch(host ? `${service.url}${url.slice(host.length)}` : input, init);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await waitForTaskRuns();
  await service.close();
});
afterEach(() => {
  script = [];
});

const PROVIDERS = [
  { name: "Claude", provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" },
  { name: "OpenAI", provider: "openai", model: "gpt-6.1-sol", effort: "low" },
  { name: "DeepSeek", provider: "deepseek", model: "deepseek-flash", effort: "off" },
] as const;
const keys = new Map<string, number>();
for (const p of PROVIDERS) {
  keys.set(p.provider, Number(db.prepare(
    `INSERT INTO api_keys (label, provider, model, effort, encrypted_key, last4, shared, created_at)
     VALUES (?, ?, ?, ?, ?, 'test', 1, ?)`,
  ).run(p.name, p.provider, p.model, p.effort, encryptSecret("sk-ask-plan-test"), nowIso()).lastInsertRowid));
}

type Message = { id: number; text: string; status: string; moments: Moment[] };
type Event = { event: string; data: any };

class Person {
  id: number;
  token = randomUUID();
  constructor() {
    this.id = Number(db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, 'test', ?)").run(`${randomUUID()}@example.com`, nowIso()).lastInsertRowid);
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(this.token), this.id, new Date(Date.now() + 86_400_000).toISOString(), nowIso());
  }
  request(method: string, path: string, body?: unknown) {
    return app.request(`http://parley.test/api${path}`, {
      method,
      headers: { cookie: `sid=${this.token}`, origin: "http://parley.test", "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  /**
   * Sends a message and reads the reply's stream as it comes. Each time questions are waiting,
   * `answer` gets the newest one and the chat's id, and answers it (or doesn't).
   */
  async chat(body: Record<string, unknown>, answer?: (ask: any, conversationId: string) => Promise<void> | void) {
    const response = await this.request("POST", "/chat", body);
    if (response.status !== 200) assert.fail(await response.text());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: Event[] = [];
    let buffer = "";
    let conversationId = "";
    const answered = new Set<string>();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!event || data === undefined) continue;
        const parsed = { event, data: JSON.parse(data) };
        events.push(parsed);
        if (event === "meta") conversationId = parsed.data.conversationId;
        if (event === "asks" && answer) {
          const waiting = parsed.data.asks.filter((a: { id: string }) => !answered.has(a.id));
          for (const ask of waiting) {
            answered.add(ask.id);
            await answer(ask, conversationId);
          }
        }
      }
    }
    const final = events.find((e) => e.event === "done" || e.event === "error");
    assert.ok(final, JSON.stringify(events));
    return { message: final.data.message as Message, events, conversationId };
  }
  async answer(conversationId: string, askId: string, body: Record<string, unknown>) {
    const response = await this.request("POST", `/conversations/${conversationId}/asks/${askId}`, body);
    assert.equal(response.status, 200, await response.clone().text());
  }
  async load(conversationId: string) {
    const response = await this.request("GET", `/conversations/${conversationId}`);
    assert.equal(response.status, 200);
    return (await response.json()) as {
      conversation: { planFirst: boolean; canPlan: boolean };
      messages: Message[];
      generating: boolean;
      live: { text: string; thinking: string } | null;
    };
  }
}

/** The tool results the model was sent in its latest request, by provider. */
function toolResults(req: Received): string[] {
  if (req.path.endsWith("/messages")) {
    return (req.body.messages as { content: unknown }[]).flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b: { type?: string }) => b.type === "tool_result").map((b: { content: unknown }) => String(b.content));
  }
  if (req.path.endsWith("/responses")) return (req.body.input as { type?: string; output?: string }[]).filter((i) => i.type === "function_call_output").map((i) => i.output!);
  return (req.body.messages as { role: string; content: string }[]).filter((m) => m.role === "tool").map((m) => m.content);
}
/** The names of the functions a request offered, by provider. */
function offered(req: Received): string[] {
  return (req.body.tools ?? []).map((t: { name?: string; function?: { name: string } }) => t.function?.name ?? t.name).filter(Boolean);
}
const streamed = (req: Received) => req.body?.stream === true;
const since = (from: number) => service.requests.slice(from).filter(streamed);

const ASK = { name: "ask_person", input: { question: "Which colour should the chart use?", options: ["Teal", "Orange", "Grey"] } };
const PLAN = { name: "propose_plan", input: { steps: ["Read the data", "Draw the chart", "Write a summary"] } };

test("coming back to a reply that's still being written shows what it has thought and written so far", async () => {
  const person = new Person();
  script = [{ thinking: "Which colour suits a chart of sales?", text: "Let me check one thing.", calls: [ASK] }, { text: " Teal it is." }];
  const { message, conversationId } = await person.chat({ text: "Make me a chart", keyId: keys.get("deepseek"), model: "deepseek-flash", effort: "off" }, async (ask, id) => {
    // As another page of theirs sees it, mid-reply.
    const meanwhile = await person.load(id);
    assert.equal(meanwhile.generating, true);
    assert.deepEqual(meanwhile.live, { text: "Let me check one thing.", thinking: "Which colour suits a chart of sales?" });
    await person.answer(id, ask.id, { allow: true, text: "Teal" });
  });
  assert.match(message.text, /Let me check one thing\.\s*Teal it is\./);
  // Once it's saved there's nothing live left; the thinking is with the message.
  const after = await person.load(conversationId);
  assert.deepEqual([after.generating, after.live], [false, null]);
});

for (const p of PROVIDERS) {
  const pick = { keyId: keys.get(p.provider), model: p.model, effort: p.effort };

  describe(`${p.name}: asking`, () => {
    test("stops for a question, carries on with the choice, and keeps the answer where it was asked", async () => {
      const person = new Person();
      script = [{ text: "Let me check one thing.", calls: [ASK] }, { text: " Teal it is." }];
      const from = service.requests.length;
      const { message, events, conversationId } = await person.chat({ text: "Make me a chart", ...pick }, (ask, id) => {
        assert.equal(ask.kind, "question");
        assert.equal(ask.question, "Which colour should the chart use?");
        assert.deepEqual(ask.options, ["Teal", "Orange", "Grey"]);
        return person.answer(id, ask.id, { allow: true, text: "Teal" });
      });
      const sent = since(from);
      assert.ok(offered(sent[0]).includes("ask_person"), offered(sent[0]).join());
      assert.deepEqual(toolResults(sent[1]), ["The person chose: Teal"]);
      assert.equal(message.status, "ok");
      assert.match(message.text, /Let me check one thing\.\s*Teal it is\./);
      const moment = { kind: "question", at: "Let me check one thing.".length, question: ASK.input.question, options: ASK.input.options, answer: "Teal", outcome: "answered" };
      assert.deepEqual(message.moments, [moment]);
      assert.ok(events.some((e) => e.event === "moments" && e.data.moments[0]?.answer === "Teal"), "The answer shows while the reply goes on");
      // After a reload, the question and its answer are still in the reply.
      const loaded = await person.load(conversationId);
      assert.deepEqual(loaded.messages.at(-1)!.moments, [moment]);
    });

    test("takes an answer of the person's own", async () => {
      const person = new Person();
      script = [{ calls: [ASK] }, { text: "Purple, then." }];
      const from = service.requests.length;
      const { message } = await person.chat({ text: "Make me a chart", ...pick }, (ask, id) => person.answer(id, ask.id, { allow: true, text: "Purple, like the logo" }));
      assert.deepEqual(toolResults(since(from)[1]), ["The person wrote their own answer: Purple, like the logo"]);
      assert.equal(message.moments[0].kind === "question" && message.moments[0].own, true);
    });

    test("a scheduled task gets told nobody is there, so the model decides", async () => {
      const person = new Person();
      script = [{ calls: [ASK, PLAN] }, { calls: [{ name: "update_plan", input: { step: 1, status: "done" } }] }, { text: "Went with teal." }];
      const created = await person.request("POST", "/tasks", {
        name: "Weekly chart", prompt: "Make the weekly chart", choice: pick,
        schedule: { kind: "daily", timeZone: "Asia/Singapore", time: "09:00" },
      });
      assert.equal(created.status, 200, await created.clone().text());
      const task = (await created.json()) as { id: string; nextRunAt: string };
      const from = service.requests.length;
      await tickTasks(Date.parse(task.nextRunAt));
      const sent = since(from);
      const [question, plan] = toolResults(sent[1]);
      assert.match(question, /^Nobody is here to answer: this reply runs on its own, as a scheduled task\. Decide yourself/);
      assert.match(plan, /^Nobody is here to approve the plan/);
      assert.match(toolResults(sent[2]).at(-1)!, /^Marked step 1 done/);
      const conversationId = (db.prepare("SELECT conversation_id FROM scheduled_runs WHERE task_id = ?").get(task.id) as { conversation_id: string }).conversation_id;
      const reply = (await person.load(conversationId)).messages.at(-1)!;
      assert.equal(reply.status, "ok");
      assert.deepEqual(reply.moments.map((m) => [m.kind, m.outcome]), [["question", "away"], ["plan", "away"]]);
      const steps = reply.moments[1].kind === "plan" ? reply.moments[1].steps : [];
      assert.deepEqual(steps.map((s) => s.status), ["done", "todo", "todo"]);
    });
  });

  describe(`${p.name}: planning first`, () => {
    test("proposes a plan, waits for the edited OK, then ticks the steps off live", async () => {
      const person = new Person();
      script = [
        { text: "Here's how I'd go about it.", calls: [PLAN] },
        { calls: [{ name: "update_plan", input: { step: 1, status: "done" } }] },
        { text: "Drawn.", calls: [{ name: "update_plan", input: { step: 2, status: "done" } }] },
        { calls: [{ name: "update_plan", input: { step: 3, status: "skipped", reason: "The chart says it all" } }] },
        { text: " All done." },
      ];
      const from = service.requests.length;
      const { message, events, conversationId } = await person.chat({ text: "Chart last week's sales", planFirst: true, ...pick }, (ask, id) => {
        assert.equal(ask.kind, "plan");
        assert.deepEqual(ask.steps, PLAN.input.steps);
        return person.answer(id, ask.id, { allow: true, steps: ["Read the data", "Draw the chart in teal", "Write a summary", " "] });
      });
      const sent = since(from);
      // The note that it plans first follows the message, in every provider's own way.
      assert.ok(JSON.stringify(sent[0].body).includes(PLAN_FIRST_NOTE.slice(0, 40)), "The plan-first note goes with the message");
      assert.match(toolResults(sent[1])[0], /^The person approved the plan after editing it\. Its steps are now:\n1\. Read the data\n2\. Draw the chart in teal\n3\. Write a summary\n/);
      assert.match(toolResults(sent[2]).at(-1)!, /^Marked step 1 done\. 2 of 3 still to do/);
      assert.match(toolResults(sent[4]).at(-1)!, /^Marked step 3 skipped\. Every step is marked now/);
      const plan = message.moments[0];
      assert.equal(plan.kind, "plan");
      assert.equal(plan.at, "Here's how I'd go about it.".length);
      assert.equal(plan.outcome, "answered");
      assert.equal(plan.kind === "plan" && plan.edited, true);
      assert.deepEqual(plan.kind === "plan" && plan.steps, [
        { text: "Read the data", status: "done" },
        { text: "Draw the chart in teal", status: "done" },
        { text: "Write a summary", status: "skipped", reason: "The chart says it all" },
      ]);
      // Ticked as it went: the stream carried each step's change.
      const ticks = events.filter((e) => e.event === "moments").map((e) => e.data.moments[0].steps.map((s: { status: string }) => s.status).join());
      assert.deepEqual(ticks, ["todo,todo,todo", "done,todo,todo", "done,done,todo", "done,done,skipped"]);
      const loaded = await person.load(conversationId);
      assert.equal(loaded.conversation.planFirst, true);
      assert.deepEqual(loaded.messages.at(-1)!.moments, message.moments);
    });
  });
}

describe("asking and planning, what else can happen", () => {
  const pick = { keyId: keys.get("deepseek"), model: "deepseek-flash", effort: "off" };

  test("a plan sent back with a comment isn't carried out, and update_plan says there's nothing approved", async () => {
    const person = new Person();
    script = [{ calls: [PLAN] }, { calls: [{ name: "update_plan", input: { step: 1, status: "done" } }] }, { text: "I'll keep it shorter." }];
    const from = service.requests.length;
    const { message } = await person.chat({ text: "Chart it", planFirst: true, ...pick }, (ask, id) => person.answer(id, ask.id, { allow: false, text: "Fewer steps please" }));
    const sent = since(from);
    assert.match(toolResults(sent[1])[0], /^The person sent the plan back with this comment: Fewer steps please\. Don't start the work/);
    assert.match(toolResults(sent[2]).at(-1)!, /^Error: There's no approved plan to update/);
    assert.deepEqual(message.moments.map((m) => [m.kind, m.outcome, m.kind === "plan" ? m.comment : null]), [["plan", "returned", "Fewer steps please"]]);
  });

  test("a question left to the model says so, and a bad one is refused before anyone is asked", async () => {
    const person = new Person();
    script = [{ calls: [{ name: "ask_person", input: { question: "Which?", options: ["Only one"] } }] }, { calls: [ASK] }, { text: "Grey." }];
    const from = service.requests.length;
    const asked: unknown[] = [];
    const { message } = await person.chat({ text: "Chart it", ...pick }, (ask, id) => (asked.push(ask), person.answer(id, ask.id, { allow: false })));
    const sent = since(from);
    assert.equal(toolResults(sent[1])[0], "Error: Give 2 to 4 options in options");
    assert.match(toolResults(sent[2]).at(-1)!, /^The person left this to you\. Decide yourself/);
    assert.equal(asked.length, 1);
    assert.deepEqual(message.moments.map((m) => m.outcome), ["left"]);
  });

  test("answering a question needs an answer, and a stopped reply keeps the question as unanswered", async () => {
    const person = new Person();
    script = [{ text: "One moment.", calls: [ASK] }, { text: "Never sent" }];
    const { message } = await person.chat({ text: "Chart it", ...pick }, async (ask, id) => {
      const empty = await person.request("POST", `/conversations/${id}/asks/${ask.id}`, { allow: true, text: "  " });
      assert.equal(empty.status, 400);
      await person.request("POST", `/conversations/${id}/stop`);
    });
    assert.equal(message.status, "stopped");
    assert.equal(message.text, "One moment.");
    assert.deepEqual(message.moments.map((m) => [m.outcome, m.at]), [["stopped", "One moment.".length]]);
  });

  test("planning first is a chat's switch, kept by each message as it's sent", async () => {
    const person = new Person();
    script = [{ text: "Hi." }];
    const from = service.requests.length;
    const { conversationId } = await person.chat({ text: "Hello", ...pick });
    assert.ok(!JSON.stringify(since(from)[0].body).includes(PLAN_FIRST_NOTE.slice(0, 40)));
    let loaded = await person.load(conversationId);
    assert.deepEqual([loaded.conversation.planFirst, loaded.conversation.canPlan], [false, true]);
    const patched = await person.request("PATCH", `/conversations/${conversationId}`, { planFirst: true });
    assert.equal(patched.status, 200);
    loaded = await person.load(conversationId);
    assert.equal(loaded.conversation.planFirst, true);
    const next = service.requests.length;
    await person.chat({ text: "Now chart it", conversationId, ...pick });
    const body = JSON.stringify(since(next)[0].body);
    assert.equal(body.split(PLAN_FIRST_NOTE.slice(0, 40)).length - 1, 1, "Only the message sent with it on carries the note");
    // A chat from before the planning tools can't switch it on.
    db.prepare("UPDATE conversations SET tool_defs = NULL WHERE id = ?").run(conversationId);
    const old = await person.request("PATCH", `/conversations/${conversationId}`, { planFirst: true });
    assert.equal(old.status, 400);
    assert.equal((await person.load(conversationId)).conversation.canPlan, false);
  });

  test("Claude gets its question and the answer back in the next message, exactly as they were", async () => {
    const person = new Person();
    const claude = { keyId: keys.get("anthropic"), model: "claude-sonnet-5-5", effort: "low" };
    script = [{ calls: [ASK] }, { text: "Orange." }];
    const { conversationId } = await person.chat({ text: "Chart it", ...claude }, (ask, id) => person.answer(id, ask.id, { allow: true, text: "Orange" }));
    script = [{ text: "Sure." }];
    const from = service.requests.length;
    await person.chat({ text: "Thanks", conversationId, ...claude });
    const messages = since(from)[0].body.messages as { role: string; content: unknown }[];
    const blocks = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    assert.ok(blocks.some((b: { type?: string; name?: string }) => b.type === "tool_use" && b.name === "ask_person"));
    assert.ok(blocks.some((b: { type?: string; content?: unknown }) => b.type === "tool_result" && b.content === "The person chose: Orange"));
  });
});
