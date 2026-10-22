// Cowork: a job the person describes once, which the model then works through on its own on the
// server, turn after turn in one ordinary chat, until it says it's done or a limit stops it.
//
// Each turn is a reply from prepareChat (routes/chat.ts) with the chat's tools, less memory, plus
// two of the job's own: update_progress, the checklist beside its work, and finish_job. A turn that
// ends without finish_job is followed by "Carry on with the job", unless it did nothing at all.
// The person can message it as it works: their words wait in the job's inbox, the next tool result
// tells the model to wrap up its step, and the next turn is their message. What the job did is
// kept in cowork_steps (its tools, its replies, their messages and answers), separate from the chat.
//
// Like scheduled tasks (tasks.ts), a turn is claimed (turn_open) before any provider is called, so
// a restart never repeats a call that may have been billed: a job caught mid-turn waits as
// "interrupted" until the person has it carry on, and one caught between turns simply resumes.
// A tool call that needs the person's OK holds the job at "waiting" (asks.ts) until they answer
// on its page or in its chat; that time doesn't count toward its working time.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { allowanceOf, overLimitMessage } from "./allowance.ts";
import { answerAsk, askPerson, type Answer, type Ask } from "./asks.ts";
import { pickAttachments, unreadable } from "./attachments.ts";
import { requireUser, type AppEnv, type SessionUser } from "./auth.ts";
import { getConversation, getMessage, titleFrom, tx } from "./chat-store.ts";
import { exactChoice } from "./comparisons.ts";
import { db, nowIso } from "./db.ts";
import { env } from "./env.ts";
import { inLang, lang, t, type Lang } from "./i18n.ts";
import { keyModelLabel } from "./keys.ts";
import { canUse, getBase } from "./knowledge.ts";
import { mailMode, sendMail } from "./mail.ts";
import { getServer } from "./mcp.ts";
import type { ToolCall, ToolOutcome, ToolSpec } from "./providers/types.ts";
import { chatCapacityAvailable, ChatStartError, prepareChat, type JobTurn } from "./routes/chat.ts";
import { codeOnSite, declaredOf } from "./tools.ts";

type Status = "queued" | "running" | "waiting" | "done" | "stopped" | "limit" | "failed" | "interrupted";
type Limit = "steps" | "time" | "spend" | "allowance";
type JobRow = {
  id: string; user_id: number; title: string; goal: string; key_id: number | null; model: string; effort: string;
  model_label: string; language: Lang; knowledge: string; attachments: string;
  max_steps: number; max_minutes: number; max_spend: number | null; email: number;
  status: Status; limit_hit: Limit | null; error: string | null; conversation_id: string | null;
  turn_open: number; turns: number; steps: number; worked_ms: number; spent: number;
  base_steps: number; base_ms: number; base_spent: number; asks: string | null;
  progress: string | null; inbox: string | null;
  created_at: string; updated_at: string; finished_at: string | null;
};
type StepRow = { id: number; job_id: string; kind: string; text: string; failed: number; created_at: string };

/** What the person may pick for each limit; null spending means only their monthly allowance. */
export const STEP_CHOICES = [20, 50, 100];
export const MINUTE_CHOICES = [15, 60, 240];
export const SPEND_CHOICES = [0.5, 2, 10, null];
/** Jobs that work for one person at once; more wait their turn. A chat reply takes a slot too. */
const JOBS_AT_ONCE = 2;
const MAX_UNFINISHED = 10;
const MAX_KEPT = 200;
/** How long a question waits for the person before the job carries on without it. */
const WAIT_MS = 3 * 24 * 60 * 60_000;
/** After its time runs out, a turn has this long to write up before it's cut off. */
const GRACE_MS = 2 * 60_000;
/** Tool calls turned away after a limit before the turn is cut off. */
const EXTRA_CALLS = 3;
const MAX_EMAIL_CHARS = 100_000;
const MAX_ITEM_CHARS = 200;
const MAX_ITEMS = 20;
const MAX_MESSAGE_CHARS = 50_000;
const MAX_INBOX = 20;
/** Limits a job starts with, which the person can change on its page. */
const DEFAULT_LIMITS = { steps: 50, minutes: 60, spend: 2 as number | null };
const ACTIVE: Status[] = ["queued", "running", "waiting"];

const PROGRESS_TOOL: ToolSpec = {
  name: "update_progress",
  description:
    "Keep the person's checklist for this job up to date; it shows beside your work. Give the whole list each time: a few short steps in the language they write in, each todo, doing or done. Make it when you start and update it as each step moves on.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: { text: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "done"] } },
          required: ["text", "status"],
        },
      },
    },
    required: ["steps"],
  },
};
type ProgressItem = { text: string; status: "todo" | "doing" | "done" };
const FINISH_TOOL: ToolSpec = {
  name: "finish_job",
  description: "Say the job is done. Call it once everything is finished, then write your final answer.",
  parameters: { type: "object", properties: {} },
};

const JOB_NOTE = [
  "You're doing a job for the person on your own, in the background. Their first message in this chat is the goal. They may not be watching, so don't stop to ask them anything: make sensible choices and say what you assumed. They can send you messages as you work, which come to you as their messages: take them into account straight away.",
  "Start by calling update_progress with a short plan, and keep it current as you go. Between steps, write a sentence or two on what you're doing; the person sees your words as you write them.",
  "Your work is split into turns. If you stop writing without calling finish_job, you'll be asked to carry on, so you can stop partway and continue in the next turn. Some tools wait for the person's OK; just carry on when they come back.",
  "When the job is done, call finish_job, then write the result in full: what you found or made, naming any files you saved. That answer is what the person reads first.",
  "The job has limits on steps, working time and spending. When one is reached your tools stop working: then write up what you have and say what's left undone.",
].join("\n\n");

/** Added to a tool's result when the person has written meanwhile, so the turn ends and the next one reads it. */
const NUDGE =
  "\n\nThe person has just sent you a message. Finish this step briefly and stop writing, without calling finish_job, so you can read it.";

const LIMIT_NOTE: Record<Exclude<Limit, "allowance" | "spend">, string> = {
  steps: "This job has used all its steps, so no more tools can run. Write your final answer now from what you have, and say what's left undone",
  time: "This job's working time is up, so no more tools can run. Write your final answer now from what you have, and say what's left undone",
};

/** A job being worked on in this process. */
type Driver = {
  jobId: string;
  userId: number;
  stopped: boolean;
  cancel?: () => void;
  promise: Promise<void>;
  /** When the turn last started working; null while it waits for the person or between turns. */
  activeSince: number | null;
  timers: ReturnType<typeof setTimeout>[];
  /** Questions waiting for the person right now. */
  waiting: number;
  /** Questions that ended without the person's OK: those calls did nothing, so they aren't steps. */
  notAllowed: number;
  /** A limit reached during the turn: tools refuse, the model writes up, then the job stops. */
  limit: Limit | null;
  refused: number;
  /** The turn was cut off for a limit. */
  cut: boolean;
  /** finish_job was called this turn. */
  finished: boolean;
  /** Tools used this turn, other than the job's own. */
  actions: number;
  /** Inside one of the app's tools: its status lines aren't the provider's own work. */
  inTool: number;
  lastStatus: string;
  /** What the model has written so far this turn, shown as it comes. */
  partial: string;
};
const drivers = new Map<string, Driver>();

const jobRow = (id: string) => db.prepare("SELECT * FROM cowork_jobs WHERE id = ?").get(id) as JobRow | undefined;
const ownJob = (id: string, userId: number) =>
  db.prepare("SELECT * FROM cowork_jobs WHERE id = ? AND user_id = ?").get(id, userId) as JobRow | undefined;

/** Sets columns on a job; the names come from this file, never from a request. */
function setJob(id: string, fields: Partial<JobRow>) {
  const names = Object.keys(fields);
  db.prepare(`UPDATE cowork_jobs SET ${names.map((n) => `${n} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...names.map((n) => (fields as Record<string, string | number | null>)[n]), nowIso(), id);
}

function addStep(jobId: string, kind: string, text: string, failed = false) {
  db.prepare("INSERT INTO cowork_steps (job_id, kind, text, failed, created_at) VALUES (?, ?, ?, ?, ?)").run(jobId, kind, text, failed ? 1 : 0, nowIso());
}

const inboxOf = (row: JobRow | undefined): string[] => (row?.inbox ? (JSON.parse(row.inbox) as string[]) : []);

/** What the model wrote before a tool, kept in the record ahead of the tool's line. */
function keepWords(d: Driver) {
  const text = d.partial.trim();
  d.partial = "";
  if (text) addStep(d.jobId, "reply", text);
}

const countStep = (jobId: string) => db.prepare("UPDATE cowork_jobs SET steps = steps + 1 WHERE id = ?").run(jobId);

/** Working time so far, the turn in progress included. */
function workedMs(row: JobRow) {
  const since = drivers.get(row.id)?.activeSince;
  return row.worked_ms + (since ? Date.now() - since : 0);
}

/** The limit a job has reached, checked before each turn. */
function limitReached(row: JobRow): Limit | null {
  if (row.steps - row.base_steps >= row.max_steps) return "steps";
  if (workedMs(row) - row.base_ms >= row.max_minutes * 60_000) return "time";
  if (row.max_spend != null && row.spent - row.base_spent >= row.max_spend) return "spend";
  if (allowanceOf(row.user_id).over) return "allowance";
  return null;
}

function limitText(row: JobRow, limit: Limit) {
  if (limit === "steps") return t("Stopped after using its {count} steps", { count: row.max_steps });
  if (limit === "time") return t("Stopped after {count} minutes of work", { count: row.max_minutes });
  if (limit === "spend") return t("Stopped at its spending cap of ${value}", { value: (row.max_spend ?? 0).toFixed(2) });
  return t("Stopped because you've reached this month's allowance");
}

function filesOf(conversationId: string | null) {
  if (!conversationId) return [];
  return db.prepare(
    `SELECT f.id, f.name, f.mime, f.size FROM message_files f JOIN messages m ON m.id = f.message_id
     WHERE m.conversation_id = ? ORDER BY f.created_at, f.rowid`,
  ).all(conversationId) as { id: string; name: string; mime: string; size: number }[];
}

function jobOut(row: JobRow, detail = false) {
  const visible = row.conversation_id && db.prepare("SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL").get(row.conversation_id);
  const conversationId = visible ? row.conversation_id : null;
  const steps = db.prepare(`SELECT * FROM cowork_steps WHERE job_id = ? ORDER BY id ${detail ? "" : "DESC LIMIT 1"}`).all(row.id) as StepRow[];
  return {
    id: row.id, title: row.title, goal: row.goal, status: row.status, limit: row.limit_hit, error: row.error,
    choice: { keyId: row.key_id ?? -1, model: row.model, effort: row.effort }, modelLabel: row.model_label,
    limits: { steps: row.max_steps, minutes: row.max_minutes, spend: row.max_spend },
    // What this stretch has used: limits start again from here when the person has it carry on.
    used: { steps: row.steps - row.base_steps, ms: workedMs(row) - row.base_ms, spent: row.spent - row.base_spent },
    email: !!row.email, conversationId, createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
    progress: row.progress ? (JSON.parse(row.progress) as ProgressItem[]) : [],
    // The newest line, for the list: a reply by its first line.
    lastStep: detail || !steps[0] ? null : steps[0].text.split("\n").find((line) => line.trim())?.replace(/[#*_`>]/g, "").trim().slice(0, 160) ?? null,
    ...(detail ? {
      steps: steps.map((s) => ({ id: s.id, kind: s.kind, text: s.text, failed: !!s.failed, at: s.created_at })),
      asks: row.status === "waiting" && row.asks ? (JSON.parse(row.asks) as Ask[]) : [],
      files: filesOf(conversationId),
      /** What the model is writing right now. */
      live: drivers.get(row.id)?.partial ?? "",
      /** The person's messages it hasn't read yet. */
      inbox: inboxOf(row),
      context: {
        knowledge: (JSON.parse(row.knowledge) as string[]).flatMap((id) => {
          const base = getBase(id);
          return base ? [{ id, name: base.name }] : [];
        }),
        attachments: db.prepare("SELECT id, name, mime, size, kind FROM attachments WHERE id IN (SELECT value FROM json_each(?))")
          .all(row.attachments) as { id: string; name: string; mime: string; size: number; kind: string }[],
      },
    } : {}),
  };
}

/**
 * Emails the job's owner, when the job asks for it: the result, why it stopped, or that it's
 * waiting for their OK. A job the person stopped sends nothing.
 */
function emailJob(row: JobRow, outcome: { answer?: string; waiting?: string; reason?: string }) {
  if (!row.email || mailMode === "off") return;
  const user = db.prepare("SELECT email, disabled FROM users WHERE id = ?").get(row.user_id) as { email: string; disabled: number } | undefined;
  if (!user || user.disabled) return;
  // Mail goes out unattended, so links only point at PUBLIC_URL, never at an address a request named.
  const link = env.publicUrl ? `${env.publicUrl}/cowork/${row.id}` : "";
  const vars = { name: row.title, appName: env.appName };
  let subject: string;
  let body: string;
  if (outcome.answer !== undefined) {
    subject = t("Your Cowork job {name} is done", vars);
    body = outcome.answer.length > MAX_EMAIL_CHARS ? `${outcome.answer.slice(0, MAX_EMAIL_CHARS)}\n\n${t("The rest of the answer is in the chat")}` : outcome.answer;
  } else if (outcome.waiting !== undefined) {
    subject = t("Your Cowork job {name} is waiting for you", vars);
    body = t("It needs your OK to carry on: {question}", { question: outcome.waiting });
  } else {
    subject = t("Your Cowork job {name} stopped", vars);
    body = outcome.reason ?? t("No reply came back");
  }
  if (link) body += `\n\n${t("Open the job: {link}", { link })}`;
  sendMail({
    to: user.email,
    subject,
    text: `${body}\n\n${t("You get this email because {name} is set to email you. To stop it, turn this off on the job's page in {appName}.", vars)}`,
  }).catch((err) => console.error("[mail] sending failed:", err));
}

/** Ends a job: its status, a last line in its steps, and an email unless the person stopped it. */
function endJob(id: string, status: Status, line: string, extra: { limit?: Limit; error?: string; answer?: string } = {}) {
  setJob(id, { status, limit_hit: extra.limit ?? null, error: extra.error ?? null, turn_open: 0, asks: null, finished_at: nowIso() });
  addStep(id, "end", line, status === "failed");
  const row = jobRow(id);
  if (row && status !== "stopped") emailJob(row, extra.answer !== undefined ? { answer: extra.answer } : { reason: extra.error ?? line });
}

function clearTimers(d: Driver) {
  d.timers.forEach(clearTimeout);
  d.timers = [];
}

/** Starts the turn's clock: its time runs out softly (tools refuse), then for good after GRACE_MS. */
function startClock(d: Driver) {
  const row = jobRow(d.jobId);
  if (!row) return;
  d.activeSince = Date.now();
  const left = Math.max(0, row.max_minutes * 60_000 - (row.worked_ms - row.base_ms));
  const soft = setTimeout(() => { d.limit ??= "time"; }, left);
  const hard = setTimeout(() => { d.limit ??= "time"; d.cut = true; d.cancel?.(); }, left + GRACE_MS);
  soft.unref();
  hard.unref();
  d.timers = [soft, hard];
}

function stopClock(d: Driver) {
  clearTimers(d);
  if (d.activeSince == null) return;
  db.prepare("UPDATE cowork_jobs SET worked_ms = worked_ms + ? WHERE id = ?").run(Date.now() - d.activeSince, d.jobId);
  d.activeSince = null;
}

const hostOf = (url: unknown) => {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
    return String(url);
  }
};

/** One of the app's tools, as a line in the job's steps. */
function stepText(call: ToolCall, conversationId: string | null): string {
  const text = (value: unknown) => String(value ?? "").trim().slice(0, 200);
  switch (call.name) {
    case "search_knowledge": return t("Searched your knowledge for “{query}”", { query: text(call.input.query) });
    case "web_search": return t("Searched the web for “{query}”", { query: text(call.input.query) });
    case "read_page": return t("Read a page on {host}", { host: hostOf(call.input.url) });
    case "save_file": return t("Saved {name}", { name: text(call.input.name) });
  }
  const declared = conversationId ? declaredOf(getConversation(conversationId)?.tool_defs ?? null).find((d) => d.name === call.name) : undefined;
  if (declared?.mcp) {
    const server = getServer(declared.mcp.server);
    return t("Used {tool} on {name}", { tool: declared.mcp.tool, name: server?.name ?? t("a connected service") });
  }
  return t("Used {name}", { name: call.name });
}

/** What a turn adds to prepareChat: the note on working alone, the job's tools, holding for the person's OK, and spend. */
function jobTurn(d: Driver): JobTurn {
  const id = d.jobId;
  const convId = () => jobRow(id)?.conversation_id ?? null;
  return {
    system: JOB_NOTE,
    tools: (offered) => ({
      functions: [...offered.functions, PROGRESS_TOOL, FINISH_TOOL],
      runTool: async (call): Promise<ToolOutcome> => {
        keepWords(d);
        if (call.name === PROGRESS_TOOL.name) {
          const list = Array.isArray(call.input.steps) ? (call.input.steps as Record<string, unknown>[]) : [];
          const items: ProgressItem[] = list.slice(0, MAX_ITEMS).flatMap((item) => {
            const text = String(item?.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS);
            const status = item?.status === "done" || item?.status === "doing" ? item.status : "todo";
            return text ? [{ text, status }] : [];
          });
          if (!items.length) return { content: "Give the steps as a list, each with text and status", isError: true };
          setJob(id, { progress: JSON.stringify(items) });
          return { content: `Checklist updated${inboxOf(jobRow(id)).length ? NUDGE : ""}` };
        }
        if (call.name === FINISH_TOOL.name) {
          d.finished = true;
          return { content: "Noted. Now write your final answer: what you did and the result, naming any files you saved" };
        }
        const row = jobRow(id);
        if (row && !d.limit && row.steps - row.base_steps >= row.max_steps) d.limit = "steps";
        if (d.limit === "steps" || d.limit === "time") {
          // A model that keeps calling tools after it's told to stop is cut off.
          if (++d.refused > EXTRA_CALLS) { d.cut = true; d.cancel?.(); }
          return { content: LIMIT_NOTE[d.limit], isError: true };
        }
        d.inTool++;
        const notAllowed = d.notAllowed;
        let outcome: ToolOutcome;
        try {
          outcome = await offered.runTool(call);
        } finally {
          d.inTool--;
        }
        // Turned down, unanswered or stopped while it waited: the answer is in the steps already.
        if (d.notAllowed > notAllowed || d.stopped || d.cut) return outcome;
        d.actions++;
        countStep(id);
        addStep(id, "tool", stepText(call, convId()), !!outcome.isError);
        return inboxOf(jobRow(id)).length ? { ...outcome, content: outcome.content + NUDGE } : outcome;
      },
    }),
    ask: async (conversationId, question, signal): Promise<Answer> => {
      if (d.waiting++ === 0) {
        stopClock(d);
        setJob(id, { status: "waiting" });
        const row = jobRow(id);
        if (row) emailJob(row, { waiting: question.question });
      }
      addStep(id, "wait", t("Waiting for your OK: {question}", { question: question.question }));
      const answer = await askPerson(conversationId, question, signal, (asks) => setJob(id, { asks: asks.length ? JSON.stringify(asks) : null }), WAIT_MS);
      if (--d.waiting === 0 && !signal.aborted) {
        setJob(id, { status: "running" });
        startClock(d);
      }
      if (answer !== "allow") d.notAllowed++;
      if (answer === "allow") addStep(id, "answer", t("You allowed it"));
      else if (answer === "deny") addStep(id, "answer", t("You turned it down"));
      else if (answer === "timeout") addStep(id, "answer", t("No answer came in three days, so it carried on without it"));
      return answer;
    },
    spent: (cost) => void db.prepare("UPDATE cowork_jobs SET spent = spent + ? WHERE id = ?").run(cost, id),
  };
}

/** The provider's own work (its web search, running code) comes to the job as status lines. */
function statusSender(d: Driver) {
  return async (event: string, data: unknown) => {
    if (event === "delta") {
      d.partial += (data as { text: string }).text;
      return;
    }
    if (event !== "status" || d.inTool) return;
    const { status, detail } = data as { status: string; detail?: string };
    const key = `${status}\n${detail ?? ""}`;
    if (key === d.lastStatus) return;
    d.lastStatus = key;
    if (status === "searching" && detail) {
      keepWords(d);
      d.actions++;
      countStep(d.jobId);
      addStep(d.jobId, "tool", t("Searched the web for “{query}”", { query: detail.slice(0, 200) }));
    } else if (status === "coding") {
      keepWords(d);
      d.actions++;
      countStep(d.jobId);
      addStep(d.jobId, "tool", t("Ran code"));
    }
  };
}

/** One turn: claimed, run, and what follows from it. "again" means another turn should follow. */
async function turn(d: Driver, row: JobRow): Promise<"again" | "end"> {
  Object.assign(d, { limit: null, refused: 0, cut: false, finished: false, actions: 0, lastStatus: "", partial: "" });
  const user = db.prepare("SELECT id, email, role, disabled FROM users WHERE id = ?").get(row.user_id) as (SessionUser & { disabled: number }) | undefined;
  if (!user || user.disabled) {
    endJob(row.id, "failed", t("This account is turned off"), { error: t("This account is turned off") });
    return "end";
  }
  const choice = { keyId: row.key_id, model: row.model, effort: row.effort };
  // The person's messages go to the model as their next message, once the job has a chat.
  const inbox = row.conversation_id ? inboxOf(row) : [];
  let body: Record<string, unknown>;
  if (!row.conversation_id) {
    body = { ...choice, text: row.goal, knowledgeIds: JSON.parse(row.knowledge), attachments: JSON.parse(row.attachments) };
  } else {
    // Carry on from the last good point: a message whose reply never came (a restart cut it off)
    // or failed is answered again, rather than left out of what the model sees.
    const conv = getConversation(row.conversation_id);
    const head = conv?.head_id != null ? getMessage(conv.head_id) : undefined;
    const unanswered = head?.role === "user" ? head : head && !head.in_context && head.parent_id != null ? getMessage(head.parent_id) : undefined;
    body = unanswered
      ? { ...choice, conversationId: row.conversation_id, regenerate: unanswered.id }
      : { ...choice, conversationId: row.conversation_id, text: inbox.join("\n\n") || t("Carry on with the job") };
  }

  let prepared;
  try {
    prepared = await prepareChat(user, body, { title: row.title, job: jobTurn(d) });
  } catch (err) {
    setJob(row.id, { turn_open: 0 });
    if (err instanceof ChatStartError) {
      const over = allowanceOf(row.user_id).over;
      if (over) endJob(row.id, "limit", limitText(row, "allowance"), { limit: "allowance" });
      // Too many replies at once, or sent too quickly: wait for a free slot.
      else if (err.status === 429) {
        db.prepare("UPDATE cowork_jobs SET status = 'queued', turns = turns - 1, steps = steps - 1 WHERE id = ?").run(row.id);
      }
      else endJob(row.id, "failed", err.message, { error: err.message });
    } else {
      console.error("[cowork] a turn couldn't start", err);
      endJob(row.id, "failed", t("The job couldn't carry on. Try Carry on"), { error: t("The job couldn't carry on. Try Carry on") });
    }
    return "end";
  }
  if (!row.conversation_id) setJob(row.id, { conversation_id: prepared.conversationId });
  if (inbox.length && body.text) {
    // Taken: anything that came in meanwhile waits for the turn after.
    const left = inboxOf(jobRow(row.id)).slice(inbox.length);
    setJob(row.id, { inbox: left.length ? JSON.stringify(left) : null });
  }
  d.cancel = prepared.cancel;
  if (d.stopped) prepared.cancel();
  startClock(d);
  let message;
  try {
    message = await prepared.run(statusSender(d));
  } finally {
    stopClock(d);
    d.cancel = undefined;
    setJob(row.id, { turn_open: 0, asks: null });
  }

  // The rest of what it wrote this turn (its text before each tool is in the record already).
  keepWords(d);
  if (d.stopped) {
    endJob(row.id, "stopped", t("You stopped it"));
    return "end";
  }
  if (message.status === "stopped") {
    if (d.cut && d.limit) endJob(row.id, "limit", limitText(row, d.limit), { limit: d.limit });
    else endJob(row.id, "stopped", t("It was stopped in its chat"));
    return "end";
  }
  if (message.status !== "ok" && message.status !== "truncated") {
    const error = message.error ?? t("No reply came back");
    endJob(row.id, "failed", error, { error });
    return "end";
  }
  if (d.limit) {
    endJob(row.id, "limit", limitText(row, d.limit), { limit: d.limit });
    return "end";
  }
  // The person wrote while it worked: the next turn is their message.
  if (inboxOf(jobRow(row.id)).length) return "again";
  // finish_job, or a turn that used no tools at all: there's nothing left it means to do.
  if (d.finished || !d.actions) {
    endJob(row.id, "done", t("Finished"), { answer: message.text });
    return "end";
  }
  return "again";
}

async function work(d: Driver) {
  for (;;) {
    const row = jobRow(d.jobId);
    if (!row || (row.status !== "queued" && row.status !== "running")) return;
    if (d.stopped) {
      endJob(row.id, "stopped", t("You stopped it"));
      return;
    }
    const limit = limitReached(row);
    if (limit) {
      endJob(row.id, "limit", limitText(row, limit), { limit });
      return;
    }
    // The turn is claimed before any provider is called, together with its step.
    const claimed = tx(() => {
      const current = jobRow(d.jobId);
      if (!current || (current.status !== "queued" && current.status !== "running") || current.turn_open) return null;
      if (!chatCapacityAvailable(current.user_id)) {
        setJob(current.id, { status: "queued" });
        return null;
      }
      db.prepare("UPDATE cowork_jobs SET status = 'running', turn_open = 1, turns = turns + 1, steps = steps + 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), current.id);
      return jobRow(current.id)!;
    });
    if (!claimed) return;
    if ((await turn(d, claimed)) === "end") return;
  }
}

function startDriver(row: JobRow) {
  if (drivers.has(row.id)) return;
  const d: Driver = {
    jobId: row.id, userId: row.user_id, stopped: false, promise: Promise.resolve(), activeSince: null, timers: [],
    waiting: 0, notAllowed: 0, limit: null, refused: 0, cut: false, finished: false, actions: 0, inTool: 0, lastStatus: "", partial: "",
  };
  drivers.set(row.id, d);
  d.promise = inLang(row.language, () => work(d))
    .catch((err) => {
      console.error("[cowork] job failed", err);
      inLang(row.language, () => endJob(row.id, "failed", t("The job couldn't carry on. Try Carry on"), { error: t("The job couldn't carry on. Try Carry on") }));
    })
    .finally(() => {
      clearTimers(d);
      drivers.delete(row.id);
    });
}

const workingFor = (userId: number) => [...drivers.values()].filter((d) => d.userId === userId).length;

/** Starts the jobs that are waiting to work, as far as each person's slots allow. */
export function tickCowork() {
  const rows = db.prepare("SELECT * FROM cowork_jobs WHERE status IN ('queued', 'running') AND turn_open = 0 ORDER BY updated_at LIMIT 100").all() as JobRow[];
  for (const row of rows) {
    if (drivers.has(row.id) || workingFor(row.user_id) >= JOBS_AT_ONCE || !chatCapacityAvailable(row.user_id)) continue;
    startDriver(row);
  }
}

/**
 * At startup: a job caught mid-turn may already have been billed for it, so it waits for the
 * person rather than calling the provider again; one caught between turns goes back in the queue.
 */
export function recoverCowork() {
  const rows = db.prepare("SELECT * FROM cowork_jobs WHERE status IN ('running', 'waiting')").all() as JobRow[];
  for (const row of rows) {
    if (!row.turn_open) {
      setJob(row.id, { status: "queued", asks: null });
      continue;
    }
    inLang(row.language, () => {
      const error = t("The server restarted during a step, so the job paused. Carry on when you're ready");
      setJob(row.id, { status: "interrupted", error, turn_open: 0, asks: null, finished_at: nowIso() });
      addStep(row.id, "end", error, true);
      emailJob(row, { reason: error });
    });
  }
}

export async function waitForCowork() {
  while (drivers.size) await Promise.all([...drivers.values()].map((d) => d.promise));
}

export function startCoworkRunner() {
  recoverCowork();
  const tick = () => {
    try {
      tickCowork();
    } catch (err) {
      console.error("[cowork] runner failed", err);
    }
  };
  tick();
  const timer = setInterval(tick, 5_000);
  timer.unref();
  return () => clearInterval(timer);
}

export const coworkRoutes = new Hono<AppEnv>();
coworkRoutes.use("*", requireUser);

coworkRoutes.get("/cowork", (c) => {
  const rows = db.prepare("SELECT * FROM cowork_jobs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(c.var.user!.id, MAX_KEPT) as JobRow[];
  return c.json({ jobs: rows.map((r) => jobOut(r)) });
});

coworkRoutes.get("/cowork/:id", (c) => {
  const row = ownJob(c.req.param("id"), c.var.user!.id);
  return row ? c.json(jobOut(row, true)) : c.json({ error: t("This job doesn't exist") }, 404);
});

/** Limits from the options offered, or null when they aren't. */
function cleanLimits(value: unknown): { steps: number; minutes: number; spend: number | null } | null {
  const limits = (value ?? {}) as Record<string, unknown>;
  const spend = limits.spend === undefined ? null : limits.spend;
  if (!STEP_CHOICES.includes(limits.steps as number) || !MINUTE_CHOICES.includes(limits.minutes as number) || !SPEND_CHOICES.includes(spend as number | null)) return null;
  return { steps: limits.steps as number, minutes: limits.minutes as number, spend: spend as number | null };
}

function jobInput(body: unknown, userId: number) {
  if (!body || typeof body !== "object") throw new Error(t("Describe the job first"));
  const value = body as Record<string, unknown>;
  const goal = typeof value.goal === "string" ? value.goal.trim() : "";
  if (!goal || goal.length > 50_000) throw new Error(t("Describe the job in under 50000 characters"));
  const key = exactChoice(userId, value.choice);
  if (!key) throw new Error(t("The selected model or thinking level is no longer available"));
  // A job starts with the usual limits unless it says otherwise; they can change on its page.
  const limits = value.limits === undefined ? DEFAULT_LIMITS : cleanLimits(value.limits);
  if (!limits) throw new Error(t("Choose the job's limits from the options"));
  if (value.knowledgeIds !== undefined && !Array.isArray(value.knowledgeIds)) throw new Error(t("Pick the knowledge bases for this chat"));
  const knowledgeIds = [...new Set(((value.knowledgeIds as unknown[]) ?? []).map(String))];
  if (knowledgeIds.some((id) => !canUse(getBase(id), userId))) throw new Error(t("One of those knowledge bases isn't yours to use"));
  const files = pickAttachments(userId, null, value.attachments);
  if (!Array.isArray(files)) throw new Error(files.error);
  const cantRead = unreadable(files, key, keyModelLabel(key, key.model), codeOnSite());
  if (cantRead) throw new Error(cantRead);
  return {
    goal, key, knowledgeIds, attachments: files.map((f) => f.id),
    steps: limits.steps, minutes: limits.minutes, spend: limits.spend, email: value.email === true,
  };
}

coworkRoutes.post("/cowork", async (c) => {
  const userId = c.var.user!.id;
  let input: ReturnType<typeof jobInput>;
  try {
    input = jobInput(await c.req.json(), userId);
  } catch (err) {
    return c.json({ error: err instanceof SyntaxError ? t("Describe the job first") : (err as Error).message }, 400);
  }
  const overLimit = overLimitMessage(allowanceOf(userId));
  if (overLimit) return c.json({ error: overLimit }, 429);
  // Counted and inserted in one synchronous turn after reading the body.
  const counts = db.prepare(
    "SELECT COUNT(*) AS kept, COALESCE(SUM(status IN ('queued', 'running', 'waiting')), 0) AS unfinished FROM cowork_jobs WHERE user_id = ?",
  ).get(userId) as { kept: number; unfinished: number };
  if (counts.unfinished >= MAX_UNFINISHED) return c.json({ error: t("You have {count} jobs that haven't finished. Wait for one or stop it first", { count: MAX_UNFINISHED }) }, 409);
  if (counts.kept >= MAX_KEPT) return c.json({ error: t("You can keep up to {count} jobs. Delete some old ones first", { count: MAX_KEPT }) }, 409);
  const { goal, key, knowledgeIds, attachments, steps, minutes, spend, email } = input;
  const id = randomUUID();
  const now = nowIso();
  const label = keyModelLabel(key, key.model);
  db.prepare(
    `INSERT INTO cowork_jobs (id, user_id, title, goal, key_id, model, effort, model_label, language, knowledge, attachments,
       max_steps, max_minutes, max_spend, email, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(id, userId, titleFrom(goal), goal, key.id, key.model, key.effort, label, lang(), JSON.stringify(knowledgeIds), JSON.stringify(attachments),
    steps, minutes, spend, email ? 1 : 0, now, now);
  addStep(id, "start", t("Started with {model}", { model: label }));
  tickCowork();
  return c.json(jobOut(jobRow(id)!, true));
});

/** Turns its emails on or off, or changes its limits, which apply at once. */
coworkRoutes.patch("/cowork/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  const row = ownJob(c.req.param("id"), c.var.user!.id);
  if (!row) return c.json({ error: t("This job doesn't exist") }, 404);
  if (body?.email !== undefined && typeof body.email !== "boolean") return c.json({ error: t("Choose whether to email you") }, 400);
  const limits = body?.limits === undefined ? undefined : cleanLimits(body.limits);
  if (limits === null) return c.json({ error: t("Choose the job's limits from the options") }, 400);
  if (body?.email === undefined && !limits) return c.json({ error: t("Choose whether to email you") }, 400);
  if (typeof body.email === "boolean") setJob(row.id, { email: body.email ? 1 : 0 });
  if (limits) setJob(row.id, { max_steps: limits.steps, max_minutes: limits.minutes, max_spend: limits.spend });
  return c.json(jobOut(jobRow(row.id)!, true));
});

coworkRoutes.post("/cowork/:id/stop", (c) => {
  const row = ownJob(c.req.param("id"), c.var.user!.id);
  if (!row) return c.json({ error: t("This job doesn't exist") }, 404);
  const d = drivers.get(row.id);
  if (d) {
    d.stopped = true;
    d.cancel?.();
  } else if (ACTIVE.includes(row.status)) {
    endJob(row.id, "stopped", t("You stopped it"));
  }
  return c.json({ ok: true });
});

/**
 * Has a job that stopped carry on in its chat, with its limits starting again from here: with the
 * person's message when they wrote one. Null when it can, else why not and the status to answer with.
 */
function carryOn(row: JobRow, message?: string): { error: string; status: 409 | 429 } | null {
  if (row.conversation_id && getConversation(row.conversation_id)?.deleted_at) return { error: t("The job's chat was deleted, so it can't carry on"), status: 409 };
  if (!exactChoice(row.user_id, { keyId: row.key_id, model: row.model, effort: row.effort })) {
    return { error: t("The selected model or thinking level is no longer available"), status: 409 };
  }
  const overLimit = overLimitMessage(allowanceOf(row.user_id));
  if (overLimit) return { error: overLimit, status: 429 };
  db.prepare(
    `UPDATE cowork_jobs SET status = 'queued', limit_hit = NULL, error = NULL, finished_at = NULL, turn_open = 0, asks = NULL,
       base_steps = steps, base_ms = worked_ms, base_spent = spent, inbox = ?, updated_at = ? WHERE id = ?`,
  ).run(message ? JSON.stringify([message]) : null, nowIso(), row.id);
  addStep(row.id, message ? "message" : "resume", message ?? t("You had it carry on"));
  tickCowork();
  return null;
}

coworkRoutes.post("/cowork/:id/continue", (c) => {
  const row = ownJob(c.req.param("id"), c.var.user!.id);
  if (!row) return c.json({ error: t("This job doesn't exist") }, 404);
  if (ACTIVE.includes(row.status) || drivers.has(row.id)) return c.json({ error: t("This job is still working") }, 409);
  const refused = carryOn(row);
  if (refused) return c.json({ error: refused.error }, refused.status);
  return c.json(jobOut(jobRow(row.id)!, true));
});

/**
 * A message from the person. While the job works it waits for the model's next turn (the model is
 * told to wrap up its step); once the job has stopped or finished, it carries on with it.
 */
coworkRoutes.post("/cowork/:id/messages", async (c) => {
  const body = await c.req.json().catch(() => null);
  const row = ownJob(c.req.param("id"), c.var.user!.id);
  if (!row) return c.json({ error: t("This job doesn't exist") }, 404);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: t("Write a message first") }, 400);
  if (text.length > MAX_MESSAGE_CHARS) return c.json({ error: t("That message is too long") }, 400);
  if (ACTIVE.includes(row.status) || drivers.has(row.id)) {
    const inbox = inboxOf(row);
    if (inbox.length >= MAX_INBOX) return c.json({ error: t("Wait for it to read your earlier messages first") }, 429);
    setJob(row.id, { inbox: JSON.stringify([...inbox, text]) });
    addStep(row.id, "message", text);
  } else {
    const refused = carryOn(row, text);
    if (refused) return c.json({ error: refused.error }, refused.status);
  }
  return c.json(jobOut(jobRow(row.id)!, true));
});

/** The person's answer to a question the job is waiting on: allow: true lets the tool run. */
coworkRoutes.post("/cowork/:id/asks/:askId", async (c) => {
  const row = ownJob(c.req.param("id"), c.var.user!.id);
  if (!row) return c.json({ error: t("This job doesn't exist") }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.allow !== "boolean") return c.json({ error: t("Say whether to allow it") }, 400);
  if (!row.conversation_id || !answerAsk(row.conversation_id, c.req.param("askId"), body.allow)) {
    return c.json({ error: t("That isn't waiting for an answer any more") }, 409);
  }
  return c.json({ ok: true });
});

/** Removes the job from the list; its chat stays. */
coworkRoutes.delete("/cowork/:id", (c) => {
  const row = ownJob(c.req.param("id"), c.var.user!.id);
  if (!row) return c.json({ error: t("This job doesn't exist") }, 404);
  if (ACTIVE.includes(row.status) || drivers.has(row.id)) return c.json({ error: t("Stop this job before deleting it") }, 409);
  db.prepare("DELETE FROM cowork_jobs WHERE id = ?").run(row.id);
  return c.json({ ok: true });
});
