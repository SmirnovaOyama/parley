import { anthropicProvider } from "./anthropic.ts";
import { customProvider } from "./custom.ts";
import { deepseekProvider } from "./deepseek.ts";
import { geminiProvider } from "./gemini.ts";
import { openaiProvider } from "./openai.ts";
import { opencodeGoProvider, opencodeProvider } from "./opencode.ts";
import { xaiProvider } from "./xai.ts";
import { t } from "../i18n.ts";
import type { ProviderId } from "./catalog.ts";
import type { ChatProvider } from "./types.ts";

const providers: Record<ProviderId, ChatProvider> = {
  anthropic: anthropicProvider,
  deepseek: deepseekProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  xai: xaiProvider,
  opencode: opencodeProvider,
  "opencode-go": opencodeGoProvider,
  custom: customProvider,
};

export function getProvider(id: string): ChatProvider {
  const provider = providers[id as ProviderId];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

/** Turns an SDK error into a sentence a person can act on. Both SDKs (Anthropic, OpenAI) expose `status`. */
export function describeProviderError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403) return t("The AI provider rejected the API key. Ask an admin to check it");
  if (status === 402) return t("The API key's account is out of credit. Ask an admin to top it up");
  if (status === 404) return t("The selected model isn't available for this key. Ask an admin to check it");
  if (status === 429) return t("The AI provider is rate limiting this key. Try again in a minute");
  if (status === 529 || status === 503) return t("The AI provider is busy right now. Try again in a minute");
  if (status === 400) return t("The AI provider couldn't process this conversation");
  return t("Couldn't reach the AI provider. Try again");
}

/**
 * Whether a failure is about the key or the provider (worth trying the backup key) rather than
 * about the conversation itself. Refusals never get here: they come back as a result.
 */
export function shouldUseBackup(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === undefined) return true; // couldn't connect, timed out
  return status >= 500 || [401, 402, 403, 404, 408, 429].includes(status);
}
