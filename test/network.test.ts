// Where a request comes from (server/network.ts): a proxy's X-Forwarded-For counts only from a
// proxy on this machine or network, or from anywhere with TRUST_PROXY.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Context } from "hono";
import { env } from "../server/env.ts";
import { clientAddress } from "../server/network.ts";

/** A request as @hono/node-server hands it over: connected from `remote`, with these headers. */
function from(remote: string, headers: Record<string, string> = {}): Context {
  return {
    env: { incoming: { socket: { remoteAddress: remote, remotePort: 40000, remoteFamily: remote.includes(":") ? "IPv6" : "IPv4" } } },
    req: { header: (name: string) => headers[name.toLowerCase()] },
  } as unknown as Context;
}

afterEach(() => {
  env.trustProxy = false;
});

test("a proxy on this machine or network passes on the visitor's address, the last it added", () => {
  assert.equal(clientAddress(from("127.0.0.1", { "x-forwarded-for": "10.9.8.7, 198.51.100.20" })), "198.51.100.20");
  assert.equal(clientAddress(from("172.18.0.3", { "x-forwarded-for": "203.0.113.5" })), "203.0.113.5");
  assert.equal(clientAddress(from("::ffff:192.168.1.2", { "x-forwarded-for": "203.0.113.6" })), "203.0.113.6");
});

test("someone reaching the server from the internet can't name another address", () => {
  assert.equal(clientAddress(from("198.51.100.30", { "x-forwarded-for": "203.0.113.7" })), "198.51.100.30");
  assert.equal(clientAddress(from("127.0.0.1")), "127.0.0.1");
});

test("with TRUST_PROXY, the proxy's word counts from any address it connects from", () => {
  env.trustProxy = true;
  assert.equal(clientAddress(from("100.96.4.2", { "x-forwarded-for": "198.51.100.40" })), "198.51.100.40");
  // A request with nothing to pass on is still where it connected from.
  assert.equal(clientAddress(from("100.96.4.2")), "100.96.4.2");
});
