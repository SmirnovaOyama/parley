// What a person may use each month and what they've used so far: spending, in dollars of
// estimated cost (usage_events.cost_usd), and tokens. Both limits are optional, both start again
// on the 1st (UTC), and a verified email reward raises each by its amount.
import { bonusOf } from "./bonus.ts";
import { db, getSettings, startOfMonthIso } from "./db.ts";
import { locale, t } from "./i18n.ts";

export type SpendLimitMode = "site" | "own" | "none";
export const SPEND_LIMIT_MODES: readonly SpendLimitMode[] = ["site", "own", "none"];

/** The most a limit or reward may be, in dollars; anything above is surely a typo. */
export const MAX_DOLLARS = 1_000_000;

export type UserLimits = {
  id: number;
  role: string;
  spend_limit_mode: string;
  monthly_spend_limit: number | null;
  monthly_token_limit: number | null;
};

/** The highest monthly limit among the groups someone is in that set one; null when none do. */
export function groupSpendLimit(userId: number): number | null {
  const row = db
    .prepare(
      `SELECT MAX(g.spend_limit) AS spend FROM user_groups g JOIN group_members m ON m.group_id = g.id
       WHERE m.user_id = ? AND g.spend_limit IS NOT NULL`,
    )
    .get(userId) as { spend: number | null };
  return row.spend;
}

/**
 * The spending limit before any reward: their own, their group's or the site's for members, or none.
 * A member of a group with its own limit follows the group's (the highest, if they're in several).
 */
export function baseSpendLimit(u: UserLimits, siteLimit = getSettings().spendLimit): number | null {
  if (u.spend_limit_mode === "none") return null;
  if (u.spend_limit_mode === "own") return u.monthly_spend_limit;
  // Admins pay for the keys; the site's limit is for members.
  if (u.role === "admin") return null;
  return groupSpendLimit(u.id) ?? siteLimit;
}

export type Allowance = {
  spent: number;
  /** Dollars they may spend this month, reward included; null for no limit. */
  spendLimit: number | null;
  tokens: number;
  tokenLimit: number | null;
  /** When the month's counts start again. */
  resetsAt: string;
  /** Which limit they've reached, if any. */
  over: "spend" | "tokens" | null;
};

export function nextMonthIso(): string {
  const d = new Date(startOfMonthIso());
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

export function allowanceOf(userId: number): Allowance {
  const u = db
    .prepare("SELECT id, role, spend_limit_mode, monthly_spend_limit, monthly_token_limit FROM users WHERE id = ?")
    .get(userId) as UserLimits;
  const used = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spent,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens
       FROM usage_events WHERE user_id = ? AND created_at >= ?`,
    )
    .get(userId, startOfMonthIso()) as { spent: number; tokens: number };
  const bonus = bonusOf(userId);
  const base = baseSpendLimit(u);
  const spendLimit = base == null ? null : base + (bonus.eligible ? (bonus.spend ?? 0) : 0);
  const tokenLimit = u.monthly_token_limit == null ? null : u.monthly_token_limit + (bonus.eligible ? (bonus.tokens ?? 0) : 0);
  return {
    spent: used.spent,
    spendLimit,
    tokens: used.tokens,
    tokenLimit,
    resetsAt: nextMonthIso(),
    over: spendLimit != null && used.spent >= spendLimit ? "spend" : tokenLimit != null && used.tokens >= tokenLimit ? "tokens" : null,
  };
}

/** Why a message can't be sent this month, for the composer; null while they're within limits. */
export function overLimitMessage(a: Allowance): string | null {
  const resetFmt = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", timeZone: "UTC" });
  const when = t("It starts again on {value}, or an admin can raise it", { value: resetFmt.format(new Date(a.resetsAt)) });
  if (a.over === "spend") return t("You've reached this month's spending limit of ${value}. {when}", { value: a.spendLimit!.toFixed(2), when });
  if (a.over === "tokens") return t("You've used this month's tokens. {when}", { when });
  return null;
}
