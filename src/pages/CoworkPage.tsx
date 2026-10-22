// Cowork: jobs the model works through on its own on the server (server/cowork.ts). The Cowork
// page opens on one box to describe a job, with the recent jobs under it. A job's page is its
// work as it happens (what it writes, the tools it uses, the questions it waits on) beside its
// checklist, the files it made and what it works with; a box at the foot sends it a message.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { ComposerFiles, MessageFiles } from "../components/Attachments.tsx";
import { BusyButton } from "../components/BusyButton.tsx";
import { CheckList, Tick } from "../components/Controls.tsx";
import { DangerRow } from "../components/DangerRow.tsx";
import { Advisory, BusyMark, EmptyState, Spinner } from "../components/Feedback.tsx";
import { InlineModelPicker } from "../components/InlineModelPicker.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { Icon, type IconName } from "../icons/Icon.tsx";
import { api, ApiError, type Ask, type Attachment, type Choice, type KnowledgeBase, type ModelChoice } from "../lib/api.ts";
import { dateTime, formatCost, plural } from "../lib/format.ts";
import { LANG, t } from "../lib/i18n.ts";
import { useSession } from "../lib/session.tsx";
import { useSlideNavigate } from "../lib/slide.ts";
import { useUploads } from "../lib/uploads.ts";
import "../styles/tasks.css";
import "../styles/cowork.css";

// The Markdown renderer loads when a page first needs it, as in the chat.
const Markdown = lazy(() => import("../components/Markdown.tsx").then((m) => ({ default: m.Markdown })));

type Status = "queued" | "running" | "waiting" | "done" | "stopped" | "limit" | "failed" | "interrupted";
type Limit = "steps" | "time" | "spend" | "allowance";
type Limits = { steps: number; minutes: number; spend: number | null };
type ProgressItem = { text: string; status: "todo" | "doing" | "done" };
type Job = {
  id: string; title: string; goal: string; status: Status; limit: Limit | null; error: string | null;
  choice: Choice; modelLabel: string; limits: Limits;
  used: { steps: number; ms: number; spent: number };
  email: boolean; conversationId: string | null; createdAt: string; updatedAt: string; finishedAt: string | null;
  progress: ProgressItem[]; lastStep: string | null;
};
type Step = { id: number; kind: string; text: string; failed: boolean; at: string };
type JobFile = { id: string; name: string; mime: string; size: number };
type JobDetail = Job & {
  steps: Step[]; asks: Ask[]; files: JobFile[]; live: string; inbox: string[];
  context: { knowledge: { id: string; name: string }[]; attachments: Attachment[] };
};
type Models = { choices: ModelChoice[]; start: Choice | null };

const STEPS = [20, 50, 100];
const MINUTES = [15, 60, 240];
const SPEND: (number | null)[] = [0.5, 2, 10, null];
const fileUrl = (id: string) => `/api/files/${id}`;
const listText = (names: string[]) => names.join(LANG === "zh" ? "、" : ", ");

const working = (job: Job) => job.status === "queued" || job.status === "running" || job.status === "waiting";
const canCarryOn = (job: Job) => !working(job) && job.status !== "done" && !!job.conversationId;

function minutesText(minutes: number) {
  return minutes < 60 ? plural(minutes, "minute", "minutes") : plural(minutes / 60, "hour", "hours");
}

function statusText(job: Job) {
  switch (job.status) {
    case "queued": return t("Waiting to start");
    case "running": return t("Working");
    case "waiting": return t("Waiting for you");
    case "done": return t("Done");
    case "stopped": return t("Stopped");
    case "failed": return t("Didn't finish");
    case "interrupted": return t("Interrupted by a restart");
  }
  if (job.limit === "steps") return t("Stopped at its step limit");
  if (job.limit === "time") return t("Stopped at its time limit");
  if (job.limit === "spend") return t("Stopped at its spending cap");
  return t("Stopped at your monthly allowance");
}

/** What it has used of its limits, as sentences. */
function usedText(job: Job) {
  const minutes = Math.floor(job.used.ms / 60_000);
  const parts = [
    t("It has used {steps} of {max} steps and {minutes} of its {limit} of working time", {
      steps: job.used.steps, max: job.limits.steps, minutes: plural(minutes, "minute", "minutes"), limit: minutesText(job.limits.minutes),
    }),
    job.limits.spend == null
      ? t("It has spent {spent}, with no cap besides your monthly allowance", { spent: formatCost(job.used.spent) })
      : t("It has spent {spent} of its {cap} cap", { spent: formatCost(job.used.spent), cap: formatCost(job.limits.spend) }),
  ];
  return parts.join(LANG === "zh" ? "。" : ". ");
}

/** Refreshes while the page is in view: every second while a job works, now and then otherwise. */
function usePolling(load: () => Promise<void>, active: boolean, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, active ? 1000 : 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load, active, enabled]);
}

/** A box like the chat's: files at its top, then add, the words and send (or stop). */
function JobComposer({ value, onChange, onSend, placeholder, sending, canSend, onStop, uploads, rows = 1 }: {
  value: string; onChange: (value: string) => void; onSend: () => void; placeholder: string; sending: boolean; canSend: boolean;
  onStop?: () => void; uploads?: ReturnType<typeof useUploads>; rows?: number;
}) {
  const pickerRef = useRef<HTMLInputElement>(null);
  return <form className={`composer cowork-composer${rows > 1 ? " is-tall" : ""}`} onSubmit={(event) => { event.preventDefault(); if (canSend && !sending) onSend(); }}>
    {uploads && <ComposerFiles files={uploads.files} onRemove={uploads.remove} />}
    <div className="composer-row">
      {uploads && <>
        <button type="button" className="btn-ghost composer-add" onClick={() => pickerRef.current?.click()} aria-label={t("Add files or images")} title={t("Add files or images")}>
          <Icon name="plus" size={20} />
        </button>
        <input ref={pickerRef} type="file" multiple hidden onChange={(event) => { uploads.add([...(event.target.files ?? [])]); event.target.value = ""; }} />
      </>}
      <textarea rows={rows} value={value} placeholder={placeholder} aria-label={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter adds a line; never while an input method is composing.
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend && !sending) onSend();
          }
        }} />
      {onStop
        ? <button type="button" className="composer-send is-stop" onClick={onStop} aria-label={t("Stop")}><Icon name="stop" size={16} /></button>
        : <button type="submit" className="composer-send" disabled={!canSend || sending} aria-label={t("Send")}><Icon name="send" size={20} strokeWidth={2.1} /></button>}
    </div>
  </form>;
}

export function CoworkPage() {
  const slideTo = useSlideNavigate();
  const { refreshConversations } = useSession();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [models, setModels] = useState<Models | null>(null);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [knowledge, setKnowledge] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const uploads = useUploads();
  const mounted = useRef(true);
  const load = useCallback(async () => {
    try {
      const data = await api.get<{ jobs: Job[] }>("/cowork");
      if (mounted.current) { setJobs(data.jobs); setError(null); }
    } catch (err) { if (mounted.current) setError((err as Error).message); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    api.get<Models>("/models").then((m) => { setModels(m); setChoice((current) => current ?? m.start); }, (err) => setStartError((err as Error).message));
    api.get<{ knowledge: KnowledgeBase[] }>("/knowledge").then((r) => setBases(r.knowledge), () => {});
    return () => { mounted.current = false; };
  }, [load]);
  usePolling(load, !!jobs?.some(working));
  // A job's chat shows in the chat list once its first turn starts.
  const chats = jobs?.map((job) => job.conversationId ?? "").join("|");
  useEffect(() => { if (chats) void refreshConversations(); }, [chats, refreshConversations]);

  const model = models?.choices.find((m) => m.keyId === choice?.keyId && m.model === choice?.model);
  const validChoice = !!model?.efforts.some((e) => e.id === choice?.effort);
  const canStart = !!goal.trim() && validChoice && !uploads.uploading && !uploads.problem;
  const start = async () => {
    if (!canStart || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const job = await api.post<JobDetail>("/cowork", { goal: goal.trim(), choice, knowledgeIds: knowledge, attachments: uploads.ready.map((a) => a.id) });
      uploads.release(uploads.take());
      void refreshConversations();
      slideTo(`/cowork/${job.id}`, "forward");
    } catch (err) {
      setStartError((err as Error).message);
      setStarting(false);
    }
  };
  const picked = bases.filter((k) => knowledge.includes(k.id)).map((k) => k.name);

  return <div className="tasks-page cowork-page">
    <PageHeader title={t("Cowork")} subtitle={t("Give a model a job and it works through it on its own")} back={{ label: t("Chats"), to: "/chats", mobileOnly: true }} />
    <div className="oy-page-column page-body">
      <section className="cowork-start" aria-labelledby="cowork-start-heading">
        <h2 id="cowork-start-heading">{t("What should I work on?")}</h2>
        <JobComposer value={goal} onChange={setGoal} onSend={() => void start()} sending={starting} canSend={canStart} uploads={uploads} rows={3}
          placeholder={t("Describe the job and what the result should be")} />
        {uploads.problem && <Advisory>{uploads.problem}</Advisory>}
        <div className="cowork-start-options">
          {!models && !startError ? <Spinner label={t("Loading models")} />
            : <InlineModelPicker choices={models?.choices ?? []} value={choice} onChange={setChoice} disabled={starting} label={t("Model")} />}
          {bases.length > 0 && <details className="cowork-knowledge">
            <summary>{picked.length ? t("Knowledge: {names}", { names: listText(picked) }) : t("Add knowledge")}</summary>
            <CheckList label={t("Knowledge it can search")} values={knowledge} onChange={setKnowledge}
              options={bases.map((k) => ({ id: k.id, label: k.name, detail: plural(k.docs, "document", "documents") }))} />
          </details>}
        </div>
        {models && !validChoice && <Advisory>{t("No models are available for this job")}</Advisory>}
        {startError && <Advisory>{startError}</Advisory>}
        <p className="task-note cowork-start-note">{t("It works on the server and keeps going after you close this page. You can follow along, send it a message or stop it at any time")}</p>
      </section>

      <section className="cowork-recent" aria-labelledby="cowork-recent-heading">
        <h2 id="cowork-recent-heading">{t("Recent jobs")}</h2>
        {error && <Advisory action={<button type="button" className="task-text-action" onClick={() => void load()}>{t("Try again")}</button>}>{error}</Advisory>}
        {!jobs && !error ? <Spinner label={t("Loading jobs")} /> : jobs?.length === 0 ? <p className="task-note">{t("Your jobs will show here")}</p>
          : <ul className="cowork-list">
            {jobs?.map((job) => <li key={job.id}>
              <SlideLink to={`/cowork/${job.id}`} direction="forward" className="cowork-row">
                <span className="cowork-row-mark" aria-hidden="true">{working(job) ? <BusyMark label={null} size={16} /> : <Icon name={job.status === "done" ? "check" : "alert"} size={16} />}</span>
                <span className="cowork-row-text">
                  <span className="cowork-row-title">{job.title}</span>
                  <span className="cowork-row-desc">{working(job) && job.lastStep ? job.lastStep : statusText(job)}</span>
                </span>
                <span className="cowork-row-when">{dateTime(job.createdAt)}</span>
              </SlideLink>
            </li>)}
          </ul>}
      </section>
    </div>
  </div>;
}

/** The icon for a tool line in the job's work. */
function stepIcon(step: Step): IconName {
  if (step.kind === "end") return step.failed ? "alert" : "check";
  if (/knowledge|知识库/i.test(step.text)) return "book";
  if (/\bweb\b|网上|网页/i.test(step.text)) return "search";
  if (/\bcode\b|代码/i.test(step.text)) return "code";
  if (/^(Saved|已保存)/.test(step.text)) return "file";
  return "plug";
}

/** The job's work in order: its request, what it wrote, the tools it used, your messages and answers. */
function Stream({ job, onAnswer, busy }: { job: JobDetail; onAnswer: (ask: Ask, allow: boolean) => void; busy: boolean }) {
  const items: ReactNode[] = [];
  let tools: Step[] = [];
  const flush = () => {
    if (!tools.length) return;
    const group = tools;
    items.push(<ul className="cowork-tools" key={`tools-${group[0].id}`}>
      {group.map((step) => <li key={step.id} className={step.failed ? "is-failed" : undefined}>
        <Icon name={stepIcon(step)} size={14} />
        <span>{step.text}{step.failed && <span className="cowork-tool-note">{t("This didn't work, so it carried on without it")}</span>}</span>
      </li>)}
    </ul>);
    tools = [];
  };
  for (const step of job.steps) {
    if (step.kind === "tool") { tools.push(step); continue; }
    flush();
    if (step.kind === "message") items.push(<div className="msg-user cowork-message" key={step.id}><div className="bubble">{step.text}</div></div>);
    else if (step.kind === "reply") items.push(<div className="cowork-reply" key={step.id}><Markdown text={step.text} /></div>);
    else if (step.kind === "end") items.push(<p className={`cowork-line is-end${step.failed ? " is-failed" : ""}`} key={step.id}><Icon name={stepIcon(step)} size={14} />{step.text}</p>);
    else items.push(<p className={`cowork-line is-${step.kind}`} key={step.id}>{step.text}</p>);
  }
  flush();
  return <Suspense fallback={null}><div className="cowork-stream">
    <div className="msg-user cowork-message">
      <div className="bubble">{job.goal}</div>
      {job.context.attachments.length > 0 && <MessageFiles files={job.context.attachments} url={fileUrl} />}
    </div>
    {items}
    {job.live.trim() && <div className="cowork-reply is-live"><Markdown text={job.live} streaming /></div>}
    {job.asks.length > 0 && <div className="tool-asks cowork-asks">
      {job.asks.map((ask) => <div key={ask.id} className="tool-ask" role="group" aria-label={ask.question}>
        <Icon name={ask.kind === "page" ? "file" : "plug"} size={16} />
        <div className="tool-ask-body">
          <p className="tool-ask-question">{ask.question}</p>
          {ask.detail && <pre className="tool-ask-detail">{ask.detail}</pre>}
          <p className="tool-ask-reason">{ask.reason}</p>
        </div>
        <span className="inline-confirm-actions">
          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => onAnswer(ask, false)}>{t("Don't allow")}</button>
          <button type="button" className="btn-tonal btn-sm" disabled={busy} onClick={() => onAnswer(ask, true)}>{t("Allow")}</button>
        </span>
      </div>)}
    </div>}
    {working(job) && job.status !== "waiting" && <p className="cowork-working" role="status"><BusyMark label={null} size={14} />{job.status === "queued" ? t("Waiting to start") : t("Working")}</p>}
    {job.inbox.length > 0 && <p className="task-note cowork-inbox">{job.status === "waiting" ? t("It reads your message once you've answered the question above") : t("It reads your message after the step it's on")}</p>}
  </div></Suspense>;
}

/** One section of the side panel, which folds away on its heading. */
function PanelSection({ title, summary, open, children }: { title: string; summary?: string; open: boolean; children: ReactNode }) {
  return <details className="cowork-panel-section" open={open}>
    <summary><span className="cowork-panel-title">{title}</span>{summary && <span className="cowork-panel-summary">{summary}</span>}<Icon name="chevron-down" size={16} /></summary>
    <div className="cowork-panel-body">{children}</div>
  </details>;
}

/** A short list of choices in a row, the chosen one ticked. */
function Choices<K extends number | null>({ legend, name, value, onChange, options, disabled }: {
  legend: string; name: string; value: K; onChange: (value: K) => void; options: { id: K; label: string }[]; disabled?: boolean;
}) {
  return <fieldset className="task-choice-field" disabled={disabled}>
    <legend>{legend}</legend>
    <div className="task-choice-options">
      {options.map((option) => <label className="task-choice" key={String(option.id)}>
        <input type="radio" name={name} checked={value === option.id} onChange={() => onChange(option.id)} />
        <Tick on={value === option.id} size={16} /><span>{option.label}</span>
      </label>)}
    </div>
  </fieldset>;
}

/** Wide enough for the panel beside the work; on narrower screens it sits above, folded but for the checklist. */
function useWide() {
  const query = "(min-width: 1100px)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = () => setWide(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return wide;
}

export function CoworkJobPage() {
  const { id = "" } = useParams();
  const slideTo = useSlideNavigate();
  const { refreshConversations } = useSession();
  const wide = useWide();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [mail, setMail] = useState<{ available: boolean } | null>(null);
  const shown = useRef(id);
  useEffect(() => { void api.get<{ available: boolean }>("/tasks/email").then(setMail, () => {}); }, []);
  const load = useCallback(async () => {
    try {
      const data = await api.get<JobDetail>(`/cowork/${id}`);
      if (shown.current !== id) return;
      setJob(data); setLoadError(null); setMissing(false);
    } catch (err) {
      if (shown.current !== id) return;
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setLoadError((err as Error).message);
    }
  }, [id]);
  useEffect(() => { shown.current = id; setJob(null); setMissing(false); void load(); }, [id, load]);
  usePolling(load, !!job && working(job), !missing);
  useEffect(() => { if (job?.conversationId) void refreshConversations(); }, [job?.conversationId, job?.status, refreshConversations]);

  // New work keeps the page at its foot, unless the person has scrolled up to read.
  const size = job ? `${job.steps.length}:${job.live.length}:${job.asks.length}:${job.inbox.length}` : "";
  const atFoot = useRef(true);
  useEffect(() => {
    const track = () => { atFoot.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160; };
    window.addEventListener("scroll", track, { passive: true });
    return () => window.removeEventListener("scroll", track);
  }, []);
  useLayoutEffect(() => { if (size && atFoot.current) window.scrollTo({ top: document.documentElement.scrollHeight }); }, [size]);

  const act = async (name: string, run: () => Promise<unknown>) => {
    if (busy) return false;
    setBusy(name);
    setError(null);
    try {
      await run();
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally { setBusy(null); }
  };
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await act("send", () => api.post(`/cowork/${id}/messages`, { text }))) setDraft("");
  };
  const setLimits = (limits: Limits) => void act("limits", () => api.patch(`/cowork/${id}`, { limits }));
  const remove = async () => {
    try { await api.del(`/cowork/${id}`); slideTo("/cowork", "back", { replace: true }); }
    catch (err) { setError((err as Error).message); }
  };

  const done = job?.progress.filter((item) => item.status === "done").length ?? 0;
  return <div className="tasks-page cowork-page cowork-job">
    <PageHeader title={job?.title ?? t("Job")} back={{ label: t("Cowork"), to: "/cowork" }}
      subtitle={job ? <span className="cowork-status" role="status">{working(job) && <BusyMark label={null} size={14} />}{statusText(job)}</span> : undefined}
      trailing={job?.conversationId ? <SlideLink to={`/chat/${job.conversationId}`} direction="forward" className="task-text-action task-answer-link">{t("Open the chat")}</SlideLink> : undefined} />
    {loadError && <div className="oy-page-column"><Advisory action={<button type="button" className="task-text-action" onClick={() => void load()}>{t("Try again")}</button>}>{loadError}</Advisory></div>}
    {missing ? <div className="oy-page-column"><EmptyState title={t("This job isn't here")}>{t("It may have been deleted")}</EmptyState></div>
      : !job ? (!loadError && <div className="oy-page-column"><Spinner label={t("Loading the job")} /></div>) : <>
        <div className="cowork-layout">
          <aside className="cowork-panel" aria-label={t("About this job")}>
            <PanelSection title={t("Progress")} open summary={job.progress.length ? t("{done} of {count} done", { done, count: job.progress.length }) : undefined}>
              {job.progress.length
                ? <ol className="cowork-progress">{job.progress.map((item, index) => <li key={index} className={`is-${item.status}`}>
                  <span className="cowork-progress-mark" aria-hidden="true">{item.status === "done" ? <Tick on size={16} /> : item.status === "doing" && working(job) ? <BusyMark label={null} size={14} /> : <span className="cowork-dot" />}</span>
                  <span>{item.text}</span>
                </li>)}</ol>
                : <p className="task-note">{working(job) ? t("Its plan shows here once it has made one") : t("It didn't make a plan for this job")}</p>}
            </PanelSection>
            <PanelSection title={t("Output")} open={wide} summary={job.files.length ? plural(job.files.length, "file", "files") : undefined}>
              {job.files.length
                ? <MessageFiles files={job.files.map((f) => ({ ...f, kind: "other" as const }))} url={fileUrl} />
                : <p className="task-note">{t("Files it makes show here")}</p>}
              {job.conversationId && <SlideLink to={`/chat/${job.conversationId}`} direction="forward" className="task-text-action task-answer-link">{job.status === "done" ? t("Open the result") : t("Open the chat")}</SlideLink>}
            </PanelSection>
            <PanelSection title={t("Context")} open={wide}>
              <dl className="cowork-context">
                <dt>{t("Model")}</dt><dd>{job.modelLabel}</dd>
                {job.context.knowledge.length > 0 && <><dt>{t("Knowledge")}</dt><dd>{listText(job.context.knowledge.map((k) => k.name))}</dd></>}
                {job.context.attachments.length > 0 && <><dt>{t("Your files")}</dt><dd>{listText(job.context.attachments.map((a) => a.name))}</dd></>}
                <dt>{t("Started")}</dt><dd>{dateTime(job.createdAt)}</dd>
              </dl>
              <p className="task-note cowork-used">{usedText(job)}</p>
              <details className="cowork-limits">
                <summary>{t("Change its limits")}</summary>
                <div>
                  <Choices legend={t("Steps")} name="job-steps" value={job.limits.steps} disabled={!!busy} onChange={(steps) => setLimits({ ...job.limits, steps })}
                    options={STEPS.map((n) => ({ id: n, label: plural(n, "step", "steps") }))} />
                  <Choices legend={t("Working time")} name="job-minutes" value={job.limits.minutes} disabled={!!busy} onChange={(minutes) => setLimits({ ...job.limits, minutes })}
                    options={MINUTES.map((n) => ({ id: n, label: minutesText(n) }))} />
                  <Choices legend={t("Spending cap")} name="job-spend" value={job.limits.spend} disabled={!!busy} onChange={(spend) => setLimits({ ...job.limits, spend })}
                    options={SPEND.map((n) => ({ id: n, label: n == null ? t("No cap") : formatCost(n) }))} />
                  <p className="task-note">{t("It stops at whichever comes first and writes up what it has")}</p>
                </div>
              </details>
              {/* A job that already emails keeps showing the option, so it can be turned off. */}
              {(mail?.available || job.email) && <label className="task-choice task-email">
                <input type="checkbox" checked={job.email} disabled={!!busy} onChange={() => void act("email", () => api.patch(`/cowork/${id}`, { email: !job.email }))} />
                <Tick on={job.email} size={16} /><span>{t("Email me when it finishes or needs my OK")}</span>
              </label>}
              {!working(job) && <div className="task-danger"><DangerRow label={t("Delete this job")} confirmLabel={t("Delete this job? Its chat will stay")} onConfirm={remove} /></div>}
            </PanelSection>
          </aside>
          <div className="cowork-main">
            <Stream job={job} busy={!!busy} onAnswer={(ask, allow) => void act(ask.id, () => api.post(`/cowork/${id}/asks/${ask.id}`, { allow }))} />
            {canCarryOn(job) && <div className="cowork-carry-on">
              <BusyButton type="button" className="task-run-action" busy={busy === "continue"} onClick={() => void act("continue", () => api.post(`/cowork/${id}/continue`))}>{t("Carry on")}</BusyButton>
              <p className="task-note">{t("Or write below what it should do next. Its limits count again from here")}</p>
            </div>}
          </div>
        </div>
        <div className="composer-dock cowork-dock">
          <div className="cowork-dock-inner">
            {error && <Advisory>{error}</Advisory>}
            <JobComposer value={draft} onChange={setDraft} onSend={() => void send()} sending={busy === "send"} canSend={!!draft.trim()}
              onStop={working(job) && !draft.trim() ? () => void act("stop", () => api.post(`/cowork/${id}/stop`)) : undefined}
              placeholder={working(job) ? t("Send it a message as it works") : job.status === "done" ? t("Ask for changes or more") : t("Tell it what to do next")} />
          </div>
        </div>
      </>}
  </div>;
}
