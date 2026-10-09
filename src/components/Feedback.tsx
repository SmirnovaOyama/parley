import type { ReactNode } from "react";
import { Doodle } from "../icons/Doodle.tsx";
import { Icon } from "../icons/Icon.tsx";

/** A warning as a plain coloured line, never boxed, with an optional next step. */
export function Advisory({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="oy-advisory advisory-line" role="status">
      <div className="oy-advisory-lead">
        <span className="icon-line">
          <Icon name="alert" size={16} className="icon" />
        </span>
        <span className="lead">{children}</span>
      </div>
      {action && <div className="advisory-action">{action}</div>}
    </div>
  );
}

/** A quiet filled note for something to read, never a warning. */
export function Callout({ icon, children }: { icon?: "eye" | "lock" | "alert" | "gift"; children: ReactNode }) {
  return (
    <div className="callout callout-row">
      {icon && (
        <span className="icon-line">
          <Icon name={icon} size={16} />
        </span>
      )}
      <span>{children}</span>
    </div>
  );
}

type EmptyProps = { doodle?: "chat" | "people"; title: string; children?: ReactNode; action?: ReactNode };

/** Names what's missing and the one thing to do about it. */
export function EmptyState({ doodle, title, children, action }: EmptyProps) {
  return (
    <div className="empty-state">
      {doodle && <Doodle name={doodle} />}
      <h2 className="title-sm">{title}</h2>
      {children && <p className="text-muted">{children}</p>}
      {action}
    </div>
  );
}

/**
 * The one loading mark: a turning stroke on a faint ring. Beside a chat with a reply being
 * written, while a page loads, while the AI thinks. `label` null when text beside it says it.
 */
export function BusyMark({ label = "Replying", size = 14 }: { label?: string | null; size?: number }) {
  return (
    <svg
      className="busy-mark"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <path className="busy-track" d="M8.1 2.3c3.2-.1 5.7 2.5 5.6 5.7-.1 3.1-2.6 5.6-5.7 5.6-3.1 0-5.6-2.6-5.6-5.7.1-3.1 2.6-5.7 5.7-5.6z" />
      <path className="busy-arc" d="M8.1 2.3c3.2-.1 5.7 2.5 5.6 5.7" />
    </svg>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <p className="loading-line" role="status">
      <BusyMark label={null} size={20} />
      <span className="visually-hidden">{label}</span>
    </p>
  );
}
