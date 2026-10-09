// A stand-in for an AI provider: a local HTTP server on a free port that answers each request with
// whatever the test says, and remembers what it was sent. Nothing leaves the machine.
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A request as the mock saw it, with its body parsed when it was JSON. */
export type Received = { method: string; path: string; headers: IncomingHttpHeaders; body: any };

/** How the mock answers: writes the whole response. */
export type Reply = (res: ServerResponse) => void;

export type MockServer = {
  /** The server's address, without a trailing slash. */
  url: string;
  requests: Received[];
  close(): Promise<void>;
};

export async function mockServer(handle: (req: Received) => Reply | Promise<Reply>): Promise<MockServer> {
  const requests: Received[] = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part);
    const raw = Buffer.concat(parts).toString("utf8");
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // Not JSON: kept as text.
    }
    const received = { method: req.method ?? "", path: new URL(req.url ?? "/", "http://mock").pathname, headers: req.headers, body };
    requests.push(received);
    try {
      (await handle(received))(res);
    } catch (err) {
      // 418 rather than a 5xx, which the SDKs would retry with a wait.
      res.writeHead(418, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `Mock: ${err}` } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export const json =
  (body: unknown, status = 200): Reply =>
  (res) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };

/** A chat-completions stream: one data line per chunk, then [DONE]. */
export const completionStream =
  (chunks: unknown[]): Reply =>
  (res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  };

/** A Responses API stream: each event named after its type, and no [DONE]. */
export const responseStream =
  (events: ({ type: string } & Record<string, unknown>)[]): Reply =>
  (res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    events.forEach((event, i) => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: i })}\n\n`));
    res.end();
  };

/** One chat-completions chunk carrying this delta. */
export const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: 0,
  model: "mock",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/** The last chunk, which carries the usage when stream_options.include_usage is on. */
export const usageChunk = (usage: Record<string, unknown>) => ({
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: 0,
  model: "mock",
  choices: [],
  usage,
});

/** A model list, as GET /models answers. */
export const modelList = (models: (string | Record<string, unknown>)[]) =>
  json({ object: "list", data: models.map((m) => (typeof m === "string" ? { id: m, object: "model", owned_by: "mock" } : { object: "model", ...m })) });
