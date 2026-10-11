// The interface in English or Chinese. Every string a person reads goes through t() (or tn(), tx()),
// keyed by its English text, with {name} for what's filled in. locales/zh.json holds the Chinese,
// proofread on the translation site; a string it doesn't have shows in English.
//
// The language is picked once, as the page loads: the one chosen under Settings, else the browser's.
// Choosing another reloads the page. The server is told it with every request (src/lib/api.ts), so
// its messages and emails come in it too (server/i18n.ts).
import { createElement, Fragment, type ReactNode } from "react";
import zh from "../../locales/zh.json";

export type Lang = "en" | "zh";
export type LangChoice = Lang | "system";

const KEY = "lang";

function saved(): LangChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "en" || v === "zh" ? v : "system";
  } catch {
    return "system";
  }
}

const browserLang = (): Lang => ((navigator.languages ?? [navigator.language]).some((l) => l?.toLowerCase().startsWith("zh")) ? "zh" : "en");

export const LANG_CHOICE: LangChoice = saved();
export const LANG: Lang = LANG_CHOICE === "system" ? browserLang() : LANG_CHOICE;
/** For Intl's dates and numbers: Chinese, or in English the browser's own way, as before. */
export const LOCALE = LANG === "zh" ? "zh-CN" : undefined;

document.documentElement.lang = LANG === "zh" ? "zh-CN" : "en";

/** Saves the choice and loads the page again in it. */
export function setLang(choice: LangChoice) {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Private windows can refuse storage; then the browser's language stays.
  }
  location.reload();
}

export type Vars = Record<string, string | number>;

const CHINESE = zh as Record<string, string>;

const fill = (template: string, vars?: Vars) =>
  vars ? template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole)) : template;

/** The string in the page's language: `en` is the English, with {name} for each of `vars`. */
export function t(en: string, vars?: Vars): string {
  return fill(LANG === "zh" ? (CHINESE[en] ?? en) : en, vars);
}

/**
 * A sentence with a count in it: English picks `one` or `many` by `count`; Chinese has one form,
 * kept under `many`. `vars` fills both, the count included where it's named.
 */
export function tn(count: number, one: string, many: string, vars?: Vars): string {
  return LANG === "zh" ? fill(CHINESE[many] ?? (count === 1 ? one : many), vars) : fill(count === 1 ? one : many, vars);
}

/**
 * A sentence with parts that aren't plain text: {name} takes a node, and <tag>words</tag> hands the
 * words to the function under `tag` (a link, say), so the words are translated with the sentence.
 */
export function tx(en: string, parts: Record<string, ReactNode | ((words: string) => ReactNode)>): ReactNode {
  const template = LANG === "zh" ? (CHINESE[en] ?? en) : en;
  const nodes: ReactNode[] = [];
  const re = /<(\w+)>(.*?)<\/\1>|\{(\w+)\}/g;
  let last = 0;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    if (m.index > last) nodes.push(template.slice(last, m.index));
    const part = parts[m[1] ?? m[3]];
    if (m[1]) nodes.push(typeof part === "function" ? part(m[2]) : m[2]);
    else nodes.push(typeof part === "function" ? part("") : (part ?? m[0]));
    last = re.lastIndex;
  }
  if (last < template.length) nodes.push(template.slice(last));
  return createElement(Fragment, null, ...nodes);
}

// Lists in English as the site always wrote them, with no comma before "and" (en-GB).
const LIST_LOCALE = LANG === "zh" ? "zh-CN" : "en-GB";
const andList = new Intl.ListFormat(LIST_LOCALE, { type: "conjunction" });
const orList = new Intl.ListFormat(LIST_LOCALE, { type: "disjunction" });

/** "a, b and c" or "a、b和c". */
export const andText = (items: string[]) => andList.format(items);
/** "a, b or c" or "a、b或c". */
export const orText = (items: string[]) => orList.format(items);
