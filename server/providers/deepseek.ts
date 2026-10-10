// DeepSeek speaks the OpenAI chat-completions format at its own address, and reads text only.
import { compatProvider } from "./compat.ts";

export const deepseekProvider = compatProvider({
  baseURL: "https://api.deepseek.com",
  // Thinking is on by default at DeepSeek; "off" turns it off, otherwise it sets the effort
  // (low, high or max).
  thinking: (effort) => (effort === "off" ? { thinking: { type: "disabled" } } : { reasoning_effort: effort }),
  quick: () => ({ thinking: { type: "disabled" } }),
  maxTokens: 32768,
  systemMidChat: true,
  // In thinking mode a turn that calls tools has to come back with its reasoning.
  echoReasoning: true,
});
