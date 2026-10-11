// What the server says to people, in English or Chinese: error messages, notes on replies, and
// emails. Each request says its page's language in X-Parley-Lang (src/lib/i18n.ts), which holds for
// everything done for that request, a reply's stream and the emails it sends included. Strings are
// keyed by their English text, as on the page; what the model is told stays in English.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import type { MiddlewareHandler } from "hono";

export type Lang = "en" | "zh";
export type Vars = Record<string, string | number>;

const CHINESE = JSON.parse(readFileSync(new URL("../locales/zh.json", import.meta.url), "utf8")) as Record<string, string>;
const current = new AsyncLocalStorage<Lang>();

/** The language of the request being handled; English outside one. */
export const lang = (): Lang => current.getStore() ?? "en";

export const langMiddleware: MiddlewareHandler = (c, next) => current.run(c.req.header("x-parley-lang") === "zh" ? "zh" : "en", next);

/** Runs `fn` in `language`, for work done for someone outside their request. */
export const inLang = <T>(language: Lang, fn: () => T): T => current.run(language, fn);

const fill = (template: string, vars?: Vars) =>
  vars ? template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole)) : template;

/** The string in the request's language: `en` is the English, with {name} for each of `vars`. */
export function t(en: string, vars?: Vars): string {
  return fill(lang() === "zh" ? (CHINESE[en] ?? en) : en, vars);
}

/** A sentence with a count: English picks `one` or `many`; Chinese has one form, under `many`. */
export function tn(count: number, one: string, many: string, vars?: Vars): string {
  return lang() === "zh" ? fill(CHINESE[many] ?? (count === 1 ? one : many), vars) : fill(count === 1 ? one : many, vars);
}

/** "a, b and c" or "a、b和c". */
export const andText = (items: string[]) => new Intl.ListFormat(lang() === "zh" ? "zh-CN" : "en-GB", { type: "conjunction" }).format(items);
/** "a, b or c" or "a、b或c". */
export const orText = (items: string[]) => new Intl.ListFormat(lang() === "zh" ? "zh-CN" : "en-GB", { type: "disjunction" }).format(items);
/** For Intl's dates and numbers. */
export const locale = () => (lang() === "zh" ? "zh-CN" : "en-GB");
