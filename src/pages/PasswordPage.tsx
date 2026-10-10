import { useState, type FormEvent } from "react";
import { BusyButton } from "../components/BusyButton.tsx";
import { Advisory } from "../components/Feedback.tsx";
import { LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { api } from "../lib/api.ts";
import { useSlideNavigate } from "../lib/slide.ts";

/** Changing the password you sign in with (/account/password). */
export function PasswordPage() {
  const slideTo = useSlideNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/password", { current, next });
      slideTo("/account", "back", { state: { passwordChanged: true } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Password" subtitle="Changing it signs you out on your other devices" back={{ label: "Account", to: "/account" }} />
      <div className="oy-page-column page-body">
        <form className="form-page" onSubmit={save}>
          <LineField id="pw-current" label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <LineField id="pw-next" label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} hint="At least 8 characters" />
          {error && <Advisory>{error}</Advisory>}
          <div className="form-page-actions">
            <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!current || !next}>
              Change password
            </BusyButton>
            <SlideLink to="/account" direction="back" className="btn-secondary">
              Cancel
            </SlideLink>
          </div>
        </form>
      </div>
    </>
  );
}
