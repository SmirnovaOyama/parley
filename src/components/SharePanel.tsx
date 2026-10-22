import { useState } from "react";
import { Icon } from "../icons/Icon.tsx";
import { api, shareUrl, type Share, type SharingMode } from "../lib/api.ts";
import { longDate } from "../lib/format.ts";
import { t } from "../lib/i18n.ts";
import { BusyButton } from "./BusyButton.tsx";
import { LineField } from "./LineField.tsx";

type Props = {
  conversationId: string;
  share: Share | null;
  /** The link shows every message on screen. */
  upToDate: boolean;
  sharing: SharingMode;
  /** A reply is being written; the link can be made once it's saved. */
  busy: boolean;
  /** Nothing has been said yet, so there's nothing to share. */
  empty: boolean;
  onChange: (share: Share | null) => void;
};

/**
 * On a chat's settings page: make a read-only link to the chat as it is now, copy it, bring it up
 * to date, or stop sharing. Later messages stay private until the link is updated.
 */
export function SharePanel({ conversationId, share, upToDate, sharing, busy, empty, onChange }: Props) {
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = share ? shareUrl(share.token) : "";

  const act = async (fn: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const create = () =>
    act(async () => {
      const res = await api.post<{ share: Share }>(`/conversations/${conversationId}/share`);
      onChange(res.share);
      setCopied(false);
      setStopped(false);
    });

  const stop = () =>
    act(async () => {
      await api.del(`/conversations/${conversationId}/share`);
      onChange(null);
      setStopped(true);
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard access (an insecure page, say): select the link so it can be copied by hand.
      document.querySelector<HTMLInputElement>("#share-link")?.select();
    }
  };

  if (!share) {
    // Translate the whole sentence so the audience never gains extra spaces in Chinese.
    const description = sharing === "anyone"
      ? t("Share this chat as read-only with anyone who has the link")
      : sharing === "signed-in"
        ? t("Share this chat as read-only with people signed in here")
        : t("An admin has turned sharing off, so the link doesn't open for now");
    return (
      <div className="settings-panel">
        <p className="settings-text">
          {stopped
            ? t("Sharing stopped, the old link no longer opens")
            : empty
              ? t("Once there's something in this chat, you can make a read-only link to it")
              : description}
        </p>
        {!stopped && !empty && sharing !== "off" && <p className="settings-text">{t("Later messages stay private until you update the link")}</p>}
        {error && <p className="settings-text text-danger">{error}</p>}
        {!empty && (
          <div className="form-page-actions">
            <BusyButton type="button" className="btn-secondary" busy={working} disabled={busy} onClick={() => void create()}>
              {stopped ? t("Share again") : t("Create link")}
            </BusyButton>
          </div>
        )}
      </div>
    );
  }

  const status =
    sharing === "off"
      ? t("An admin has turned sharing off, so the link doesn't open for now")
      : upToDate
        ? sharing === "anyone"
          ? t("Shared on {sharedAt}, anyone with the link can read it", { sharedAt: longDate(share.sharedAt) })
          : t("Shared on {sharedAt}, people signed in here can read it", { sharedAt: longDate(share.sharedAt) })
        : t("Shared on {sharedAt}, update the link to include newer messages", { sharedAt: longDate(share.sharedAt) });

  return (
    <div className="settings-panel">
      <LineField
        id="share-link"
        label={t("Link")}
        value={url}
        readOnly
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        hint={status}
        error={error}
      />
      <div className="form-page-actions">
        <button type="button" className="btn-secondary" onClick={() => void copy()}>
          {/* Sized for both wordings, so "Copied" never nudges Update link aside. */}
          <span className="swap">
            <span className="reserve" aria-hidden="true">
              <Icon name="check" size={16} />
              {t("Copied")}
            </span>
            <span className="reserve" aria-hidden="true">
              {t("Copy link")}
            </span>
            {copied ? (
              <span>
                <Icon name="check" size={16} className="draw-in" />
                {t("Copied")}
              </span>
            ) : (
              <span>{t("Copy link")}</span>
            )}
          </span>
        </button>
        {!upToDate && sharing !== "off" && (
          <button type="button" className="btn-secondary" disabled={working || busy} onClick={() => void create()}>
            {t("Update link")}
          </button>
        )}
        <button type="button" className="btn-ghost share-stop" disabled={working} onClick={() => void stop()}>
          {t("Stop sharing")}
        </button>
      </div>
    </div>
  );
}
