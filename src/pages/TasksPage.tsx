import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { BusyButton } from "../components/BusyButton.tsx";
import { Tick } from "../components/Controls.tsx";
import { DangerRow } from "../components/DangerRow.tsx";
import { Advisory, EmptyState, Spinner } from "../components/Feedback.tsx";
import { InlineModelPicker } from "../components/InlineModelPicker.tsx";
import { LineArea, LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { api, ApiError, type Choice, type ModelChoice, type ScheduledTask, type TaskDetail, type TaskRun, type TaskSchedule } from "../lib/api.ts";
import { andText, LOCALE, t } from "../lib/i18n.ts";
import { useSession } from "../lib/session.tsx";
import { useSlideNavigate } from "../lib/slide.ts";
import "../styles/tasks.css";

type Models = { choices: ModelChoice[]; start: Choice | null };
type Draft = { name: string; prompt: string; choice: Choice | null; schedule: TaskSchedule; email: boolean };
const pickId = (choice: Pick<Choice, "keyId" | "model">) => JSON.stringify([choice.keyId, choice.model]);
const modelFor = (models: Models, choice: Choice | null) => choice ? models.choices.find((model) => pickId(model) === pickId(choice)) : undefined;
const available = (models: Models, choice: Choice | null) => !!choice && !!modelFor(models, choice)?.efforts.some((effort) => effort.id === choice.effort);
const running = (task: ScheduledTask) => task.lastRun?.status === "running";
function completedOnce(task: ScheduledTask) {
  if (task.schedule.kind !== "once" || task.enabled || task.nextRunAt || !task.schedule.date) return false;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: task.schedule.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
    const now = `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
    return `${task.schedule.date}T${task.schedule.time}` <= now;
  } catch { return false; }
}
const weekdays = () => [
  { id: "1", label: t("Monday") }, { id: "2", label: t("Tuesday") }, { id: "3", label: t("Wednesday") },
  { id: "4", label: t("Thursday") }, { id: "5", label: t("Friday") }, { id: "6", label: t("Saturday") }, { id: "0", label: t("Sunday") },
];

function initialSchedule(): TaskSchedule {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    kind: "once", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`, days: [date.getDay()],
  };
}

function scheduleBody(schedule: TaskSchedule): TaskSchedule {
  return {
    kind: schedule.kind, timeZone: schedule.timeZone.trim(), time: schedule.time,
    ...(schedule.kind === "once" ? { date: schedule.date } : {}),
    ...(schedule.kind === "weekly" ? { days: [...(schedule.days ?? [])].sort((a, b) => a - b) } : {}),
  };
}

function zonedDate(iso: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat(LOCALE, { timeZone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch { return iso; }
}

function scheduleText(schedule: TaskSchedule) {
  if (schedule.kind === "daily") return t("Every day at {time}", { time: schedule.time });
  if (schedule.kind === "weekly") {
    const days = weekdays().filter((day) => schedule.days?.includes(Number(day.id))).map((day) => day.label);
    return t("Every {days} at {time}", { days: andText(days), time: schedule.time });
  }
  return t("Once on {date} at {time}", { date: schedule.date ?? "", time: schedule.time });
}

function runText(run: TaskRun) {
  if (run.status === "running") return t("Running");
  if (run.status === "succeeded") return t("Finished");
  if (run.status === "failed") return t("Failed");
  if (run.status === "stopped") return t("Stopped");
  return t("Interrupted");
}

function taskText(task: ScheduledTask) {
  if (running(task)) return task.enabled || task.schedule.kind === "once" ? t("Running") : t("Running with future runs paused");
  if (completedOnce(task)) return t("Schedule finished");
  return task.enabled ? t("Scheduled") : t("Paused");
}

/** Polling refreshes saved state while the form keeps its separate draft untouched */
function useTaskPolling(load: () => Promise<void>, active: boolean, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, active ? 1500 : 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load, active, enabled]);
}

function useModels() {
  const [models, setModels] = useState<Models>({ choices: [], start: null });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    let sequence = 0;
    const load = async () => {
      const request = ++sequence;
      try {
        const saved = await api.get<Models>("/models");
        if (mounted && request === sequence) { setModels(saved); setReady(true); setError(null); }
      } catch (err) {
        if (mounted && request === sequence) { setError((err as Error).message); setReady(true); }
      }
    };
    void load();
    const onShow = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", onShow);
    document.addEventListener("visibilitychange", onShow);
    return () => { mounted = false; window.removeEventListener("focus", onShow); document.removeEventListener("visibilitychange", onShow); };
  }, []);
  return { models, ready, error };
}

function TaskActions({ task, refresh, allowRun = true }: { task: ScheduledTask; refresh: () => Promise<void>; allowRun?: boolean }) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const pending = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const { refreshConversations } = useSession();
  const perform = async (action: "toggle" | "run" | "stop") => {
    if (pending.current.has(action)) return;
    pending.current.add(action);
    setBusy((current) => ({ ...current, [action]: true }));
    setError(null);
    try {
      if (action === "toggle") await api.patch<TaskDetail>(`/tasks/${task.id}`, { enabled: !task.enabled });
      else await api.post(`/tasks/${task.id}/${action}`);
      await refresh();
      void refreshConversations();
    } catch (err) { setError((err as Error).message); }
    finally { pending.current.delete(action); setBusy((current) => ({ ...current, [action]: false })); }
  };
  return <div className="task-action-block">
    <div className="task-actions">
      {running(task)
        ? <BusyButton type="button" className="task-run-action" busy={busy.stop} onClick={() => void perform("stop")}>{t("Stop this run")}</BusyButton>
        : <BusyButton type="button" className="task-run-action" busy={busy.run} disabled={!allowRun} onClick={() => void perform("run")}>{t("Run now")}</BusyButton>}
      {!completedOnce(task) && <BusyButton type="button" className="task-text-action" busy={busy.toggle} onClick={() => void perform("toggle")}>{task.enabled ? t("Pause schedule") : t("Resume schedule")}</BusyButton>}
    </div>
    {error && <Advisory>{error}</Advisory>}
  </div>;
}

export function TasksPage() {
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const { refreshConversations } = useSession();
  const { models, ready: modelsReady, error: modelsError } = useModels();
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const data = await api.get<{ tasks: ScheduledTask[] }>("/tasks");
      if (mountedRef.current && request === requestRef.current) { setTasks(data.tasks); setError(null); }
    } catch (err) { if (mountedRef.current && request === requestRef.current) setError((err as Error).message); }
  }, []);
  useEffect(() => { mountedRef.current = true; void load(); return () => { mountedRef.current = false; }; }, [load]);
  useTaskPolling(load, !!tasks?.some(running));
  const runChanges = tasks?.map((task) => `${task.lastRun?.id}:${task.lastRun?.status}:${task.lastRun?.conversationId}`).join("|");
  useEffect(() => { if (runChanges) void refreshConversations(); }, [runChanges, refreshConversations]);
  return <div className="tasks-page">
    <PageHeader title={t("Scheduled tasks")} subtitle={t("Run a prompt later and keep the answer in a chat")}
      back={{ label: t("Chats"), to: "/chats", mobileOnly: true }}
      trailing={<SlideLink to="/tasks/new" direction="forward" className="btn-primary">{t("New task")}</SlideLink>} />
    <div className="oy-page-column page-body">
      {error && <Advisory action={<button type="button" className="task-text-action" onClick={() => void load()}>{t("Try again")}</button>}>{error}</Advisory>}
      {modelsError && <Advisory>{modelsError}</Advisory>}
      {!tasks && !error ? <Spinner label={t("Loading tasks")} /> : tasks?.length === 0 ? <EmptyState title={t("No scheduled tasks yet")}>{t("Choose a prompt, a model and a time to get started")}</EmptyState> : <div className="scheduled-task-list">
        {!!tasks?.length && <div className="scheduled-task-head" aria-hidden="true"><span>{t("Task")}</span><span>{t("Status and results")}</span><span>{t("Actions")}</span></div>}
        {tasks?.map((task) => <section className="scheduled-task-row" key={task.id} aria-label={task.name}>
          <div className="scheduled-task-main">
            <h2><SlideLink to={`/tasks/${task.id}`} direction="forward" className="task-title-link">{task.name}</SlideLink></h2>
            <div className="task-schedule-summary"><p>{scheduleText(task.schedule)}</p><p className="task-note">{task.schedule.timeZone}</p></div>
            <p className="task-note task-model-name">{task.modelLabel}</p>
            {modelsReady && !modelsError && !available(models, task.choice) && <p className="task-unavailable">{t("The saved model or thinking level is unavailable")}</p>}
          </div>
          <div className="scheduled-task-status">
            <p className="task-state" role="status">{taskText(task)}</p>
            {task.enabled && task.nextRunAt && <p className="task-note">{t("Next run: {time}", { time: zonedDate(task.nextRunAt, task.schedule.timeZone) })}</p>}
            {task.lastRun && <div className="task-last-run"><p className="task-note">{t("Last run: {status}", { status: runText(task.lastRun) })}</p>
              {task.lastRun.conversationId && <SlideLink to={`/chat/${task.lastRun.conversationId}`} direction="forward" className="task-text-action task-answer-link">{running(task) ? t("View running chat") : t("View answer")}</SlideLink>}
            </div>}
          </div>
          <TaskActions task={task} refresh={load} allowRun={modelsReady && !modelsError && available(models, task.choice)} />
        </section>)}
      </div>}
    </div>
  </div>;
}

export function TaskFormPage() {
  const { id = "new" } = useParams();
  const adding = id === "new";
  const slideTo = useSlideNavigate();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [draft, setDraft] = useState<Draft>(() => ({ name: "", prompt: "", choice: null, schedule: initialSchedule(), email: false }));
  const [loaded, setLoaded] = useState(adding);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const shownIdRef = useRef(id);
  const filledRef = useRef<string | null>(null);
  const requestsRef = useRef(0);
  const saveRevisionRef = useRef(0);
  const { models, ready: modelsReady, error: modelsError } = useModels();
  const { refreshConversations } = useSession();
  const [mail, setMail] = useState<{ available: boolean; address: string } | null>(null);
  useEffect(() => { void api.get<{ available: boolean; address: string }>("/tasks/email").then(setMail, () => {}); }, []);
  const fill = (data: TaskDetail) => setDraft({ name: data.name, prompt: data.prompt, choice: data.choice, schedule: { ...data.schedule }, email: data.email });
  const load = useCallback(async () => {
    if (id === "new") return;
    const request = ++requestsRef.current;
    const revision = saveRevisionRef.current;
    try {
      const data = await api.get<TaskDetail>(`/tasks/${id}`);
      if (!mountedRef.current || shownIdRef.current !== id || request !== requestsRef.current || revision !== saveRevisionRef.current) return;
      setTask(data); setLoadError(null); setMissing(false);
      if (filledRef.current !== id) { fill(data); filledRef.current = id; }
    } catch (err) {
      if (!mountedRef.current || shownIdRef.current !== id || request !== requestsRef.current) return;
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setLoadError((err as Error).message);
    } finally { if (mountedRef.current && shownIdRef.current === id) setLoaded(true); }
  }, [id]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => {
    shownIdRef.current = id; filledRef.current = null; requestsRef.current++;
    setTask(null); setError(null); setLoadError(null); setMissing(false); setSavedNote(false); setLoaded(adding);
    if (adding) setDraft({ name: "", prompt: "", choice: null, schedule: initialSchedule(), email: false });
    else void load();
  }, [id, adding, load]);
  useEffect(() => {
    if (adding && modelsReady && models.start) setDraft((current) => current.choice ? current : { ...current, choice: models.start });
  }, [adding, modelsReady, models.start]);
  useTaskPolling(load, !!task && running(task), !adding && !missing);
  useEffect(() => { if (task?.lastRun) void refreshConversations(); }, [task?.lastRun?.id, task?.lastRun?.status, task?.lastRun?.conversationId, refreshConversations]);

  const setField = <K extends keyof Draft>(field: K, value: Draft[K]) => { setDraft((current) => ({ ...current, [field]: value })); setSavedNote(false); };
  const setSchedule = (patch: Partial<TaskSchedule>) => { setDraft((current) => ({ ...current, schedule: { ...current.schedule, ...patch } })); setSavedNote(false); };
  const validChoice = !modelsError && available(models, draft.choice);
  let validZone = false;
  try { new Intl.DateTimeFormat("en", { timeZone: draft.schedule.timeZone.trim() }).format(); validZone = !!draft.schedule.timeZone.trim(); } catch { /* The field explains invalid zones */ }
  const validSchedule = validZone && /^\d{2}:\d{2}$/.test(draft.schedule.time)
    && (draft.schedule.kind !== "once" || !!draft.schedule.date) && (draft.schedule.kind !== "weekly" || !!draft.schedule.days?.length);
  const body = { name: draft.name.trim(), prompt: draft.prompt.trim(), choice: draft.choice, schedule: scheduleBody(draft.schedule), email: draft.email };
  const dirty = !task || JSON.stringify(body) !== JSON.stringify({ name: task.name, prompt: task.prompt, choice: task.choice, schedule: scheduleBody(task.schedule), email: task.email });
  const canSave = loaded && !!body.name && !!body.prompt && validChoice && validSchedule && dirty && (!task || !running(task));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || savingRef.current) return;
    savingRef.current = true; saveRevisionRef.current++;
    setSaving(true); setError(null); setSavedNote(false);
    try {
      const data = adding ? await api.post<TaskDetail>("/tasks", body) : await api.put<TaskDetail>(`/tasks/${id}`, body);
      if (!mountedRef.current || shownIdRef.current !== id) return;
      if (adding) slideTo(`/tasks/${data.id}`, "forward", { replace: true });
      else { setTask(data); fill(data); setSavedNote(true); }
    } catch (err) { if (mountedRef.current && shownIdRef.current === id) setError((err as Error).message); }
    finally { saveRevisionRef.current++; savingRef.current = false; if (mountedRef.current) setSaving(false); }
  };
  const remove = async () => {
    try { await api.del(`/tasks/${id}`); slideTo("/tasks", "back", { replace: true }); }
    catch (err) { setError((err as Error).message); }
  };
  return <div className="tasks-page">
    <PageHeader title={adding ? t("New scheduled task") : task?.name ?? t("Scheduled task")} back={{ label: t("Scheduled tasks"), to: "/tasks" }} />
    <div className="oy-page-column page-body">
      {loadError && <Advisory action={<button type="button" className="task-text-action" onClick={() => void load()}>{t("Try again")}</button>}>{loadError}</Advisory>}
      {!loaded ? <Spinner label={t("Loading the task")} /> : missing ? <EmptyState title={t("This task isn't here")}>{t("It may have been deleted")}</EmptyState> : !adding && !task ? null : <>
        {task && <section className="task-live" aria-label={t("Schedule controls")}>
          <div className="task-live-summary">
            <p className="task-state" role="status">{taskText(task)}</p>
            {task.enabled && task.nextRunAt && <p>{t("Next run: {time}", { time: zonedDate(task.nextRunAt, task.schedule.timeZone) })}</p>}
            <p className="task-note">{task.schedule.timeZone}</p>
            {completedOnce(task) && <p className="task-note">{t("Choose a new date to schedule another run")}</p>}
          </div>
          <TaskActions task={task} refresh={load} allowRun={!dirty && modelsReady && !modelsError && available(models, task.choice)} />
          {dirty && <p className="task-note task-live-notice">{t("Save your changes before running this task")}</p>}
        </section>}

        <form className="task-form" onSubmit={save}>
          <fieldset className="task-form-fields" disabled={saving}>
            <section className="task-form-section" aria-labelledby="task-content-heading">
              <div className="task-section-label"><h2 id="task-content-heading">{t("Task")}</h2><p>{t("Each run starts a new chat with this prompt")}</p></div>
              <div className="task-section-fields">
                <LineField id="task-name" label={t("Name")} value={draft.name} maxLength={120} required autoComplete="off" onChange={(event) => setField("name", event.target.value)} />
                <div className="task-prompt-field"><LineArea id="task-prompt" label={t("Prompt to run")} value={draft.prompt} maxLength={50000} required onChange={(event) => setField("prompt", event.target.value)} /></div>
              </div>
            </section>

            <section className="task-form-section" aria-labelledby="task-model-heading">
              <div className="task-section-label"><h2 id="task-model-heading">{t("Model")}</h2></div>
              <div className="task-section-fields">
                {!modelsReady ? <Spinner label={t("Loading models")} /> : <InlineModelPicker choices={models.choices} value={draft.choice} onChange={(choice) => setField("choice", choice)} disabled={saving} label={t("Model")} />}
                {modelsError && <Advisory>{modelsError}</Advisory>}
                {modelsReady && !modelsError && !validChoice && <Advisory>{draft.choice ? t("The saved model or thinking level is unavailable, so choose an available one") : t("No models are available for this task")}</Advisory>}
              </div>
            </section>

            <section className="task-form-section" aria-labelledby="task-schedule-heading">
              <div className="task-section-label"><h2 id="task-schedule-heading">{t("Schedule")}</h2><p>{t("Times follow the selected time zone")}</p></div>
              <div className="task-section-fields">
                <fieldset className="task-choice-field">
                  <legend>{t("Repeat")}</legend>
                  <div className="task-choice-options">
                    {([{ id: "once", label: t("Once") }, { id: "daily", label: t("Every day") }, { id: "weekly", label: t("Every week") }] as const).map((option) => <label className="task-choice" key={option.id}>
                      <input type="radio" name="task-repeat" value={option.id} checked={draft.schedule.kind === option.id} onChange={() => setSchedule({ kind: option.id })} />
                      <Tick on={draft.schedule.kind === option.id} size={16} /><span>{option.label}</span>
                    </label>)}
                  </div>
                </fieldset>
                {draft.schedule.kind === "weekly" && <fieldset className="task-choice-field task-weekdays">
                  <legend>{t("Days of the week")}</legend>
                  <div className="task-choice-options">{weekdays().map((day) => {
                    const number = Number(day.id);
                    const checked = draft.schedule.days?.includes(number) ?? false;
                    return <label className="task-choice" key={day.id}>
                      <input type="checkbox" checked={checked} onChange={() => setSchedule({ days: checked ? draft.schedule.days?.filter((value) => value !== number) : [...(draft.schedule.days ?? []), number] })} />
                      <Tick on={checked} size={16} /><span>{day.label}</span>
                    </label>;
                  })}</div>
                  {!draft.schedule.days?.length && <Advisory>{t("Choose at least one day")}</Advisory>}
                </fieldset>}
                <div className="task-date-fields">
                  {draft.schedule.kind === "once" && <LineField id="task-date" type="date" label={t("Date")} value={draft.schedule.date ?? ""} required onChange={(event) => setSchedule({ date: event.target.value })} />}
                  <LineField id="task-time" type="time" step={60} label={t("Time")} value={draft.schedule.time} required onChange={(event) => setSchedule({ time: event.target.value })} />
                </div>
                <LineField id="task-time-zone" label={t("Time zone")} value={draft.schedule.timeZone} required autoComplete="off" spellCheck={false} onChange={(event) => setSchedule({ timeZone: event.target.value })}
                  hint={t("Use an IANA time zone, such as Asia/Singapore")} error={!validZone ? t("Enter a valid time zone") : null} />
              </div>
            </section>

            {/* A task that already emails keeps showing the option, so it can be turned off. */}
            {mail && (mail.available || draft.email) && <section className="task-form-section" aria-labelledby="task-email-heading">
              <div className="task-section-label"><h2 id="task-email-heading">{t("Email updates")}</h2><p>{t("Sent to {address}", { address: mail.address })}</p></div>
              <div className="task-section-fields">
                <label className="task-choice task-email">
                  <input type="checkbox" checked={draft.email} onChange={() => setField("email", !draft.email)} />
                  <Tick on={draft.email} size={16} /><span>{t("Email me the answer after each scheduled run")}</span>
                </label>
                {!mail.available && <Advisory>{t("This site can't send email right now, so nothing will be sent")}</Advisory>}
              </div>
            </section>}
          </fieldset>
          <div className="task-form-footer">
            <div className="task-save-row">
              <div className="task-save-copy">
                <p>{t("Scheduled runs use your allowance and run while the server is online")}</p>
                {adding && <p>{t("Creating this task enables its schedule")}</p>}
                {task && running(task) && <p>{t("Stop the current run or wait for it to finish before saving changes")}</p>}
              </div>
              <BusyButton type="submit" className="btn-primary" busy={saving} disabled={!canSave}>{adding ? t("Create and enable") : t("Save changes")}</BusyButton>
            </div>
            {error && <Advisory>{error}</Advisory>}
            {savedNote && <p className="task-saved" role="status">{t("Saved")}</p>}
            <details className="task-explanation">
              <summary>{t("How scheduled runs work")}</summary>
              <div><p>{t("Run now uses the saved prompt without changing the schedule")}</p><p>{t("After downtime, at most one missed run is caught up")}</p><p>{t("Scheduled runs do not approve tools, write memories or use connected service tools")}</p></div>
            </details>
          </div>
        </form>

        {task && <section className="task-history" aria-labelledby="task-history-heading">
          <div className="task-history-heading"><h2 id="task-history-heading">{t("Run history")}</h2><p className="task-note">{task.schedule.timeZone}</p></div>
          {!task.runs.length ? <p className="task-note">{t("This task has not run yet")}</p> : task.runs.map((run) => <article className="task-run" key={run.id}>
            <div><time dateTime={run.startedAt}>{zonedDate(run.startedAt, task.schedule.timeZone)}</time><p className="task-note">{run.trigger === "manual" ? t("Run manually") : t("Scheduled run")}</p></div>
            <p className="task-run-status" role="status">{runText(run)}</p>
            <div className="task-run-result">{run.conversationId && <SlideLink to={`/chat/${run.conversationId}`} direction="forward" className="task-text-action task-answer-link">{run.status === "running" ? t("View running chat") : t("View answer")}</SlideLink>}</div>
            {run.error && <p className="task-run-error">{run.error}</p>}
          </article>)}
        </section>}
        {task && !running(task) && !saving && <div className="task-danger"><DangerRow label={t("Delete this task")} confirmLabel={t("Delete this task? Its existing chats will stay")} onConfirm={remove} /></div>}
      </>}
    </div>
  </div>;
}
