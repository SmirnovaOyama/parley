// The line of a message a search result shows (server/chat-search.ts): around the first match, as
// plain text, short enough for a phone whatever the language.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { snippetOf, wordsOf } from "../server/chat-search.ts";

describe("chat search", () => {
  test("splits a query into its words, in lower case, once each", () => {
    assert.deepEqual(wordsOf("  Docker  compose docker "), ["docker", "compose"]);
    assert.deepEqual(wordsOf("数据库迁移"), ["数据库迁移"]);
    assert.deepEqual(wordsOf(" "), []);
  });

  test("a short message comes whole", () => {
    assert.equal(snippetOf("Hello there", ["hello"]), "Hello there");
    assert.equal(snippetOf("短消息：数据库迁移完成", ["迁移"]), "短消息：数据库迁移完成");
  });

  test("starts a little before the match, on a whole word, without Markdown", () => {
    const text = `${"Some words first. ".repeat(20)}Here is **the plan** for [the move](https://example.com) in \`prod\`:\n\n## Steps\n- back up\n- move ${"and more after. ".repeat(20)}`;
    const snippet = snippetOf(text, ["plan"]);
    assert.match(snippet, /^…first\. Here is the plan for the move in prod: Steps back up move and more/);
    assert.match(snippet, /after\.…$/);
  });

  test("Chinese takes twice the room, and is cut anywhere", () => {
    const text = `${"这是一段很长的中文。".repeat(30)}关键字在这里${"后面还有很多内容。".repeat(30)}`;
    const snippet = snippetOf(text, ["关键字"]);
    // Twelve characters before the match, sixty in all.
    assert.equal(snippet, "…文。这是一段很长的中文。关键字在这里后面还有很多内容。后面还有很多内容。后面还有很多内容。后面还有很多内容。后面还有很多…");
    // A space before a Latin word in Chinese text doesn't throw away the Chinese before it.
    assert.equal(snippetOf("一周都一致后，把读请求切到 Postgres；最后切写请求", ["postgres"]), "…都一致后，把读请求切到 Postgres；最后切写请求");
  });

  test("never cuts an emoji in half", () => {
    const snippet = snippetOf(`${"😀".repeat(300)}x${"😀".repeat(300)}`, ["x"]);
    assert.doesNotMatch(snippet, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    assert.ok(snippet.includes("x"));
  });
});
