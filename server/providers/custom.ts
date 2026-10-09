// A service of the admin's choosing that speaks OpenAI's chat format (OpenRouter, Groq, Mistral,
// Qwen, Kimi, GLM, a local Ollama...). Each key brings the address and the model names. Nothing
// beyond the common core is sent: services differ in how thinking is set and in how long a reply
// they allow, so those stay at each model's own default.
import { compatProvider } from "./compat.ts";

export const customProvider = compatProvider({
  baseURL: null,
  thinking: () => ({}),
  quick: () => ({}),
  // Chat templates of many open models take a system message only at the start.
  systemMidChat: false,
  // Open reasoning models served raw open their reply with it in <think> tags.
  thinkTags: true,
});
