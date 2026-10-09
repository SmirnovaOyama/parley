// OpenAI, through its Responses API: reasoning summaries, images and PDFs read directly, and its
// web search and code interpreter tools.
import { responsesProvider } from "./responses.ts";

export const openaiProvider = responsesProvider({
  provider: "openai",
  pdf: true,
  noteRole: "developer",
  summaries: () => true,
  tools: true,
});
