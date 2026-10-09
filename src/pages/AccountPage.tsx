import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { BusyButton } from "../components/BusyButton.tsx";
import { Segmented } from "../components/Controls.tsx";
import { Advisory } from "../components/Feedback.tsx";
import { InstructionsForm } from "../components/InstructionsForm.tsx";
import { LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api, type Instructions } from "../lib/api.ts";
import { domainsText, rewardText, type BonusStatus } from "../lib/bonus.ts";
import { compactNumber, formatCost, shortDate } from "../lib/format.ts";
import { useSession } from "../lib/session.tsx";

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
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [instructions, setInstructions] = useState<Instructions | null>(null);
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState(false);

  const [bonus, setBonus] = useState<BonusStatus | null>(null);
  const [allowance, setAllowance] = useState<Allowance | null>(null);

  useEffect(() => {
    api.get<Instructions>("/auth/instructions").then(setInstructions, () => {});
    api.get<BonusStatus>("/auth/bonus").then(setBonus, () => {});
    api.get<Allowance>("/auth/allowance").then(setAllowance, () => {});
  }, []);

  const instructionsSummary = (() => {
    if (instructionsSaved) return "Saved. New chats will start with them";
    const first = [instructions?.aboutMe, instructions?.answerStyle].find((t) => t?.trim());
    return first ? first.replace(/\s+/g, " ") : "About you and how to answer, copied into each new chat";
  })();

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
          <p className="oy-overline">Personal instructions</p>
          <div className="oy-section">
            <button
              type="button"
              className="oy-row"
              aria-expanded={editingInstructions}
              aria-controls="instructions-panel"
              onClick={() => {
                setInstructionsSaved(false);
                setEditingInstructions((open) => !open);
              }}
            >
              <Icon name="user" size={20} />
              <div className="text">
                <p className="title">Defaults for new chats</p>
                <div className="desc truncate">{instructionsSummary}</div>
              </div>
              <Icon name="chevron-down" size={18} className={`chevron chev${editingInstructions ? " is-open" : ""}`} />
            </button>
            {instructions && (
              <InstructionsPanel
                open={editingInstructions}
                saved={instructions}
                onSaved={(next) => {
                  setInstructions(next);
                  setInstructionsSaved(true);
                  setEditingInstructions(false);
                }}
                onCancel={() => setEditingInstructions(false)}
              />
            )}
          </div>
        </div>

        {allowance && (allowance.spendLimit != null || allowance.tokenLimit != null) && <AllowanceGroup allowance={allowance} />}

        {bonus && bonus.domains.length > 0 && <RewardsGroup bonus={bonus} />}

        <div className="oy-group">
          <p className="oy-overline">Security</p>
          <div className="oy-section">
            <button
              type="button"
              className="oy-row"
              aria-expanded={changingPassword}
              aria-controls="password-panel"
              onClick={() => setChangingPassword((open) => !open)}
            >
              <Icon name="lock" size={20} />
              <div className="text">
                <p className="title">Password</p>
                <div className="desc">{passwordChanged ? "Changed. Other devices were signed out" : "Change the password you sign in with"}</div>
              </div>
              <Icon name="chevron-down" size={18} className={`chevron chev${changingPassword ? " is-open" : ""}`} />
            </button>
            <PasswordPanel
              open={changingPassword}
              onDone={() => {
                setChangingPassword(false);
                setPasswordChanged(true);
              }}
              onCancel={() => setChangingPassword(false)}
            />
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
          </div>
        </div>
      </div>

    </>
  );
}

/** Unfolds under its row: your defaults for new chats. */
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
        <Link className="oy-row" to="/account/bonus">
          <Icon name="gift" size={20} />
          <div className="text">
            <p className="title">{title}</p>
            <div className="desc">{desc}</div>
          </div>
          <Icon name="chevron-right" size={18} className="chevron" />
        </Link>
      </div>
    </div>
  );
}

function InstructionsPanel({
  open,
  saved,
  onSaved,
  onCancel,
}: {
  open: boolean;
  saved: Instructions;
  onSaved: (next: Instructions) => void;
  onCancel: () => void;
}) {
  return (
    <div id="instructions-panel" className="disclosure inline-panel" data-open={open} inert={!open}>
      <div className="disclosure-inner">
        <InstructionsForm
          idPrefix="defaults"
          value={saved}
          open={open}
          note="Each new chat starts with these. To change one chat's, use Instructions at the top of that chat"
          onSave={async (next) => onSaved(await api.put<Instructions>("/auth/instructions", next))}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}

/** Unfolds under the Password row: two line fields and a button, no pop-up. */
function PasswordPanel({ open, onDone, onCancel }: { open: boolean; onDone: () => void; onCancel: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setCurrent("");
      setNext("");
      setError(null);
    }
  }, [open]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/password", { current, next });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="password-panel" className="disclosure inline-panel" data-open={open} inert={!open}>
      <div className="disclosure-inner">
        <form onSubmit={save}>
          <LineField id="pw-current" label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <LineField id="pw-next" label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} hint="At least 8 characters" />
          {error && <Advisory>{error}</Advisory>}
          <div className="form-page-actions">
            <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!current || !next}>
              Change password
            </BusyButton>
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
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
