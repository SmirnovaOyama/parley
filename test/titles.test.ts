// Chat titles a model writes (server/titles.ts), cleaned to the house rules whatever came back.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cleanTitle } from "../server/titles.ts";

describe("titles", () => {
  test("keeps one line, without a label, quotes, Markdown, a closing full stop or Title Case", () => {
    assert.equal(cleanTitle('\nTitle: "How To Fix Login Errors."\nMore'), "How to fix login errors");
    assert.equal(cleanTitle("**「周末计划」**"), "周末计划");
    assert.equal(cleanTitle("标题：周末计划。。"), "周末计划");
  });

  test("takes time in proportion to what came back, however it's written", () => {
    // 200 KB of dots or quotes that a word follows took about 20 seconds with /[.。]+$/ and the like.
    for (const unit of [".", "。", '"', "」"]) {
      const started = Date.now();
      cleanTitle(`A${unit.repeat(200_000)}word`);
      assert.ok(Date.now() - started < 2000, `${unit} took ${Date.now() - started} ms`);
    }
  });
});
