// Which of the app's own tools a reply may run (server/tools.ts): only those the model was offered
// in that request, whatever name it sends back.
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { saveSettings } from "../server/db.ts";
import { chatToolkit } from "../server/tools.ts";

const kit = () =>
  chatToolkit({ userId: 1, conversationId: "chat", declared: [], signal: new AbortController().signal, onStatus: () => {} });

describe("chat tools", () => {
  // The site's search service is set up, so web search and page reading would work if offered.
  saveSettings({ searchProvider: "searxng", searchUrl: "http://127.0.0.1:9" });

  test("offers web search and page reading only where asked", () => {
    assert.deepEqual(kit().offer(false).functions, []);
    assert.deepEqual(kit().offer(true).functions.map((f) => f.name), ["web_search", "read_page"]);
  });

  test("won't run a tool the model wasn't offered", async () => {
    const tools = kit();
    for (const name of ["read_page", "web_search", "memory", "search_knowledge"]) {
      const outcome = await tools.offer(false).runTool({ id: "1", name, input: { url: "http://127.0.0.1/", query: "x" } });
      assert.deepEqual(outcome, { content: `There's no tool called ${name} in this chat`, isError: true });
    }
    assert.deepEqual(tools.uses, []);
  });

  test("runs one it was offered", async () => {
    const tools = kit();
    // The page reader gets the call, and turns this address down itself.
    const outcome = await tools.offer(true).runTool({ id: "1", name: "read_page", input: { url: "http://127.0.0.1/" } });
    assert.equal(outcome.isError, true);
    assert.doesNotMatch(outcome.content, /no tool called/);
    assert.deepEqual(tools.uses, [{ kind: "page", text: "Couldn't read 127.0.0.1", error: true }]);
  });
});
