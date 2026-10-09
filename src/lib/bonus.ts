// Email rewards, as the account pages show them.
import { compactNumber, formatCost } from "./format.ts";

export type BonusStatus = {
  /** Domains whose addresses earn the reward; empty when the site offers none. */
  domains: string[];
  verified: { email: string; at: string; active: boolean } | null;
  reward: { tokens: number | null; spend: number | null; models: string[] };
  /** A code already sent and still valid. */
  pending: { email: string; resendIn: number } | null;
  /** How codes travel: real email, the server log (development), or not at all. */
  mail: "smtp" | "dev" | "off";
};

const list = (items: string[], joiner = "and") =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${joiner} ${items[items.length - 1]}`;

/** "$2.00 more to spend a month and access to Claude Fable 5.1", or null when the admins set no reward. */
export function rewardText(reward: BonusStatus["reward"]): string | null {
  const parts: string[] = [];
  if (reward.spend) parts.push(`${formatCost(reward.spend)} more to spend a month`);
  if (reward.tokens) parts.push(`${compactNumber(reward.tokens)} extra tokens a month`);
  if (reward.models.length) parts.push(`access to ${list(reward.models)}`);
  return parts.length ? list(parts) : null;
}

/** "example.edu or example.org", shortened past three. */
export function domainsText(domains: string[]): string {
  return domains.length > 3 ? `${domains.slice(0, 3).join(", ")} and ${domains.length - 3} more` : list(domains, "or");
}
