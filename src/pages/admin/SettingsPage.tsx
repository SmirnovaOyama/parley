import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useParams } from "react-router";
import { BusyButton } from "../../components/BusyButton.tsx";
import { OptionList, Switch, Tick } from "../../components/Controls.tsx";
import { InlineConfirm } from "../../components/DangerRow.tsx";
import { Advisory, Spinner } from "../../components/Feedback.tsx";
import { LineArea, LineField } from "../../components/LineField.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { SlideLink } from "../../components/SlideLink.tsx";
import { Icon, type IconName } from "../../icons/Icon.tsx";
import { api, type SharingMode, type SiteNotice } from "../../lib/api.ts";
import { AUDIT_ACTIONS as ACTIONS } from "../../lib/audit.ts";
import { amountInput, amountText, dateTime, formatCost, formatNumber } from "../../lib/format.ts";
import { t, tn } from "../../lib/i18n.ts";
import { useSession } from "../../lib/session.tsx";

import type { ApiKey } from "./KeysPage.tsx";

type Settings = {
  allowSignup: boolean;
  /** Null leaves it to the site: on once it can send email. */
  signupCode: boolean | null;
  systemPrompt: string;
  showThinking: boolean;
  sharing: SharingMode;
  bonusDomains: string[];
  bonusTokens: number | null;
  bonusKeyIds: number[];
  bonusSpend: number | null;
  spendLimit: number | null;
  memory: boolean;
  privacyNotice: boolean;
  retainChatsDays: number | null;
  retainDeletedDays: number | null;
  maxSessions: number | null;
};
type MailMode = "smtp" | "dev" | "off";
type AuditEntry = { id: number; action: string; target: string | null; createdAt: string; admin: string };

/** What every settings page loads: the settings, how the site sends email, and the notice. */
function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mail, setMail] = useState<MailMode>("dev");
  const [notice, setNotice] = useState<SiteNotice | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadAudit = () => api.get<{ entries: AuditEntry[] }>("/admin/audit").then((r) => setAudit(r.entries), () => {});

  useEffect(() => {
    api.get<{ settings: Settings; mail: MailMode; notice: SiteNotice | null }>("/admin/settings").then(
      (r) => {
        setSettings(r.settings);
        setMail(r.mail);
        setNotice(r.notice);
      },
      (err) => setError((err as Error).message),
    );
    void loadAudit();
  }, []);

  /** Saves some settings; false when the server said no (its reason is in `error`). */
  const update = async (next: Partial<Settings>) => {
    setError(null);
    try {
      const r = await api.patch<{ settings: Settings }>("/admin/settings", next);
      setSettings(r.settings);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  return { settings, setSettings, mail, notice, setNotice, audit, loadAudit, error, update };
}

type Loaded = ReturnType<typeof useSettings> & { settings: Settings };

const signupCodeOn = (s: Settings, mail: MailMode) => mail !== "off" && (s.signupCode ?? mail === "smtp");

const SHARING_LABELS: Record<SharingMode, string> = {
  anyone: t("Anyone with the link"),
  "signed-in": t("People signed in here"),
  off: t("Nobody"),
};

type Section = {
  id: string;
  icon: IconName;
  title: string;
  /** The row's second line on the Settings menu: how it's set now. */
  summary: (s: Loaded) => string;
  page: (s: Loaded) => ReactNode;
};

/**
 * Admin › Settings is a menu: one row for each part, each opening its own page
 * (/admin/settings/<id>), so no page holds every setting at once.
 */
const SECTIONS: { label: string; sections: Section[] }[] = [
  {
    label: t("People"),
    sections: [
      {
        id: "notice",
        icon: "megaphone",
        title: t("Notice for everyone"),
        summary: ({ notice }) => notice?.text ?? t("Nothing posted"),
        page: ({ notice, setNotice, loadAudit }) => (
          <NoticeForm
            notice={notice}
            onChange={(next) => {
              setNotice(next);
              void loadAudit();
            }}
          />
        ),
      },
      {
        id: "sign-ups",
        icon: "users",
        title: t("Sign-ups"),
        summary: ({ settings, mail }) =>
          !settings.allowSignup
            ? t("Only admins add people")
            : signupCodeOn(settings, mail)
              ? t("Anyone can sign up, with a code sent to their address")
              : t("Anyone can sign up"),
        page: (s) => <SignupsPage {...s} />,
      },
      {
        id: "signing-in",
        icon: "devices",
        title: t("Signing in"),
        summary: ({ settings }) =>
          settings.maxSessions == null
            ? t("No limit on devices")
            : tn(settings.maxSessions, "Each account on up to {count} device", "Each account on up to {count} devices", { count: formatNumber(settings.maxSessions) }),
        page: ({ settings, update }) => <DevicesForm saved={settings.maxSessions} onSave={(maxSessions) => update({ maxSessions })} />,
      },
      {
        id: "spending",
        icon: "coin",
        title: t("Spending"),
        summary: ({ settings }) =>
          settings.spendLimit == null ? t("No monthly limit") : t("{amount} a month for each member", { amount: formatCost(settings.spendLimit) }),
        page: ({ settings, update }) => <SpendingForm saved={settings.spendLimit} onSave={(spendLimit) => update({ spendLimit })} />,
      },
      {
        id: "rewards",
        icon: "gift",
        title: t("Email rewards"),
        summary: ({ settings }) =>
          settings.bonusDomains.length === 0
            ? t("No domains yet")
            : tn(settings.bonusDomains.length, "{count} domain earns a reward", "{count} domains earn a reward", { count: formatNumber(settings.bonusDomains.length) }),
        page: ({ settings, setSettings, mail }) => (
          <RewardsForm
            settings={settings}
            mail={mail}
            onSave={async (next) => {
              // The rewards form reports its own errors next to its fields.
              const r = await api.patch<{ settings: Settings }>("/admin/settings", next);
              setSettings(r.settings);
            }}
          />
        ),
      },
    ],
  },
  {
    label: t("Chats"),
    sections: [
      {
        id: "assistant",
        icon: "chat",
        title: t("Assistant"),
        summary: () => t("Instructions for the AI, its thinking and memory"),
        page: (s) => <AssistantPage {...s} />,
      },
      {
        id: "sharing",
        icon: "share",
        title: t("Sharing"),
        summary: ({ settings }) => SHARING_LABELS[settings.sharing],
        page: ({ settings, setSettings, update }) => (
          <OptionList<SharingMode>
            label={t("Who can open shared chats")}
            value={settings.sharing}
            onChange={(sharing) => {
              setSettings({ ...settings, sharing });
              void update({ sharing });
            }}
            options={[
              { id: "anyone", label: SHARING_LABELS.anyone, detail: t("No account needed") },
              { id: "signed-in", label: SHARING_LABELS["signed-in"], detail: t("A link asks for an account on this site first") },
              { id: "off", label: SHARING_LABELS.off, detail: t("People can't share chats, and existing links stop opening until it's back on") },
            ]}
          />
        ),
      },
      {
        id: "keeping-chats",
        icon: "hourglass",
        title: t("Keeping chats"),
        summary: ({ settings: { retainChatsDays: chats, retainDeletedDays: deleted } }) =>
          chats != null
            ? tn(chats, "Chats nobody touches go after {count} day", "Chats nobody touches go after {count} days", { count: formatNumber(chats) })
            : deleted === 0
              ? t("Chats people delete are removed right away")
              : deleted != null
                ? tn(deleted, "Chats people delete stay {count} day for admins", "Chats people delete stay {count} days for admins", { count: formatNumber(deleted) })
                : t("Chats are kept for good"),
        page: ({ settings, update }) => <RetentionForm settings={settings} onSave={(next) => update(next)} />,
      },
      {
        id: "privacy",
        icon: "eye",
        title: t("Privacy"),
        summary: ({ settings }) => (settings.privacyNotice ? t("People are told admins can read chats") : t("People aren't told admins can read chats")),
        page: (s) => <PrivacyPage {...s} />,
      },
    ],
  },
  {
    label: t("Admins"),
    sections: [
      {
        id: "activity",
        icon: "list",
        title: t("Recent admin activity"),
        summary: ({ audit }) => (audit[0] ? t("Latest: {action}", { action: ACTIONS[audit[0].action] ?? audit[0].action }) : t("Nothing yet")),
        page: ({ audit }) => <ActivityPage audit={audit} />,
      },
    ],
  },
];

/** Admin › Settings: the menu of settings, each row saying how it's set now. */
export function SettingsPage() {
  const s = useSettings();
  if (!s.settings) return s.error ? <Advisory>{s.error}</Advisory> : <Spinner />;
  const loaded = s as Loaded;

  return (
    <>
      {SECTIONS.map((group) => (
        <div key={group.label} className="oy-group">
          <p className="oy-overline">{group.label}</p>
          <div className="oy-section">
            {group.sections.map((section) => (
              <SlideLink key={section.id} className="oy-row" to={`/admin/settings/${section.id}`} direction="forward">
                <Icon name={section.icon} size={20} />
                <div className="text">
                  <p className="title">{section.title}</p>
                  <div className="desc truncate">{section.summary(loaded)}</div>
                </div>
                <Icon name="chevron-right" size={18} className="chevron" />
              </SlideLink>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** Admin › Settings › one part of them (/admin/settings/<id>). */
export function SettingsSectionPage() {
  const { section: id } = useParams();
  const section = SECTIONS.flatMap((g) => g.sections).find((x) => x.id === id);
  const s = useSettings();
  if (!section) return <Navigate to="/admin/settings" replace />;

  return (
    <div className="admin-page">
      <PageHeader title={section.title} back={{ label: t("Settings"), to: "/admin/settings" }} />
      <div className="oy-page-column page-body">
        {s.error && <Advisory>{s.error}</Advisory>}
        {s.settings ? section.page(s as Loaded) : !s.error && <Spinner />}
      </div>
    </div>
  );
}

function SignupsPage({ settings, mail, update }: Loaded) {
  return (
    <div className="oy-section">
      <div className="oy-row">
        <Icon name="users" size={20} />
        <div className="text">
          <label className="title" htmlFor="allow-signup">
            {t("Let people create accounts")}
          </label>
          <div className="desc">{t("When it's off, only admins can add people")}</div>
        </div>
        <Switch id="allow-signup" checked={settings.allowSignup} onChange={(v) => void update({ allowSignup: v })} />
      </div>
      <div className="oy-row">
        <Icon name="mail" size={20} />
        <div className="text">
          <label className="title" htmlFor="signup-code">
            {t("Check new addresses with a code")}
          </label>
          <div className="desc">{SIGNUP_CODE_NOTE[mail]}</div>
        </div>
        <Switch id="signup-code" checked={signupCodeOn(settings, mail)} disabled={mail === "off"} onChange={(v) => void update({ signupCode: v })} />
      </div>
    </div>
  );
}

function AssistantPage({ settings, update }: Loaded) {
  const [prompt, setPrompt] = useState(settings.systemPrompt);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaved(await update({ systemPrompt: prompt }));
    setBusy(false);
  };

  return (
    <>
      <div className="oy-group oy-section">
        <div className="oy-row">
          <Icon name="eye" size={20} />
          <div className="text">
            <label className="title" htmlFor="show-thinking">
              {t("Show the AI's thinking")}
            </label>
            <div className="desc">{t("Folded above each reply, for models that share it: a summary of their reasoning, or the reasoning itself")}</div>
          </div>
          <Switch id="show-thinking" checked={settings.showThinking} onChange={(v) => void update({ showThinking: v })} />
        </div>
        <div className="oy-row">
          <Icon name="note" size={20} />
          <div className="text">
            <label className="title" htmlFor="memory">
              {t("Memory")}
            </label>
            <div className="desc">{t("The AI keeps short notes about each person between chats. People see and edit theirs, and can turn it off for themselves")}</div>
          </div>
          <Switch id="memory" checked={settings.memory} onChange={(v) => void update({ memory: v })} />
        </div>
      </div>
      <form className="oy-group form-page" onSubmit={save}>
        <LineArea
          id="system-prompt"
          label={t("Instructions for the AI")}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setSaved(false);
          }}
        />
        <div className="form-actions">
          <p className="oy-field-hint">{t("Sent with every chat on every key. Changes apply to the next message")}</p>
          <BusyButton type="submit" className="btn-primary" busy={busy} disabled={prompt === settings.systemPrompt}>
            {saved && prompt === settings.systemPrompt ? t("Saved") : t("Save")}
          </BusyButton>
        </div>
      </form>
    </>
  );
}

function PrivacyPage({ settings, update }: Loaded) {
  return (
    <div className="oy-section">
      <div className="oy-row">
        <Icon name="eye" size={20} />
        <div className="text">
          <label className="title" htmlFor="privacy-notice">
            {t("Tell people admins can read chats")}
          </label>
          <div className="desc">
            {t(
              "Under Settings, everyone sees that the people who run this site can open any chat, and that each time is logged, and deleting a chat says admins can still see it. Off, none of this is shown, but admins can still read chats and each time is still logged",
            )}
          </div>
        </div>
        <Switch id="privacy-notice" checked={settings.privacyNotice} onChange={(v) => void update({ privacyNotice: v })} />
      </div>
    </div>
  );
}

function ActivityPage({ audit }: { audit: AuditEntry[] }) {
  if (audit.length === 0) return <p className="text-muted">{t("Nothing yet")}</p>;
  return (
    <div className="oy-section is-plain">
      {audit.map((a) => (
        <div key={a.id} className="oy-row audit-row">
          <div className="text">
            <p className="title">
              {ACTIONS[a.action] ?? a.action}
              {a.target && <span className="audit-target"> {a.target}</span>}
            </p>
            <div className="desc">{t("By {admin} on {createdAt}", { admin: a.admin, createdAt: dateTime(a.createdAt) })}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

const NOTICE_MAX = 500;

/**
 * The site notice: a line of plain text everyone sees at the top of the app until they dismiss it.
 * Changing the words shows it again to people who dismissed it; taking it down hides it from all.
 */
function NoticeForm({ notice, onChange }: { notice: SiteNotice | null; onChange: (next: SiteNotice | null) => void }) {
  const { refreshUser } = useSession();
  const [text, setText] = useState(notice?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.replace(/\s+/g, " ").trim();
  const dirty = trimmed !== (notice?.text ?? "");

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<{ notice: SiteNotice }>("/admin/notice", { text });
      onChange(r.notice);
      setText(r.notice.text);
      // The admin sees it at the top straight away, as everyone will on their next page load.
      void refreshUser();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const takeDown = async () => {
    setError(null);
    try {
      await api.del("/admin/notice");
      onChange(null);
      setText("");
      setAsking(false);
      void refreshUser();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="oy-group">
      <p className="group-intro">
        {notice
          ? t("Showing at the top of the app since {postedAt}. People can dismiss it, and it shows again when you change it", { postedAt: dateTime(notice.postedAt) })
          : t("A line at the top of the app for everyone signed in, such as planned maintenance or a new model. People can dismiss it")}
      </p>
      <form className="form-page" onSubmit={save}>
        <LineArea
          id="site-notice"
          label={t("What it says")}
          value={text}
          maxLength={NOTICE_MAX}
          onChange={(e) => setText(e.target.value)}
          hint={t("Plain text on one line. {count} of {max} characters", { count: trimmed.length, max: NOTICE_MAX })}
        />
        {error && <Advisory>{error}</Advisory>}
        {asking && notice ? (
          <InlineConfirm message={t("Take it down?")} action={t("Take down")} onCancel={() => setAsking(false)} onConfirm={takeDown} />
        ) : (
          <div className="form-actions">
            {notice ? (
              <button type="button" className="btn-secondary" onClick={() => setAsking(true)}>
                {t("Take down")}
              </button>
            ) : (
              <span />
            )}
            <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!dirty || !trimmed}>
              {notice ? (dirty ? t("Publish changes") : t("Published")) : t("Publish")}
            </BusyButton>
          </div>
        )}
      </form>
    </div>
  );
}

const daysText = (n: number | null) => (n == null ? "" : String(n));

/**
 * How many devices one account can be signed in on. Signing in on one more signs out the one used
 * longest ago, so an account passed around a class keeps signing its people out of each other.
 */
function DevicesForm({ saved, onSave }: { saved: number | null; onSave: (limit: number | null) => Promise<boolean> }) {
  const [limit, setLimit] = useState(daysText(saved));
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = limit !== daysText(saved);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await onSave(limit.trim() === "" ? null : Number(limit));
    setBusy(false);
    setDone(ok);
  };

  return (
    <div className="oy-group">
      <form className="form-page" onSubmit={save}>
        <LineField
          id="max-sessions"
          label={t("Devices each account can be signed in on")}
          inputMode="numeric"
          autoComplete="off"
          value={limit}
          onChange={(e) => {
            setLimit(e.target.value.replace(/[^\d]/g, ""));
            setDone(false);
          }}
          hint={t("Leave empty for no limit")}
        />
        <div className="form-actions">
          <p className="oy-field-hint">
            {t(
              "Signing in on one more signs out the one used longest ago, and a lower number holds as soon as it's saved. Each person's page shows where they're signed in",
            )}
          </p>
          <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!dirty}>
            {done && !dirty ? t("Saved") : t("Save")}
          </BusyButton>
        </div>
      </form>
    </div>
  );
}

/**
 * How long chats are kept: ones nobody touches, and ones people deleted (which admins can still read
 * until then). Both empty keeps everything, as before. People see the rules under Settings.
 */
function RetentionForm({ settings, onSave }: { settings: Settings; onSave: (next: Pick<Settings, "retainChatsDays" | "retainDeletedDays">) => Promise<boolean> }) {
  const [chats, setChats] = useState(daysText(settings.retainChatsDays));
  const [deleted, setDeleted] = useState(daysText(settings.retainDeletedDays));
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = chats !== daysText(settings.retainChatsDays) || deleted !== daysText(settings.retainDeletedDays);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await onSave({ retainChatsDays: chats.trim() === "" ? null : Number(chats), retainDeletedDays: deleted.trim() === "" ? null : Number(deleted) });
    setBusy(false);
    setDone(ok);
  };

  return (
    <div className="oy-group">
      <form className="form-page" onSubmit={save}>
        <LineField
          id="retain-chats"
          label={t("Delete chats nobody has touched for this many days")}
          inputMode="numeric"
          autoComplete="off"
          value={chats}
          onChange={(e) => {
            setChats(e.target.value.replace(/[^\d]/g, ""));
            setDone(false);
          }}
          hint={t("Leave empty to keep them for good. Their files go with them; usage records stay")}
        />
        <LineField
          id="retain-deleted"
          label={t("Keep chats people deleted, for admins, this many days")}
          inputMode="numeric"
          autoComplete="off"
          value={deleted}
          onChange={(e) => {
            setDeleted(e.target.value.replace(/[^\d]/g, ""));
            setDone(false);
          }}
          hint={t("Leave empty to keep them for good, or 0 to remove them as soon as they're deleted")}
        />
        <div className="form-actions">
          <p className="oy-field-hint">{t("Checked every hour, and right away when saved. People see these rules under Settings")}</p>
          <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!dirty}>
            {done && !dirty ? t("Saved") : t("Save")}
          </BusyButton>
        </div>
      </form>
    </div>
  );
}

/** A typed dollar amount to the cent, as the server keeps it; null when empty. */
const toCents = (text: string) => (text.trim() === "" ? null : Math.round(Number(text) * 100) / 100);

/** What each member may spend a month. A person's own page can give them their own limit, or none. */
function SpendingForm({ saved, onSave }: { saved: number | null; onSave: (limit: number | null) => Promise<boolean> }) {
  const [limit, setLimit] = useState(amountText(saved));
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = limit !== amountText(saved);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const next = toCents(limit);
    const ok = await onSave(next);
    setBusy(false);
    setDone(ok);
    // Shown as the server keeps it: "5.50", not "5.5000".
    if (ok) setLimit(amountText(next));
  };

  return (
    <div className="oy-group">
      <form className="form-page" onSubmit={save}>
        <LineField
          id="spend-limit"
          label={t("Each member's monthly limit, in dollars")}
          inputMode="decimal"
          autoComplete="off"
          value={limit}
          onChange={(e) => {
            setLimit(amountInput(e.target.value));
            setDone(false);
          }}
          hint={t("Leave empty for no limit")}
        />
        <div className="form-actions">
          <p className="oy-field-hint">
            {t(
              "Estimated from each model's price and counted from the 1st. Someone who reaches it can't send messages until next month. Admins aren't held to it, and a person's page can set their own limit",
            )}
          </p>
          <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!dirty}>
            {done && !dirty ? t("Saved") : t("Save")}
          </BusyButton>
        </div>
      </form>
    </div>
  );
}

const SIGNUP_CODE_NOTE: Record<MailMode, string> = {
  smtp: t("Before an account is made, a code goes to its address and has to be typed in, so nobody signs up with an address that isn't theirs"),
  dev: t("Before an account is made, a code goes to its address. No email server is set up, so codes are printed in the server log"),
  off: t("Needs email, which isn't set up yet: set SMTP_URL in the server's environment"),
};

const MAIL_NOTE: Record<MailMode, string> = {
  smtp: t("Codes go out by email through the server set in SMTP_URL"),
  dev: t("No email server is set up, so codes are printed in the server log. That only works while developing; set SMTP_URL to send real email"),
  off: t("No email server is set up, so nobody can verify yet. Set SMTP_URL in the server's environment"),
};

/**
 * Email rewards: the domains whose addresses earn a reward, and the reward itself. People verify an
 * address from Settings (or right after signing up with one); it's optional.
 */
function RewardsForm({
  settings,
  mail,
  onSave,
}: {
  settings: Settings;
  mail: MailMode;
  onSave: (next: Pick<Settings, "bonusDomains" | "bonusTokens" | "bonusSpend" | "bonusKeyIds">) => Promise<void>;
}) {
  const [domains, setDomains] = useState(settings.bonusDomains.join("\n"));
  const [tokens, setTokens] = useState(settings.bonusTokens == null ? "" : String(settings.bonusTokens));
  const [spend, setSpend] = useState(amountText(settings.bonusSpend));
  const [keyIds, setKeyIds] = useState<number[]>(settings.bonusKeyIds);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<{ keys: ApiKey[] }>("/admin/keys").then((r) => setKeys(r.keys), () => {});
  }, []);

  // Only keys that aren't already everyone's can be a reward. A shared one that was saved as a
  // reward stays listed after it's unticked, so the rows don't jump under the pointer.
  const offerable = keys.filter((k) => !k.shared || settings.bonusKeyIds.includes(k.id));
  const list = (text: string) => text.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const dirty =
    list(domains).join() !== settings.bonusDomains.join() ||
    tokens.trim() !== (settings.bonusTokens == null ? "" : String(settings.bonusTokens)) ||
    spend !== amountText(settings.bonusSpend) ||
    [...keyIds].sort().join() !== [...settings.bonusKeyIds].sort().join();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({
        bonusDomains: list(domains),
        bonusTokens: tokens.trim() ? Number(tokens.replace(/[,_\s]/g, "")) : null,
        bonusSpend: toCents(spend) || null,
        bonusKeyIds: keyIds,
      });
      setSpend(amountText(toCents(spend) || null));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="oy-group">
      <p className="group-intro">
        {t(
          "People who prove they own an address on one of these domains, with a code sent to it, get the reward. It's optional for them, and lasts while the domain stays listed",
        )}
      </p>
      <form className="form-page rewards-form" onSubmit={save}>
        <LineArea
          id="bonus-domains"
          label={t("Domains that earn a reward")}
          value={domains}
          spellCheck={false}
          onChange={(e) => {
            setDomains(e.target.value);
            setSaved(false);
          }}
          hint={t("One per line, like example.edu. Its subdomains count too")}
        />
        <LineField
          id="bonus-spend"
          label={t("Extra spending each month, in dollars")}
          inputMode="decimal"
          autoComplete="off"
          value={spend}
          onChange={(e) => {
            setSpend(amountInput(e.target.value));
            setSaved(false);
          }}
          hint={t("Added on top of each person's spending limit. Leave empty for none")}
        />
        <LineField
          id="bonus-tokens"
          label={t("Extra tokens each month")}
          inputMode="numeric"
          autoComplete="off"
          value={tokens}
          onChange={(e) => {
            setTokens(e.target.value);
            setSaved(false);
          }}
          hint={t("Added on top of each person's monthly limit. Leave empty for none")}
        />
        <div className="field" role="group" aria-label={t("Models they unlock")}>
          <p className="oy-field-label">{t("Models they unlock")}</p>
          {offerable.length === 0 ? (
            <p className="oy-field-hint">
              {t("Every model is open to everyone. Set a key to “Only people you choose” to offer it as a reward")}
            </p>
          ) : (
            <div className="oy-section is-plain">
              {offerable.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  className="oy-row option-row"
                  role="checkbox"
                  aria-checked={keyIds.includes(k.id)}
                  onClick={() => {
                    setKeyIds((ids) => (ids.includes(k.id) ? ids.filter((id) => id !== k.id) : [...ids, k.id]));
                    setSaved(false);
                  }}
                >
                  <span className="text">
                    <span className="title">{k.label}</span>
                    <span className="desc">{k.shared ? t("{modelLabel}. Everyone can pick it now", { modelLabel: k.modelLabel }) : k.modelLabel}</span>
                  </span>
                  <Tick on={keyIds.includes(k.id)} />
                </button>
              ))}
            </div>
          )}
        </div>
        {error && <Advisory>{error}</Advisory>}
        <div className="form-actions">
          <p className="oy-field-hint">{MAIL_NOTE[mail]}</p>
          <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!dirty}>
            {saved && !dirty ? t("Saved") : t("Save")}
          </BusyButton>
        </div>
      </form>
    </div>
  );
}
