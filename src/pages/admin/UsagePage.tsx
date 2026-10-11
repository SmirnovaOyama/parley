import { useEffect, useState, type ReactNode } from "react";
import { ColumnChart } from "../../components/ColumnChart.tsx";
import { Segmented } from "../../components/Controls.tsx";
import { EmptyState, Spinner } from "../../components/Feedback.tsx";
import { ModelArt } from "../../components/ModelArt.tsx";
import { api } from "../../lib/api.ts";
import { compactNumber, formatCost, formatNumber, plural, shortDate } from "../../lib/format.ts";
import { LOCALE, t, tn } from "../../lib/i18n.ts";

type Row = {
  name: string;
  provider?: string;
  model?: string | null;
  modelLabel?: string | null;
  replies: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  searches: number | null;
  cost: number;
};

type Bucket = { key: string; cost: number; replies: number; cached: number; sent: number; written: number };
type Series = { unit: "day" | "month"; buckets: Bucket[] };
type Usage = { byUser: Row[]; byKey: Row[]; series: Series };

type Range = "month" | "30d" | "all";

const RANGES = [
  { id: "month", label: t("This month"), during: t("this month") },
  { id: "30d", label: t("Last 30 days"), during: t("in the last 30 days") },
  { id: "all", label: t("All time"), during: t("in all") },
] as const;

const tokensIn = (r: Row) => r.input + r.cache_read + r.cache_write;
const sum = (rows: Row[], pick: (r: Row) => number) => rows.reduce((total, r) => total + pick(r), 0);

/** Usage in cards, like the overview: totals for the period, then who and which key spent it. */
export function UsagePage() {
  const [range, setRange] = useState<Range>("month");
  const [data, setData] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  // The period both charts point at, so hovering one day shows that day in both.
  const [active, setActive] = useState<number | null>(null);

  // A new period loads over the old numbers, dimmed, so nothing jumps.
  useEffect(() => {
    let current = true;
    setLoading(true);
    setActive(null);
    api.get<Usage>(`/admin/usage?range=${range}`).then(
      (next) => current && setData(next),
      () => current && setData({ byUser: [], byKey: [], series: { unit: "day", buckets: [] } }),
    ).finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [range]);

  const rows = data?.byUser ?? [];
  const cost = sum(rows, (r) => r.cost);
  const replies = sum(rows, (r) => r.replies);
  const input = sum(rows, tokensIn);
  const cached = sum(rows, (r) => r.cache_read);
  const output = sum(rows, (r) => r.output);
  const searches = sum(rows, (r) => r.searches ?? 0);
  const period = RANGES.find((r) => r.id === range)!.label.toLowerCase();

  return (
    <div className={`overview${loading && data ? " is-refreshing" : ""}`}>
      <div className="admin-toolbar">
        <Segmented aria-label={t("Period")} value={range} onChange={setRange} options={RANGES} />
      </div>

      {!data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState doodle="coins" title={t("Nothing to count yet")}>
          {t("Usage shows up here after the first replies")}
        </EmptyState>
      ) : (
        <>
          <div className="stat-grid is-four">
            <Stat label={t("Cost")} tag={plural(replies, "reply", "replies")} value={formatCost(cost)}>
              {t("Estimated from list prices, {period}", { period })}
            </Stat>
            <Stat label={t("Tokens in")} tag={input ? t("{round}% cached", { round: Math.round((cached / input) * 100) }) : undefined} value={compactNumber(input)}>
              {t("History and messages sent to the models")}
            </Stat>
            <Stat label={t("Tokens out")} value={compactNumber(output)}>
              {t("Written by the models, thinking included")}
            </Stat>
            <Stat label={t("Web searches")} tag={searches ? formatCost(searches * 0.01) : undefined} value={formatNumber(searches)}>
              {t("Claude and OpenAI, $10 per 1,000")}
            </Stat>
          </div>

          {data.series.buckets.length > 1 && (
            <UsageCharts series={data.series} range={RANGES.find((r) => r.id === range)!} active={active} onActive={setActive} />
          )}

          <UsageGroup title={t("By person")} rows={data.byUser} total={cost} />
          <UsageGroup title={t("By key")} rows={data.byKey} total={cost} withArt />

          <p className="footnote">
            {t(
              "Costs are estimates from list prices; DeepSeek is counted at its peak-hour rate, and another service's models at the prices given on their key. Tokens in include history read from the cache. Replies stopped early aren't counted.",
            )}
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, tag, value, children }: { label: string; tag?: string; value: string; children: ReactNode }) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <div className="stat-figure">
        <p className="stat-value">{value}</p>
        {tag && <span className="tag">{tag}</span>}
      </div>
      <p className="stat-note">{children}</p>
    </div>
  );
}

/**
 * One card per person or key: what it cost, its share of the period's spend as a bar (the track a
 * lighter step of the same hue), and the counts behind it as quiet chips.
 */
function UsageGroup({ title, rows, total, withArt }: { title: string; rows: Row[]; total: number; withArt?: boolean }) {
  return (
    <section className="overview-section">
      <div className="overview-head">
        <h2 className="oy-overline">{title}</h2>
      </div>
      <div className="card-grid">
        {rows.map((r, i) => {
          const share = total > 0 ? r.cost / total : 0;
          const percent = Math.round(share * 100);
          return (
            <div key={`${r.name}-${i}`} className="model-card usage-card">
              {withArt && r.model && <ModelArt model={r.model} />}
              <div className="model-card-body">
                <p className="usage-card-name">{r.name}</p>
                {r.modelLabel && <p className="model-card-key">{r.modelLabel}</p>}
                <p className="usage-card-cost">{formatCost(r.cost)}</p>
                <div
                  className="share-meter"
                  role="meter"
                  aria-label={t("Share of spend: {percent}%", { percent })}
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }} />
                </div>
                <p className="usage-card-share">{share > 0 && percent === 0 ? t("Under 1%") : `${percent}%`} {t("of spend")}</p>
                <div className="chip-row">
                  <span className="chip-quiet">{plural(r.replies, "reply", "replies")}</span>
                  <span className="chip-quiet" title={formatNumber(tokensIn(r))}>
                    {t("{r} in", { r: compactNumber(tokensIn(r)) })}
                  </span>
                  <span className="chip-quiet" title={formatNumber(r.output)}>
                    {t("{output} out", { output: compactNumber(r.output) })}
                  </span>
                  {(r.searches ?? 0) > 0 && <span className="chip-quiet">{plural(r.searches ?? 0, "search", "searches")}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const dayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "numeric", month: "short" });
const monthFmt = new Intl.DateTimeFormat(LOCALE, { month: "short", year: "numeric" });
const parseKey = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d || 1);
};

/** Token kinds, bottom of each column first: what they are and how each part is coloured. */
const TOKEN_SERIES = [
  { id: "cached", label: t("From cache"), className: "series-cached" },
  { id: "sent", label: t("Sent"), className: "series-sent" },
  { id: "written", label: t("Written"), className: "series-written" },
] as const;

/**
 * Cost, then tokens split by kind, over the period. Each card leads with the period's figure; a
 * hovered or focused column swaps in that day's (or month's) numbers, in both cards at once.
 */
function UsageCharts({ series, range, active, onActive }: { series: Series; range: (typeof RANGES)[number]; active: number | null; onActive: (i: number | null) => void }) {
  const { buckets, unit } = series;
  const isToday = (i: number) => unit === "day" && i === buckets.length - 1;
  const labelOf = (i: number) => (isToday(i) ? t("Today") : unit === "day" ? dayFmt.format(parseKey(buckets[i].key)) : monthFmt.format(parseKey(buckets[i].key)));
  const axis: [string, string] =
    unit === "day"
      ? [shortDate(parseKey(buckets[0].key).toISOString()), t("Today")]
      : [monthFmt.format(parseKey(buckets[0].key)), monthFmt.format(parseKey(buckets[buckets.length - 1].key))];
  const picked = active == null ? null : buckets[active];
  const total = (pick: (b: Bucket) => number) => buckets.reduce((sum, b) => sum + pick(b), 0);
  const scope = picked ? labelOf(active!) : range.label;
  // The same span inside a sentence: "today", "on Sat 3 Oct", "in Sep 2026", "in the last 30 days".
  const when = !picked
    ? range.during
    : isToday(active!)
      ? t("today")
      : unit === "day"
        ? t("on {labelOf}", { labelOf: labelOf(active!) })
        : t("in {labelOf}", { labelOf: labelOf(active!) });
  const unitText = unit === "day" ? t("day") : t("month");
  const tokensOf = (b: Bucket) => b.cached + b.sent + b.written;

  return (
    <div className="chart-grid">
      <div className="stat-card chart-card">
        <p className="stat-label">{t("Cost by {unit}", { unit: unitText })}</p>
        <p className="stat-value">{formatCost(picked ? picked.cost : total((b) => b.cost))}</p>
        <p className="stat-note">
          {t("{plural} {when}", { plural: plural(picked ? picked.replies : total((b) => b.replies), "reply", "replies"), when })}
        </p>
        <ColumnChart
          buckets={buckets.map((b) => ({ key: b.key, values: [b.cost] }))}
          seriesClasses={["series-cost"]}
          active={active}
          onActive={onActive}
          describe={(i) =>
            tn(buckets[i].replies, "{labelOf}: {cost}, {replies} reply", "{labelOf}: {cost}, {replies} replies", {
              labelOf: labelOf(i),
              cost: formatCost(buckets[i].cost),
              replies: formatNumber(buckets[i].replies),
            })
          }
          axis={axis}
        />
      </div>

      <div className="stat-card chart-card">
        <p className="stat-label">{t("Tokens by {unit}", { unit: unitText })}</p>
        <p className="stat-value">{compactNumber(picked ? tokensOf(picked) : total(tokensOf))}</p>
        <p className="stat-note">{scope}</p>
        {/* The legend doubles as the labels: each kind's count for the period, or the column pointed at. */}
        <ul className="chart-legend">
          {TOKEN_SERIES.map((t) => (
            <li key={t.id}>
              <span className={`chart-key ${t.className}`} aria-hidden="true" />
              {t.label}
              <strong>{compactNumber(picked ? picked[t.id] : total((b) => b[t.id]))}</strong>
            </li>
          ))}
        </ul>
        <ColumnChart
          buckets={buckets.map((b) => ({ key: b.key, values: [b.cached, b.sent, b.written] }))}
          seriesClasses={TOKEN_SERIES.map((t) => t.className)}
          active={active}
          onActive={onActive}
          describe={(i) =>
            t("{labelOf}: {cached} from cache, {sent} sent, {written} written", {
              labelOf: labelOf(i),
              cached: formatNumber(buckets[i].cached),
              sent: formatNumber(buckets[i].sent),
              written: formatNumber(buckets[i].written),
            })
          }
          axis={axis}
        />
      </div>
    </div>
  );
}
