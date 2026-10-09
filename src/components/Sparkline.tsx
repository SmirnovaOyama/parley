import type { KeyboardEvent, PointerEvent } from "react";

type Props = {
  /** Oldest first; null where there's nothing to show (the line breaks there). */
  values: (number | null)[];
  /** The top of the scale; the bottom is always 0. Defaults to the largest value. */
  max?: number;
  active: number | null;
  onActive: (index: number | null) => void;
  /** What a screen reader hears before it moves through the days. */
  label: string;
};

const W = 100;
const H = 36;
const PAD = 5;

/**
 * A trend line for a stat card, following the house chart rules: a 2px line in the quiet grey, the
 * latest point marked in the accent with a ring in the card colour, no axes. Pointing at it (or
 * the arrow keys once it has focus) snaps to the nearest day and reports it, so the card can show
 * that day's value in place; there are no pop-ups.
 */
export function Sparkline({ values, max, active, onActive, label }: Props) {
  const n = values.length;
  const top = max ?? Math.max(...values.map((v) => v ?? 0), 0);
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : W / 2);
  const y = (v: number) => (top > 0 ? H - PAD - (v / top) * (H - 2 * PAD) : H - PAD);

  // One path, broken wherever a day has no value.
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(2)} ${y(v).toFixed(2)}`;
    pen = true;
  });

  const last = values.findLastIndex((v) => v != null);
  const marked = active ?? last;
  const markedValue = marked >= 0 ? values[marked] : null;

  const nearest = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return Math.round(((e.clientX - box.left) / box.width) * (n - 1));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step) {
      e.preventDefault();
      onActive(Math.min(n - 1, Math.max(0, (active ?? n - 1) + step)));
    } else if (e.key === "Escape") onActive(null);
  };

  return (
    <div
      className="sparkline"
      role="group"
      tabIndex={0}
      aria-label={label}
      onPointerMove={(e) => onActive(Math.min(n - 1, Math.max(0, nearest(e))))}
      onPointerLeave={() => onActive(null)}
      onKeyDown={onKey}
      onBlur={() => onActive(null)}
    >
      <div className="sparkline-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <path d={d} className="sparkline-line" />
        </svg>
        {active != null && <span className="sparkline-cross" style={{ left: `${(x(active) / W) * 100}%` }} />}
        {markedValue != null && (
          <span className="sparkline-dot" style={{ left: `${(x(marked) / W) * 100}%`, top: `${(y(markedValue) / H) * 100}%` }} />
        )}
      </div>
    </div>
  );
}
