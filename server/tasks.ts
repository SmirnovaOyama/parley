// A task claims its next occurrence before calling a provider, so a restart never repeats a billed call.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { requireUser, type AppEnv, type SessionUser } from "./auth.ts";
import { tx } from "./chat-store.ts";
import { exactChoice } from "./comparisons.ts";
import { db, nowIso } from "./db.ts";
import { env } from "./env.ts";
import { inLang, lang, t, type Lang } from "./i18n.ts";
import { keyModelLabel } from "./keys.ts";
import { mailMode, sendMail } from "./mail.ts";
import { chatCapacityAvailable, ChatStartError, prepareChat } from "./routes/chat.ts";
import { cleanSchedule, nextOccurrence, type TaskSchedule } from "./schedule-time.ts";

type TaskRow = {
  id: string; user_id: number; name: string; prompt: string; key_id: number | null;
  model: string; effort: string; model_label: string; schedule: string; language: Lang;
  enabled: number; email: number; next_run_at: string | null; created_at: string; updated_at: string;
};
type RunRow = {
  id: string; task_id: string; trigger: "scheduled" | "manual"; scheduled_for: string;
  started_at: string; finished_at: string | null;
  status: "running" | "succeeded" | "failed" | "stopped" | "interrupted";
  conversation_id: string | null; error: string | null;
};
const MAX_TASKS = 50;
const RUN_TIMEOUT_MS = 10 * 60_000;
const MANUAL_RUNS_PER_MINUTE = 20;
const MANUAL_RUNS_PER_HOUR = 200;
/** An emailed answer stops here; the rest is in the chat. */
const MAX_EMAIL_CHARS = 100_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const running = new Map<string, { taskId: string; stopped: boolean; cancel?: () => void; promise: Promise<void> }>();
const manualAttempts = new Map<number, number[]>();

/** Failed starts still consume this allowance, but rejected requests never create run records. */
function manualRunLimit(userId: number): string | null {
  const now = Date.now();
  const attempts = (manualAttempts.get(userId) ?? []).filter((at) => now - at < HOUR_MS);
  manualAttempts.set(userId, attempts);
  if (attempts.length >= MANUAL_RUNS_PER_HOUR) return t("You've started {limit} tasks in the last hour, try again a little later", { limit: MANUAL_RUNS_PER_HOUR });
  if (attempts.filter((at) => now - at < MINUTE_MS).length >= MANUAL_RUNS_PER_MINUTE) return t("You're running tasks quickly, wait a moment and try again");
  attempts.push(now);
  return null;
}

function ownTask(id: string, userId: number): TaskRow | undefined {
  return db.prepare("SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?").get(id, userId) as TaskRow | undefined;
}
function activeRun(taskId: string): RunRow | undefined {
  return db.prepare("SELECT * FROM scheduled_runs WHERE task_id = ? AND status = 'running'").get(taskId) as RunRow | undefined;
}
function runOut(row: RunRow) {
  const visible = row.conversation_id && db.prepare("SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL").get(row.conversation_id);
  return {
    id: row.id, trigger: row.trigger, scheduledFor: row.scheduled_for, startedAt: row.started_at,
    finishedAt: row.finished_at, status: row.status, conversationId: visible ? row.conversation_id : null, error: row.error,
  };
}
function taskOut(row: TaskRow, detail = false) {
  const runs = db.prepare("SELECT * FROM scheduled_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?").all(row.id, detail ? 50 : 1) as RunRow[];
  return {
    id: row.id, name: row.name, prompt: row.prompt,
    choice: { keyId: row.key_id ?? -1, model: row.model, effort: row.effort }, modelLabel: row.model_label,
    schedule: JSON.parse(row.schedule) as TaskSchedule, enabled: !!row.enabled, email: !!row.email, nextRunAt: row.next_run_at,
    lastRun: runs[0] ? runOut(runs[0]) : null, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(detail ? { runs: runs.map(runOut) } : {}),
  };
}

function finish(runId: string, status: RunRow["status"], error: string | null = null) {
  db.prepare("UPDATE scheduled_runs SET status = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'")
    .run(status, error, nowIso(), runId);
}

/**
 * Emails a scheduled run's outcome to the task's owner, when the task asks for it: the answer, or
 * why it didn't finish. Runs started with Run now, and runs the person stopped, send nothing.
 */
function emailRun(row: TaskRow, run: RunRow, outcome: { answer?: string; error?: string | null }) {
  if (!row.email || run.trigger !== "scheduled" || mailMode === "off") return;
  const user = db.prepare("SELECT email, disabled FROM users WHERE id = ?").get(row.user_id) as { email: string; disabled: number } | undefined;
  if (!user || user.disabled) return;
  // Mail goes out unattended, so links only point at PUBLIC_URL, never at an address a request named.
  const link = env.publicUrl && (run.conversation_id ? `${env.publicUrl}/chat/${run.conversation_id}` : `${env.publicUrl}/tasks/${row.id}`);
  const vars = { name: row.name, appName: env.appName };
  let body: string;
  if (outcome.answer !== undefined) {
    const answer = outcome.answer.length > MAX_EMAIL_CHARS
      ? `${outcome.answer.slice(0, MAX_EMAIL_CHARS)}\n\n${t("The rest of the answer is in the chat")}`
      : outcome.answer;
    body = answer + (link ? `\n\n${t("Open the chat: {link}", { link })}` : "");
  } else {
    body = t("It stopped with this message: {error}", { error: outcome.error ?? t("No reply came back") })
      + (link ? `\n\n${t("See the task: {link}", { link })}` : "");
  }
  sendMail({
    to: user.email,
    subject: outcome.answer !== undefined ? t("Your scheduled task {name} has run", vars) : t("Your scheduled task {name} didn't finish", vars),
    text: `${body}\n\n${t("You get this email because {name} is set to email you after each scheduled run. To stop it, turn this off on the task's page in {appName}.", vars)}`,
  }).catch((err) => console.error("[mail] sending failed:", err));
}

function launch(row: TaskRow, run: RunRow): Promise<void> {
  const control: { taskId: string; stopped: boolean; cancel?: () => void; promise: Promise<void> } = {
    taskId: row.id, stopped: false, promise: Promise.resolve(),
  };
  running.set(run.id, control);
  // prepareChat reserves its slot before its first await. Enter it now, so the next claim sees
  // that reservation and leaves excess occurrences pending instead of failing them as busy.
  control.promise = inLang(row.language, async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      if (control.stopped) { finish(run.id, "stopped"); return; }
      const user = db.prepare("SELECT id, email, role, disabled FROM users WHERE id = ?").get(row.user_id) as (SessionUser & { disabled: number }) | undefined;
      if (!user || user.disabled) throw new ChatStartError(403, t("This account is disabled"));
      const prepared = await prepareChat(user, {
        text: row.prompt, keyId: row.key_id, model: row.model, effort: row.effort,
      }, { unattended: true, title: row.name });
      db.prepare("UPDATE scheduled_runs SET conversation_id = ? WHERE id = ?").run(prepared.conversationId, run.id);
      control.cancel = prepared.cancel;
      if (control.stopped) prepared.cancel();
      timeout = setTimeout(() => { timedOut = true; prepared.cancel(); }, RUN_TIMEOUT_MS);
      timeout.unref();
      const message = await prepared.run();
      const status = message.status === "ok" || message.status === "truncated" ? "succeeded" : message.status === "stopped" ? "stopped" : "failed";
      const error = timedOut ? t("The task stopped after running for ten minutes") : status === "failed" ? (message.error ?? t("No reply came back")) : null;
      finish(run.id, status, error);
      if (!control.stopped) emailRun(row, { ...run, conversation_id: prepared.conversationId }, status === "succeeded" ? { answer: message.text } : { error });
    } catch (err) {
      control.cancel?.();
      const error = err instanceof ChatStartError ? err.message : t("The task couldn't finish, try running it again");
      if (!(err instanceof ChatStartError)) console.error("[tasks] execution failed", err);
      finish(run.id, control.stopped ? "stopped" : "failed", control.stopped ? null : error);
      if (!control.stopped) emailRun(row, run, { error });
    } finally {
      if (timeout) clearTimeout(timeout);
      running.delete(run.id);
    }
  });
  return control.promise;
}

/** The occurrence and its next time are committed together before any external work starts. */
function claim(id: string, trigger: RunRow["trigger"], nowMs: number): { task: TaskRow; run: RunRow } | null {
  return tx(() => {
    const row = db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as TaskRow | undefined;
    const now = new Date(nowMs).toISOString();
    if (!row || activeRun(id) || (trigger === "scheduled" && (!row.enabled || !row.next_run_at || row.next_run_at > now))) return null;
    // Temporary concurrency or send limits postpone this occurrence without advancing its clock.
    if (trigger === "scheduled" && !chatCapacityAvailable(row.user_id)) return null;
    const scheduledFor = trigger === "scheduled" ? row.next_run_at! : now;
    const run: RunRow = {
      id: randomUUID(), task_id: id, trigger, scheduled_for: scheduledFor,
      started_at: now, finished_at: null, status: "running", conversation_id: null, error: null,
    };
    db.prepare("INSERT INTO scheduled_runs (id, task_id, trigger, scheduled_for, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')")
      .run(run.id, id, trigger, scheduledFor, now);
    if (trigger === "scheduled") {
      // Catch up once after downtime, then advance beyond now instead of replaying a backlog.
      const next = nextOccurrence(JSON.parse(row.schedule), nowMs);
      db.prepare("UPDATE scheduled_tasks SET next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ?")
        .run(next, next ? 1 : 0, now, id);
    }
    return { task: row, run };
  });
}

export async function tickTasks(nowMs = Date.now()): Promise<void> {
  const rows = db.prepare("SELECT id FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 100")
    .all(new Date(nowMs).toISOString()) as { id: string }[];
  const work: Promise<void>[] = [];
  for (const row of rows) {
    const claimed = claim(row.id, "scheduled", nowMs);
    if (claimed) work.push(launch(claimed.task, claimed.run));
  }
  await Promise.all(work);
}

/** A provider may already have billed an interrupted run, so never silently retry it at startup. */
export function recoverTaskRuns() {
  const rows = db.prepare("SELECT r.*, t.language FROM scheduled_runs r JOIN scheduled_tasks t ON t.id = r.task_id WHERE r.status = 'running'")
    .all() as (RunRow & { language: Lang })[];
  for (const run of rows) {
    inLang(run.language, () => {
      const error = t("The server restarted during this run, run it again if needed");
      finish(run.id, "interrupted", error);
      emailRun(db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(run.task_id) as TaskRow, run, { error });
    });
  }
}

export async function waitForTaskRuns() { await Promise.all([...running.values()].map((r) => r.promise)); }

export function startTaskScheduler() {
  recoverTaskRuns();
  const tick = () => { void tickTasks().catch((err) => console.error("[tasks] scheduler failed", err)); };
  tick();
  const timer = setInterval(tick, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}

export const taskRoutes = new Hono<AppEnv>();
taskRoutes.use("*", requireUser);

taskRoutes.get("/tasks", (c) => {
  const rows = db.prepare("SELECT * FROM scheduled_tasks WHERE user_id = ? ORDER BY created_at DESC, rowid DESC").all(c.var.user!.id) as TaskRow[];
  return c.json({ tasks: rows.map((r) => taskOut(r)) });
});
// Whether runs can be emailed here, and to which address.
taskRoutes.get("/tasks/email", (c) => c.json({ available: mailMode !== "off", address: c.var.user!.email }));
taskRoutes.get("/tasks/:id", (c) => {
  const row = ownTask(c.req.param("id"), c.var.user!.id);
  return row ? c.json(taskOut(row, true)) : c.json({ error: t("This task doesn't exist") }, 404);
});

function taskInput(body: unknown, userId: number) {
  if (!body || typeof body !== "object") throw new Error(t("Fill in the task's settings"));
  const value = body as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!name || name.length > 120) throw new Error(t("Give the task a name under 120 characters"));
  if (!prompt || prompt.length > 50_000) throw new Error(t("Write a prompt under 50000 characters"));
  const key = exactChoice(userId, value.choice);
  if (!key) throw new Error(t("The selected model or thinking level is no longer available"));
  const schedule = cleanSchedule(value.schedule);
  if (!schedule) throw new Error(t("Choose a valid date, time, timezone and repeat schedule"));
  const next = nextOccurrence(schedule, Date.now());
  if (!next) throw new Error(t("Choose a future time that exists in this timezone"));
  return { name, prompt, key, schedule, next, email: value.email === true };
}

taskRoutes.post("/tasks", async (c) => {
  const userId = c.var.user!.id;
  let input: ReturnType<typeof taskInput>;
  try { input = taskInput(await c.req.json(), userId); } catch (err) { return c.json({ error: err instanceof SyntaxError ? t("Fill in the task's settings") : (err as Error).message }, 400); }
  // Keep the count and insert in the same synchronous turn after reading the body.
  const count = (db.prepare("SELECT COUNT(*) AS n FROM scheduled_tasks WHERE user_id = ?").get(userId) as { n: number }).n;
  if (count >= MAX_TASKS) return c.json({ error: t("You can keep up to 50 scheduled tasks") }, 409);
  const { name, prompt, key, schedule, next, email } = input;
  const id = randomUUID();
  const now = nowIso();
  db.prepare(`INSERT INTO scheduled_tasks (id, user_id, name, prompt, key_id, model, effort, model_label, schedule, language, email, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, name, prompt, key.id, key.model, key.effort, keyModelLabel(key, key.model), JSON.stringify(schedule), lang(), email ? 1 : 0, next, now, now);
  return c.json(taskOut(ownTask(id, userId)!, true));
});

taskRoutes.put("/tasks/:id", async (c) => {
  const row = ownTask(c.req.param("id"), c.var.user!.id);
  if (!row) return c.json({ error: t("This task doesn't exist") }, 404);
  if (activeRun(row.id)) return c.json({ error: t("Wait for this task to finish or stop it first") }, 409);
  let input: ReturnType<typeof taskInput>;
  try { input = taskInput(await c.req.json(), row.user_id); } catch (err) { return c.json({ error: err instanceof SyntaxError ? t("Fill in the task's settings") : (err as Error).message }, 400); }
  // Reading the body yields: check again before changing a task the scheduler may just have claimed.
  if (activeRun(row.id)) return c.json({ error: t("Wait for this task to finish or stop it first") }, 409);
  const current = ownTask(row.id, row.user_id);
  if (!current) return c.json({ error: t("This task doesn't exist") }, 404);
  const { name, prompt, key, schedule, next, email } = input;
  db.prepare(`UPDATE scheduled_tasks SET name = ?, prompt = ?, key_id = ?, model = ?, effort = ?, model_label = ?, schedule = ?,
    language = ?, email = ?, next_run_at = ?, updated_at = ? WHERE id = ?`).run(name, prompt, key.id, key.model, key.effort, keyModelLabel(key, key.model), JSON.stringify(schedule), lang(), email ? 1 : 0, current.enabled ? next : null, nowIso(), row.id);
  return c.json(taskOut(ownTask(row.id, row.user_id)!, true));
});

taskRoutes.patch("/tasks/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  const row = ownTask(c.req.param("id"), c.var.user!.id);
  if (!row) return c.json({ error: t("This task doesn't exist") }, 404);
  if (typeof body?.enabled !== "boolean") return c.json({ error: t("Choose whether the task is enabled") }, 400);
  let next: string | null = null;
  if (body.enabled) {
    if (!exactChoice(row.user_id, { keyId: row.key_id, model: row.model, effort: row.effort })) return c.json({ error: t("The selected model or thinking level is no longer available") }, 409);
    next = nextOccurrence(JSON.parse(row.schedule), Date.now());
    if (!next) return c.json({ error: t("Choose a future time that exists in this timezone") }, 400);
  }
  db.prepare("UPDATE scheduled_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(body.enabled ? 1 : 0, next, nowIso(), row.id);
  return c.json(taskOut(ownTask(row.id, row.user_id)!, true));
});

taskRoutes.post("/tasks/:id/run", (c) => {
  const row = ownTask(c.req.param("id"), c.var.user!.id);
  if (!row) return c.json({ error: t("This task doesn't exist") }, 404);
  const limit = manualRunLimit(row.user_id);
  if (limit) return c.json({ error: limit }, 429);
  const claimed = claim(row.id, "manual", Date.now());
  if (!claimed) return c.json({ error: t("This task is already running") }, 409);
  void launch(claimed.task, claimed.run);
  return c.json({ run: runOut(claimed.run) }, 202);
});

taskRoutes.post("/tasks/:id/stop", (c) => {
  const row = ownTask(c.req.param("id"), c.var.user!.id);
  if (!row) return c.json({ error: t("This task doesn't exist") }, 404);
  const active = activeRun(row.id);
  const control = active && running.get(active.id);
  if (control) { control.stopped = true; control.cancel?.(); }
  return c.json({ ok: true });
});

taskRoutes.delete("/tasks/:id", (c) => {
  const row = ownTask(c.req.param("id"), c.var.user!.id);
  if (!row) return c.json({ error: t("This task doesn't exist") }, 404);
  if (activeRun(row.id)) return c.json({ error: t("Wait for this task to finish or stop it first") }, 409);
  db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(row.id);
  return c.json({ ok: true });
});
