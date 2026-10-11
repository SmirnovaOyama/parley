import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { BusyButton } from "../components/BusyButton.tsx";
import { Advisory, Callout, Spinner } from "../components/Feedback.tsx";
import { LineField } from "../components/LineField.tsx";
import { HAND_LETTERED, ParleyFlag, Wordmark } from "../icons/Brand.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api, ApiError } from "../lib/api.ts";
import { APP_NAME } from "../lib/brand.ts";
import { useSession } from "../lib/session.tsx";

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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

  const signup = mode === "signup" || state.needsSetup;
  if (signup && !state.needsSetup && !state.allowSignup) {
    return (
      <AuthFrame title="Sign-ups are closed">
        <p className="text-muted">Ask an admin of this site to create an account for you</p>
        <p className="auth-switch">
          <Link to={`/login${keepNext}`}>Sign in instead</Link>
        </p>
      </AuthFrame>
    );
  }
  const needsCode = signup && state.signupCode;

  const sendCode = async () => {
    // Checked here too, so a code isn't spent on a password the next step turns away.
    if (password.length < 8) {
      setError({ text: "Use at least 8 characters for the password", field: "password" });
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
      const r = await api.post<{ bonusEligible?: boolean }>(signup ? "/auth/signup" : "/auth/login", { email, password, ...(needsCode ? { code } : {}) });
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

  const title = state.needsSetup ? "Set up your chat site" : signup ? "Create an account" : "Sign in";
  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));

  return (
    <AuthFrame title={title}>
      {state.needsSetup && (
        <Callout>This first account becomes the admin. You'll add an AI key next</Callout>
      )}
      <form className="auth-form" onSubmit={submit} noValidate>
        <LineField
          id="email"
          label="Email"
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
          label="Password"
          type="password"
          autoComplete={signup ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={signup ? "At least 8 characters" : undefined}
          error={error?.field === "password" ? error.text : null}
          required
        />
        {needsCode && sent && (
          <>
            <p className="auth-sent">
              <Icon name="mail" size={18} />
              <span>
                We've emailed a code to <strong>{sent.to}</strong>. It works for 10 minutes
                {sent.inLog && " (no email server is set up, so it's in the server log)"}
              </span>
            </p>
            <LineField
              id="code"
              label="Code"
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
          {needsCode && !sent ? "Send code" : signup ? "Create account" : "Sign in"}
        </BusyButton>
        {needsCode && sent && (
          <button type="button" className="btn-ghost btn-block" disabled={busy || wait > 0} onClick={() => void sendCode()}>
            {/* As wide as its longest wording all along, so the countdown never moves it. */}
            <span className="swap tabular">
              <span className="reserve" aria-hidden="true">
                Send again in 00s
              </span>
              <span>{wait > 0 ? `Send again in ${wait}s` : "Send again"}</span>
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
                  Forgot your password?
                </Link>
              ) : (
                "Forgot your password? Ask an admin of this site"
              )}
            </p>
          )}
          {signup ? (
            <p>
              Already have an account? <Link to={`/login${keepNext}`}>Sign in</Link>
            </p>
          ) : state.allowSignup ? (
            <p>
              New here? <Link to={`/signup${keepNext}`}>Create an account</Link>
            </p>
          ) : null}
        </div>
      )}
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
      <Link to="/login">Back to sign in</Link>
    </p>
  );

  if (!state.passwordReset) {
    return (
      <AuthFrame title="Forgot your password?">
        <p className="text-muted">This site can't send email, so ask an admin of this site to reset it</p>
        {backToSignIn}
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Forgot your password?">
      {sent ? (
        <>
          <p className="auth-sent">
            <Icon name="mail" size={18} />
            <span>
              If an account uses <strong>{sent.to}</strong>, we've emailed it a link to set a new password. The link works for 30 minutes
              {sent.inLog && " (no email server is set up, so it's in the server log)"}
            </span>
          </p>
          {error && <Advisory>{error}</Advisory>}
          <div className="form-page-actions">
            <button type="button" className="btn-secondary" disabled={busy || wait > 0} onClick={() => void send(sent.to)}>
              {/* As wide as its longest wording all along, so the countdown never moves it. */}
              <span className="swap tabular">
                <span className="reserve" aria-hidden="true">
                  Send again in 00s
                </span>
                <span>{wait > 0 ? `Send again in ${wait}s` : "Send again"}</span>
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
              Use another address
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted">Type the email you sign in with, and we'll send you a link to set a new password</p>
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
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={error}
              required
            />
            <BusyButton className="btn-primary btn-block" type="submit" busy={busy} disabled={!email.trim()}>
              Send link
            </BusyButton>
          </form>
        </>
      )}
      {backToSignIn}
    </AuthFrame>
  );
}

type ResetLink = { email: string } | { dead: string } | { off: true };
const DEAD_LINK = "It has expired, been used, or been replaced by a newer one. Each link works once, for 30 minutes";

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
      <AuthFrame title="This account is turned off">
        <p className="text-muted">Its password can't be reset while it's off. Ask an admin of this site</p>
        <p className="auth-links text-muted">
          <Link to="/login">Back to sign in</Link>
        </p>
      </AuthFrame>
    );
  }
  if ("dead" in link) {
    return (
      <AuthFrame title="This link doesn't work">
        <p className="text-muted">{link.dead}</p>
        <Link className="btn-primary btn-block" to="/forgot-password">
          Ask for a new link
        </Link>
        <p className="auth-links text-muted">
          <Link to="/login">Back to sign in</Link>
        </p>
      </AuthFrame>
    );
  }

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/reset", { token, password });
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
    <AuthFrame title="Set a new password">
      <p className="text-muted">
        For <strong>{link.email}</strong>. Setting it signs you out on your other devices
      </p>
      <form className="auth-form" onSubmit={save} noValidate>
        {/* Tells a password manager which account the new password is for. */}
        <input className="visually-hidden" type="email" name="username" autoComplete="username" value={link.email} readOnly tabIndex={-1} aria-hidden="true" />
        <LineField
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint="At least 8 characters"
          error={error}
          autoFocus
          required
        />
        <BusyButton className="btn-primary btn-block" type="submit" busy={busy} disabled={!password}>
          Set password
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
