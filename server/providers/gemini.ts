// Google's Gemini through its OpenAI-compatible endpoint. Google's own settings go under a field
// that is literally named extra_body. Gemini 3 always thinks; its level (and whether a summary of
// the thinking comes back, as <thought> text ahead of the answer) is set there.
import { findModel } from "./catalog.ts";
import { compatProvider } from "./compat.ts";

const thinkingConfig = (level: string, show: boolean) => ({
  extra_body: { google: { thinking_config: { thinking_level: level, ...(show ? { include_thoughts: true } : {}) } } },
});

export const geminiProvider = compatProvider({
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  thinking: (effort, _model, show) => thinkingConfig(effort, show),
  quick: (model) => thinkingConfig(findModel("gemini", model)?.efforts[0] ?? "low", false),
  // It gathers system messages into one instruction, losing where a note came in the chat.
  systemMidChat: false,
  thinkTags: true,
});
