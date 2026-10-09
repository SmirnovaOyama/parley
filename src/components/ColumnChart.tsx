// Columns from one baseline, one per period, optionally stacked. Following the house chart rules:
// columns at most 24px wide with a 4px rounded top and a square foot, a 2px gap between stacked
// parts, a hairline baseline, no gridlines. Pointing at (or focusing) a column reports it, so the
// card can show its numbers in place; there are no pop-ups.

/** The plotting height in px (see .column-bars): a stack shorter than 6px a part drops its gaps. */
const CHART_HEIGHT = 120;

type Props = {
  /** One per period, oldest first; `values` per series, bottom of the stack first. */
  buckets: { key: string; values: number[] }[];
  /** A class per series that colours its parts, bottom first. */
  seriesClasses: string[];
  active: number | null;
  onActive: (index: number | null) => void;
  /** What a screen reader hears for a column. */
  describe: (index: number) => string;
  /** Under the first and the last column. */
  axis: [string, string];
};

export function ColumnChart({ buckets, seriesClasses, active, onActive, describe, axis }: Props) {
  const totals = buckets.map((b) => b.values.reduce((sum, v) => sum + v, 0));
  const max = Math.max(...totals, 0);

  return (
    <div className="column-chart" onPointerLeave={() => onActive(null)}>
      <div className="column-bars">
        {buckets.map((b, i) => {
          const parts = b.values.map((v, s) => ({ v, s })).filter((p) => p.v > 0);
          return (
            <button
              key={b.key}
              type="button"
              className={`column-slot${active === i ? " is-active" : ""}`}
              aria-label={describe(i)}
              onPointerEnter={() => onActive(i)}
              onFocus={() => onActive(i)}
              onBlur={() => onActive(null)}
            >
              {max > 0 && totals[i] > 0 && (
                <span
                  className={`column-stack${(totals[i] / max) * CHART_HEIGHT < parts.length * 6 ? " is-short" : ""}`}
                  style={{ height: `${Math.max((totals[i] / max) * 100, 3)}%` }}
                >
                  {parts.map((p, j) => (
                    <span
                      key={p.s}
                      className={`column-part ${seriesClasses[p.s]}${j === parts.length - 1 ? " is-top" : ""}`}
                      style={{ flexGrow: p.v }}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="column-axis">
        <span>{axis[0]}</span>
        <span>{axis[1]}</span>
      </div>
    </div>
  );
}
