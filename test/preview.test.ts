// The page that runs code from a reply (server/preview.ts). Anyone can open it, so it must show
// only code that this site's own pages send it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import vm from "node:vm";
import { PREVIEW_SHELL } from "../server/preview.ts";

const SITE = "https://parley.example";
const script = PREVIEW_SHELL.match(/<script>([\s\S]*)<\/script><\/body>/)![1];

/** Runs the page's script with a stand-in window, as framed by `parent` or opened by `opener`. */
function shell({ framed }: { framed: boolean }) {
  const listeners: ((e: unknown) => void)[] = [];
  const written: string[] = [];
  const other = { postMessage() {} };
  const win: Record<string, unknown> = {
    location: { origin: SITE },
    addEventListener: (type: string, fn: (e: unknown) => void) => type === "message" && listeners.push(fn),
    document: { open() {}, write: (html: string) => written.push(html), close() {} },
  };
  win.window = win;
  win.parent = framed ? other : win;
  win.opener = framed ? null : other;
  vm.runInNewContext(script, win);
  const send = (origin: string, source: unknown = other) =>
    listeners.forEach((fn) => fn({ data: { type: "preview-code", kind: "html", code: "<p>Hello</p>" }, origin, source }));
  return { send, written, other };
}

describe("preview", () => {
  test("shows code from the chat that framed it", () => {
    const page = shell({ framed: true });
    page.send(SITE);
    assert.equal(page.written.length, 1);
    assert.match(page.written[0], /<p>Hello<\/p>/);
  });

  test("shows code from the chat that opened it in a tab", () => {
    const page = shell({ framed: false });
    page.send(SITE);
    assert.equal(page.written.length, 1);
  });

  test("ignores code from another site, even the one that opened it", () => {
    const page = shell({ framed: false });
    page.send("https://evil.example");
    page.send("null");
    assert.equal(page.written.length, 0);
  });

  test("ignores code from this site's other windows", () => {
    const page = shell({ framed: true });
    page.send(SITE, { postMessage() {} });
    assert.equal(page.written.length, 0);
  });
});
