// The site notice: admins post it, everyone signed in gets it with their account, and dismissing
// hides only the version they saw.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { sameOriginGuard, sessionMiddleware, type AppEnv } from "../server/auth.ts";
import { hashToken } from "../server/crypto.ts";
import { db, nowIso } from "../server/db.ts";
import { adminRoutes } from "../server/routes/admin.ts";
import { authRoutes } from "../server/routes/auth.ts";

const app = new Hono<AppEnv>();
app.use("*", sameOriginGuard, sessionMiddleware);
app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);

class Person {
  token = randomUUID();
  constructor(role: "admin" | "user" = "user") {
    const id = db.prepare("INSERT INTO users (email, password_hash, role, created_at) VALUES (?, 'test', ?, ?)")
      .run(`${randomUUID()}@example.com`, role, nowIso()).lastInsertRowid;
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(this.token), id, new Date(Date.now() + 86_400_000).toISOString(), nowIso());
  }
  async json(method: string, path: string, body?: unknown) {
    const response = await app.request(`http://parley.test/api${path}`, {
      method, headers: { cookie: `sid=${this.token}`, origin: "http://parley.test", "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  }
  async notice() {
    return (await this.json("GET", "/auth/me")).body.notice as { text: string; version: number } | null;
  }
}

const admin = new Person("admin");
const member = new Person();
const other = new Person();

test("only admins can post or take down the notice", async () => {
  assert.equal((await member.json("PUT", "/admin/notice", { text: "Free tokens for all" })).status, 403);
  assert.equal((await member.json("DELETE", "/admin/notice")).status, 403);
  assert.equal(await member.notice(), null);
  assert.equal((await admin.json("PUT", "/admin/notice", { text: "   " })).status, 400);
  assert.equal((await admin.json("PUT", "/admin/notice", { text: "x".repeat(501) })).status, 400);
  assert.equal(await member.notice(), null);
});

test("everyone signed in gets the notice, on one line", async () => {
  const posted = await admin.json("PUT", "/admin/notice", { text: "  Down for maintenance\n on Saturday  " });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.notice.text, "Down for maintenance on Saturday");
  for (const person of [admin, member, other]) assert.equal((await person.notice())?.text, "Down for maintenance on Saturday");
  assert.equal((await admin.json("GET", "/admin/settings")).body.notice.text, "Down for maintenance on Saturday");
  const log = (await admin.json("GET", "/admin/audit")).body.entries;
  assert.equal(log[0].action, "post_notice");
});

test("dismissing hides that version only, and a changed notice shows again", async () => {
  const first = (await member.notice())!;
  assert.equal((await member.json("POST", "/auth/notice/dismiss", { version: first.version })).status, 200);
  assert.equal(await member.notice(), null);
  assert.equal((await other.notice())?.version, first.version, "someone else still sees it");

  // Saving the same words again isn't a new version.
  await admin.json("PUT", "/admin/notice", { text: "Down for maintenance on Saturday" });
  assert.equal(await member.notice(), null);

  // A made-up later version doesn't hide notices that aren't written yet.
  await member.json("POST", "/auth/notice/dismiss", { version: first.version + 50 });
  const changed = await admin.json("PUT", "/admin/notice", { text: "Maintenance moved to Sunday" });
  assert.equal(changed.body.notice.version, first.version + 1);
  assert.equal((await member.notice())?.text, "Maintenance moved to Sunday");
  assert.equal((await admin.json("GET", "/admin/audit")).body.entries[0].action, "edit_notice");
});

test("taking the notice down hides it from everyone", async () => {
  const taken = await admin.json("DELETE", "/admin/notice");
  assert.equal(taken.status, 200);
  for (const person of [admin, member, other]) assert.equal(await person.notice(), null);
  assert.equal((await admin.json("GET", "/admin/settings")).body.notice, null);
  assert.equal((await admin.json("GET", "/admin/audit")).body.entries[0].action, "take_down_notice");

  // Posting again later is a new version, so people who dismissed the old one see it.
  await admin.json("PUT", "/admin/notice", { text: "Maintenance moved to Sunday" });
  assert.equal((await member.notice())?.text, "Maintenance moved to Sunday");
});

test("the notice needs a session", async () => {
  assert.equal((await app.request("http://parley.test/api/auth/notice/dismiss", { method: "POST", headers: { origin: "http://parley.test", "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: "{\"version\":1}" })).status, 401);
});
