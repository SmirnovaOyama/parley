import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../icons/Icon.tsx";
import type { Ask, AskAnswer, Attachment, Message, Moment, PlanStep, ToolUse } from "../lib/api.ts";
import { dateTime, fileSize } from "../lib/format.ts";
import { t, tn } from "../lib/i18n.ts";
import { EditFiles, MessageFiles } from "./Attachments.tsx";
import { OptionTitle, Tick } from "./Controls.tsx";
import { Advisory, BusyMark } from "./Feedback.tsx";
import { LineField } from "./LineField.tsx";
import { SlideLink } from "./SlideLink.tsx";
// The renderer brings code highlighting and math typesetting, so it loads on first use; until then
// a reply shows as plain text.
const Markdown = lazy(() => import("./Markdown.tsx").then((m) => ({ default: m.Markdown })));

export type UiMessage = Message & {
  /** The reply is still arriving. */
  streaming?: boolean;
  phase?: "waiting" | "uploading" | "thinking" | "writing" | "searching" | "coding" | "saving" | "tool";
  /** While searching: what for; while using a tool, what it's doing. */
  searchQuery?: string;
  notice?: string;
  /** Questions it's waiting on before a tool runs. */
  asks?: Ask[];
  /**
   * What the row is known by while it changes from a stand-in to the saved message, which has
   * another id, so what's open in it (its thinking, say) stays open.
   */
  key?: number;
};

type Props = {
  messages: UiMessage[];
  /** Admin view: show times and every status plainly; no editing. */
  readOnly?: boolean;
  /** Comparison columns already name the model in their heading. */
  showModel?: boolean;
  /** Narrow comparison columns show each table row as labelled fields. */
  stackTables?: boolean;
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
  /** Answers a question the reply being written is waiting on. */
  onAnswer?: (ask: Ask, answer: AskAnswer) => void;
};

export function Transcript({ messages, readOnly, showModel = true, stackTables = false, busy, onEdit, onRegenerate, onSwitch, onAnswer, fileUrl = (id) => `/api/files/${id}` }: Props) {
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
            // A message just sent has no id yet: its Edit is there from the start, resting until the
            // id comes back, so the row doesn't appear a moment later and push the reply down.
            busy={busy || m.id <= 0}
            onEdit={!readOnly && onEdit ? (text, ids) => onEdit(m, text, ids) : undefined}
          />
        ) : (
          <AssistantMessage
            key={m.key ?? m.id}
            message={m}
            readOnly={readOnly}
            showModel={showModel}
            stackTables={stackTables}
            switcher={switcher(m)}
            fileUrl={fileUrl}
            busy={busy}
            onRegenerate={!readOnly && onRegenerate && m.id > 0 && m.parentId ? () => onRegenerate(m) : undefined}
            onAnswer={readOnly ? undefined : onAnswer}
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
    <span className="versions" aria-label={t("Version {at} of {length}", { at: at + 1, length: ids.length })}>
      <button
        type="button"
        className="btn-ghost versions-step"
        aria-label={t("Previous version")}
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
        aria-label={t("Next version")}
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
  /** A reply is on its way: Edit stays where it is but rests, so nothing around it moves. */
  busy?: boolean;
  onEdit?: (text: string, attachmentIds: string[]) => void;
};

function UserMessage({ message, readOnly, switcher, fileUrl, busy, onEdit }: UserProps) {
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
      {message.instructionsChanged && <p className="msg-note instr-note">{t("Instructions changed from here")}</p>}
      {attachments.length > 0 && <MessageFiles files={attachments} url={fileUrl} />}
      {message.text && <div className="bubble">{message.text}</div>}
      {(readOnly || switcher || onEdit) && (
        <div className={`msg-meta msg-meta-user${!switcher && !readOnly ? " is-floating" : ""}`}>
          {readOnly && <span>{dateTime(message.createdAt)}</span>}
          {switcher}
          {onEdit && (
            <button type="button" className="btn-ghost msg-action" onClick={() => setEditing(true)} disabled={busy} aria-label={t("Edit")} title={t("Edit")}>
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
        aria-label={t("Edit your message")}
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
          {t("Cancel")}
        </button>
        <button type="submit" className="btn-primary btn-sm" disabled={!sendable}>
          {t("Send")}
        </button>
      </div>
    </form>
  );
}

type AssistantProps = {
  message: UiMessage;
  readOnly?: boolean;
  showModel: boolean;
  stackTables: boolean;
  switcher: React.ReactNode;
  fileUrl: (fileId: string) => string;
  /** A reply is on its way: Regenerate stays where it is but rests. */
  busy?: boolean;
  onRegenerate?: () => void;
  onAnswer?: (ask: Ask, answer: AskAnswer) => void;
};

/** Phases that get their own status line under the text while the reply is still coming. */
const BUSY_PHASES = new Set(["searching", "coding", "saving", "tool"]);

function AssistantMessage({ message, readOnly, showModel, stackTables, switcher, fileUrl, busy, onRegenerate, onAnswer }: AssistantProps) {
  const [copied, setCopied] = useState(false);
  const failed = message.status === "failed" || message.status === "declined";
  const waiting = message.streaming && !message.text;
  const asks = message.streaming ? (message.asks ?? []) : [];

  const copy = () =>
    void navigator.clipboard.writeText(message.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });

  return (
    <div className="msg msg-assistant" data-message-id={message.id} aria-busy={message.streaming || undefined}>
      {waiting && !message.thinking && !asks.length && !message.moments?.length && !BUSY_PHASES.has(message.phase ?? "") && <Thinking phase={message.phase} />}
      {message.thinking && (
        <ThinkingFold text={message.thinking} ms={message.thinkingMs} live={!!message.streaming && !message.text} streaming={!!message.streaming} />
      )}
      {piecesOf(message.text, message.moments ?? []).map((piece, i, all) =>
        piece.kind === "text" ? (
          <Suspense key={i} fallback={<div className="md md-plain">{piece.text}</div>}>
            <Markdown text={piece.text} streaming={message.streaming && i === all.length - 1} stackTables={stackTables} />
          </Suspense>
        ) : piece.moment.kind === "question" ? (
          <QuestionMoment key={i} moment={piece.moment} />
        ) : (
          <PlanMoment key={i} moment={piece.moment} live={!!message.streaming} />
        ),
      )}
      {asks.length > 0 && <AskLines asks={asks} onAnswer={onAnswer} />}
      {message.streaming && !asks.length && BUSY_PHASES.has(message.phase ?? "") && <Thinking phase={message.phase} detail={message.searchQuery} />}
      {message.files && message.files.length > 0 && <FileCards files={message.files} url={fileUrl} />}
      {!message.streaming && message.tools && message.tools.length > 0 && <ToolUses uses={message.tools} own={!!onAnswer} />}
      {!message.streaming && (message.sources?.length || message.searches?.length) ? (
        <SourcesFold sources={message.sources ?? []} found={message.found ?? []} searches={message.searches ?? []} />
      ) : null}
      {(message.note ?? message.notice) && <p className="msg-note">{message.note ?? message.notice}</p>}
      {failed && (
        <Advisory
          action={
            onRegenerate && (
              <button type="button" className="btn-ghost is-accent" onClick={onRegenerate} disabled={busy}>
                <Icon name="retry" size={16} />
                {t("Try again")}
              </button>
            )
          }
        >
          {message.error ?? t("No reply came back")}
        </Advisory>
      )}
      {message.status === "stopped" && <p className="msg-note">{t("Stopped")}</p>}
      {message.status === "truncated" && <p className="msg-note">{t("The reply reached its length limit")}</p>}
      {!message.streaming && (message.text || readOnly || switcher) && (
        <div className="msg-meta">
          {showModel && message.model && <span>{message.model}</span>}
          {readOnly && <span>{dateTime(message.createdAt)}</span>}
          {switcher}
          {message.text && (
            <button type="button" className="btn-ghost msg-action" onClick={copy} aria-label={copied ? t("Copied") : t("Copy reply")} title={copied ? t("Copied") : t("Copy")}>
              <Icon name={copied ? "check" : "copy"} size={14} className={copied ? "draw-in" : undefined} />
            </button>
          )}
          {onRegenerate && !failed && (
            <button type="button" className="btn-ghost msg-action" onClick={onRegenerate} disabled={busy} aria-label={t("Regenerate")} title={t("Regenerate")}>
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
  return s < 60 ? t("{s}s", { s }) : t("{floor}m {s}s", { floor: Math.floor(s / 60), s: s % 60 });
}

/**
 * Whether the person last chose to watch a reply think, kept in this browser. A reply still being
 * written when its fold appears again (they left the chat and came back to it) opens or stays
 * folded as they left it.
 */
const WATCH_KEY = "watchThinking";

function watching(): boolean {
  try {
    return localStorage.getItem(WATCH_KEY) === "1";
  } catch {
    return false;
  }
}

function watch(on: boolean) {
  try {
    if (on) localStorage.setItem(WATCH_KEY, "1");
    else localStorage.removeItem(WATCH_KEY);
  } catch {
    // Private windows can refuse storage; then a reply's thinking starts folded.
  }
}

/**
 * The model's thinking, folded above its reply: "Thinking" with moving dots while it thinks
 * (unfold to watch), then "Thought for 8s". Unfolds in place, in muted text.
 */
function ThinkingFold({ text, ms, live, streaming }: { text: string; ms: number | null; live: boolean; streaming: boolean }) {
  const [open, setOpen] = useState(() => streaming && watching());
  const scrollRef = useRef<HTMLDivElement>(null);
  const label = live ? t("Thinking") : ms == null ? t("Thought") : ms < 1500 ? t("Thought briefly") : t("Thought for {duration}", { duration: duration(ms) });
  // Long reasoning streams many tokens a second. Folded, nobody can see it, so it isn't rendered
  // until first opened, and while folded again it keeps the text it last showed.
  const [opened, setOpened] = useState(open);
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
          setOpen(!open);
          if (streaming) watch(!open);
        }}
      >
        {/* When thinking ends the mark folds away, so the words slide back instead of jumping. */}
        <span className="thought-mark" data-on={live || undefined} aria-hidden="true">
          <BusyMark label={null} size={13} />
        </span>
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
        <span className="thinking-detail">{detail ? t("Searching the web for “{detail}”", { detail }) : t("Searching the web")}</span>
      ) : phase === "tool" ? (
        <span className="thinking-detail">{detail || t("Using a tool")}</span>
      ) : phase === "coding" ? (
        t("Running code")
      ) : phase === "saving" ? (
        t("Saving the files it made")
      ) : phase === "uploading" ? (
        t("Sending your files")
      ) : phase === "thinking" ? (
        t("Thinking")
      ) : (
        t("Waiting for a reply")
      )}
    </p>
  );
}

const TOOL_ICONS: Record<ToolUse["kind"], IconName> = { memory: "note", knowledge: "book", page: "file", mcp: "plug" };

/**
 * The questions a reply is waiting on, each a line in the reply (never a pop-up). Before a tool
 * runs: what it wants to do, exactly what (the address, the note, the tool's input), why you're
 * asked, then Don't allow or Allow. A question of the AI's own offers its choices; a plan, its steps.
 */
function AskLines({ asks, onAnswer }: { asks: Ask[]; onAnswer?: (ask: Ask, answer: AskAnswer) => void }) {
  return (
    <div className="tool-asks">
      {asks.map((a) =>
        a.kind === "question" ? (
          <QuestionAsk key={a.id} ask={a} onAnswer={onAnswer && ((answer) => onAnswer(a, answer))} />
        ) : a.kind === "plan" ? (
          <PlanAsk key={a.id} ask={a} onAnswer={onAnswer && ((answer) => onAnswer(a, answer))} />
        ) : (
          <div key={a.id} className="tool-ask" role="group" aria-label={a.question}>
            <Icon name={TOOL_ICONS[a.kind as ToolUse["kind"]] ?? "plug"} size={16} />
            <div className="tool-ask-body">
              <p className="tool-ask-question">{a.question}</p>
              {a.detail && (a.kind === "memory" ? <p className="tool-ask-detail">{a.detail}</p> : <pre className="tool-ask-detail">{a.detail}</pre>)}
              <p className="tool-ask-reason">{a.reason}</p>
            </div>
            {onAnswer && (
              <span className="inline-confirm-actions">
                <button type="button" className="btn-secondary btn-sm" onClick={() => onAnswer(a, { allow: false })}>
                  {t("Don't allow")}
                </button>
                <button type="button" className="btn-tonal btn-sm" onClick={() => onAnswer(a, { allow: true })}>
                  {t("Allow")}
                </button>
              </span>
            )}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * A question the AI asks you mid-reply: its choices as plain rows with a tick, a line to write your
 * own answer instead, then Leave it to the AI or Answer.
 */
function QuestionAsk({ ask, onAnswer }: { ask: Ask; onAnswer?: (answer: AskAnswer) => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [own, setOwn] = useState("");
  const answer = own.trim() || picked;
  const send = () => answer && onAnswer?.({ allow: true, text: answer });
  return (
    <div className="tool-ask is-question" role="group" aria-label={ask.question}>
      <Icon name="question" size={16} />
      <div className="tool-ask-body">
        <p className="tool-ask-question">{ask.question}</p>
        <div className="oy-section is-plain ask-options" role="radiogroup" aria-label={ask.question}>
          {(ask.options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              className="oy-row option-row"
              role="radio"
              aria-checked={!own.trim() && picked === option}
              disabled={!onAnswer}
              onClick={() => {
                setPicked(option);
                setOwn("");
              }}
            >
              <span className="text">
                <OptionTitle label={option} />
              </span>
              <Tick on={!own.trim() && picked === option} />
            </button>
          ))}
        </div>
        {onAnswer && (
          <>
            <LineField
              id={`ask-own-${ask.id}`}
              label={t("Or write your own answer")}
              value={own}
              maxLength={2000}
              autoComplete="off"
              onChange={(e) => setOwn(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <span className="inline-confirm-actions ask-actions">
              <button type="button" className="btn-secondary btn-sm" onClick={() => onAnswer({ allow: false })}>
                {t("Leave it to the AI")}
              </button>
              <button type="button" className="btn-tonal btn-sm" disabled={!answer} onClick={send}>
                {t("Answer")}
              </button>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** The most steps a plan has, as the server keeps them. */
const MAX_STEPS = 10;

/**
 * A plan waiting for your OK: its steps, which you can edit in place, then Approve; or Send back,
 * which opens a line for what should change.
 */
function PlanAsk({ ask, onAnswer }: { ask: Ask; onAnswer?: (answer: AskAnswer) => void }) {
  const proposed = ask.steps ?? [];
  const [steps, setSteps] = useState<string[] | null>(null);
  const [returning, setReturning] = useState(false);
  const [comment, setComment] = useState("");
  const kept = (steps ?? proposed).map((s) => s.trim()).filter(Boolean);
  const edit = (i: number, value: string) => setSteps((list) => (list ?? proposed).map((s, j) => (j === i ? value : s)));
  return (
    <div className="tool-ask is-plan" role="group" aria-label={ask.question}>
      <Icon name="plan" size={16} />
      <div className="tool-ask-body">
        <p className="tool-ask-question">{ask.question}</p>
        {steps ? (
          <ol className="plan-edit">
            {steps.map((step, i) => (
              <li key={i}>
                <span className="plan-n tabular" aria-hidden="true">
                  {i + 1}
                </span>
                <LineField
                  id={`plan-${ask.id}-${i}`}
                  label={t("Step {n}", { n: i + 1 })}
                  value={step}
                  maxLength={300}
                  autoComplete="off"
                  onChange={(e) => edit(i, e.target.value)}
                />
                <button
                  type="button"
                  className="btn-ghost icon-button"
                  aria-label={t("Remove step {n}", { n: i + 1 })}
                  title={t("Remove")}
                  disabled={steps.length <= 1}
                  onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
            {steps.length < MAX_STEPS && (
              <li className="plan-add">
                <button type="button" className="btn-ghost" onClick={() => setSteps([...steps, ""])}>
                  <Icon name="plus" size={16} />
                  {t("Add a step")}
                </button>
              </li>
            )}
          </ol>
        ) : (
          <PlanSteps steps={proposed.map((text) => ({ text, status: "todo" }))} numbered />
        )}
        {onAnswer && returning && (
          <LineField
            id={`plan-comment-${ask.id}`}
            label={t("What should change?")}
            value={comment}
            maxLength={2000}
            autoComplete="off"
            autoFocus
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onAnswer({ allow: false, text: comment.trim() || undefined });
              }
            }}
          />
        )}
        {onAnswer && (
          <span className="inline-confirm-actions ask-actions">
            {returning ? (
              <>
                <button type="button" className="btn-secondary btn-sm" onClick={() => setReturning(false)}>
                  {t("Cancel")}
                </button>
                <button type="button" className="btn-tonal btn-sm" onClick={() => onAnswer({ allow: false, text: comment.trim() || undefined })}>
                  {t("Send back")}
                </button>
              </>
            ) : (
              <>
                {!steps && (
                  <button type="button" className="btn-ghost btn-sm plan-edit-start" onClick={() => setSteps(proposed)}>
                    <Icon name="pencil" size={14} />
                    {t("Edit steps")}
                  </button>
                )}
                <button type="button" className="btn-secondary btn-sm" onClick={() => setReturning(true)}>
                  {t("Send back")}
                </button>
                <button type="button" className="btn-tonal btn-sm" disabled={!kept.length} onClick={() => onAnswer({ allow: true, steps: kept })}>
                  {t("Approve")}
                </button>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/** A reply's text cut where its questions and plans came, so each sits in its place. */
type Piece = { kind: "text"; text: string } | { kind: "moment"; moment: Moment };
function piecesOf(text: string, moments: Moment[]): Piece[] {
  const pieces: Piece[] = [];
  let from = 0;
  for (const moment of [...moments].sort((a, b) => a.at - b.at)) {
    const at = Math.min(Math.max(moment.at, from), text.length);
    if (text.slice(from, at).trim()) pieces.push({ kind: "text", text: text.slice(from, at) });
    pieces.push({ kind: "moment", moment });
    from = at;
  }
  if (text.slice(from).trim()) pieces.push({ kind: "text", text: text.slice(from) });
  return pieces;
}

/** A question the AI asked, as it stays in the reply: the question, and what came of it. */
function QuestionMoment({ moment }: { moment: Extract<Moment, { kind: "question" }> }) {
  const outcome: Record<Moment["outcome"], string> = {
    answered: "",
    left: t("You left it to the AI"),
    returned: t("You left it to the AI"),
    unanswered: t("Not answered in time, so the AI decided"),
    stopped: t("Not answered before the reply stopped"),
    away: t("Nobody was there to answer, so the AI decided"),
  };
  return (
    <div className="moment" role="group" aria-label={moment.question}>
      <Icon name="question" size={16} />
      <div className="moment-body">
        <p className="moment-title">{moment.question}</p>
        {moment.outcome === "answered" && moment.answer ? (
          <p className="moment-answer">
            <Tick on size={16} />
            <span>{moment.own ? t("You wrote: {answer}", { answer: moment.answer }) : moment.answer}</span>
          </p>
        ) : (
          <p className="moment-note">{outcome[moment.outcome]}</p>
        )}
      </div>
    </div>
  );
}

/**
 * A plan as it stays in the reply: a checklist ticked as the AI carries it out (live while the
 * reply is written), or the steps it proposed and what came of them.
 */
function PlanMoment({ moment, live }: { moment: Extract<Moment, { kind: "plan" }>; live: boolean }) {
  const carried = moment.outcome === "answered" || moment.outcome === "away";
  const done = moment.steps.filter((s) => s.status === "done").length;
  const title: Record<Moment["outcome"], string> = {
    answered: moment.edited ? t("Plan you edited and approved") : t("Plan you approved"),
    away: t("Plan it followed on its own"),
    returned: t("Plan you sent back"),
    left: t("Plan you sent back"),
    unanswered: t("Plan not approved in time"),
    stopped: t("Plan not approved before the reply stopped"),
  };
  return (
    <div className={`moment plan${carried ? "" : " is-idle"}`} role="group" aria-label={title[moment.outcome]}>
      <Icon name="plan" size={16} />
      <div className="moment-body">
        <p className="moment-title">
          <span>{title[moment.outcome]}</span>
          {carried && <span className="plan-count tabular">{t("{done} of {total} done", { done, total: moment.steps.length })}</span>}
        </p>
        <PlanSteps steps={moment.steps} numbered={!carried} live={carried && live} />
        {moment.comment && <p className="moment-note">{t("You said: {comment}", { comment: moment.comment })}</p>}
      </div>
    </div>
  );
}

/** A plan's steps: numbered while it's only proposed, else each with its mark (done, skipped, still to do). */
function PlanSteps({ steps, numbered, live }: { steps: PlanStep[]; numbered?: boolean; live?: boolean }) {
  // While the reply carries the plan out, the first step still to do is the one under way.
  const current = live ? steps.findIndex((s) => s.status === "todo") : -1;
  return (
    <ol className={`plan-steps${numbered ? " is-numbered" : ""}`}>
      {steps.map((step, i) => (
        <li key={i} data-status={step.status}>
          <span className="plan-mark" aria-hidden="true">
            {numbered ? (
              <span className="plan-n tabular">{i + 1}</span>
            ) : i === current ? (
              <BusyMark label={null} size={13} />
            ) : step.status === "todo" ? (
              <svg viewBox="0 0 24 24" className="plan-todo">
                <path d="M12.1 5.6c-3.6-.1-6.5 2.8-6.4 6.5.1 3.5 2.9 6.3 6.5 6.2 3.5-.1 6.3-2.9 6.2-6.4-.1-3.5-2.8-6.3-6.3-6.3z" />
              </svg>
            ) : step.status === "skipped" ? (
              <svg viewBox="0 0 24 24" className="plan-skip">
                <path d="M7.2 12.2c3.2-.15 6.4-.1 9.6.05" />
              </svg>
            ) : live ? (
              // Ticked off just now: the tick draws itself in.
              <Icon name="check" size={16} className="text-accent draw-in" />
            ) : (
              <Tick on size={16} />
            )}
          </span>
          <span className="plan-text">
            <span className="visually-hidden">
              {step.status === "done" ? t("Done:") : step.status === "skipped" ? t("Skipped:") : t("To do:")}{" "}
            </span>
            <span className="plan-step">{step.text}</span>
            {step.reason && <span className="plan-reason">{t("Skipped: {reason}", { reason: step.reason })}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * What a reply did with the app's tools: a quiet line when it was one thing ("Remembered “…”"),
 * otherwise "Used 3 tools", unfolding to a line each. In your own chat, a tool that needed your
 * account on its server links to where you connect it.
 */
function ToolUses({ uses, own }: { uses: ToolUse[]; own: boolean }) {
  const [open, setOpen] = useState(false);
  const line = (u: ToolUse, i: number) => (
    <li key={i} className={u.error ? "is-error" : undefined}>
      <Icon name={TOOL_ICONS[u.kind] ?? "plug"} size={14} />
      <span>
        {u.text}
        {u.connect && own && (
          <>
            {". "}
            <SlideLink to="/settings/connections" direction="forward">
              {t("Connect it")}
            </SlideLink>
          </>
        )}
      </span>
    </li>
  );
  if (uses.length === 1) return <ul className="tool-uses">{uses.map(line)}</ul>;
  return (
    <div className="sources">
      <button type="button" className="thought-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{t("Used {length} tools", { length: uses.length })}</span>
        <Icon name="chevron-down" size={14} className={`chev${open ? " is-open" : ""}`} />
      </button>
      <div className="disclosure" data-open={open} inert={!open}>
        <div className="disclosure-inner">
          <ul className="tool-uses">{uses.map(line)}</ul>
        </div>
      </div>
    </div>
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
    ? tn(sources.length, "{length} source", "{length} sources", { length: sources.length })
    : searches.length > 1
      ? t("Searched the web {length} times", { length: searches.length })
      : t("Searched the web");
  return (
    <div className="sources">
      <button type="button" className="thought-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{label}</span>
        <Icon name="chevron-down" size={14} className={`chev${open ? " is-open" : ""}`} />
      </button>
      <div className="disclosure" data-open={open} inert={!open}>
        <div className="disclosure-inner">
          {searches.length > 0 && <p className="sources-searches">{t("Searched for {map}", { map: searches.map((q) => `“${q}”`).join(", ") })}</p>}
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
