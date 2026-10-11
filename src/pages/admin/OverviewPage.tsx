import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Advisory, Spinner } from "../../components/Feedback.tsx";
import { ModelArt } from "../../components/ModelArt.tsx";
import { SlideLink } from "../../components/SlideLink.tsx";
import { Sparkline } from "../../components/Sparkline.tsx";
import { Icon, type IconName } from "../../icons/Icon.tsx";
import { api, type SharingMode } from "../../lib/api.ts";
import { AUDIT_ACTIONS } from "../../lib/audit.ts";
import { compactNumber, formatCost, formatNumber, plural, shortDate } from "../../lib/format.ts";
import { LOCALE, t } from "../../lib/i18n.ts";

type Overview = {
  spend: { cost: number; replies: number; monthStart: string };
  people: { total: number; joined: number; active: number; allowSignup: boolean };
  caching: { hitRate: number | null; saved: number };
  volume: { day: string; tokens: number; cost: number; people: number; saved: number }[];
  models: {
    id: number;
    label: string;
    provider: string;
    model: string;
    modelLabel: string;
    providerLabel: string;
    modelCount: number;
    effortLabel: string;
    isDefault: boolean;
    everyone: boolean;
    granted: number;
    webSearch: boolean;
    replies: number;
  }[];
  shortcuts: {
    declinedToReview: number;
    shared: number;
    sharing: SharingMode;
    lastAudit: { action: string; createdAt: string } | null;
  };
};

/** The admin home: this month at a glance, the models people chat with, and what needs a look. */
export function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Overview>("/admin/overview").then(setData, (err) => setError((err as Error).message));
  }, []);

  if (error) return <Advisory>{error}</Advisory>;
  if (!data) return <Spinner />;

  const { spend, people, caching, shortcuts, volume } = data;
  const dayOf = (i: number) => (i === volume.length - 1 ? t("Today") : dayFmt.format(parseDay(volume[i].day)));
  const nextMonth = new Date(spend.monthStart);
  nextMonth.setMonth(nextMonth.getMonth() + 1);

  return (
    <div className="overview">
      {/* The two things admins add most, under the tabs; the first icon lines up with the cards' edge. */}
      <div className="overview-actions">
        <SlideLink className="btn-ghost" to="/admin/keys/new" direction="forward">
          <Icon name="plus" size={16} />
          {t("Add a key")}
        </SlideLink>
        <SlideLink className="btn-ghost" to="/admin/people/new" direction="forward">
          <Icon name="users" size={16} />
          {t("Add a person")}
        </SlideLink>
      </div>
      <div className="stat-grid">
        <StatCard
          label={t("Spend this month")}
          tag={plural(spend.replies, "reply", "replies")}
          value={formatCost(spend.cost)}
          trend={{
            label: t("Spend per day, last 14 days"),
            values: volume.map((d) => d.cost),
            describe: (i) => `${dayOf(i)}: ${formatCost(volume[i].cost)}`,
          }}
        >
          {t("Estimated from list prices. It starts over on {toISOString}", { toISOString: shortDate(nextMonth.toISOString()) })}
        </StatCard>
        <StatCard
          label={t("Active people")}
          tag={people.allowSignup ? t("Sign-ups open") : t("Sign-ups closed")}
          value={formatNumber(people.active)}
          trend={{
            label: t("People active per day, last 14 days"),
            values: volume.map((d) => d.people),
            describe: (i) => t("{dayOf}: {people} active", { dayOf: dayOf(i), people: volume[i].people }),
          }}
        >
          {t("Of {plural}", { plural: plural(people.total, "account", "accounts") })}
          {people.joined > 0 && t(", {joined} of them new this month", { joined: people.joined })}
        </StatCard>
        <StatCard
          label={t("Prompt caching")}
          tag={caching.hitRate == null ? undefined : t("{round}% hit rate", { round: Math.round(caching.hitRate * 100) })}
          value={`~${formatCost(Math.max(caching.saved, 0))}`}
          trend={{
            label: t("Saved by caching per day, last 14 days"),
            values: volume.map((d) => Math.max(d.saved, 0)),
            describe: (i) => t("{dayOf}: ~{max} saved", { dayOf: dayOf(i), max: formatCost(Math.max(volume[i].saved, 0)) }),
          }}
        >
          {t("Estimated saving, last 7 days")}
        </StatCard>
      </div>

      <TokenVolume volume={data.volume} />

      <section className="overview-section">
        <div className="overview-head">
          <h2 className="oy-overline">{t("Models")}</h2>
          <Link className="text-link" to="/admin/keys">
            {t("Manage keys")}
          </Link>
        </div>
        <div className="card-grid">
          {data.models.map((m) => (
            <SlideLink key={m.id} className="model-card" to={`/admin/keys/${m.id}`} direction="forward">
              <ModelArt model={m.model} />
              {/* On the band's corner, so the name below always keeps a line of its own. */}
              {m.isDefault && <span className="model-card-badge">{t("Default")}</span>}
              <div className="model-card-body">
                <p className="model-card-title">{m.providerLabel}</p>
                <p className="model-card-key">{m.label}</p>
                <div className="chip-row">
                  <span className="chip-quiet">{plural(m.modelCount, "model", "models")}</span>
                  <span className="chip-quiet">
                    {t("Starts on {replace}", { replace: m.modelLabel.replace(/^Claude /, "") })}
                    {m.effortLabel !== "Default" && `, ${m.effortLabel.toLowerCase()}`}
                  </span>
                  {m.webSearch && <span className="chip-quiet">{t("Web search")}</span>}
                  <span className="chip-quiet">{m.everyone ? t("Everyone") : plural(m.granted, "person", "people")}</span>
                  <span className="chip-quiet">{t("{plural} this month", { plural: plural(m.replies, "reply", "replies") })}</span>
                </div>
              </div>
            </SlideLink>
          ))}
          {/* Always last: a way to add another model (an API key), drawn as an empty slot. */}
          <SlideLink className="model-card is-add" to="/admin/keys/new" direction="forward">
            <Icon name="plus" size={20} />
            <span className="model-card-title">{data.models.length ? t("Add a key") : t("Add the first key")}</span>
            <span className="model-card-key">{t("Claude, OpenAI, Gemini, Grok or another service, for everyone or chosen people")}</span>
          </SlideLink>
        </div>
      </section>

      <section className="overview-section">
        <div className="overview-head">
          <h2 className="oy-overline">{t("Shortcuts")}</h2>
        </div>
        <div className="card-grid">
          <Shortcut
            to="/admin/chats?view=declined"
            icon="alert"
            title={t("Declined messages")}
            tag={shortcuts.declinedToReview > 0 ? t("{declinedToReview} to review", { declinedToReview: shortcuts.declinedToReview }) : undefined}
          >
            {shortcuts.declinedToReview > 0
              ? t("Replies the AI refused. Check them without reading every chat")
              : t("Nothing waiting. Replies the AI refuses show up here")}
          </Shortcut>
          <Shortcut to="/admin/chats" icon="share" title={t("Shared chats")} tag={shortcuts.shared > 0 ? t("{shared} shared", { shared: shortcuts.shared }) : undefined}>
            {shortcuts.sharing === "off"
              ? t("Sharing is off, so links don't open")
              : shortcuts.sharing === "signed-in"
                ? t("Links open only for people signed in here")
                : t("Anyone with a link can read the chat it shares")}
          </Shortcut>
          <Shortcut to="/admin/people" icon="users" title={t("People")} tag={plural(people.total, "account", "accounts")}>
            {t("Add people, choose which models they can pick, and set monthly limits")}
          </Shortcut>
          <Shortcut to="/admin/settings" icon="eye" title={t("Activity log")}>
            {shortcuts.lastAudit
              ? t("Last: {toLowerCase}, {createdAt}", {
                  toLowerCase: (AUDIT_ACTIONS[shortcuts.lastAudit.action] ?? shortcuts.lastAudit.action).toLowerCase(),
                  createdAt: shortDate(shortcuts.lastAudit.createdAt),
                })
              : t("Every admin action, and every chat an admin opens, is listed here")}
          </Shortcut>
        </div>
      </section>
    </div>
  );
}

type Trend = { label: string; values: (number | null)[]; max?: number; describe: (index: number) => string };

/** A number with its label and a note; with a trend, a line of the last 14 days under it. */
function StatCard({ label, tag, value, trend, children }: { label: string; tag?: string; value: string; trend?: Trend; children: ReactNode }) {
  const [active, setActive] = useState<number | null>(null);
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <div className="stat-figure">
        <p className="stat-value">{value}</p>
        {tag && <span className="tag">{tag}</span>}
      </div>
      {/* Pointing at a day on the line shows that day here, in place of the note. */}
      <p className="stat-note has-readout" aria-live="polite">
        {trend && active != null ? trend.describe(active) : children}
      </p>
      {trend && <Sparkline values={trend.values} max={trend.max} active={active} onActive={setActive} label={trend.label} />}
    </div>
  );
}

const dayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "numeric", month: "short" });
const parseDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/**
 * Tokens per day for two weeks, one column a day from a single baseline. The headline counts the
 * last 7 days, drawn in the accent; the week before sits in the quieter grey for comparison.
 * Pointing at (or focusing) a day shows its count in the headline, in place, no pop-up.
 */
function TokenVolume({ volume }: { volume: Overview["volume"] }) {
  const [active, setActive] = useState<number | null>(null);
  const lastWeek = volume.slice(-7).reduce((sum, d) => sum + d.tokens, 0);
  const max = Math.max(...volume.map((d) => d.tokens), 1);
  const picked = active == null ? null : volume[active];
  const today = volume.length - 1;

  return (
    <div className="stat-card volume-card">
      <div className="volume-figure">
        <p className="stat-label">{t("Token volume")}</p>
        <p className="stat-value">{compactNumber(picked ? picked.tokens : lastWeek)}</p>
        <p className="stat-note">{picked ? (active === today ? t("Today") : dayFmt.format(parseDay(picked.day))) : t("Last 7 days")}</p>
      </div>
      <div className="volume-chart" onPointerLeave={() => setActive(null)}>
        <div className="volume-bars">
          {volume.map((d, i) => (
            <button
              key={d.day}
              type="button"
              className={`volume-slot${i >= volume.length - 7 ? " is-recent" : ""}${active === i ? " is-active" : ""}`}
              aria-label={t("{value}: {tokens} tokens", { value: i === today ? t("Today") : dayFmt.format(parseDay(d.day)), tokens: formatNumber(d.tokens) })}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            >
              {d.tokens > 0 && <span className="volume-bar" style={{ height: `${Math.max((d.tokens / max) * 100, 3)}%` }} />}
            </button>
          ))}
        </div>
        <div className="volume-axis">
          <span>{shortDate(parseDay(volume[0].day).toISOString())}</span>
          <span>{t("Today")}</span>
        </div>
      </div>
    </div>
  );
}

function Shortcut({ to, icon, title, tag, children }: { to: string; icon: IconName; title: string; tag?: string; children: ReactNode }) {
  return (
    <Link className="shortcut-card" to={to}>
      <p className="shortcut-title">
        <Icon name={icon} size={18} />
        <span>{title}</span>
      </p>
      <p className="shortcut-desc">{children}</p>
      {/* The count sits at the card's foot, never squeezed beside the title. */}
      {tag && <span className="chip-quiet shortcut-count">{tag}</span>}
    </Link>
  );
}
