import { startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { BusyButton } from "../components/BusyButton.tsx";
import { Advisory, Spinner } from "../components/Feedback.tsx";
import { LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api, ApiError, type TwoStep } from "../lib/api.ts";
import { atOrOn, formatNumber } from "../lib/format.ts";
import { andText, t, tn, tx } from "../lib/i18n.ts";

/** Where things stand, as a sentence: off, or on with what. */
export function twoStepText(s: TwoStep): string {
  if (!s.on) return t("Off. Add a code from an app or a passkey after your password");
  const ways = [s.totp && t("an authenticator app"), s.passkeys.length > 0 && tn(s.passkeys.length, "{count} passkey", "{count} passkeys", { count: formatNumber(s.passkeys.length) })].filter(Boolean) as string[];
  return t("On, with {ways}", { ways: andText(ways) });
}

/**
 * Settings › Two-step verification (/settings/two-step): after the password, a code from an
 * authenticator app or a passkey. Setting either up or removing it asks for the password first,
 * and the first one set up comes with recovery codes, shown once.
 */
export function TwoStepPage() {
  const [state, setState] = useState<TwoStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Recovery codes just made, shown until they're put away.
  const [codes, setCodes] = useState<string[] | null>(null);

  useEffect(() => {
    api.get<TwoStep>("/auth/two-step").then(setState, (err) => setError((err as Error).message));
  }, []);

  /** After a change: the new state, and recovery codes if it made some. */
  const changed = (r: { twoStep: TwoStep; recoveryCodes?: string[] | null }) => {
    setState(r.twoStep);
    if (r.recoveryCodes) setCodes(r.recoveryCodes);
  };

  return (
    <>
      <PageHeader title={t("Two-step verification")} subtitle={state ? (state.on ? t("On") : t("Off")) : undefined} back={{ label: t("Settings"), to: "/settings" }} />
      <div className="oy-page-column page-body">
        {error && <Advisory>{error}</Advisory>}
        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
        ) : !state ? (
          !error && <Spinner />
        ) : (
          <>
            <p className="group-intro">
              {t(
                "After your password, a second step shows it's really you: a six-digit code from an authenticator app on your phone, or a passkey, which your phone or computer unlocks with your face, fingerprint or screen lock",
              )}
            </p>
            <AuthenticatorGroup state={state} onChange={changed} />
            <PasskeysGroup state={state} onChange={changed} />
            {state.on && <RecoveryGroup state={state} onChange={changed} />}
          </>
        )}
      </div>
    </>
  );
}

type GroupProps = { state: TwoStep; onChange: (r: { twoStep: TwoStep; recoveryCodes?: string[] | null }) => void };

/**
 * A step that takes the password: a field and the button that goes ahead, unfolded in place. The
 * field's error is the server's when it says the password is the problem.
 */
function WithPassword({ id, note, action, danger, onCancel, onConfirm }: {
  id: string;
  note: string;
  action: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConfirm(password);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form
      className="settings-panel"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.nativeEvent.isComposing) onCancel();
      }}
    >
      <LineField id={id} label={t("Your password")} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} hint={note} error={error} />
      <div className="form-page-actions">
        <BusyButton type="submit" className={danger ? "btn-danger" : "btn-primary"} busy={busy} disabled={!password}>
          {action}
        </BusyButton>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}

function AuthenticatorGroup({ state, onChange }: GroupProps) {
  const [step, setStep] = useState<"idle" | "password" | "remove">("idle");
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);

  if (setup) return <AuthenticatorSetup setup={setup} onCancel={() => setSetup(null)} onDone={(r) => (setSetup(null), onChange(r))} />;

  return (
    <div className="oy-group">
      <p className="oy-overline">{t("Authenticator app")}</p>
      <div className="oy-section">
        <div className="oy-row">
          <Icon name="shield" size={20} />
          <div className="text">
            <p className="title">{state.totp ? t("In use") : t("Not set up")}</p>
            <div className="desc">
              {state.totp
                ? t("Signing in asks for the six-digit code it shows")
                : t("Google Authenticator, Microsoft Authenticator, 1Password, or the Passwords app on an iPhone")}
            </div>
          </div>
          {step === "idle" && (
            <button type="button" className={state.totp ? "btn-secondary btn-sm" : "btn-tonal btn-sm"} onClick={() => setStep(state.totp ? "remove" : "password")}>
              {state.totp ? t("Remove") : t("Set up")}
            </button>
          )}
        </div>
      </div>
      {step === "password" && (
        <WithPassword
          id="totp-password"
          note={t("To set up an app, type your password first")}
          action={t("Continue")}
          onCancel={() => setStep("idle")}
          onConfirm={async (password) => {
            setSetup(await api.post<{ secret: string; uri: string; qr: string }>("/auth/two-step/totp/start", { password }));
            setStep("idle");
          }}
        />
      )}
      {step === "remove" && (
        <WithPassword
          id="totp-remove"
          note={state.passkeys.length ? t("Signing in then takes a passkey alone") : t("Two-step verification then goes off, and its recovery codes with it")}
          action={t("Remove the app")}
          danger
          onCancel={() => setStep("idle")}
          onConfirm={async (password) => {
            onChange(await api.post<{ twoStep: TwoStep }>("/auth/two-step/totp/remove", { password }));
            setStep("idle");
          }}
        />
      )}
    </div>
  );
}

/** The QR code to scan (or the secret to type), then the app's first code to show it worked. */
function AuthenticatorSetup({ setup, onCancel, onDone }: {
  setup: { secret: string; uri: string; qr: string };
  onCancel: () => void;
  onDone: (r: { twoStep: TwoStep; recoveryCodes?: string[] | null }) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const grouped = setup.secret.match(/.{1,4}/g)!.join(" ");

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<{ twoStep: TwoStep; recoveryCodes: string[] | null }>("/auth/two-step/totp/confirm", { code }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="oy-group">
      <p className="oy-overline">{t("Set up an authenticator app")}</p>
      <form className="settings-panel two-step-setup" onSubmit={confirm}>
        <p className="settings-text">{t("1. Scan this with your authenticator app")}</p>
        <img className="two-step-qr" src={setup.qr} alt={t("QR code to scan with an authenticator app")} width={184} height={184} />
        <p className="settings-text">{tx("On this phone? <a>Open it in your app</a>. Or type in this key:", { a: (w) => <a href={setup.uri}>{w}</a> })}</p>
        <p className="two-step-secret">
          <code>{grouped}</code>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => void navigator.clipboard.writeText(setup.secret).then(() => setCopied(true))}
          >
            {copied ? t("Copied") : t("Copy")}
          </button>
        </p>
        <p className="settings-text">{t("2. Type the six-digit code it shows")}</p>
        <LineField
          id="totp-code"
          label={t("Code")}
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
          error={error}
        />
        <div className="form-page-actions">
          <BusyButton type="submit" className="btn-primary" busy={busy} disabled={code.length < 6}>
            {t("Turn it on")}
          </BusyButton>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t("Cancel")}
          </button>
        </div>
      </form>
    </div>
  );
}

function PasskeysGroup({ state, onChange }: GroupProps) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;

  return (
    <div className="oy-group">
      <p className="oy-overline">{t("Passkeys")}</p>
      {state.passkeys.length > 0 && (
        <div className="oy-section">
          {state.passkeys.map((p) => (
            <div key={p.id} className="oy-row">
              <Icon name="devices" size={20} />
              <div className="text">
                <p className="title truncate">{p.name}</p>
                <div className="desc">
                  {p.lastUsedAt
                    ? t("Added {createdAt}, last used {lastUsedAt}", { createdAt: atOrOn(p.createdAt), lastUsedAt: atOrOn(p.lastUsedAt) })
                    : t("Added {createdAt}, not used yet", { createdAt: atOrOn(p.createdAt) })}
                </div>
              </div>
              {removing !== p.id && (
                <button type="button" className="btn-secondary btn-sm" onClick={() => (setRemoving(p.id), setAdding(false))}>
                  {t("Remove")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {removing && (
        <WithPassword
          id="passkey-remove"
          note={state.passkeys.length > 1 || state.totp ? t("It stops working here") : t("Two-step verification then goes off, and its recovery codes with it")}
          action={t("Remove the passkey")}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={async (password) => {
            onChange(await api.post<{ twoStep: TwoStep }>(`/auth/two-step/passkeys/${encodeURIComponent(removing)}/remove`, { password }));
            setRemoving(null);
          }}
        />
      )}
      {error && <Advisory>{error}</Advisory>}
      {adding ? (
        <WithPassword
          id="passkey-password"
          note={t("Then your browser asks where to keep the passkey")}
          action={t("Make a passkey")}
          onCancel={() => setAdding(false)}
          onConfirm={async (password) => {
            setError(null);
            const { options } = await api.post<{ options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("/auth/two-step/passkeys/options", { password });
            let response;
            try {
              response = await startRegistration({ optionsJSON: options });
            } catch (err) {
              setAdding(false);
              setError(passkeyProblem(err));
              return;
            }
            onChange(await api.post<{ twoStep: TwoStep; recoveryCodes: string[] | null }>("/auth/two-step/passkeys", { response }));
            setAdding(false);
          }}
        />
      ) : (
        <div className="settings-panel">
          <p className="settings-text">
            {supported
              ? state.passkeys.length
                ? t("Add one on each phone or computer you sign in on")
                : t("Your phone or computer keeps it, and unlocks it with your face, fingerprint or screen lock")
              : t("This browser can't make passkeys")}
          </p>
          {supported && (
            <div className="form-page-actions">
              <button type="button" className="btn-secondary" onClick={() => (setAdding(true), setRemoving(null))}>
                {t("Add a passkey")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** What went wrong in the browser's own passkey prompt, in words. */
export function passkeyProblem(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") return t("The passkey prompt was closed before it finished");
  if (name === "InvalidStateError") return t("This device has a passkey for your account already");
  if (err instanceof ApiError) return err.message;
  return t("The passkey couldn't be made here. Try another browser or device");
}

function RecoveryGroup({ state, onChange }: GroupProps) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="oy-group">
      <p className="oy-overline">{t("Recovery codes")}</p>
      <div className="oy-section">
        <div className="oy-row">
          <Icon name="note" size={20} />
          <div className="text">
            <p className="title">{tn(state.recoveryLeft, "{recoveryLeft} code left", "{recoveryLeft} codes left", { recoveryLeft: formatNumber(state.recoveryLeft) })}</p>
            <div className={`desc${state.recoveryLeft <= 3 ? " text-warning" : ""}`}>
              {state.recoveryLeft <= 3 ? t("Running low. Make new ones before they run out") : t("Each works once, in place of the second step, if you lose your phone")}
            </div>
          </div>
          {!asking && (
            <button type="button" className="btn-secondary btn-sm" onClick={() => setAsking(true)}>
              {t("Make new ones")}
            </button>
          )}
        </div>
      </div>
      {asking && (
        <WithPassword
          id="recovery-password"
          note={t("The codes you have now stop working")}
          action={t("Make new codes")}
          onCancel={() => setAsking(false)}
          onConfirm={async (password) => {
            onChange(await api.post<{ twoStep: TwoStep; recoveryCodes: string[] }>("/auth/two-step/recovery-codes", { password }));
            setAsking(false);
          }}
        />
      )}
    </div>
  );
}

/** Codes just made: shown this once, to copy or write down. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <div className="oy-group">
      <p className="oy-overline">{t("Save your recovery codes")}</p>
      <div className="settings-panel">
        <p className="settings-text">
          {t("If you lose your phone, each of these signs you in once in place of the second step. They're shown only now: keep them somewhere safe, like a password manager")}
        </p>
        <ul className="recovery-codes" aria-label={t("Recovery codes")}>
          {codes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
        <div className="form-page-actions">
          <button type="button" className="btn-secondary" onClick={() => void navigator.clipboard.writeText(codes.join("\n")).then(() => setCopied(true))}>
            {copied ? t("Copied") : t("Copy them")}
          </button>
          <button type="button" className="btn-primary" onClick={onDone}>
            {t("I've saved them")}
          </button>
        </div>
      </div>
    </div>
  );
}
