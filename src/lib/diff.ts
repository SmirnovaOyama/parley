// Two versions of a text side by side, with the words only one of them has marked: what an MCP
// server now says of a tool against what it said before, say, so words slipped in stand out.

export type Piece = { text: string; changed: boolean };

/** Past this many word pairs, the part that differs is marked whole rather than word by word. */
const MAX_PAIRS = 250_000;

/** Which words of each list are in the longest run of words both share, in order. */
function shared(x: string[], y: string[]): [boolean[], boolean[]] {
  const inX = x.map(() => false);
  const inY = y.map(() => false);
  if (!x.length || !y.length || x.length * y.length > MAX_PAIRS) return [inX, inY];
  const w = y.length + 1;
  const run = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) run[i * w + j] = x[i] === y[j] ? run[(i + 1) * w + j + 1] + 1 : Math.max(run[(i + 1) * w + j], run[i * w + j + 1]);
  }
  for (let i = 0, j = 0; i < x.length && j < y.length; ) {
    if (x[i] === y[j]) inX[i++] = inY[j++] = true;
    else if (run[(i + 1) * w + j] >= run[i * w + j + 1]) i++;
    else j++;
  }
  return [inX, inY];
}

/** Neighbouring pieces that are both changed or both not, as one. */
function joined(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const last = out.at(-1);
    if (last && last.changed === p.changed) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/** Words, runs of space, and each mark of punctuation on its own, so "text", and "text" share the word. */
const tokens = (text: string) => text.split(/(\s+|[^\p{L}\p{N}_\s])/u).filter(Boolean);

/** Both texts in pieces, the words (and spaces) only one of them has marked as changed. */
export function wordDiff(before: string, after: string): { before: Piece[]; after: Piece[] } {
  const [a, b] = [tokens(before), tokens(after)];
  // What both start and end with is set aside first, so a change at one end costs nothing to find.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const [midA, midB] = [a.slice(start, a.length - end), b.slice(start, b.length - end)];
  const [keepA, keepB] = shared(midA, midB);
  const pieces = (words: string[], mid: string[], keep: boolean[]) => {
    const out = joined([
      ...words.slice(0, start).map((text) => ({ text, changed: false })),
      ...mid.map((text, i) => ({ text, changed: !keep[i] })),
      ...words.slice(words.length - end).map((text) => ({ text, changed: false })),
    ]);
    // A space both share between two changed words on a line is part of the change, so rewritten
    // words read as one marked run rather than a word at a time.
    for (let i = 1; i < out.length - 1; i++) if (!out[i].changed && !out[i].text.trim() && !out[i].text.includes("\n")) out[i].changed = true;
    return joined(out);
  };
  return { before: pieces(a, midA, keepA), after: pieces(b, midB, keepB) };
}
