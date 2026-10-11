import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { BusyButton } from "../components/BusyButton.tsx";
import { Advisory, Callout, Spinner } from "../components/Feedback.tsx";
import { LineField } from "../components/LineField.tsx";
import { HAND_LETTERED, ParleyFlag, Wordmark } from "../icons/Brand.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api, ApiError } from "../lib/api.ts";
import { APP_NAME } from "../lib/brand.ts";
import { t, tx } from "../lib/i18n.ts";
import { useSession } from "../lib/session.tsx";
import { passkeyProblem } from "./TwoStepPage.tsx";

/** passwordReset: the server can email a link to set a new password. signupCode: making an account takes a code emailed to it. */
type AuthState = { needsSetup: boolean; allowSignup: boolean; passwordReset: boolean; signupCode: boolean };
const CLOSED: AuthState = { needsSetup: false, allowSignup: false, passwordReset: false, signupCode: false };

function useAuthState(): AuthState | null {
  const [state, setState] = useState<AuthState | null>(null);
  useEffect(() => {
    api.get<AuthState>("/auth/state").then(setState, () => setState(CLOSED));
  }, []);
  return state;
}

/** Where to go after signing in: a page on this site only (never another origin). */
function safeNext(next: string | null): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : null;
}

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const { user, loading, refreshUser } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const keepNext = next ? `?next=${encodeURIComponent(next)}` : "";
  const state = useAuthState();
  const location = useLocation();
  // Back from setting a new password, with two-step verification on: sign in, second step and all.
  const [passwordSet] = useState(() => !!(location.state as { passwordSet?: boolean } | null)?.passwordSet);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // The password was right and the account has two-step verification: its second step.
  const [second, setSecond] = useState<SecondStepTicket | null>(null);
  // Making an account can take a code emailed to it: where it went, and what was typed.
  const [sent, setSent] = useState<{ to: string; inLog: boolean } | null>(null);
  const [code, setCode] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<{ text: string; field: "password" | "code" } | null>(null);
  const [busy, setBusy] = useState(false);

  // The "Send again" countdown.
  useEffect(() => {
    if (!sent || resendAt <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sent, resendAt]);

  if (!loading && user) return <Navigate to={next ?? "/chat"} replace />;
  if (!state) return <Booting />;
  if (second) {
    return (
      <SecondStep
        email={email.trim()}
        ticket={second}
        onBack={(problem) => {
          setSecond(null);
          setError(problem ? { text: problem, field: "password" } : null);
        }}
        onDone={async (recoveryLeft) => {
          await refreshUser();
          // Someone who used a recovery code may have lost their phone: their two-step page is next.
          navigate(recoveryLeft != null ? "/settings/two-step" : (next ?? "/chat"), { replace: true });
        }}
      />
    );
  }

  const signup = mode === "signup" || state.needsSetup;
  if (signup && !state.needsSetup && !state.allowSignup) {
    return (
      <AuthFrame title={t("Sign-ups are closed")}>
        <p className="text-muted">{t("Ask an admin of this site to create an account for you")}</p>
        <p className="auth-switch">
          <Link to={`/login${keepNext}`}>{t("Sign in instead")}</Link>
        </p>
      </AuthFrame>
    );
  }
  const needsCode = signup && state.signupCode;

  const sendCode = async () => {
    // Checked here too, so a code isn't spent on a password the next step turns away.
    if (password.length < 8) {
      setError({ text: t("Use at least 8 characters for the password"), field: "password" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ resendIn: number; mail: "smtp" | "dev" }>("/auth/signup/code", { email });
      setSent({ to: email.trim(), inLog: r.mail === "dev" });
      setResendAt(Date.now() + r.resendIn * 1000);
      setNow(Date.now());
    } catch (err) {
      setError({ text: (err as Error).message, field: sent ? "code" : "password" });
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (needsCode && !sent) return void sendCode();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ bonusEligible?: boolean; twoStep?: SecondStepTicket }>(signup ? "/auth/signup" : "/auth/login", {
        email,
        password,
        ...(needsCode ? { code } : {}),
      });
      if (r.twoStep) {
        setSecond(r.twoStep);
        return;
      }
      await refreshUser();
      // A brand-new site can't chat until it has a key, so its first admin goes there first. An
      // address on a rewarded domain is offered the (skippable) check that earns the reward.
      if (state.needsSetup) navigate("/admin/keys", { replace: true });
      else if (r.bonusEligible) navigate(`/settings/bonus?from=signup&email=${encodeURIComponent(email.trim())}`, { replace: true });
      else navigate(next ?? "/chat", { replace: true });
    } catch (err) {
      setError({ text: (err as Error).message, field: err instanceof ApiError && err.field === "code" ? "code" : "password" });
    } finally {
      setBusy(false);
    }
  };

  const title = state.needsSetup ? t("Set up your chat site") : signup ? t("Create an account") : t("Sign in");
  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));

  return (
    <AuthFrame title={title}>
      {state.needsSetup && (
        <Callout>{t("This first account becomes the admin. You'll add an AI key next")}</Callout>
      )}
      {passwordSet && !signup && <Callout>{t("Your new password is set. Sign in with it, then take the second step as usual")}</Callout>}
      <form className="auth-form" onSubmit={submit} noValidate>
        <LineField
          id="email"
          label={t("Email")}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            // A code is for the address it went to: another one needs its own.
            if (sent) {
              setSent(null);
              setCode("");
            }
          }}
          required
        />
        <LineField
          id="password"
          label={t("Password")}
          type="password"
          autoComplete={signup ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={signup ? t("At least 8 characters") : undefined}
          error={error?.field === "password" ? error.text : null}
          required
        />
        {needsCode && sent && (
          <>
            <p className="auth-sent">
              <Icon name="mail" size={18} />
              <span>
                {tx("We've emailed a code to <strong>{to}</strong>. It works for 10 minutes", { strong: () => <strong>{sent.to}</strong> })}
                {sent.inLog && ` ${t("(no email server is set up, so it's in the server log)")}`}
              </span>
            </p>
            <LineField
              id="code"
              label={t("Code")}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
              error={error?.field === "code" ? error.text : null}
              required
            />
          </>
        )}
        <BusyButton
          className="btn-primary btn-block"
          type="submit"
          busy={busy}
          disabled={!email || !password || (needsCode && !!sent && code.length < 6)}
        >
          {needsCode && !sent ? t("Send code") : signup ? t("Create account") : t("Sign in")}
        </BusyButton>
        {needsCode && sent && (
          <button type="button" className="btn-ghost btn-block" disabled={busy || wait > 0} onClick={() => void sendCode()}>
            {/* As wide as its longest wording all along, so the countdown never moves it. */}
            <span className="swap tabular">
              <span className="reserve" aria-hidden="true">
                {t("Send again in 00s")}
              </span>
              <span>{wait > 0 ? t("Send again in {wait}s", { wait }) : t("Send again")}</span>
            </span>
          </button>
        )}
      </form>
      {!state.needsSetup && (
        <div className="auth-links text-muted">
          {!signup && (
            <p>
              {state.passwordReset ? (
                // The address typed so far comes along, so it needn't be typed again.
                <Link to="/forgot-password" state={{ email: email.trim() }}>
                  {t("Forgot your password?")}
                </Link>
              ) : (
                t("Forgot your password? Ask an admin of this site")
              )}
            </p>
          )}
          {signup ? (
            <p>{tx("Already have an account? <a>Sign in</a>", { a: (w) => <Link to={`/login${keepNext}`}>{w}</Link> })}</p>
          ) : state.allowSignup ? (
            <p>{tx("New here? <a>Create an account</a>", { a: (w) => <Link to={`/signup${keepNext}`}>{w}</Link> })}</p>
          ) : null}
        </div>
      )}
    </AuthFrame>
  );
}

/** What the password opened: a ticket for the second step, and which ways it can take. */
type SecondStepTicket = { ticket: string; totp: boolean; passkey: boolean };

/**
 * Signing in's second step, for an account with two-step verification: a passkey, a six-digit code
 * from the authenticator app, or a recovery code. onBack leaves for the password again, saying why
 * when the ticket ran out.
 */
function SecondStep({ email, ticket, onBack, onDone }: {
  email: string;
  ticket: SecondStepTicket;
  onBack: (problem?: string) => void;
  onDone: (recoveryLeft: number | null) => Promise<void>;
}) {
  const [recovery, setRecovery] = useState(!ticket.totp && !ticket.passkey);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"code" | "passkey" | null>(null);

  /** A ticket that ran out (410) goes back to the password; anything else is said here. */
  const failed = (err: unknown) => {
    if (err instanceof ApiError && err.status === 410) return onBack(err.message);
    setError(err instanceof ApiError ? err.message : passkeyProblem(err));
  };

  const withCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("code");
    setError(null);
    try {
      const r = await api.post<{ recoveryLeft: number | null }>("/auth/login/code", { ticket: ticket.ticket, code });
      await onDone(r.recoveryLeft);
    } catch (err) {
      failed(err);
      setBusy(null);
    }
  };

  const withPasskey = async () => {
    setBusy("passkey");
    setError(null);
    try {
      const { options } = await api.post<{ options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/auth/login/passkey/options", { ticket: ticket.ticket });
      const response = await startAuthentication({ optionsJSON: options });
      await api.post("/auth/login/passkey", { ticket: ticket.ticket, response });
      await onDone(null);
    } catch (err) {
      failed(err);
      setBusy(null);
    }
  };

  return (
    <AuthFrame title={t("Two-step verification")}>
      <p className="text-muted">{tx("Signing in as <strong>{email}</strong>", { strong: () => <strong>{email}</strong> })}</p>
      {ticket.passkey && !recovery && (
        <BusyButton type="button" className={ticket.totp ? "btn-secondary btn-block" : "btn-primary btn-block"} busy={busy === "passkey"} disabled={busy === "code"} onClick={() => void withPasskey()}>
          {t("Use a passkey")}
        </BusyButton>
      )}
      {(ticket.totp || recovery) && (
        <form className="auth-form" onSubmit={withCode} noValidate>
          {recovery ? (
            <LineField
              id="recovery-code"
              label={t("Recovery code")}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              hint={t("One of the codes you saved when you turned this on")}
              error={error}
            />
          ) : (
            <LineField
              id="totp-code"
              label={t("Code from your authenticator app")}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus={!ticket.passkey}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
              error={error}
            />
          )}
          <BusyButton className="btn-primary btn-block" type="submit" busy={busy === "code"} disabled={busy === "passkey" || (recovery ? !code.trim() : code.length < 6)}>
            {t("Sign in")}
          </BusyButton>
        </form>
      )}
      {!ticket.totp && !recovery && error && <Advisory>{error}</Advisory>}
      <div className="auth-links text-muted">
        <p>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setRecovery(!recovery);
              setCode("");
              setError(null);
            }}
          >
            {recovery ? (ticket.totp ? t("Use the code from your app") : t("Use a passkey")) : t("Use a recovery code instead")}
          </button>
        </p>
        <p>
          <button type="button" className="link-button" onClick={() => onBack()}>
            {t("Sign in as someone else")}
          </button>
        </p>
      </div>
    </AuthFrame>
  );
}

/**
 * Asking for a link to set a new password (/forgot-password). The answer is the same whether or
 * not an account uses the address, so the page says what happens if one does.
 */
export function ForgotPasswordPage() {
  const { user, loading } = useSession();
  const location = useLocation();
  const state = useAuthState();
  const [email, setEmail] = useState(() => (location.state as { email?: string } | null)?.email ?? "");
  const [sent, setSent] = useState<{ to: string; inLog: boolean } | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The "Send again" countdown.
  useEffect(() => {
    if (!sent || resendAt <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sent, resendAt]);

  if (!loading && user) return <Navigate to="/chat" replace />;
  if (!state) return <Booting />;

  const send = async (to: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ resendIn: number; mail: "smtp" | "dev" }>("/auth/forgot", { email: to });
      setSent({ to: to.trim(), inLog: r.mail === "dev" });
      setResendAt(Date.now() + r.resendIn * 1000);
      setNow(Date.now());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const backToSignIn = (
    <p className="auth-links text-muted">
      <Link to="/login">{t("Back to sign in")}</Link>
    </p>
  );

  if (!state.passwordReset) {
    return (
      <AuthFrame title={t("Forgot your password?")}>
        <p className="text-muted">{t("This site can't send email, so ask an admin of this site to reset it")}</p>
        {backToSignIn}
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title={t("Forgot your password?")}>
      {sent ? (
        <>
          <p className="auth-sent">
            <Icon name="mail" size={18} />
            <span>
              {tx("If an account uses <strong>{to}</strong>, we've emailed it a link to set a new password. The link works for 30 minutes", {
                strong: () => <strong>{sent.to}</strong>,
              })}
              {sent.inLog && ` ${t("(no email server is set up, so it's in the server log)")}`}
            </span>
          </p>
          {error && <Advisory>{error}</Advisory>}
          <div className="form-page-actions">
            <button type="button" className="btn-secondary" disabled={busy || wait > 0} onClick={() => void send(sent.to)}>
              {/* As wide as its longest wording all along, so the countdown never moves it. */}
              <span className="swap tabular">
                <span className="reserve" aria-hidden="true">
                  {t("Send again in 00s")}
                </span>
                <span>{wait > 0 ? t("Send again in {wait}s", { wait }) : t("Send again")}</span>
              </span>
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setEmail(sent.to);
                setError(null);
                setSent(null);
              }}
            >
              {t("Use another address")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted">{t("Type the email you sign in with, and we'll send you a link to set a new password")}</p>
          <form
            className="auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send(email);
            }}
            noValidate
          >
            <LineField
              id="email"
              label={t("Email")}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={error}
              required
            />
            <BusyButton className="btn-primary btn-block" type="submit" busy={busy} disabled={!email.trim()}>
              {t("Send link")}
            </BusyButton>
          </form>
        </>
      )}
      {backToSignIn}
    </AuthFrame>
  );
}

type ResetLink = { email: string } | { dead: string } | { off: true };
const DEAD_LINK = t("It has expired, been used, or been replaced by a newer one. Each link works once, for 30 minutes");

/**
 * Setting a new password from an emailed link (/reset-password#token). The token is after the #,
 * so it never reaches the server's logs; the page checks it first, to say straight away when the
 * link no longer works. Setting the password signs out every other device and signs in this one.
 */
export function ResetPasswordPage() {
  const { refreshUser } = useSession();
  const navigate = useNavigate();
  const token = useLocation().hash.slice(1);
  const [link, setLink] = useState<ResetLink | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A link that's used up, replaced or expired answers 410, and an account that's off 403.
  const linkGone = (err: unknown): ResetLink | null =>
    !(err instanceof ApiError) ? null : err.status === 410 ? { dead: DEAD_LINK } : err.status === 403 ? { off: true } : null;

  useEffect(() => {
    api.post<{ email: string }>("/auth/reset/check", { token }).then(setLink, (err) => setLink(linkGone(err) ?? { dead: (err as Error).message }));
  }, [token]);

  if (!link) return <Booting />;

  if ("off" in link) {
    return (
      <AuthFrame title={t("This account is turned off")}>
        <p className="text-muted">{t("Its password can't be reset while it's off. Ask an admin of this site")}</p>
        <p className="auth-links text-muted">
          <Link to="/login">{t("Back to sign in")}</Link>
        </p>
      </AuthFrame>
    );
  }
  if ("dead" in link) {
    return (
      <AuthFrame title={t("This link doesn't work")}>
        <p className="text-muted">{link.dead}</p>
        <Link className="btn-primary btn-block" to="/forgot-password">
          {t("Ask for a new link")}
        </Link>
        <p className="auth-links text-muted">
          <Link to="/login">{t("Back to sign in")}</Link>
        </p>
      </AuthFrame>
    );
  }

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ signIn?: boolean }>("/auth/reset", { token, password });
      // With two-step verification on, the link doesn't sign anyone in: they sign in, second step and all.
      if (r.signIn) return void navigate("/login", { replace: true, state: { passwordSet: true } });
      await refreshUser();
      navigate("/chat", { replace: true });
    } catch (err) {
      const gone = linkGone(err);
      if (gone) setLink(gone);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title={t("Set a new password")}>
      <p className="text-muted">{tx("For <strong>{email}</strong>. Setting it signs you out on your other devices", { strong: () => <strong>{link.email}</strong> })}</p>
      <form className="auth-form" onSubmit={save} noValidate>
        {/* Tells a password manager which account the new password is for. */}
        <input className="visually-hidden" type="email" name="username" autoComplete="username" value={link.email} readOnly tabIndex={-1} aria-hidden="true" />
        <LineField
          id="password"
          label={t("New password")}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={t("At least 8 characters")}
          error={error}
          autoFocus
          required
        />
        <BusyButton className="btn-primary btn-block" type="submit" busy={busy} disabled={!password}>
          {t("Set password")}
        </BusyButton>
      </form>
    </AuthFrame>
  );
}

function Booting() {
  return (
    <div className="boot">
      <Spinner />
    </div>
  );
}

// The flag and name draw themselves once per visit; moving between sign in and sign up shows them drawn.
let brandDrawn = false;

function AuthFrame({ title, children }: { title: string; children: React.ReactNode }) {
  const [draw] = useState(() => !brandDrawn);
  useEffect(() => {
    brandDrawn = true;
  }, []);
  return (
    <div className="auth">
      {HAND_LETTERED ? (
        <div className="auth-brand">
          <ParleyFlag draw={draw} />
          <p className="auth-wordmark">
            <Wordmark draw={draw} start={1150} />
          </p>
        </div>
      ) : (
        <p className="auth-wordmark">{APP_NAME}</p>
      )}
      <h1 className="title-lg">{title}</h1>
      {children}
    </div>
  );
}
