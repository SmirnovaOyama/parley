import { startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { BusyButton } from "../components/BusyButton.tsx";
import { Advisory, Spinner } from "../components/Feedback.tsx";
import { LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api, ApiError, type TwoStep } from "../lib/api.ts";
import { atOrOn, plural } from "../lib/format.ts";

/** Where things stand, as a sentence: off, or on with what. */
export function twoStepText(s: TwoStep): string {
  if (!s.on) return "Off. Add a code from an app or a passkey after your password";
  const ways = [s.totp && "an authenticator app", s.passkeys.length > 0 && plural(s.passkeys.length, "passkey", "passkeys")].filter(Boolean);
  return `On, with ${ways.join(" and ")}`;
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
      <PageHeader title="Two-step verification" subtitle={state ? (state.on ? "On" : "Off") : undefined} back={{ label: "Settings", to: "/settings" }} />
      <div className="oy-page-column page-body">
        {error && <Advisory>{error}</Advisory>}
        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
        ) : !state ? (
          !error && <Spinner />
        ) : (
          <>
            <p className="group-intro">
              After your password, a second step shows it's really you: a six-digit code from an authenticator app on your phone, or a
              passkey, which your phone or computer unlocks with your face, fingerprint or screen lock
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
      <LineField id={id} label="Your password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} hint={note} error={error} />
      <div className="form-page-actions">
        <BusyButton type="submit" className={danger ? "btn-danger" : "btn-primary"} busy={busy} disabled={!password}>
          {action}
        </BusyButton>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
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
      <p className="oy-overline">Authenticator app</p>
      <div className="oy-section">
        <div className="oy-row">
          <Icon name="shield" size={20} />
          <div className="text">
            <p className="title">{state.totp ? "Set up" : "Not set up"}</p>
            <div className="desc">
              {state.totp
                ? "Signing in asks for the six-digit code it shows"
                : "Google Authenticator, Microsoft Authenticator, 1Password, or the Passwords app on an iPhone"}
            </div>
          </div>
          {step === "idle" && (
            <button type="button" className={state.totp ? "btn-secondary btn-sm" : "btn-tonal btn-sm"} onClick={() => setStep(state.totp ? "remove" : "password")}>
              {state.totp ? "Remove" : "Set up"}
            </button>
          )}
        </div>
      </div>
      {step === "password" && (
        <WithPassword
          id="totp-password"
          note="To set up an app, type your password first"
          action="Continue"
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
          note={state.passkeys.length ? "Signing in then takes a passkey alone" : "Two-step verification then goes off, and its recovery codes with it"}
          action="Remove the app"
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
      <p className="oy-overline">Set up an authenticator app</p>
      <form className="settings-panel two-step-setup" onSubmit={confirm}>
        <p className="settings-text">1. Scan this with your authenticator app</p>
        <img className="two-step-qr" src={setup.qr} alt="QR code to scan with an authenticator app" width={184} height={184} />
        <p className="settings-text">
          On this phone? <a href={setup.uri}>Open it in your app</a>. Or type in this key:
        </p>
        <p className="two-step-secret">
          <code>{grouped}</code>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => void navigator.clipboard.writeText(setup.secret).then(() => setCopied(true))}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </p>
        <p className="settings-text">2. Type the six-digit code it shows</p>
        <LineField
          id="totp-code"
          label="Code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
          error={error}
        />
        <div className="form-page-actions">
          <BusyButton type="submit" className="btn-primary" busy={busy} disabled={code.length < 6}>
            Turn it on
          </BusyButton>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
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
      <p className="oy-overline">Passkeys</p>
      {state.passkeys.length > 0 && (
        <div className="oy-section">
          {state.passkeys.map((p) => (
            <div key={p.id} className="oy-row">
              <Icon name="devices" size={20} />
              <div className="text">
                <p className="title truncate">{p.name}</p>
                <div className="desc">
                  Added {atOrOn(p.createdAt)}
                  {p.lastUsedAt ? `, last used ${atOrOn(p.lastUsedAt)}` : ", not used yet"}
                </div>
              </div>
              {removing !== p.id && (
                <button type="button" className="btn-secondary btn-sm" onClick={() => (setRemoving(p.id), setAdding(false))}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {removing && (
        <WithPassword
          id="passkey-remove"
          note={state.passkeys.length > 1 || state.totp ? "It stops working here" : "Two-step verification then goes off, and its recovery codes with it"}
          action="Remove the passkey"
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
          note="Then your browser asks where to keep the passkey"
          action="Make a passkey"
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
                ? "Add one on each phone or computer you sign in on"
                : "Your phone or computer keeps it, and unlocks it with your face, fingerprint or screen lock"
              : "This browser can't make passkeys"}
          </p>
          {supported && (
            <div className="form-page-actions">
              <button type="button" className="btn-secondary" onClick={() => (setAdding(true), setRemoving(null))}>
                Add a passkey
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
  if (name === "NotAllowedError" || name === "AbortError") return "The passkey prompt was closed before it finished";
  if (name === "InvalidStateError") return "This device has a passkey for your account already";
  if (err instanceof ApiError) return err.message;
  return "The passkey couldn't be made here. Try another browser or device";
}

function RecoveryGroup({ state, onChange }: GroupProps) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="oy-group">
      <p className="oy-overline">Recovery codes</p>
      <div className="oy-section">
        <div className="oy-row">
          <Icon name="note" size={20} />
          <div className="text">
            <p className="title">{plural(state.recoveryLeft, "code left", "codes left")}</p>
            <div className={`desc${state.recoveryLeft <= 3 ? " text-warning" : ""}`}>
              {state.recoveryLeft <= 3 ? "Running low. Make new ones before they run out" : "Each works once, in place of the second step, if you lose your phone"}
            </div>
          </div>
          {!asking && (
            <button type="button" className="btn-secondary btn-sm" onClick={() => setAsking(true)}>
              Make new ones
            </button>
          )}
        </div>
      </div>
      {asking && (
        <WithPassword
          id="recovery-password"
          note="The codes you have now stop working"
          action="Make new codes"
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
      <p className="oy-overline">Save your recovery codes</p>
      <div className="settings-panel">
        <p className="settings-text">
          If you lose your phone, each of these signs you in once in place of the second step. They're shown only now: keep them
          somewhere safe, like a password manager
        </p>
        <ul className="recovery-codes" aria-label="Recovery codes">
          {codes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
        <div className="form-page-actions">
          <button type="button" className="btn-secondary" onClick={() => void navigator.clipboard.writeText(codes.join("\n")).then(() => setCopied(true))}>
            {copied ? "Copied" : "Copy them"}
          </button>
          <button type="button" className="btn-primary" onClick={onDone}>
            I've saved them
          </button>
        </div>
      </div>
    </div>
  );
}
