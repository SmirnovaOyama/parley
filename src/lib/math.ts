// Gets model output ready for the math plugin, which only understands $…$ and $$…$$.
// Code (fenced blocks and `inline code`) is left exactly as written.

const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

// A dollar sign that reads as a price: "$5", "$1,200", "$9.99", "$3M", at the start of a word and
// followed by a word break. Math that starts with a digit and goes on ("$2x + 1$") isn't touched.
const PRICE = /(^|[\s([{>*_~"'“‘])\$(?=\d[\d,]*(?:\.\d+)?(?:k|K|M|B|bn)?(?=[\s.,;:!?)\]}"'”’]|$))/gm;

function prose(text: string): string {
  return (
    text
      // \[ … \] → a display block. The math plugin wants its $$ fences on their own lines.
      .replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => `\n$$\n${tex.trim()}\n$$\n`)
      // \( … \) → inline math.
      .replace(/\\\((.+?)\\\)/g, (_m, tex: string) => `$${tex.trim()}$`)
      // Prices stay text.
      .replace(PRICE, (_m, before: string) => `${before}\\$`)
  );
}

export function prepareMath(text: string): string {
  return text
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : prose(part)))
    .join("");
}
