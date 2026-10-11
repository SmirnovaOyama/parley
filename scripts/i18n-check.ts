// Lists the English the code hands to t(), tn() and tx() (src/lib/i18n.ts, server/i18n.ts) that
// locales/zh.json has no Chinese for: new or reworded strings, which then go to the translation
// site. `node scripts/i18n-check.ts` prints them; `--json` prints them as a JSON array.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const zh = JSON.parse(readFileSync("locales/zh.json", "utf8")) as Record<string, string>;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

// A string literal: "…" or '…' with escapes, or `…` with nothing filled in.
const LITERAL = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\`(?:[^\`\\$]|\\.)*\`)`;
const CALLS = [
  new RegExp(String.raw`\b(?:t|tx)\(\s*` + LITERAL, "g"),
  new RegExp(String.raw`\btn\(\s*[^,]+?,\s*` + LITERAL + String.raw`\s*,\s*` + LITERAL, "g"),
];
// plural(n, "chat", "chats") (src/lib/format.ts) looks up the word it shows: both forms count.
const PLURAL = new RegExp(String.raw`\bplural\(\s*[^,]+?,\s*` + LITERAL + String.raw`\s*,\s*` + LITERAL, "g");

const unquote = (literal: string) => (literal.startsWith("`") ? literal.slice(1, -1).replace(/\\`/g, "`") : (JSON.parse(literal.startsWith("'") ? `"${literal.slice(1, -1).replace(/"/g, '\\"')}"` : literal) as string));

const missing = new Map<string, string[]>();
for (const path of [...files("src"), ...files("server")]) {
  if (path.endsWith("i18n.ts")) continue;
  const text = readFileSync(path, "utf8");
  for (const re of CALLS) {
    for (const m of text.matchAll(re)) {
      // For tn() the translation lives under the plural form, the last literal.
      const en = unquote(m[m.length - 1]);
      if (zh[en] == null) missing.set(en, [...(missing.get(en) ?? []), path]);
    }
  }
  if (path.startsWith("src")) {
    for (const m of text.matchAll(PLURAL)) {
      for (const word of [unquote(m[1]), unquote(m[2])]) if (zh[word] == null) missing.set(word, [...(missing.get(word) ?? []), path]);
    }
  }
}
// Looked up by format.ts from a table, not a literal.
for (const word of ["images", "PDFs", "text files", "no files"]) if (zh[word] == null) missing.set(word, ["src/lib/format.ts"]);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify([...missing].map(([en, places]) => ({ en, places: [...new Set(places)] })), null, 1));
} else {
  for (const [en, places] of missing) console.log(`${en}\n    ${[...new Set(places)].join(", ")}`);
  console.log(`\n${missing.size} strings without Chinese`);
}
