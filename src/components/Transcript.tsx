import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../icons/Icon.tsx";
import type { Attachment, Message } from "../lib/api.ts";
import { dateTime, fileSize } from "../lib/format.ts";
import { EditFiles, MessageFiles } from "./Attachments.tsx";
import { Advisory, BusyMark } from "./Feedback.tsx";
// The renderer brings code highlighting and math typesetting, so it loads on first use; until then
// a reply shows as plain text.
const Markdown = lazy(() => import("./Markdown.tsx").then((m) => ({ default: m.Markdown })));

export type UiMessage = Message & {
  /** The reply is still arriving. */
  streaming?: boolean;
  phase?: "waiting" | "uploading" | "thinking" | "writing" | "searching" | "coding" | "saving";
  /** While searching: what for. */
  searchQuery?: string;
  notice?: string;
};

type Props = {
  messages: UiMessage[];
  /** Admin view: show times and every status plainly; no editing. */
  readOnly?: boolean;
  /** A reply is being written, so editing, regenerating and switching wait. */
  busy?: boolean;
  /** Sends a new version of your message, with the files it keeps. */
  onEdit?: (message: UiMessage, text: string, attachmentIds: string[]) => void;
  /** Writes a new version of this reply. */
  onRegenerate?: (message: UiMessage) => void;
  /** Shows another version of a message. */
  onSwitch?: (messageId: number) => void;
  /** Where a file downloads from (made or attached); a shared page goes through its link. */
  fileUrl?: (fileId: string) => string;
};

export function Transcript({ messages, readOnly, busy, onEdit, onRegenerate, onSwitch, fileUrl = (id) => `/api/files/${id}` }: Props) {
  const switcher = (m: UiMessage) =>
    onSwitch && m.siblingIds.length > 1 ? <VersionSwitcher message={m} onSwitch={onSwitch} disabled={busy} /> : null;

  return (
    <div className="transcript">
      {messages.map((m) =>
        m.role === "user" ? (
          <UserMessage
            key={m.id}
            message={m}
            readOnly={readOnly}
            switcher={switcher(m)}
            fileUrl={fileUrl}
            onEdit={!readOnly && !busy && onEdit && m.id > 0 ? (text, ids) => onEdit(m, text, ids) : undefined}
          />
        ) : (
          <AssistantMessage
            key={m.id}
            message={m}
            readOnly={readOnly}
            switcher={switcher(m)}
            fileUrl={fileUrl}
            onRegenerate={!readOnly && !busy && onRegenerate && m.id > 0 && m.parentId ? () => onRegenerate(m) : undefined}
          />
        ),
      )}
    </div>
  );
}

/** ‹ 2 / 3 › between the versions of a message. */
function VersionSwitcher({ message, onSwitch, disabled }: { message: UiMessage; onSwitch: (id: number) => void; disabled?: boolean }) {
  const ids = message.siblingIds;
  const at = ids.indexOf(message.id);
  return (
    <span className="versions" aria-label={`Version ${at + 1} of ${ids.length}`}>
      <button
        type="button"
        className="btn-ghost versions-step"
        aria-label="Previous version"
        disabled={disabled || at <= 0}
        onClick={() => onSwitch(ids[at - 1])}
      >
        <Icon name="chevron-left" size={14} />
      </button>
      <span className="tabular">
        {at + 1} / {ids.length}
      </span>
      <button
        type="button"
        className="btn-ghost versions-step"
        aria-label="Next version"
        disabled={disabled || at >= ids.length - 1}
        onClick={() => onSwitch(ids[at + 1])}
      >
        <Icon name="chevron-right" size={14} />
      </button>
    </span>
  );
}

type UserProps = {
  message: UiMessage;
  readOnly?: boolean;
  switcher: React.ReactNode;
  fileUrl: (fileId: string) => string;
  onEdit?: (text: string, attachmentIds: string[]) => void;
};

function UserMessage({ message, readOnly, switcher, fileUrl, onEdit }: UserProps) {
  const [editing, setEditing] = useState(false);
  const attachments = message.attachments ?? [];

  if (editing && onEdit) {
    return (
      <div className="msg msg-user">
        <EditBox
          initial={message.text}
          files={attachments}
          fileUrl={fileUrl}
          onCancel={() => setEditing(false)}
          onSend={(text, ids) => {
            setEditing(false);
            onEdit(text, ids);
          }}
        />
      </div>
    );
  }

  return (
    <div className="msg msg-user">
      {message.instructionsChanged && <p className="msg-note instr-note">Instructions changed from here</p>}
      {attachments.length > 0 && <MessageFiles files={attachments} url={fileUrl} />}
      {message.text && <div className="bubble">{message.text}</div>}
      {(readOnly || switcher || onEdit) && (
        <div className={`msg-meta msg-meta-user${!switcher && !readOnly ? " is-floating" : ""}`}>
          {readOnly && <span>{dateTime(message.createdAt)}</span>}
          {switcher}
          {onEdit && (
            <button type="button" className="btn-ghost msg-action" onClick={() => setEditing(true)} aria-label="Edit" title="Edit">
              <Icon name="pencil" size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type EditProps = {
  initial: string;
  files: Attachment[];
  fileUrl: (fileId: string) => string;
  onCancel: () => void;
  onSend: (text: string, attachmentIds: string[]) => void;
};

/**
 * The message, editable in place, with its files (the cross leaves one out). Sending makes a new
 * version; the old one stays.
 */
function EditBox({ initial, files, fileUrl, onCancel, onSend }: EditProps) {
  const [value, setValue] = useState(initial);
  const [kept, setKept] = useState(files);
  const changed = value.trim() !== initial.trim() || kept.length !== files.length;
  const sendable = (!!value.trim() || kept.length > 0) && changed;
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [value]);

  useLayoutEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const send = () => {
    if (sendable) onSend(value.trim(), kept.map((f) => f.id));
  };

  return (
    <form
      className="edit-box"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <EditFiles files={kept} url={fileUrl} onRemove={(id) => setKept((list) => list.filter((f) => f.id !== id))} />
      <textarea
        ref={ref}
        aria-label="Edit your message"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="edit-box-actions">
        <button type="button" className="btn-secondary btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary btn-sm" disabled={!sendable}>
          Send
        </button>
      </div>
    </form>
  );
}

type AssistantProps = {
  message: UiMessage;
  readOnly?: boolean;
  switcher: React.ReactNode;
  fileUrl: (fileId: string) => string;
  onRegenerate?: () => void;
};

/** Phases that get their own status line under the text while the reply is still coming. */
const BUSY_PHASES = new Set(["searching", "coding", "saving"]);

function AssistantMessage({ message, readOnly, switcher, fileUrl, onRegenerate }: AssistantProps) {
  const [copied, setCopied] = useState(false);
  const failed = message.status === "failed" || message.status === "declined";
  const waiting = message.streaming && !message.text;

  const copy = () =>
    void navigator.clipboard.writeText(message.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });

  return (
    <div className="msg msg-assistant" data-message-id={message.id} aria-busy={message.streaming || undefined}>
      {waiting && !message.thinking && !BUSY_PHASES.has(message.phase ?? "") && <Thinking phase={message.phase} />}
      {message.thinking && (
        <ThinkingFold text={message.thinking} ms={message.thinkingMs} live={!!message.streaming && !message.text} />
      )}
      {message.text && (
        <Suspense fallback={<div className="md md-plain">{message.text}</div>}>
          <Markdown text={message.text} streaming={message.streaming} />
        </Suspense>
      )}
      {message.streaming && BUSY_PHASES.has(message.phase ?? "") && <Thinking phase={message.phase} detail={message.searchQuery} />}
      {message.files && message.files.length > 0 && <FileCards files={message.files} url={fileUrl} />}
      {!message.streaming && (message.sources?.length || message.searches?.length) ? (
        <SourcesFold sources={message.sources ?? []} found={message.found ?? []} searches={message.searches ?? []} />
      ) : null}
      {(message.note ?? message.notice) && <p className="msg-note">{message.note ?? message.notice}</p>}
      {failed && (
        <Advisory
          action={
            onRegenerate && (
              <button type="button" className="btn-ghost is-accent" onClick={onRegenerate}>
                <Icon name="retry" size={16} />
                Try again
              </button>
            )
          }
        >
          {message.error ?? "No reply came back"}
        </Advisory>
      )}
      {message.status === "stopped" && <p className="msg-note">Stopped</p>}
      {message.status === "truncated" && <p className="msg-note">The reply reached its length limit</p>}
      {!message.streaming && (message.text || readOnly || switcher) && (
        <div className="msg-meta">
          {message.model && <span>{message.model}</span>}
          {readOnly && <span>{dateTime(message.createdAt)}</span>}
          {switcher}
          {message.text && (
            <button type="button" className="btn-ghost msg-action" onClick={copy} aria-label={copied ? "Copied" : "Copy reply"} title={copied ? "Copied" : "Copy"}>
              <Icon name={copied ? "check" : "copy"} size={14} className={copied ? "draw-in" : undefined} />
            </button>
          )}
          {onRegenerate && !failed && (
            <button type="button" className="btn-ghost msg-action" onClick={onRegenerate} aria-label="Regenerate" title="Regenerate">
              <Icon name="retry" size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * The model's thinking, folded above its reply: "Thinking" with moving dots while it thinks
 * (unfold to watch), then "Thought for 8s". Unfolds in place, in muted text.
 */
function ThinkingFold({ text, ms, live }: { text: string; ms: number | null; live: boolean }) {
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const label = live ? "Thinking" : ms == null ? "Thought" : ms < 1500 ? "Thought briefly" : `Thought for ${duration(ms)}`;
  // Long reasoning streams many tokens a second. Folded, nobody can see it, so it isn't rendered
  // until first opened, and while folded again it keeps the text it last showed.
  const [opened, setOpened] = useState(false);
  const shown = useRef(text);
  if (open) shown.current = text;

  // Watching it think: keep the newest line in view, unless the reader scrolled up to look back.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !open || !live) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) el.scrollTop = el.scrollHeight;
  }, [text, open, live]);
  return (
    <div className="thought">
      <button
        type="button"
        className="thought-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpened(true);
          setOpen((o) => !o);
        }}
      >
        {live && (
          <BusyMark label={null} size={13} />
        )}
        <span>{label}</span>
        <Icon name="chevron-down" size={14} className={`chev${open ? " is-open" : ""}`} />
      </button>
      <div className="disclosure" data-open={open} inert={!open}>
        <div className="disclosure-inner">
          <div className="thought-body">
            <div className="thought-scroll" ref={scrollRef}>
              {opened && (
                <Suspense fallback={<div className="md md-plain">{shown.current}</div>}>
                  <Markdown text={shown.current} streaming={live} />
                </Suspense>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Thinking({ phase, detail }: { phase?: UiMessage["phase"]; detail?: string }) {
  return (
    <p className="thinking" role="status">
      <BusyMark label={null} size={13} />
      {phase === "searching" ? (
        <span className="thinking-detail">{detail ? `Searching the web for “${detail}”` : "Searching the web"}</span>
      ) : phase === "coding" ? (
        "Running code"
      ) : phase === "saving" ? (
        "Saving the files it made"
      ) : phase === "uploading" ? (
        "Sending your files"
      ) : phase === "thinking" ? (
        "Thinking"
      ) : (
        "Waiting for a reply"
      )}
    </p>
  );
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The files a reply made, as cards under it: a preview for images, a hand-drawn file mark for the
 * rest, the name and size. The whole card downloads the file.
 */
function FileCards({ files, url }: { files: { id: string; name: string; mime: string; size: number }[]; url: (id: string) => string }) {
  return (
    <ul className="file-cards">
      {files.map((f) => (
        <li key={f.id}>
          <a className="file-card" href={url(f.id)} download={f.name}>
            {IMAGE_TYPES.has(f.mime) ? (
              <img className="file-card-preview" src={`${url(f.id)}?inline=1`} alt="" loading="lazy" />
            ) : (
              <span className="file-card-icon" aria-hidden="true">
                <Icon name="file" size={22} />
              </span>
            )}
            <span className="file-card-text">
              <span className="file-card-name">{f.name}</span>
              <span className="file-card-size">{fileSize(f.size)}</span>
            </span>
            <Icon name="download" size={16} className="file-card-get" />
          </a>
        </li>
      ))}
    </ul>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

type Page = { url: string; title: string };

/**
 * Under a reply that searched the web. With citations: "3 sources", unfolding to the numbered
 * pages its [n] chips point to. Without (Claude often reads results through its own filtering
 * code and cites none): "Searched the web", unfolding to the queries and the pages they returned.
 */
function SourcesFold({ sources, found, searches }: { sources: Page[]; found: Page[]; searches: string[] }) {
  const [open, setOpen] = useState(false);
  const cited = sources.length > 0;
  const pages = cited ? sources : found;
  const label = cited
    ? `${sources.length} ${sources.length === 1 ? "source" : "sources"}`
    : searches.length > 1
      ? `Searched the web ${searches.length} times`
      : "Searched the web";
  return (
    <div className="sources">
      <button type="button" className="thought-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{label}</span>
        <Icon name="chevron-down" size={14} className={`chev${open ? " is-open" : ""}`} />
      </button>
      <div className="disclosure" data-open={open} inert={!open}>
        <div className="disclosure-inner">
          {searches.length > 0 && <p className="sources-searches">Searched for {searches.map((q) => `“${q}”`).join(", ")}</p>}
          {pages.length > 0 && (
            <ol className={`sources-list${cited ? "" : " is-found"}`}>
              {pages.map((s, i) => (
                <li key={s.url}>
                  {cited && <span className="sources-n tabular">{i + 1}</span>}
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    <span className="sources-title">{s.title || hostOf(s.url)}</span>
                    <span className="sources-host">{hostOf(s.url)}</span>
                  </a>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
