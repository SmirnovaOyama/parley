import { useState } from "react";
import { t } from "../lib/i18n.ts";

type ConfirmProps = {
  message: string;
  /** The button that goes ahead (Delete unless said). */
  action?: string;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
  /** Laid over the row it asks about (which gets `is-confirming`), so the row keeps its size. */
  overlay?: boolean;
};

/** Asks "are you sure" in place, as a line on the page. There are no pop-ups in this app. */
export function InlineConfirm({ message, action = t("Delete"), onCancel, onConfirm, overlay }: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={`inline-confirm${overlay ? " is-overlay" : ""}`} role="group" aria-label={message}>
      <span className={overlay ? "truncate" : undefined}>{message}</span>
      <span className="inline-confirm-actions">
        <button type="button" className="btn-secondary btn-sm" onClick={onCancel} autoFocus>
          {t("Keep it")}
        </button>
        <button
          type="button"
          className="btn-danger btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        >
          {action}
        </button>
      </span>
    </div>
  );
}

type RowProps = { label: string; confirmLabel: string; action?: string; onConfirm: () => Promise<void> | void };

/** A destructive action at the foot of a page; it turns into an InlineConfirm when pressed. */
export function DangerRow({ label, confirmLabel, action, onConfirm }: RowProps) {
  const [asking, setAsking] = useState(false);
  if (asking) return <InlineConfirm message={confirmLabel} action={action} onCancel={() => setAsking(false)} onConfirm={onConfirm} />;
  return (
    <button type="button" className="danger-row" onClick={() => setAsking(true)}>
      {label}
    </button>
  );
}
