// Every SDK client the server makes for an AI provider, with its address and credentials spelled
// out. Left to themselves the SDKs read ANTHROPIC_BASE_URL, OPENAI_BASE_URL, ANTHROPIC_AUTH_TOKEN,
// OPENAI_ORG_ID and the like from the environment: whatever set one there would have every admin's
// key sent to an address of its choosing (a reverse proxy that keeps them, say), or another
// account's credentials sent along with it. Here a key goes only where its provider is.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export const ANTHROPIC_API = "https://api.anthropic.com";
export const OPENAI_API = "https://api.openai.com/v1";

export function anthropicClient(apiKey: string, maxRetries: number): Anthropic {
  return new Anthropic({ apiKey, authToken: null, baseURL: ANTHROPIC_API, maxRetries });
}

/** OpenAI's own API, or a service in its format at `baseURL` (DeepSeek, Gemini, Grok, another service). */
export function openaiClient(apiKey: string, baseURL: string, maxRetries: number): OpenAI {
  return new OpenAI({ apiKey, baseURL, organization: null, project: null, maxRetries });
}
