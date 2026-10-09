// What admins can pick when they add a key. Prices are USD per million tokens and only feed
// the usage estimates; DeepSeek bills peak hours at these rates and off-peak at half.

export type ProviderId = "anthropic" | "deepseek";

/**
 * Thinking levels. "off" turns thinking off where the model allows it: Claude Sonnet 5.5 via
 * `between_tools`, Claude Haiku 5.5 via `disabled`, DeepSeek via `thinking.type: disabled`.
 * Claude Opus 5.5 and Claude Fable 5.1 always think.
 */
export const EFFORT_LABELS: Record<string, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
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
};

/**
 * Models a key leaves out unless an admin ticks them: Fable 5.1 costs two and a half times Opus
 * 5.5, so it's a deliberate choice rather than part of "every model".
 */
export const OFF_BY_DEFAULT = new Set(["claude-fable-5-1"]);

/** Claude's web search is billed per search: $10 per 1,000. */
export const WEB_SEARCH_PRICE = 0.01;

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  models: ModelInfo[];
  defaultModel: string;
};

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Claude",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, efforts: CLAUDE_EFFORTS, defaultEffort: "low", fallbacks: true },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, efforts: ["off", ...CLAUDE_EFFORTS], defaultEffort: "low", fallbacks: true },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, efforts: ["off", ...CLAUDE_EFFORTS], defaultEffort: "low" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, efforts: CLAUDE_EFFORTS, defaultEffort: "low", fallbacks: true },
    ],
    defaultModel: "claude-opus-5-5",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    models: [
      { id: "deepseek-flash", label: "DeepSeek Flash", input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3, efforts: ["off", "low", "high", "max"], defaultEffort: "off" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32, efforts: ["off", "low", "high", "max"], defaultEffort: "off" },
    ],
    defaultModel: "deepseek-flash",
  },
];

export function findProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function findModel(provider: string, model: string): ModelInfo | undefined {
  return findProvider(provider)?.models.find((m) => m.id === model);
}

export function modelLabel(provider: string | null, model: string | null): string {
  if (!model) return "";
  return (provider && findModel(provider, model)?.label) || model;
}

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; webSearches?: number };

export function estimateCost(provider: string, model: string, u: Usage): number {
  const m = findModel(provider, model);
  if (!m) return 0;
  const tokens = (u.input * m.input + u.output * m.output + u.cacheRead * m.cacheRead + u.cacheWrite * m.cacheWrite) / 1_000_000;
  return tokens + (u.webSearches ?? 0) * WEB_SEARCH_PRICE;
}
