// Email rewards, as the account pages show them.
import { compactNumber, formatCost } from "./format.ts";
import { andText, orText, t } from "./i18n.ts";

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

/** "$2.00 more to spend a month and access to Claude Fable 5.1", or null when the admins set no reward. */
export function rewardText(reward: BonusStatus["reward"]): string | null {
  const parts: string[] = [];
  if (reward.spend) parts.push(t("{spend} more to spend a month", { spend: formatCost(reward.spend) }));
  if (reward.tokens) parts.push(t("{tokens} extra tokens a month", { tokens: compactNumber(reward.tokens) }));
  if (reward.models.length) parts.push(t("access to {list}", { list: andText(reward.models) }));
  return parts.length ? andText(parts) : null;
}

/** "example.edu or example.org", shortened past three. */
export function domainsText(domains: string[]): string {
  return domains.length > 3 ? t("{domains} and {length} more", { domains: domains.slice(0, 3).join(", "), length: domains.length - 3 }) : orText(domains);
}
