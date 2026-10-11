import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Segmented } from "../components/Controls.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api, uploadRaw, type Connection, type Device, type Persona, type Policy, type TwoStep } from "../lib/api.ts";
import { domainsText, rewardText, type BonusStatus } from "../lib/bonus.ts";
import { compactNumber, formatCost, formatNumber, shortDate } from "../lib/format.ts";
import { andText, LANG_CHOICE, setLang, t, tn } from "../lib/i18n.ts";
import { useSession } from "../lib/session.tsx";
import { devicesText } from "./DevicesPage.tsx";
import { twoStepText } from "./TwoStepPage.tsx";
import type { MemoryState } from "./MemoryPage.tsx";

type Theme = "light" | "dark" | "system";

/** What this person has used this month against their limits (null for none), reward included. */
type Allowance = {
  spent: number;
  spendLimit: number | null;
  tokens: number;
  tokenLimit: number | null;
  resetsAt: string;
  over: "spend" | "tokens" | null;
};

function readTheme(): Theme {
  try {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", theme);
  } catch {
    // Private windows can refuse storage; the choice still applies until reload.
  }
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  // The bars around the page take its background: each theme's own for System, else the chosen one.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = theme === "system" ? (meta.media.includes("dark") ? "dark" : "light") : theme;
    meta.content = THEME_COLORS[scheme];
  }
}

/** The page's background in each theme (--bg in tokens.css), as index.html and public/theme.js have it. */
const THEME_COLORS = { light: "#ffffff", dark: "#181714" };

export function AccountPage() {
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, setTheme] = useState<Theme>(readTheme);
  // Back from the password page, the Password row says it changed.
  const [passwordChanged] = useState(() => !!(location.state as { passwordChanged?: boolean } | null)?.passwordChanged);
  const [personas, setPersonas] = useState<Persona[] | null>(null);

  const [bonus, setBonus] = useState<BonusStatus | null>(null);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [twoStep, setTwoStep] = useState<TwoStep | null>(null);

  useEffect(() => {
    // Once read, the note leaves the history entry, so a reload doesn't say it again.
    if (passwordChanged) navigate(location.pathname, { replace: true, state: null });
    api.get<{ personas: Persona[] }>("/personas").then((r) => setPersonas(r.personas), () => {});
    api.get<BonusStatus>("/auth/bonus").then(setBonus, () => {});
    api.get<Allowance>("/auth/allowance").then(setAllowance, () => {});
    api.get<MemoryState>("/memory").then(setMemory, () => {});
    api.get<Policy>("/policy").then(setPolicy, () => {});
    api.get<{ connections: Connection[] }>("/mcp/connections").then((r) => setConnections(r.connections), () => {});
    api.get<{ sessions: Device[] }>("/auth/sessions").then((r) => setDevices(r.sessions), () => {});
    api.get<TwoStep>("/auth/two-step").then(setTwoStep, () => {});
  }, []);

  const memoryDesc = !memory
    ? t("What the AI keeps about you between chats")
    : !memory.site
      ? t("Your admins have turned memory off")
      : !memory.on
        ? memory.memories.length
          ? tn(memory.memories.length, "Off, with {count} note kept", "Off, with {count} notes kept", { count: formatNumber(memory.memories.length) })
          : t("Off")
        : memory.memories.length
          ? tn(memory.memories.length, "On, with {count} note", "On, with {count} notes", { count: formatNumber(memory.memories.length) })
          : t("On. Nothing saved yet");

  const startsAs = personas?.find((p) => p.forNewChats);
  const personaDesc = !personas?.length
    ? t("Who you are to the AI and how it should answer, up to five")
    : startsAs
      ? t("New chats start as {name}", { name: startsAs.name })
      : tn(personas.length, "{count} persona. New chats start without one", "{count} personas. New chats start without one", { count: formatNumber(personas.length) });

  useEffect(() => applyTheme(theme), [theme]);

  return (
    <>
      <PageHeader title={t("Settings")} />
      <div className="oy-page-column page-body">
        {/* Who's signed in, first. */}
        <div className="settings-profile">
          <span className="settings-avatar" aria-hidden="true">
            {(user?.email ?? "?").charAt(0).toUpperCase()}
          </span>
          <div className="text">
            <p className="title truncate">{user?.email}</p>
            <div className="desc">{user?.role === "admin" ? t("Admin of this site") : t("Member")}</div>
          </div>
        </div>

        <div className="oy-group">
          <p className="oy-overline">{t("Account")}</p>
          <div className="oy-section">
            <SlideLink className="oy-row" to="/settings/password" direction="forward">
              <Icon name="lock" size={20} />
              <div className="text">
                <p className="title">{t("Password")}</p>
                <div className="desc">{passwordChanged ? t("Changed. Other devices were signed out") : t("Change the password you sign in with")}</div>
              </div>
              <Icon name="chevron-right" size={18} className="chevron" />
            </SlideLink>
            <SlideLink className="oy-row" to="/settings/two-step" direction="forward">
              <Icon name="shield" size={20} />
              <div className="text">
                <p className="title">{t("Two-step verification")}</p>
                <div className="desc">{twoStep ? twoStepText(twoStep) : t("A code from an app, or a passkey, after your password")}</div>
              </div>
              <Icon name="chevron-right" size={18} className="chevron" />
            </SlideLink>
            <SlideLink className="oy-row" to="/settings/devices" direction="forward">
              <Icon name="devices" size={20} />
              <div className="text">
                <p className="title">{t("Where you're signed in")}</p>
                <div className={`desc${devices?.some((d) => !d.browser) ? " text-warning" : ""}`}>
                  {devices ? devicesText(devices) : t("The devices signed in to your account")}
                </div>
              </div>
              <Icon name="chevron-right" size={18} className="chevron" />
            </SlideLink>
          </div>
        </div>

        <div className="oy-group">
          <p className="oy-overline">{t("Appearance")}</p>
          <div className="oy-section">
            <div className="oy-row">
              <Icon name="sun" size={20} />
              <div className="text">
                <p className="title">{t("Theme")}</p>
              </div>
              <Segmented
                aria-label={t("Theme")}
                value={theme}
                onChange={setTheme}
                options={[
                  { id: "light", label: t("Light") },
                  { id: "dark", label: t("Dark") },
                  { id: "system", label: t("System") },
                ]}
              />
            </div>
            <div className="oy-row">
              <Icon name="chat" size={20} />
              <div className="text">
                <p className="title">{t("Language")}</p>
              </div>
              <Segmented
                aria-label={t("Language")}
                value={LANG_CHOICE}
                onChange={setLang}
                options={[
                  { id: "system", label: t("System") },
                  { id: "en", label: t("English") },
                  // Written in itself, so anyone can find their language.
                  { id: "zh", label: "中文" },
                ]}
              />
            </div>
          </div>
        </div>

        <div className="oy-group">
          <p className="oy-overline">{t("Assistant")}</p>
          <div className="oy-section">
            <SlideLink className="oy-row" to="/settings/personas" direction="forward">
              <Icon name="user" size={20} />
              <div className="text">
                <p className="title">{t("Personas")}</p>
                <div className="desc truncate">{personaDesc}</div>
              </div>
              <Icon name="chevron-right" size={18} className="chevron" />
            </SlideLink>
            <SlideLink className="oy-row" to="/settings/memory" direction="forward">
              <Icon name="note" size={20} />
              <div className="text">
                <p className="title">{t("What the AI remembers")}</p>
                <div className="desc">{memoryDesc}</div>
              </div>
              <Icon name="chevron-right" size={18} className="chevron" />
            </SlideLink>
            {connections && connections.length > 0 && (
              <SlideLink className="oy-row" to="/settings/connections" direction="forward">
                <Icon name="plug" size={20} />
                <div className="text">
                  <p className="title">{t("Connected services")}</p>
                  <div className="desc">{connectionsText(connections)}</div>
                </div>
                <Icon name="chevron-right" size={18} className="chevron" />
              </SlideLink>
            )}
          </div>
        </div>

        {allowance && (allowance.spendLimit != null || allowance.tokenLimit != null) && <AllowanceGroup allowance={allowance} />}

        {bonus && bonus.domains.length > 0 && <RewardsGroup bonus={bonus} />}

        <DataGroup />

        {/* What the site's rules say about people's chats; admins choose whether the first is shown. */}
        {policy && (policy.privacyNotice || policy.retainChatsDays != null || policy.retainDeletedDays != null) && (
          <div className="oy-group">
            <p className="oy-overline">{t("Privacy")}</p>
            <div className="oy-section">
              {policy.privacyNotice && (
                <div className="oy-row">
                  <Icon name="eye" size={20} />
                  <div className="text">
                    <p className="title">{t("Admins can read your chats")}</p>
                    <div className="desc">{t("The people who run this site can open any conversation, and each time they do it's logged")}</div>
                  </div>
                </div>
              )}
              {(policy.retainChatsDays != null || policy.retainDeletedDays != null) && (
                <div className="oy-row">
                  <Icon name="trash" size={20} />
                  <div className="text">
                    <p className="title">{t("How long chats are kept")}</p>
                    <div className="desc">{retentionText(policy)}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="oy-group">
          <p className="oy-overline">{t("About")}</p>
          <div className="oy-section">
            <a className="oy-row" href={REPOSITORY} target="_blank" rel="noopener noreferrer">
              <Icon name="code" size={20} />
              <div className="text">
                <p className="title">Parley {__APP_VERSION__}</p>
                <div className="desc">{t("Open source, under the AGPL. Its code, and where to report a problem, are on GitHub")}</div>
              </div>
            </a>
          </div>
        </div>

        <div className="oy-group">
          <div className="oy-section">
            <button type="button" className="oy-row" onClick={() => void signOut().then(() => navigate("/login", { replace: true }))}>
              <Icon name="logout" size={20} />
              <div className="text">
                <p className="title">{t("Sign out")}</p>
              </div>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/** Where Parley's code lives, for the About row. */
const REPOSITORY = "https://github.com/SmirnovaOyama/parley";

/** Where you stand with the services whose tools act with your own account, as a sentence. */
function connectionsText(list: Connection[]): string {
  const waiting = list.filter((c) => c.status !== "connected").map((c) => c.name);
  if (!waiting.length) return t("Connected to {namesText}", { namesText: andText(list.map((c) => c.name)) });
  return tn(waiting.length, "{namesText} needs your own account before chats can use its tools", "{namesText} need your own account before chats can use their tools", {
    namesText: andText(waiting),
  });
}

/** The site's retention rules, as sentences. */
function retentionText(p: Policy): string {
  const parts: string[] = [];
  if (p.retainChatsDays != null) {
    parts.push(
      tn(p.retainChatsDays, "A chat nobody has touched for {retainChatsDays} day is deleted, files and all", "A chat nobody has touched for {retainChatsDays} days is deleted, files and all", {
        retainChatsDays: formatNumber(p.retainChatsDays),
      }),
    );
  }
  if (p.retainDeletedDays === 0) parts.push(t("A chat you delete is gone at once, for admins too"));
  else if (p.retainDeletedDays != null) {
    parts.push(
      tn(p.retainDeletedDays, "A chat you delete stays readable to admins for {retainDeletedDays} day, then goes", "A chat you delete stays readable to admins for {retainDeletedDays} days, then goes", {
        retainDeletedDays: formatNumber(p.retainDeletedDays),
      }),
    );
  }
  return parts.join(". ");
}

/** Taking everything away as a file, and bringing chats in from Parley, ChatGPT or Claude. */
function DataGroup() {
  const { refreshConversations, refreshProjects } = useSession();
  const pickerRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const importFile = async (file: File) => {
    setBusy(true);
    setStatus({ text: t("Sending the file") });
    try {
      const r = await uploadRaw<{ chats: number; skipped: number; projects: number; memories: number; source: string }>("/import", file, file.name, (p) =>
        setStatus({ text: p < 1 ? t("Sending the file, {round}%", { round: Math.round(p * 100) }) : t("Reading the chats") }),
      ).promise;
      const from = { parley: t("a Parley export"), chatgpt: "ChatGPT", claude: "Claude" }[r.source] ?? t("the file");
      const extras = [
        r.projects && tn(r.projects, "{projects} project", "{projects} projects", { projects: formatNumber(r.projects) }),
        r.memories && tn(r.memories, "{memories} note", "{memories} notes", { memories: formatNumber(r.memories) }) + " " + t("for memory"),
      ].filter(Boolean) as string[];
      setStatus({
        text:
          tn(r.chats, "Brought in {chats} chat from {from}", "Brought in {chats} chats from {from}", { chats: formatNumber(r.chats), from }) +
          (extras.length ? t(", with {extras}", { extras: andText(extras) }) : "") +
          (r.skipped ? tn(r.skipped, ". {skipped} chat was here already", ". {skipped} chats were here already", { skipped: formatNumber(r.skipped) }) : ""),
      });
      void refreshConversations();
      void refreshProjects();
    } catch (err) {
      setStatus({ text: (err as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="oy-group">
      <p className="oy-overline">{t("Your data")}</p>
      <div className="oy-section">
        <a className="oy-row" href="/api/export" download>
          <Icon name="download" size={20} />
          <div className="text">
            <p className="title">{t("Export everything")}</p>
            <div className="desc">{t("Your chats with every version of each message, projects, personas and memory, as one file. Attached files stay here")}</div>
          </div>
        </a>
        <button type="button" className="oy-row" disabled={busy} onClick={() => pickerRef.current?.click()}>
          <Icon name="upload" size={20} />
          <div className="text">
            <p className="title">{t("Import chats")}</p>
            {/* The progress and the result take the place of the sentence, which keeps its room. */}
            <div className={`desc swap${status?.error ? " text-danger" : ""}`}>
              <span className={status ? "reserve" : undefined} aria-hidden={status ? true : undefined}>
                {t("From a Parley export, or the export ChatGPT or Claude emails you (the .zip, or conversations.json inside it)")}
              </span>
              {status && <span className="tabular">{status.text}</span>}
            </div>
          </div>
        </button>
        <input
          ref={pickerRef}
          type="file"
          hidden
          accept=".json,.zip,application/json,application/zip"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void importFile(file);
          }}
        />
      </div>
    </div>
  );
}

/** Shown when the site rewards some email domains: the reward, and the way to earn or keep it. */
function RewardsGroup({ bonus }: { bonus: BonusStatus }) {
  const reward = rewardText(bonus.reward);
  const v = bonus.verified;
  const title = v?.active ? t("Reward on") : v ? t("Reward ended") : t("Get a reward");
  const desc = v?.active
    ? reward
      ? t("Verified {email}. You get {reward}", { email: v.email, reward })
      : t("Verified {email}", { email: v.email })
    : v
      ? t("{email} no longer earns one. Verify an address at {domainsText}", { email: v.email, domainsText: domainsText(bonus.domains) })
      : reward
        ? t("Verify an address at {domainsText} to get {reward}", { domainsText: domainsText(bonus.domains), reward })
        : t("Verify an address at {domainsText}", { domainsText: domainsText(bonus.domains) });
  return (
    <div className="oy-group">
      <p className="oy-overline">{t("Rewards")}</p>
      <div className="oy-section">
        <SlideLink className="oy-row" to="/settings/bonus" direction="forward">
          <Icon name="gift" size={20} />
          <div className="text">
            <p className="title">{title}</p>
            <div className="desc">{desc}</div>
          </div>
          <Icon name="chevron-right" size={18} className="chevron" />
        </SlideLink>
      </div>
    </div>
  );
}

/** This month's spending (and tokens, when limited) against the limits, as a quiet meter each. */
function AllowanceGroup({ allowance: a }: { allowance: Allowance }) {
  const resets = shortDate(a.resetsAt);
  const meters = [
    a.spendLimit != null && { id: "spend", title: t("Spending"), used: a.spent, limit: a.spendLimit, text: t("{spent} of {spendLimit}", { spent: formatCost(a.spent), spendLimit: formatCost(a.spendLimit) }) },
    a.tokenLimit != null && { id: "tokens", title: t("Tokens"), used: a.tokens, limit: a.tokenLimit, text: t("{tokens} of {tokenLimit} tokens", { tokens: compactNumber(a.tokens), tokenLimit: compactNumber(a.tokenLimit) }) },
  ].filter((m) => !!m);

  return (
    <div className="oy-group">
      <p className="oy-overline">{t("This month")}</p>
      <div className="oy-section">
        {meters.map((m) => {
          const full = m.used >= m.limit;
          return (
            <div key={m.id} className="oy-row">
              <Icon name="chart" size={20} />
              <div className="text">
                <p className="title">{m.title}</p>
                <div className="desc">
                  {t("You've used {text}.", { text: m.text })} {full ? t("You can send messages again on {resets}", { resets }) : t("It starts over on {resets}", { resets })}
                </div>
                <span
                  className={`allowance-meter${full ? " is-full" : ""}`}
                  role="meter"
                  aria-label={t("{title} this month", { title: m.title })}
                  aria-valuemin={0}
                  aria-valuemax={m.limit}
                  aria-valuenow={Math.min(m.used, m.limit)}
                  aria-valuetext={m.text}
                >
                  <span style={{ width: `${m.limit > 0 ? Math.min((m.used / m.limit) * 100, 100) : 100}%` }} />
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
