import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { BusyButton } from "../components/BusyButton.tsx";
import { Callout, Spinner } from "../components/Feedback.tsx";
import { LineField } from "../components/LineField.tsx";
import { HAND_LETTERED, ParleyFlag, Wordmark } from "../icons/Brand.tsx";
import { api } from "../lib/api.ts";
import { APP_NAME } from "../lib/brand.ts";
import { useSession } from "../lib/session.tsx";

type AuthState = { needsSetup: boolean; allowSignup: boolean };

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
  const [state, setState] = useState<AuthState | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<AuthState>("/auth/state").then(setState, () => setState({ needsSetup: false, allowSignup: false }));
  }, []);

  if (!loading && user) return <Navigate to={next ?? "/chat"} replace />;
  if (!state) {
    return (
      <div className="boot">
        <Spinner />
      </div>
    );
  }

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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ bonusEligible?: boolean }>(signup ? "/auth/signup" : "/auth/login", { email, password });
      await refreshUser();
      // A brand-new site can't chat until it has a key, so its first admin goes there first. An
      // address on a rewarded domain is offered the (skippable) check that earns the reward.
      if (state.needsSetup) navigate("/admin/keys", { replace: true });
      else if (r.bonusEligible) navigate(`/account/bonus?from=signup&email=${encodeURIComponent(email.trim())}`, { replace: true });
      else navigate(next ?? "/chat", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = state.needsSetup ? "Set up your chat site" : signup ? "Create an account" : "Sign in";

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
          onChange={(e) => setEmail(e.target.value)}
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
          error={error}
          required
        />
        <BusyButton className="btn-primary btn-block" type="submit" busy={busy} disabled={!email || !password}>
          {signup ? "Create account" : "Sign in"}
        </BusyButton>
      </form>
      {!state.needsSetup && (
        <p className="auth-switch text-muted">
          {signup ? (
            <>
              Already have an account? <Link to={`/login${keepNext}`}>Sign in</Link>
            </>
          ) : state.allowSignup ? (
            <>
              New here? <Link to={`/signup${keepNext}`}>Create an account</Link>
            </>
          ) : null}
        </p>
      )}
    </AuthFrame>
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
