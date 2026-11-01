// Which models a key offers and runs, what can be attached for them, and what a reply costs
// (server/keys.ts and the catalog's estimateCost).
import "./helpers/temp-env.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { allowedModels, keyModel, modelsOf, readsFor, withChoice, type EndpointModel, type KeyRow } from "../server/keys.ts";
import { estimateCost, findModel, findProvider } from "../server/providers/catalog.ts";

const key = (fields: Partial<KeyRow>): KeyRow => ({
  id: 1,
  label: "Team key",
  provider: "anthropic",
  model: "claude-opus-5-5",
  effort: "low",
  encrypted_key: "",
  last4: "abcd",
  is_default: 0,
  shared: 1,
  fallback_key_id: null,
  web_search: 0,
  code_execution: 0,
  models: null,
  endpoint: null,
  created_at: "2026-10-01T00:00:00.000Z",
  ...fields,
});

/** A key on another service, listing these models. */
const serviceKey = (models: EndpointModel[], fields: Partial<KeyRow> = {}, images = false) =>
  key({ provider: "custom", model: models[0].id, effort: "default", endpoint: JSON.stringify({ baseUrl: "https://llm.example.com/v1", models, images }), ...fields });

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);

describe("allowedModels", () => {
  test("offers every model but the expensive ones by default", () => {
    assert.deepEqual(allowedModels(key({})), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  });

  test("leaves the expensive models off an OpenCode key too", () => {
    const offered = allowedModels(key({ provider: "opencode" }));
    assert.equal(offered.length, findProvider("opencode")!.models.length - 2);
    assert.equal(offered.includes("claude-fable-5-1") || offered.includes("gpt-6-astra"), false);
  });

  test("offers every model of an OpenCode Go key, since none of them is expensive", () => {
    assert.deepEqual(allowedModels(key({ provider: "opencode-go", model: "glm-5.3-flash" })), findProvider("opencode-go")!.models.map((m) => m.id));
  });

  test("always offers the model new chats start on, even an expensive one", () => {
    assert.deepEqual(allowedModels(key({ model: "claude-fable-5-1" })), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);
  });

  test("offers the models ticked, in catalog order, and only real ones", () => {
    const models = JSON.stringify(["claude-haiku-5-5", "claude-opus-5-5", "claude-made-up"]);
    assert.deepEqual(allowedModels(key({ models })), ["claude-opus-5-5", "claude-haiku-5-5"]);
    assert.deepEqual(allowedModels(key({ model: "claude-sonnet-5-5", models: JSON.stringify(["claude-haiku-5-5"]) })), ["claude-sonnet-5-5", "claude-haiku-5-5"]);
  });

  test("keeps the default list when the saved one can't be read", () => {
    assert.deepEqual(allowedModels(key({ models: "not json" })), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    assert.deepEqual(allowedModels(key({ models: '{"a":1}' })), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  });

  test("offers the models listed for another service", () => {
    const models = [{ id: "qwen3.8-max", input: 1, output: 4 }, { id: "qwen3.8-plus", input: null, output: null }];
    assert.deepEqual(allowedModels(serviceKey(models)), ["qwen3.8-max", "qwen3.8-plus"]);
    assert.deepEqual(allowedModels(serviceKey(models, { models: JSON.stringify(["qwen3.8-max"]) })), ["qwen3.8-max"]);
  });

  test("offers nothing for a provider the catalog doesn't know", () => {
    assert.deepEqual(allowedModels(key({ provider: "gone", model: "x" })), []);
  });
});

describe("withChoice", () => {
  const opus = key({ effort: "high" });

  test("runs the model and level asked for when the key allows them", () => {
    const chosen = withChoice(opus, "claude-haiku-5-5", "off");
    assert.equal(chosen.model, "claude-haiku-5-5");
    assert.equal(chosen.effort, "off");
    assert.equal(chosen.label, "Team key");
    // The key itself is left as it was.
    assert.equal(opus.model, "claude-opus-5-5");
  });

  test("keeps the key's own model and level when nothing is asked", () => {
    assert.deepEqual([withChoice(opus).model, withChoice(opus).effort], ["claude-opus-5-5", "high"]);
    assert.deepEqual([withChoice(opus, null, null).model, withChoice(opus, null, null).effort], ["claude-opus-5-5", "high"]);
  });

  test("falls back to the key's model for one it doesn't offer", () => {
    const fable = withChoice(opus, "claude-fable-5-1", "max");
    assert.equal(fable.model, "claude-opus-5-5");
    assert.equal(fable.effort, "max");
    assert.equal(withChoice(opus, "gpt-6.1-sol").model, "claude-opus-5-5");
  });

  test("keeps the key's level for its own model when the one asked for doesn't apply", () => {
    // Opus can't turn thinking off.
    assert.equal(withChoice(opus, "claude-opus-5-5", "off").effort, "high");
  });

  test("uses the model's own default level where the key's doesn't apply", () => {
    const sonnet = key({ model: "claude-sonnet-5-5", effort: "off" });
    assert.equal(withChoice(sonnet, "claude-opus-5-5").effort, "low");
    assert.equal(withChoice(opus, "claude-haiku-5-5", "bogus").effort, "low");
    const flash = key({ provider: "gemini", model: "gemini-3.8-flash", effort: "high" });
    assert.equal(withChoice(flash, "gemini-3.5-flash-lite").effort, "minimal");
  });

  test("thinks at the service's default on another service", () => {
    const chosen = withChoice(serviceKey([{ id: "a", input: null, output: null }, { id: "b", input: null, output: null }]), "b", "high");
    assert.equal(chosen.model, "b");
    assert.equal(chosen.effort, "default");
  });
});

describe("modelsOf", () => {
  test("lists the catalog's models for a catalog provider", () => {
    assert.equal(modelsOf(key({ provider: "deepseek" })), findProvider("deepseek")!.models);
  });

  test("lists another service's models as the admin set them", () => {
    const models = modelsOf(serviceKey([{ id: "kimi-k3", input: 0.6, output: 2.5 }, { id: "kimi-free", input: null, output: null }], {}, true));
    assert.deepEqual(models, [
      // Cache reads cost the full input price: services differ in what they charge.
      { id: "kimi-k3", label: "kimi-k3", input: 0.6, output: 2.5, cacheRead: 0.6, cacheWrite: 0.6, efforts: ["default"], defaultEffort: "default", reads: ["image", "text"] },
      { id: "kimi-free", label: "kimi-free", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, efforts: ["default"], defaultEffort: "default", reads: ["image", "text"] },
    ]);
  });

  test("lists nothing when another service's address and models can't be read", () => {
    assert.deepEqual(modelsOf(key({ provider: "custom", endpoint: null })), []);
    assert.deepEqual(modelsOf(key({ provider: "custom", endpoint: "{" })), []);
    assert.deepEqual(modelsOf(key({ provider: "custom", endpoint: '{"baseUrl":"https://x.example"}' })), []);
    assert.deepEqual(modelsOf(key({ provider: "gone" })), []);
  });
});

describe("readsFor", () => {
  test("lets Claude and OpenAI take any file in a chat that runs code, when the key may", () => {
    for (const k of [key({ code_execution: 1 }), key({ provider: "openai", model: "gpt-6.1-sol", code_execution: 1 })]) {
      assert.deepEqual(readsFor(k, true), ["image", "pdf", "text", "other"]);
      assert.deepEqual(readsFor(k, false), ["image", "pdf", "text"]);
    }
    assert.deepEqual(readsFor(key({ code_execution: 0 }), true), ["image", "pdf", "text"]);
  });

  test("gives the others what their models open, and never anything else", () => {
    assert.deepEqual(readsFor(key({ provider: "deepseek", model: "deepseek-flash", code_execution: 1 }), true), ["text"]);
    assert.deepEqual(readsFor(key({ provider: "gemini", model: "gemini-3.8-flash" }), true), ["image", "text"]);
    assert.deepEqual(readsFor(key({ provider: "xai", model: "grok-4.7" }), true), ["image", "text"]);
  });

  test("gives OpenCode's models pictures but no PDFs, and text alone where that's all they read", () => {
    assert.deepEqual(readsFor(key({ provider: "opencode", model: "claude-opus-5-5", code_execution: 1 }), true), ["image", "text"]);
    assert.deepEqual(readsFor(key({ provider: "opencode", model: "glm-5.3" }), true), ["text"]);
    assert.deepEqual(readsFor(key({ provider: "opencode-go", model: "kimi-k3.1-pro" }), true), ["image", "text"]);
    assert.deepEqual(readsFor(key({ provider: "opencode-go", model: "deepseek-v4-pro" }), true), ["text"]);
  });

  test("lets another service take pictures only when the admin said it reads them", () => {
    const models = [{ id: "m", input: null, output: null }];
    assert.deepEqual(readsFor(serviceKey(models, { code_execution: 1 }), true), ["text"]);
    assert.deepEqual(readsFor(serviceKey(models, {}, true), true), ["image", "text"]);
  });
});

describe("estimateCost", () => {
  const usage = { input: 1_000_000, output: 200_000, cacheRead: 400_000, cacheWrite: 0 };
  const service = serviceKey([{ id: "priced", input: 0.5, output: 1.5 }, { id: "unpriced", input: null, output: null }]);

  test("prices another service's model as the admin set it, cache reads at the input price", () => {
    near(estimateCost(keyModel(service, "priced"), usage, "custom"), 0.5 + 0.3 + 0.2);
  });

  test("counts another service's model with no prices as free", () => {
    assert.equal(estimateCost(keyModel(service, "unpriced"), usage, "custom"), 0);
  });

  test("counts a model the key doesn't have as free", () => {
    assert.equal(estimateCost(keyModel(service, "elsewhere"), usage, "custom"), 0);
  });

  test("adds searches at the provider's price, where it has one", () => {
    const searched = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 3 };
    near(estimateCost(findModel("openai", "gpt-6.1-sol"), searched, "openai"), 2 + 0.03);
    near(estimateCost(keyModel(service, "priced"), searched, "custom"), 0.5);
  });
});
