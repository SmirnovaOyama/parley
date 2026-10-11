// OpenAI, through its Responses API: reasoning summaries, images and PDFs read directly, and its
// web search and code interpreter tools.
import { responsesProvider } from "./responses.ts";

/** How OpenAI is set up, at its own address (tests reuse it at a mock's). */
export const openaiOptions = {
  provider: "openai",
  pdf: true,
  noteRole: "developer",
  summaries: () => true,
  tools: true,
} as const satisfies Parameters<typeof responsesProvider>[0];

export const openaiProvider = responsesProvider(openaiOptions);
