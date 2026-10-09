import { anthropicProvider } from "./anthropic.ts";
import { deepseekProvider } from "./deepseek.ts";
import type { ProviderId } from "./catalog.ts";
import type { ChatProvider } from "./types.ts";

const providers: Record<ProviderId, ChatProvider> = {
  anthropic: anthropicProvider,
  deepseek: deepseekProvider,
};

export function getProvider(id: string): ChatProvider {
  const provider = providers[id as ProviderId];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

/** Turns an SDK error into a sentence a person can act on. Both SDKs expose `status`. */
export function describeProviderError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403) return "The AI provider rejected the API key. Ask an admin to check it";
  if (status === 402) return "The API key's account is out of credit. Ask an admin to top it up";
  if (status === 404) return "The selected model isn't available for this key. Ask an admin to check it";
  if (status === 429) return "The AI provider is rate limiting this key. Try again in a minute";
  if (status === 529 || status === 503) return "The AI provider is busy right now. Try again in a minute";
  if (status === 400) return "The AI provider couldn't process this conversation";
  return "Couldn't reach the AI provider. Try again";
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
