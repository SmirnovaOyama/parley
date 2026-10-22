// save_file: models without code of their own write files out as text, kept under the reply.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { sameOriginGuard, sessionMiddleware, type AppEnv } from "../server/auth.ts";
import { encryptSecret, hashToken } from "../server/crypto.ts";
import { db, nowIso } from "../server/db.ts";
import { chatRoutes } from "../server/routes/chat.ts";
import { chunk, completionStream, mockServer, type MockServer } from "./helpers/mock-server.ts";

const app = new Hono<AppEnv>();
app.use("*", sameOriginGuard, sessionMiddleware);
app.route("/api", chatRoutes);
let service: MockServer;
let keyId: number;
/** The save_file calls the model makes on its first turn of each reply. */
let saves: { name: string; content: string }[] = [];

before(async () => {
  service = await mockServer((req) => {
    if (saves.length && req.body.messages.at(-1)?.role === "user") {
      return completionStream([
        chunk({ tool_calls: saves.map((input, index) => ({
          index, id: `save_${index}`, type: "function", function: { name: "save_file", arguments: JSON.stringify(input) },
        })) }),
        chunk({}, "tool_calls"),
      ]);
    }
    return completionStream([chunk({ content: "Here it is" }), chunk({}, "stop")]);
  });
  keyId = Number(db.prepare(
    `INSERT INTO api_keys (label, provider, model, effort, encrypted_key, last4, shared, endpoint, models, code_execution, created_at)
     VALUES ('Writer', 'custom', 'alpha', 'default', ?, 'test', 1, ?, '["alpha"]', 1, ?)`,
  ).run(encryptSecret("sk-local-file-test"), JSON.stringify({
    baseUrl: `${service.url}/v1`, images: false, models: [{ id: "alpha", input: 1, output: 2 }],
  }), nowIso()).lastInsertRowid);
});
beforeEach(() => {
  saves = [];
  db.prepare("UPDATE api_keys SET code_execution = 1 WHERE id = ?").run(keyId);
});
after(() => service.close());

function person() {
  const token = randomUUID();
  const id = Number(db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, 'test', ?)")
    .run(`${randomUUID()}@example.com`, nowIso()).lastInsertRowid);
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), id, new Date(Date.now() + 86_400_000).toISOString(), nowIso());
  return async (text: string) => {
    const response = await app.request("http://parley.test/api/chat", {
      method: "POST",
      headers: { cookie: `sid=${token}`, origin: "http://parley.test", "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ text, keyId, model: "alpha", effort: "default" }),
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    const done = stream.split("\n").find((line) => line.startsWith("data: ") && line.includes('"message"') && line.includes('"files"'));
    assert.ok(done, stream);
    return JSON.parse(done.slice(6)).message as { text: string; files: { id: string; name: string; mime: string; size: number }[] };
  };
}
const offered = (index: number) => (service.requests[index].body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
const toolReply = (index: number) => service.requests[index].body.messages.filter((m: { role: string }) => m.role === "tool").map((m: { content: string }) => m.content);

test("a key with Make files on offers save_file, and what the model writes is kept under the reply", async () => {
  const send = person();
  saves = [{ name: "scores.csv", content: "name,score\nAda,9\n" }, { name: "notes.md", content: "# Notes\nFirst draft" }, { name: "notes.md", content: "# Notes\nFinal" }];
  const from = service.requests.length;
  const message = await send("Make me the scores table and some notes");
  assert.ok(offered(from).includes("save_file"));
  assert.equal(message.text, "Here it is");
  assert.deepEqual(message.files.map((f) => [f.name, f.mime]), [["scores.csv", "text/csv"], ["notes.md", "text/markdown"]]);
  const rows = db.prepare("SELECT name, path FROM message_files WHERE id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(message.files.map((f) => f.id))) as { name: string; path: string }[];
  assert.equal(readFileSync(rows.find((r) => r.name === "notes.md")!.path, "utf8"), "# Notes\nFinal");
  assert.equal(readFileSync(rows.find((r) => r.name === "scores.csv")!.path, "utf8"), "name,score\nAda,9\n");
});

test("save_file refuses formats that aren't text and names without an extension", async () => {
  const send = person();
  saves = [{ name: "report.xlsx", content: "a,b" }, { name: "README", content: "hi" }, { name: "../../etc/run.sh", content: "echo hi" }];
  const from = service.requests.length;
  const message = await send("Make a spreadsheet");
  const answers = toolReply(from + 1);
  assert.match(answers[0], /can't be written as text\. Save it as \.csv instead/);
  assert.match(answers[1], /name with an extension/);
  assert.match(answers[2], /Saved run\.sh/);
  assert.deepEqual(message.files.map((f) => f.name), ["run.sh"]);
});

test("with Make files off the tool isn't offered, and nothing is saved", async () => {
  db.prepare("UPDATE api_keys SET code_execution = 0 WHERE id = ?").run(keyId);
  const send = person();
  saves = [{ name: "notes.md", content: "hi" }];
  const from = service.requests.length;
  const message = await send("Write notes");
  assert.ok(!offered(from).includes("save_file"));
  assert.deepEqual(message.files ?? [], []);
});
