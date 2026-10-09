// xAI's Grok, through the Responses API it shares with OpenAI (its chat-completions API is legacy
// and shows no reasoning). It takes JPEG and PNG pictures; PDFs would need its own file store.
import { responsesProvider } from "./responses.ts";

export const xaiProvider = responsesProvider({
  provider: "xai",
  baseURL: "https://api.x.ai/v1",
  pdf: false,
  imageTypes: ["image/jpeg", "image/png"],
  noteRole: "system",
  // Only Grok 4.7 summarises its reasoning.
  summaries: (model) => model.startsWith("grok-4.7"),
});
