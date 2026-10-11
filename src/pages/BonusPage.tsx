import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { BusyButton } from "../components/BusyButton.tsx";
import { Advisory, Callout, EmptyState, Spinner } from "../components/Feedback.tsx";
import { LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api } from "../lib/api.ts";
import { domainsText, rewardText, type BonusStatus } from "../lib/bonus.ts";
import { t, tx } from "../lib/i18n.ts";

type Stage = "email" | "code" | "done";

/**
 * Proving an address on a rewarded domain (/settings/bonus): type the address, get a 6-digit code
 * by email, type it here. Optional; reached from Settings, or straight after signing up with such an
 * address (?from=signup&email=…), where it can be skipped.
 */
export function BonusPage() {
  const [params] = useSearchParams();
  const fromSignup = params.get("from") === "signup";
  const [status, setStatus] = useState<BonusStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  // Which request is out, so only its own button turns.
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);

  useEffect(() => {
    api.get<BonusStatus>("/auth/bonus").then(
      (s) => {
        setStatus(s);
        if (s.pending) {
          setSentTo(s.pending.email);
          setResendAt(Date.now() + s.pending.resendIn * 1000);
          setStage("code");
        } else if (s.verified?.active && !params.get("email")) setStage("done");
      },
      (err) => setLoadError((err as Error).message),
    );
    // Read once on arrival.
  }, [params]);

  // The "Send again" countdown.
  useEffect(() => {
    if (stage !== "code" || resendAt <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage, resendAt]);

  const send = async (to: string) => {
    setBusy("send");
    setError(null);
    try {
      const r = await api.post<{ sentTo: string; resendIn: number }>("/auth/bonus/send", { email: to });
      setSentTo(r.sentTo);
      setResendAt(Date.now() + r.resendIn * 1000);
      setNow(Date.now());
      setCode("");
      setStage("code");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("verify");
    setError(null);
    try {
      await api.post("/auth/bonus/verify", { code });
      setStatus(await api.get<BonusStatus>("/auth/bonus"));
      setStage("done");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const reward = status ? rewardText(status.reward) : null;
  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const back = fromSignup ? undefined : { label: t("Settings"), to: "/settings" };

  return (
    <>
      <PageHeader title={t("Verify your email")} subtitle={t("Optional")} back={back} />
      <div className="oy-page-column page-body">
        {loadError ? (
          <Advisory>{loadError}</Advisory>
        ) : !status ? (
          <Spinner />
        ) : status.domains.length === 0 ? (
          <EmptyState doodle="gift" title={t("No email rewards here")}>
            {t("This site doesn't reward any email addresses at the moment")}
          </EmptyState>
        ) : stage === "done" && status.verified ? (
          <div className="bonus-done">
            <p className="bonus-done-title">
              <Icon name="check" size={20} className="draw-in" />
              {t("Verified {email}", { email: status.verified.email })}
            </p>
            <p className="text-muted">
              {status.verified.active
                ? reward
                  ? t("You get {reward}", { reward })
                  : t("The admins haven't set a reward yet. It applies as soon as they do")
                : t("Its domain no longer earns a reward here")}
            </p>
            <div className="form-page-actions">
              <Link className="btn-primary" to="/chat">
                {t("Start chatting")}
              </Link>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setEmail("");
                  setError(null);
                  setStage("email");
                }}
              >
                {t("Use another address")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <Callout icon="gift">
              {reward
                ? t("Prove you own an address at {domainsText} to get {reward}", { domainsText: domainsText(status.domains), reward })
                : t("Addresses at {domainsText} can be verified here", { domainsText: domainsText(status.domains) })}
            </Callout>

            {status.mail === "off" ? (
              <Advisory>{t("Email isn't set up on this site yet, so addresses can't be checked. Ask an admin")}</Advisory>
            ) : stage === "email" ? (
              <form
                className="form-page"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(email);
                }}
              >
                <LineField
                  id="bonus-email"
                  label={t("Email address")}
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  hint={t("We'll send a 6-digit code to it. It doesn't change the address you sign in with")}
                  error={error}
                />
                <div className="form-page-actions">
                  <BusyButton type="submit" className="btn-primary" busy={busy === "send"} disabled={!email.trim()}>
                    {t("Send code")}
                  </BusyButton>
                  {fromSignup ? (
                    <Link className="btn-secondary" to="/chat">
                      {t("Skip for now")}
                    </Link>
                  ) : (
                    <SlideLink className="btn-secondary" to="/settings" direction="back">
                      {t("Cancel")}
                    </SlideLink>
                  )}
                </div>
              </form>
            ) : (
              <form className="form-page" onSubmit={verify}>
                <p className="bonus-sent">
                  <Icon name="mail" size={18} />
                  <span>
                    {tx("We sent a code to <strong>{sentTo}</strong>. It works for 10 minutes", { strong: () => <strong>{sentTo}</strong> })}
                    {status.mail === "dev" && ` ${t("(no email server is set up, so it's in the server log)")}`}
                  </span>
                </p>
                <LineField
                  id="bonus-code"
                  label={t("6-digit code")}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  spellCheck={false}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  error={error}
                  autoFocus
                />
                <div className="form-page-actions">
                  <BusyButton type="submit" className="btn-primary" busy={busy === "verify"} disabled={busy === "send" || code.length !== 6}>
                    {t("Verify")}
                  </BusyButton>
                  <button type="button" className="btn-secondary" disabled={busy !== null || wait > 0} onClick={() => void send(sentTo)}>
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
                    className="btn-ghost bonus-change"
                    onClick={() => {
                      setEmail(sentTo);
                      setError(null);
                      setStage("email");
                    }}
                  >
                    {t("Change address")}
                  </button>
                </div>
                {fromSignup && (
                  <Link className="text-link bonus-skip" to="/chat">
                    {t("Skip for now")}
                  </Link>
                )}
              </form>
            )}
          </>
        )}
      </div>
    </>
  );
}
