import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Segmented } from "../components/Controls.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api, uploadRaw, type Connection, type Device, type Persona, type Policy } from "../lib/api.ts";
import { domainsText, rewardText, type BonusStatus } from "../lib/bonus.ts";
import { compactNumber, formatCost, plural, shortDate } from "../lib/format.ts";
import { useSession } from "../lib/session.tsx";
import { devicesText } from "./DevicesPage.tsx";
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
}

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
  }, []);

  const memoryDesc = !memory
    ? "What the AI keeps about you between chats"
    : !memory.site
      ? "Your admins have turned memory off"
      : !memory.on
        ? `Off${memory.memories.length ? `, with ${plural(memory.memories.length, "note", "notes")} kept` : ""}`
        : memory.memories.length
          ? `On, with ${plural(memory.memories.length, "note", "notes")}`
          : "On. Nothing saved yet";

  const startsAs = personas?.find((p) => p.forNewChats);
  const personaDesc = !personas?.length
    ? "Who you are to the AI and how it should answer, up to five"
    : startsAs
      ? `New chats start as ${startsAs.name}`
      : `${plural(personas.length, "persona", "personas")}. New chats start without one`;

  useEffect(() => applyTheme(theme), [theme]);

  return (
    <>
      <PageHeader title="Account" subtitle={user?.email} />
      <div className="oy-page-column page-body">
        <div className="oy-group">
          <p className="oy-overline">Appearance</p>
          <div className="oy-section">
            <div className="oy-row">
              <Icon name="sun" size={20} />
              <div className="text">
                <p className="title">Theme</p>
              </div>
              <Segmented
                aria-label="Theme"
                value={theme}
                onChange={setTheme}
                options={[
                  { id: "light", label: "Light" },
                  { id: "dark", label: "Dark" },
                  { id: "system", label: "System" },
                ]}
              />
            </div>
          </div>
        </div>

        <div className="oy-group">
          <p className="oy-overline">Persona</p>
          <div className="oy-section">
            <SlideLink className="oy-row" to="/account/personas" direction="forward">
              <Icon name="user" size={20} />
              <div className="text">
                <p className="title">Personas</p>
                <div className="desc truncate">{personaDesc}</div>
              </div>
              <Icon name="chevron-right" size={18} className="chevron" />
            </SlideLink>
          </div>
        </div>

        <div className="oy-group">
          <p className="oy-overline">Memory</p>
          <div className="oy-section">
            <SlideLink className="oy-row" to="/account/memory" direction="forward">
              <Icon name="note" size={20} />
              <div className="text">
                <p className="title">What the AI remembers</p>
                <div className="desc">{memoryDesc}</div>
              </div>
              <Icon name="chevron-right" size={18} className="chevron" />
            </SlideLink>
          </div>
        </div>

        {connections && connections.length > 0 && (
          <div className="oy-group">
            <p className="oy-overline">Tools</p>
            <div className="oy-section">
              <SlideLink className="oy-row" to="/account/connections" direction="forward">
                <Icon name="plug" size={20} />
                <div className="text">
                  <p className="title">Connected services</p>
                  <div className="desc">{connectionsText(connections)}</div>
                </div>
                <Icon name="chevron-right" size={18} className="chevron" />
              </SlideLink>
            </div>
          </div>
        )}

        {allowance && (allowance.spendLimit != null || allowance.tokenLimit != null) && <AllowanceGroup allowance={allowance} />}

        {bonus && bonus.domains.length > 0 && <RewardsGroup bonus={bonus} />}

        <div className="oy-group">
          <p className="oy-overline">Security</p>
          <div className="oy-section">
            <SlideLink className="oy-row" to="/account/password" direction="forward">
              <Icon name="lock" size={20} />
              <div className="text">
                <p className="title">Password</p>
                <div className="desc">{passwordChanged ? "Changed. Other devices were signed out" : "Change the password you sign in with"}</div>
              </div>
              <Icon name="chevron-right" size={18} className="chevron" />
            </SlideLink>
            <SlideLink className="oy-row" to="/account/devices" direction="forward">
              <Icon name="devices" size={20} />
              <div className="text">
                <p className="title">Where you're signed in</p>
                <div className={`desc${devices?.some((d) => !d.browser) ? " text-warning" : ""}`}>
                  {devices ? devicesText(devices) : "The devices signed in to your account"}
                </div>
              </div>
              <Icon name="chevron-right" size={18} className="chevron" />
            </SlideLink>
            <button
              type="button"
              className="oy-row"
              onClick={() => void signOut().then(() => navigate("/login", { replace: true }))}
            >
              <Icon name="logout" size={20} />
              <div className="text">
                <p className="title">Sign out</p>
              </div>
            </button>
          </div>
        </div>

        <DataGroup />

        <div className="oy-group">
          <p className="oy-overline">Privacy</p>
          <div className="oy-section">
            <div className="oy-row">
              <Icon name="eye" size={20} />
              <div className="text">
                <p className="title">Admins can read your chats</p>
                <div className="desc">The people who run this site can open any conversation, and each time they do it's logged</div>
              </div>
            </div>
            {policy && (policy.retainChatsDays != null || policy.retainDeletedDays != null) && (
              <div className="oy-row">
                <Icon name="trash" size={20} />
                <div className="text">
                  <p className="title">How long chats are kept</p>
                  <div className="desc">{retentionText(policy)}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

    </>
  );
}

/** "Notes", "Notes and GitHub", "Notes, GitHub and Linear". */
function namesText(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Where you stand with the services whose tools act with your own account, as a sentence. */
function connectionsText(list: Connection[]): string {
  const waiting = list.filter((c) => c.status !== "connected").map((c) => c.name);
  if (!waiting.length) return `Connected to ${namesText(list.map((c) => c.name))}`;
  return `${namesText(waiting)} ${waiting.length === 1 ? "needs" : "need"} your own account before chats can use ${waiting.length === 1 ? "its" : "their"} tools`;
}

/** The site's retention rules, as sentences. */
function retentionText(p: Policy): string {
  const parts: string[] = [];
  if (p.retainChatsDays != null) parts.push(`A chat nobody has touched for ${plural(p.retainChatsDays, "day", "days")} is deleted, files and all`);
  if (p.retainDeletedDays === 0) parts.push("A chat you delete is gone at once, for admins too");
  else if (p.retainDeletedDays != null) parts.push(`A chat you delete stays readable to admins for ${plural(p.retainDeletedDays, "day", "days")}, then goes`);
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
    setStatus({ text: "Sending the file" });
    try {
      const r = await uploadRaw<{ chats: number; skipped: number; projects: number; memories: number; source: string }>("/import", file, file.name, (p) =>
        setStatus({ text: p < 1 ? `Sending the file, ${Math.round(p * 100)}%` : "Reading the chats" }),
      ).promise;
      const from = { parley: "a Parley export", chatgpt: "ChatGPT", claude: "Claude" }[r.source] ?? "the file";
      const extras = [r.projects && plural(r.projects, "project", "projects"), r.memories && plural(r.memories, "note", "notes") + " for memory"].filter(Boolean);
      setStatus({
        text:
          `Brought in ${plural(r.chats, "chat", "chats")} from ${from}` +
          (extras.length ? `, with ${extras.join(" and ")}` : "") +
          (r.skipped ? `. ${plural(r.skipped, "chat was", "chats were")} here already` : ""),
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
      <p className="oy-overline">Your data</p>
      <div className="oy-section">
        <a className="oy-row" href="/api/export" download>
          <Icon name="download" size={20} />
          <div className="text">
            <p className="title">Export everything</p>
            <div className="desc">Your chats with every version of each message, projects, personas and memory, as one file. Attached files stay here</div>
          </div>
        </a>
        <button type="button" className="oy-row" disabled={busy} onClick={() => pickerRef.current?.click()}>
          <Icon name="upload" size={20} />
          <div className="text">
            <p className="title">Import chats</p>
            {/* The progress and the result take the place of the sentence, which keeps its room. */}
            <div className={`desc swap${status?.error ? " text-danger" : ""}`}>
              <span className={status ? "reserve" : undefined} aria-hidden={status ? true : undefined}>
                From a Parley export, or the export ChatGPT or Claude emails you (the .zip, or conversations.json inside it)
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
  const title = v?.active ? "Reward on" : v ? "Reward ended" : "Get a reward";
  const desc = v?.active
    ? `Verified ${v.email}${reward ? `. You get ${reward}` : ""}`
    : v
      ? `${v.email} no longer earns one. Verify an address at ${domainsText(bonus.domains)}`
      : `Verify an address at ${domainsText(bonus.domains)}${reward ? ` to get ${reward}` : ""}`;
  return (
    <div className="oy-group">
      <p className="oy-overline">Rewards</p>
      <div className="oy-section">
        <SlideLink className="oy-row" to="/account/bonus" direction="forward">
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
    a.spendLimit != null && { id: "spend", title: "Spending", used: a.spent, limit: a.spendLimit, text: `${formatCost(a.spent)} of ${formatCost(a.spendLimit)}` },
    a.tokenLimit != null && { id: "tokens", title: "Tokens", used: a.tokens, limit: a.tokenLimit, text: `${compactNumber(a.tokens)} of ${compactNumber(a.tokenLimit)} tokens` },
  ].filter((m) => !!m);

  return (
    <div className="oy-group">
      <p className="oy-overline">This month</p>
      <div className="oy-section">
        {meters.map((m) => {
          const full = m.used >= m.limit;
          return (
            <div key={m.id} className="oy-row">
              <Icon name="chart" size={20} />
              <div className="text">
                <p className="title">{m.title}</p>
                <div className="desc">
                  You've used {m.text}. {full ? `You can send messages again on ${resets}` : `It starts over on ${resets}`}
                </div>
                <span
                  className={`allowance-meter${full ? " is-full" : ""}`}
                  role="meter"
                  aria-label={`${m.title} this month`}
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
