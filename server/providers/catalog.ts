// What admins can pick when they add a key. Prices are USD per million tokens and only feed
// the usage estimates; DeepSeek bills peak hours at these rates and off-peak at half.
import { t } from "../i18n.ts";

export type ProviderId = "anthropic" | "deepseek" | "openai" | "gemini" | "xai" | "opencode" | "custom";

/** Kinds of attached file a model can open itself. */
export type FileKind = "image" | "pdf" | "text";

/**
 * Thinking levels. "off" turns thinking off where the model allows it: Claude Sonnet 5.5 via
 * `between_tools`, Claude Haiku 5.5 via `disabled`, DeepSeek via `thinking.type: disabled`, GPT-6
 * Luna and Grok 4.3 via effort `none` (and through OpenCode, GPT-6 Luna and Mistral Large 4). The
 * others always think (Gemini 3 included). "default" sends no setting at all, for services whose
 * thinking can't be set from here, and MiniMax M3 through OpenCode.
 */
export const EFFORT_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  default: "Default",
};

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export type ModelInfo = {
  id: string;
  label: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Thinking levels this model accepts, lowest first. */
  efforts: string[];
  /** What a new key starts on. Chat replies come back fastest at the low end. */
  defaultEffort: string;
  /** Claude only: whether the request can carry server-side refusal fallbacks. */
  fallbacks?: boolean;
  /** What it opens of the files people attach, where it differs from the rest of its provider. */
  reads?: FileKind[];
  /** How many tokens it reads at once (its context window), for the meter over the message box. */
  context?: number;
};

/**
 * Models a key leaves out unless an admin ticks them: Fable 5.1 costs two and a half times Opus
 * 5.5, and GPT-6 Astra five times GPT-6.1 Sol, so they're a deliberate choice rather than part of
 * "every model".
 */
export const OFF_BY_DEFAULT = new Set(["claude-fable-5-1", "gpt-6-astra"]);

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  /** A short line under its name where admins pick a provider; what it can do is listed apart. */
  detail?: string;
  models: ModelInfo[];
  defaultModel: string;
  /** What its models open of the files people attach (and anything at all in chats that run code, with tools). */
  reads: FileKind[];
  /** Its models aren't listed here: each key brings an address and the model names it serves. */
  custom?: boolean;
  /**
   * It searches the web and runs code to make files with its own tools, where a key's switches
   * allow. A search is billed apart, at this many dollars; the sandbox's time isn't counted here.
   */
  tools?: { searchPrice: number };
};

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Claude",
    detail: "Anthropic's models",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, efforts: CLAUDE_EFFORTS, defaultEffort: "low", fallbacks: true, context: 1_000_000 },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, efforts: ["off", ...CLAUDE_EFFORTS], defaultEffort: "low", fallbacks: true, context: 1_000_000 },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, efforts: ["off", ...CLAUDE_EFFORTS], defaultEffort: "low", context: 1_000_000 },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, efforts: CLAUDE_EFFORTS, defaultEffort: "low", fallbacks: true, context: 1_000_000 },
    ],
    defaultModel: "claude-opus-5-5",
    reads: ["image", "pdf", "text"],
    // $10 per 1,000 searches. Code runs free alongside search, else $0.05 an hour past 1,550 free hours a month.
    tools: { searchPrice: 0.01 },
  },
  // Prices and context windows as of October 2026. OpenAI bills writing the cache too. A prompt over 272K tokens (OpenAI)
  // or 200K (Gemini Pro, Grok) costs more; these are the everyday rates.
  {
    id: "openai",
    label: "OpenAI",
    detail: "The models behind ChatGPT",
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "low", context: 1_050_000 },
      { id: "gpt-6-luna", label: "GPT-6 Luna", input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, efforts: ["off", "low", "medium", "high", "xhigh", "max"], defaultEffort: "low", context: 1_050_000 },
      { id: "gpt-6-astra", label: "GPT-6 Astra", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "low", context: 1_050_000 },
    ],
    defaultModel: "gpt-6.1-sol",
    reads: ["image", "pdf", "text"],
    // $10 per 1,000 searches, plus the pages read as input tokens (in the usage already). Code
    // runs in a 1 GB container at $0.03 per 20-minute session, billed by the minute.
    tools: { searchPrice: 0.01 },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    models: [
      { id: "deepseek-flash", label: "DeepSeek Flash", input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3, efforts: ["off", "low", "high", "max"], defaultEffort: "off", context: 1_000_000 },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32, efforts: ["off", "low", "high", "max"], defaultEffort: "off", context: 1_000_000 },
    ],
    defaultModel: "deepseek-flash",
    reads: ["text"],
  },
  {
    id: "gemini",
    label: "Gemini",
    // Google's OpenAI-compatible endpoint takes pictures but not PDFs.
    detail: "Google's models",
    models: [
      // $1.50 in, $0.15 cached and $7.50 out from 1 January 2027.
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75, efforts: ["low", "medium", "high"], defaultEffort: "low", context: 1_048_576 },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2, efforts: ["low", "medium", "high"], defaultEffort: "low", context: 1_048_576 },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3, efforts: ["minimal", "low", "medium", "high"], defaultEffort: "minimal", context: 1_048_576 },
    ],
    defaultModel: "gemini-3.8-flash",
    reads: ["image", "text"],
  },
  {
    id: "xai",
    label: "Grok",
    // xAI reads JPEG and PNG pictures; PDFs would need its own file store.
    detail: "xAI's models",
    models: [
      { id: "grok-4.7", label: "Grok 4.7", input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "low", context: 500_000 },
      { id: "grok-4.6", label: "Grok 4.6", input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "low", context: 500_000 },
      { id: "grok-4.3", label: "Grok 4.3", input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25, efforts: ["off", "low", "medium", "high", "xhigh"], defaultEffort: "low", context: 1_000_000 },
    ],
    defaultModel: "grok-4.7",
    reads: ["image", "text"],
  },
  // OpenCode's pay-as-you-go API, at its prices as of November 2026. Long prompts cost more on some
  // models, as at their makers; these are the everyday rates. Pictures go in OpenAI's chat format,
  // which every model there takes; PDFs aren't sent that way.
  {
    id: "opencode",
    label: "OpenCode",
    detail: "One key for Claude, GPT, Gemini, Grok and open models",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, efforts: CLAUDE_EFFORTS, defaultEffort: "low", context: 1_000_000 },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, efforts: CLAUDE_EFFORTS, defaultEffort: "low", context: 1_000_000 },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, efforts: CLAUDE_EFFORTS, defaultEffort: "low", context: 1_000_000 },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, efforts: CLAUDE_EFFORTS, defaultEffort: "low", context: 1_000_000 },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "low", context: 1_050_000 },
      { id: "gpt-6-luna", label: "GPT-6 Luna", input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, efforts: ["off", "low", "medium", "high", "xhigh", "max"], defaultEffort: "low", context: 1_050_000 },
      { id: "gpt-6-astra", label: "GPT-6 Astra", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "low", context: 1_050_000 },
      // Half price until 30 November 2026: $4 in, $0.20 cached and $20 out from 1 December.
      { id: "gemini-4-argon", label: "Gemini 4 Argon", input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2, efforts: ["low", "medium", "high"], defaultEffort: "low", context: 1_048_576 },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.5, efforts: ["low", "medium", "high"], defaultEffort: "low", context: 1_048_576 },
      { id: "grok-4.7", label: "Grok 4.7", input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "low", context: 500_000 },
      { id: "kimi-k3", label: "Kimi K3", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3, efforts: ["low", "high", "max"], defaultEffort: "low", context: 1_048_576 },
      { id: "glm-5.3", label: "GLM-5.3", input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4, efforts: ["low", "high", "max"], defaultEffort: "low", reads: ["text"], context: 1_000_000 },
      { id: "qwen3.8-max", label: "Qwen3.8 Max", input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5, efforts: ["low", "medium", "xhigh"], defaultEffort: "low", context: 262_144 },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 1.74, efforts: ["high", "max"], defaultEffort: "high", reads: ["text"], context: 1_000_000 },
      { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3, efforts: ["low", "high", "max"], defaultEffort: "low", context: 1_000_000 },
      { id: "minimax-m3", label: "MiniMax M3", input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.3, efforts: ["default"], defaultEffort: "default", context: 512_000 },
      // Half its list price of $1.36 in, $0.14 cached and $4.18 out, for now.
      { id: "mistral-large-4", label: "Mistral Large 4", input: 0.68, output: 2.09, cacheRead: 0.07, cacheWrite: 0.68, efforts: ["off", "high"], defaultEffort: "off", context: 524_288 },
    ],
    defaultModel: "claude-opus-5-5",
    reads: ["image", "text"],
  },
  {
    id: "custom",
    label: "Another service",
    detail: "Anything in OpenAI's chat format, like OpenRouter, Qwen, Kimi or Ollama",
    models: [],
    defaultModel: "",
    reads: ["text"],
    custom: true,
  },
];

/**
 * Services that speak OpenAI's chat format, offered as starting points for "Another service". The
 * address is what's kept; a key on one of these hosts is named after it.
 */
export const SERVICES = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", example: "openai/gpt-oss-120b" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", example: "openai/gpt-oss-120b" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", example: "mistral-medium-3-5" },
  { id: "qwen", label: "Qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", example: "qwen3.8-max" },
  { id: "qwen-cn", label: "Qwen in mainland China", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", example: "qwen3.8-max" },
  { id: "kimi", label: "Kimi", baseUrl: "https://api.moonshot.ai/v1", example: "kimi-k3" },
  { id: "kimi-cn", label: "Kimi in mainland China", baseUrl: "https://api.moonshot.cn/v1", example: "kimi-k3" },
  { id: "glm", label: "GLM", baseUrl: "https://api.z.ai/api/paas/v4", example: "glm-5.3" },
  { id: "glm-cn", label: "GLM in mainland China", baseUrl: "https://open.bigmodel.cn/api/paas/v4", example: "glm-5.3" },
  { id: "ollama", label: "Ollama on the server", baseUrl: "http://localhost:11434/v1", example: "gpt-oss:20b" },
];

/** What to call a service at this address: its name when it's a known one, else its host. */
export function serviceName(baseUrl: string): string {
  const known = SERVICES.find((s) => s.baseUrl === baseUrl.replace(/\/+$/, ""));
  if (known) return known.label.replace(/ (in mainland China|on the server)$/, "");
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** What a provider's models can do, as admins see it when picking one. */
export function featuresOf(p: ProviderInfo): string[] {
  const reads = p.reads.map((k) => ({ image: t("Images"), pdf: t("PDFs"), text: t("Text files") })[k]);
  return p.tools ? [...reads, t("Web search"), t("Making files")] : reads;
}

export function findProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Whether this provider's keys can search the web and make files (Claude, OpenAI). */
export function hasTools(provider: string): boolean {
  return !!findProvider(provider)?.tools;
}

export function findModel(provider: string, model: string): ModelInfo | undefined {
  return findProvider(provider)?.models.find((m) => m.id === model);
}

export function modelLabel(provider: string | null, model: string | null): string {
  if (!model) return "";
  return (provider && findModel(provider, model)?.label) || model;
}

/** What a catalog model opens of what people attach. */
export function readsOf(provider: string, model: string): FileKind[] {
  return findModel(provider, model)?.reads ?? findProvider(provider)?.reads ?? ["text"];
}

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; webSearches?: number };

/**
 * What a reply cost at list prices, searches at its provider's price. A model with no prices (an
 * admin's own service, say) counts as free.
 */
export function estimateCost(m: Pick<ModelInfo, "input" | "output" | "cacheRead" | "cacheWrite"> | undefined, u: Usage, provider?: string): number {
  if (!m) return 0;
  const tokens = (u.input * m.input + u.output * m.output + u.cacheRead * m.cacheRead + u.cacheWrite * m.cacheWrite) / 1_000_000;
  return tokens + (u.webSearches ?? 0) * ((provider && findProvider(provider)?.tools?.searchPrice) || 0);
}
