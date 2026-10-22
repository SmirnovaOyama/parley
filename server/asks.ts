// Questions a reply puts to the person and waits on. Most come before one of the app's tools runs:
// reading a page nobody linked, keeping a note after the chat has taken in something from outside,
// or an MCP tool an admin set to ask first. The model can also ask a question of its own
// (ask_person, with a few choices) or ask for a plan's OK (propose_plan): those answers carry the
// choice or words the person gave, or the steps as they left them. The tool call waits (providers
// await their tools) until the person answers on a line in the transcript, the reply is stopped,
// or ASK_TIMEOUT_MS passes. Questions live in memory with the reply they belong to, so a restart
// loses both.
import { randomUUID } from "node:crypto";

/**
 * What the person sees: the question, exactly what would happen (an address, a note, a tool's
 * input), and why it asks. A question of the model's own comes with its choices; a plan, with
 * its steps.
 */
export type Ask = {
  id: string;
  kind: "page" | "memory" | "mcp" | "question" | "plan";
  question: string;
  detail: string;
  reason: string;
  options?: string[];
  steps?: string[];
};
/** How it ended: allowed (or answered), turned down (left to the model, or a plan sent back), nobody answered in time, or the reply was stopped. */
export type Answer = "allow" | "deny" | "timeout" | "stopped";
/** The answer, with what the person wrote: their choice or own words, a comment on a plan sent back, a plan's steps as approved. */
export type Reply = { answer: Answer; text?: string; steps?: string[] };

export const ASK_TIMEOUT_MS = 15 * 60_000;

type Waiting = { ask: Ask; settle: (reply: Reply) => void };
/** By conversation. Only one reply is written in a chat at a time, so they're all that reply's. */
const waiting = new Map<string, Waiting[]>();

/** The questions waiting in a chat, oldest first. */
export const asksOf = (conversationId: string): Ask[] => (waiting.get(conversationId) ?? []).map((w) => w.ask);

/**
 * Asks the person and resolves with their answer. `onChange` gets the chat's waiting questions
 * each time one is added or settled, to send to the browser.
 */
export function askPerson(
  conversationId: string,
  question: Omit<Ask, "id">,
  signal: AbortSignal,
  onChange: (asks: Ask[]) => void,
  timeoutMs = ASK_TIMEOUT_MS,
): Promise<Reply> {
  if (signal.aborted) return Promise.resolve({ answer: "stopped" });
  return new Promise((resolve) => {
    const ask: Ask = { id: randomUUID(), ...question };
    const entry: Waiting = {
      ask,
      settle: (reply) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        const list = (waiting.get(conversationId) ?? []).filter((w) => w !== entry);
        if (list.length) waiting.set(conversationId, list);
        else waiting.delete(conversationId);
        onChange(asksOf(conversationId));
        resolve(reply);
      },
    };
    const stop = () => entry.settle({ answer: "stopped" });
    const timer = setTimeout(() => entry.settle({ answer: "timeout" }), timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    waiting.set(conversationId, [...(waiting.get(conversationId) ?? []), entry]);
    onChange(asksOf(conversationId));
  });
}

/** The most an answer's words, or one step of a plan, may hold. */
export const MAX_ANSWER_CHARS = 2000;
export const MAX_STEP_CHARS = 300;
export const MAX_STEPS = 10;

/** A plan's steps as the person left them: trimmed, empty ones dropped, at most MAX_STEPS. Null when they aren't a list of words. */
export function cleanSteps(steps: unknown): string[] | null {
  if (!Array.isArray(steps) || steps.some((s) => typeof s !== "string")) return null;
  return (steps as string[]).map((s) => s.replace(/\s+/g, " ").trim().slice(0, MAX_STEP_CHARS)).filter(Boolean).slice(0, MAX_STEPS);
}

/**
 * The person's answer to one question: whether they allowed it (for a question of the model's,
 * answered it; for a plan, approved it), with their words or a plan's steps. "Not waiting" when
 * it isn't any more; "Incomplete" when a question was answered without an answer, or a plan
 * approved without steps.
 */
export function answerAsk(
  conversationId: string,
  askId: string,
  reply: { allow: boolean; text?: string; steps?: string[] },
): "ok" | "not waiting" | "incomplete" {
  const entry = waiting.get(conversationId)?.find((w) => w.ask.id === askId);
  if (!entry) return "not waiting";
  const text = reply.text?.trim().slice(0, MAX_ANSWER_CHARS) || undefined;
  if (entry.ask.kind === "question" && reply.allow && !text) return "incomplete";
  const steps = entry.ask.kind === "plan" && reply.allow ? (reply.steps ? cleanSteps(reply.steps) : entry.ask.steps) : undefined;
  if (entry.ask.kind === "plan" && reply.allow && !steps?.length) return "incomplete";
  entry.settle({ answer: reply.allow ? "allow" : "deny", ...(text ? { text } : {}), ...(steps ? { steps } : {}) });
  return "ok";
}
