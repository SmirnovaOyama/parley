// Questions a reply puts to the person before one of the app's tools runs: reading a page nobody
// linked, keeping a note after the chat has taken in something from outside, or an MCP tool an
// admin set to ask first. The tool call waits (providers await their tools) until the person
// answers on a line in the transcript, the reply is stopped, or ASK_TIMEOUT_MS passes. Questions
// live in memory with the reply they belong to, so a restart loses both.
import { randomUUID } from "node:crypto";

/** What the person sees: the question, exactly what would happen (an address, a note, a tool's input), and why it asks. */
export type Ask = { id: string; kind: "page" | "memory" | "mcp"; question: string; detail: string; reason: string };
/** How it ended: allowed, turned down, nobody answered in time, or the reply was stopped. */
export type Answer = "allow" | "deny" | "timeout" | "stopped";

export const ASK_TIMEOUT_MS = 15 * 60_000;

type Waiting = { ask: Ask; settle: (answer: Answer) => void };
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
): Promise<Answer> {
  if (signal.aborted) return Promise.resolve("stopped");
  return new Promise((resolve) => {
    const ask: Ask = { id: randomUUID(), ...question };
    const entry: Waiting = {
      ask,
      settle: (answer) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        const list = (waiting.get(conversationId) ?? []).filter((w) => w !== entry);
        if (list.length) waiting.set(conversationId, list);
        else waiting.delete(conversationId);
        onChange(asksOf(conversationId));
        resolve(answer);
      },
    };
    const stop = () => entry.settle("stopped");
    const timer = setTimeout(() => entry.settle("timeout"), timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    waiting.set(conversationId, [...(waiting.get(conversationId) ?? []), entry]);
    onChange(asksOf(conversationId));
  });
}

/** The person's answer to one question. False when it isn't waiting any more. */
export function answerAsk(conversationId: string, askId: string, allow: boolean): boolean {
  const entry = waiting.get(conversationId)?.find((w) => w.ask.id === askId);
  if (!entry) return false;
  entry.settle(allow ? "allow" : "deny");
  return true;
}
