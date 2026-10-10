// Reading what people and pages send in: zip archives (Word documents, chat exports) and HTML
// (pages read for a model, knowledge documents). Crafted input must take neither the server's
// memory nor its time.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, test } from "node:test";
import { htmlText, partsOf } from "../server/knowledge.ts";
import { readZip } from "../server/zip.ts";
import { zipOf } from "./helpers/zip.ts";

describe("zip", () => {
  test("reads stored and deflated files", () => {
    const text = Buffer.from("Hello from the archive");
    assert.equal(readZip(zipOf("a.txt", text, 0, text.length))![0].read(1024).toString(), "Hello from the archive");
    assert.equal(readZip(zipOf("b.txt", deflateRawSync(text), 8, text.length))![0].read(1024).toString(), "Hello from the archive");
  });

  test("won't unpack a file bigger than asked for", () => {
    const entry = readZip(zipOf("conversations.json", deflateRawSync(Buffer.alloc(1024)), 8, 0xffffffff))![0];
    assert.equal(entry.size, 0xffffffff);
    assert.throws(() => entry.read(1024 * 1024), /conversations.json is too big to open/);
  });

  test("won't unpack a file packed far tighter than real files are", () => {
    // 8 MB of zeros packs into about 8 KB, a thousand to one, and the archive says so.
    const zeros = Buffer.alloc(8 * 1024 * 1024);
    const bomb = readZip(zipOf("word/document.xml", deflateRawSync(zeros), 8, zeros.length))![0];
    assert.throws(() => bomb.read(64 * 1024 * 1024), /word\/document.xml is packed too tightly to open/);

    // An export's JSON packs a few times smaller, and a small file opens whatever it packs to.
    const json = Buffer.from(
      JSON.stringify(Array.from({ length: 20_000 }, (_, i) => ({ id: randomUUID(), title: `Chat ${i}`, text: "Hello" }))),
    );
    assert.ok(json.length > 1024 * 1024);
    assert.equal(readZip(zipOf("conversations.json", deflateRawSync(json), 8, json.length))![0].read(64 * 1024 * 1024).length, json.length);
    const small = Buffer.alloc(512 * 1024);
    assert.equal(readZip(zipOf("conversations.json", deflateRawSync(small), 8, small.length))![0].read(1024 * 1024).length, small.length);
  });

  test("stops at the size the archive states, when the file holds more", () => {
    // 64 MB of zeros packs into about 64 KB; the archive claims it's 1 KB.
    const entry = readZip(zipOf("word/document.xml", deflateRawSync(Buffer.alloc(64 * 1024 * 1024)), 8, 1024))![0];
    assert.throws(() => entry.read(1024 * 1024), /word\/document.xml is damaged/);
  });
});

describe("html", () => {
  test("keeps the words and drops scripts, styles, comments and tags", () => {
    const page = `<html><head><title>T</title><style>p{color:red}</style></head><body><!-- a note -->
      <h1>Heading</h1><p>One &amp; two</p><script>var x = "<p>not text</p>";</script><ul><li>first<li>second</ul></body></html>`;
    assert.equal(htmlText(page), "T\nHeading\nOne & two\n\n• first\n• second");
  });

  test("keeps the words after a comment that never closes, and a character past Unicode as written", () => {
    assert.equal(htmlText("<p>before</p><!-- open <b>after</b> &#99999999;"), "before\n<!-- open after &#99999999;");
  });

  test("takes time in proportion to the page, however it's written", () => {
    // Each of these took minutes at this size with patterns that try again from every "<".
    for (const unit of ["<a", "<!--", "<script", "<br", "<li"]) {
      const page = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
      const started = Date.now();
      htmlText(page);
      assert.ok(Date.now() - started < 2000, `${unit} took ${Date.now() - started} ms`);
    }
  });
});

describe("knowledge parts", () => {
  test("drops the spaces at the ends of lines and keeps one blank line between paragraphs", () => {
    assert.deepEqual(partsOf("One  \r\nTwo\t\n\n\n\nThree   "), ["One\nTwo\n\nThree"]);
  });

  test("takes time in proportion to the document, however it's written", () => {
    // 200 KB of spaces with no line break after them took half a minute with /[ \t]+\n/.
    for (const unit of [" ", "\t", " \t", " x", " \n"]) {
      const text = unit.repeat(Math.ceil((1024 * 1024) / unit.length)) + "end";
      const started = Date.now();
      partsOf(text);
      assert.ok(Date.now() - started < 2000, `${JSON.stringify(unit)} took ${Date.now() - started} ms`);
    }
  });
});
