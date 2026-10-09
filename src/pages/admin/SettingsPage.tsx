import { useEffect, useState, type FormEvent } from "react";
import { BusyButton } from "../../components/BusyButton.tsx";
import { OptionList, Switch, Tick } from "../../components/Controls.tsx";
import { Advisory, Spinner } from "../../components/Feedback.tsx";
import { LineArea, LineField } from "../../components/LineField.tsx";
import { Icon } from "../../icons/Icon.tsx";
import { api, type SharingMode } from "../../lib/api.ts";
import { AUDIT_ACTIONS as ACTIONS } from "../../lib/audit.ts";
import { amountInput, amountText, dateTime } from "../../lib/format.ts";

import type { ApiKey } from "./KeysPage.tsx";

type Settings = {
  allowSignup: boolean;
  systemPrompt: string;
  showThinking: boolean;
  sharing: SharingMode;
  bonusDomains: string[];
  bonusTokens: number | null;
  bonusKeyIds: number[];
  bonusSpend: number | null;
  spendLimit: number | null;
};
type MailMode = "smtp" | "dev" | "off";
type AuditEntry = { id: number; action: string; target: string | null; createdAt: string; admin: string };

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mail, setMail] = useState<MailMode>("dev");
  const [prompt, setPrompt] = useState("");
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [saved, setSaved] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAudit = () => api.get<{ entries: AuditEntry[] }>("/admin/audit").then((r) => setAudit(r.entries), () => {});

  useEffect(() => {
    api.get<{ settings: Settings; mail: MailMode }>("/admin/settings").then(
      (r) => {
        setSettings(r.settings);
        setMail(r.mail);
        setPrompt(r.settings.systemPrompt);
      },
      (err) => setError((err as Error).message),
    );
    void loadAudit();
  }, []);

  const update = async (next: Partial<Settings>) => {
    setError(null);
    try {
      const r = await api.patch<{ settings: Settings }>("/admin/settings", next);
      setSettings(r.settings);
      void loadAudit();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  // The rewards form reports its own errors next to its fields.
  const saveRewards = async (next: Pick<Settings, "bonusDomains" | "bonusTokens" | "bonusSpend" | "bonusKeyIds">) => {
    const r = await api.patch<{ settings: Settings }>("/admin/settings", next);
    setSettings(r.settings);
    void loadAudit();
  };

  if (!settings) return error ? <Advisory>{error}</Advisory> : <Spinner />;

  return (
    <>
      {error && <Advisory>{error}</Advisory>}
      <div className="oy-group">
        <p className="oy-overline">Sign-ups</p>
        <div className="oy-section">
          <div className="oy-row">
            <Icon name="users" size={20} />
            <div className="text">
              <label className="title" htmlFor="allow-signup">
                Let people create accounts
              </label>
              <div className="desc">When it's off, only admins can add people</div>
            </div>
            <Switch id="allow-signup" checked={settings.allowSignup} onChange={(v) => void update({ allowSignup: v })} />
          </div>
        </div>
      </div>

      <OptionList<SharingMode>
        label="Who can open shared chats"
        value={settings.sharing}
        onChange={(sharing) => {
          setSettings({ ...settings, sharing });
          void update({ sharing });
        }}
        options={[
          { id: "anyone", label: "Anyone with the link", detail: "No account needed" },
          { id: "signed-in", label: "People signed in here", detail: "A link asks for an account on this site first" },
          { id: "off", label: "Nobody", detail: "People can't share chats, and existing links stop opening until it's back on" },
        ]}
      />

      <div className="oy-group">
        <p className="oy-overline">Assistant</p>
        <div className="oy-section">
          <div className="oy-row">
            <Icon name="eye" size={20} />
            <div className="text">
              <label className="title" htmlFor="show-thinking">
                Show the AI's thinking
              </label>
              <div className="desc">Folded above each reply, for models that share it: a summary of their reasoning, or the reasoning itself</div>
            </div>
            <Switch id="show-thinking" checked={settings.showThinking} onChange={(v) => void update({ showThinking: v })} />
          </div>
        </div>
        <label className="oy-field-label" htmlFor="system-prompt">
          Instructions for the AI
        </label>
        <textarea
          id="system-prompt"
          className="input-base"
          rows={6}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            setSaved(false);
          }}
        />
        <div className="form-actions">
          <p className="oy-field-hint">Sent with every chat on every key. Changes apply to the next message</p>
          <BusyButton
            type="button"
            className="btn-primary"
            busy={savingPrompt}
            disabled={prompt === settings.systemPrompt}
            onClick={() => {
              setSavingPrompt(true);
              void update({ systemPrompt: prompt }).then((ok) => {
                setSaved(ok);
                setSavingPrompt(false);
              });
            }}
          >
            {saved && prompt === settings.systemPrompt ? "Saved" : "Save"}
          </BusyButton>
        </div>
      </div>

      <SpendingForm saved={settings.spendLimit} onSave={(spendLimit) => update({ spendLimit })} />

      <RewardsForm settings={settings} mail={mail} onSave={saveRewards} />

      <div className="oy-group">
        <p className="oy-overline">Recent admin activity</p>
        {audit.length === 0 ? (
          <p className="text-muted">Nothing yet</p>
        ) : (
          <div className="oy-section is-plain">
            {audit.map((a) => (
              <div key={a.id} className="oy-row audit-row">
                <div className="text">
                  <p className="title">
                    {ACTIONS[a.action] ?? a.action}
                    {a.target && <span className="audit-target"> {a.target}</span>}
                  </p>
                  <div className="desc">
                    By {a.admin} on {dateTime(a.createdAt)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
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
      <p className="oy-overline">Spending</p>
      <form className="form-page" onSubmit={save}>
        <LineField
          id="spend-limit"
          label="Each member's monthly limit, in dollars"
          inputMode="decimal"
          autoComplete="off"
          value={limit}
          onChange={(e) => {
            setLimit(amountInput(e.target.value));
            setDone(false);
          }}
          hint="Leave empty for no limit"
        />
        <div className="form-actions">
          <p className="oy-field-hint">
            Estimated from each model's price and counted from the 1st. Someone who reaches it can't send messages until
            next month. Admins aren't held to it, and a person's page can set their own limit
          </p>
          <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!dirty}>
            {done && !dirty ? "Saved" : "Save"}
          </BusyButton>
        </div>
      </form>
    </div>
  );
}

const MAIL_NOTE: Record<MailMode, string> = {
  smtp: "Codes go out by email through the server set in SMTP_URL",
  dev: "No email server is set up, so codes are printed in the server log. That only works while developing; set SMTP_URL to send real email",
  off: "No email server is set up, so nobody can verify yet. Set SMTP_URL in the server's environment",
};

/**
 * Email rewards: the domains whose addresses earn a reward, and the reward itself. People verify an
 * address from their Account (or right after signing up with one); it's optional.
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

  // Only keys that aren't already everyone's can be a reward.
  const offerable = keys.filter((k) => !k.shared || keyIds.includes(k.id));
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
      <p className="oy-overline">Email rewards</p>
      <p className="group-intro">
        People who prove they own an address on one of these domains, with a code sent to it, get the reward. It's
        optional for them, and lasts while the domain stays listed
      </p>
      <form className="form-page rewards-form" onSubmit={save}>
        <LineArea
          id="bonus-domains"
          label="Domains that earn a reward"
          value={domains}
          spellCheck={false}
          onChange={(e) => {
            setDomains(e.target.value);
            setSaved(false);
          }}
          hint="One per line, like example.edu. Its subdomains count too"
        />
        <LineField
          id="bonus-spend"
          label="Extra spending each month, in dollars"
          inputMode="decimal"
          autoComplete="off"
          value={spend}
          onChange={(e) => {
            setSpend(amountInput(e.target.value));
            setSaved(false);
          }}
          hint="Added on top of each person's spending limit. Leave empty for none"
        />
        <LineField
          id="bonus-tokens"
          label="Extra tokens each month"
          inputMode="numeric"
          autoComplete="off"
          value={tokens}
          onChange={(e) => {
            setTokens(e.target.value);
            setSaved(false);
          }}
          hint="Added on top of each person's monthly limit. Leave empty for none"
        />
        <div className="field" role="group" aria-label="Models they unlock">
          <p className="oy-field-label">Models they unlock</p>
          {offerable.length === 0 ? (
            <p className="oy-field-hint">
              Every model is open to everyone. Set a key to “Only people you choose” to offer it as a reward
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
                    <span className="desc">{k.shared ? `${k.modelLabel}. Everyone can pick it now` : k.modelLabel}</span>
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
            {saved && !dirty ? "Saved" : "Save"}
          </BusyButton>
        </div>
      </form>
    </div>
  );
}
