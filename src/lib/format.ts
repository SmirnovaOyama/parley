import { andText, LANG, LOCALE, t } from "./i18n.ts";

// Dates and numbers in the page's language (src/lib/i18n.ts): "3 Oct" or "10月3日".
const dateFmt = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short" });
const dateYearFmt = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit" });
const numberFmt = new Intl.NumberFormat(LOCALE);
const compactFmt = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 });

/** "14:05" today, "3 Oct" this year, "3 Oct 2025" before that. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  return d.getFullYear() === now.getFullYear() ? dateFmt.format(d) : dateYearFmt.format(d);
}

/** For a sentence: "at 14:05" today, "on 3 Oct" before. Chinese needs no word before a time or date. */
export function atOrOn(iso: string): string {
  const short = shortDate(iso);
  if (LANG === "zh") return short;
  return new Date(iso).toDateString() === new Date().toDateString() ? `at ${short}` : `on ${short}`;
}

/** "3 Oct 2026". */
export const longDate = (iso: string) => dateYearFmt.format(new Date(iso));
export const dateTime = (iso: string) => `${dateYearFmt.format(new Date(iso))}${LANG === "zh" ? " " : ", "}${timeFmt.format(new Date(iso))}`;
export const formatNumber = (n: number) => numberFmt.format(n);

/** "820 B", "14 KB", "1.4 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export const compactNumber = (n: number) => compactFmt.format(n);

export function formatCost(usd: number): string {
  if (!usd) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** A dollar amount as typed into a field: "5", "2.5"; empty for none. */
export const amountText = (usd: number | null) => (usd == null ? "" : String(usd));

/** Keeps what can be part of a dollar amount: digits and one point. */
export const amountInput = (text: string) => text.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");

/** "3 chats", "1 chat"; in Chinese the word's translation, measure word and all ("3 个聊天"). */
export const plural = (n: number, one: string, many: string) => `${formatNumber(n)} ${t(n === 1 ? one : many)}`;

/** The kinds of file a model opens, for a sentence: "text files", "images, PDFs and text files". */
export function kindsPhrase(kinds: readonly string[]): string {
  const names = (["image", "pdf", "text"] as const).filter((k) => kinds.includes(k)).map((k) => t({ image: "images", pdf: "PDFs", text: "text files" }[k]));
  return names.length ? andText(names) : t("no files");
}
