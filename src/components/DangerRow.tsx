import { useState } from "react";

type ConfirmProps = { message: string; onCancel: () => void; onConfirm: () => Promise<void> | void };

/** Asks "are you sure" in place, as a line on the page. There are no pop-ups in this app. */
export function InlineConfirm({ message, onCancel, onConfirm }: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="inline-confirm" role="group" aria-label={message}>
      <span>{message}</span>
      <span className="inline-confirm-actions">
        <button type="button" className="btn-secondary btn-sm" onClick={onCancel} autoFocus>
          Keep it
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
          Delete
        </button>
      </span>
    </div>
  );
}

type RowProps = { label: string; confirmLabel: string; onConfirm: () => Promise<void> | void };

/** A destructive action at the foot of a page; it turns into an InlineConfirm when pressed. */
export function DangerRow({ label, confirmLabel, onConfirm }: RowProps) {
  const [asking, setAsking] = useState(false);
  if (asking) return <InlineConfirm message={confirmLabel} onCancel={() => setAsking(false)} onConfirm={onConfirm} />;
  return (
    <button type="button" className="danger-row" onClick={() => setAsking(true)}>
      {label}
    </button>
  );
}
