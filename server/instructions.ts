// What a chat is told: the site's instructions, then the person's own for that chat. Each chat
// has its own pair, copied from the person's Account defaults when it starts.
import { db, getSettings } from "./db.ts";

export const MAX_INSTRUCTION_CHARS = 1500;

export type PersonalInstructions = { aboutMe: string; answerStyle: string };

const EMPTY: PersonalInstructions = { aboutMe: "", answerStyle: "" };

/** The person's defaults for new chats (set under Account). */
export function getInstructions(userId: number): PersonalInstructions {
  const row = db.prepare("SELECT about_me, answer_style FROM users WHERE id = ?").get(userId) as
    | { about_me: string | null; answer_style: string | null }
    | undefined;
  return { aboutMe: row?.about_me ?? "", answerStyle: row?.answer_style ?? "" };
}

export function parseInstructions(json: string | null | undefined): PersonalInstructions {
  if (!json) return EMPTY;
  try {
    const v = JSON.parse(json) as Partial<PersonalInstructions>;
    return { aboutMe: String(v.aboutMe ?? ""), answerStyle: String(v.answerStyle ?? "") };
  } catch {
    return EMPTY;
  }
}

/** Trimmed and checked; null when something's too long. */
export function cleanInstructions(input: unknown): PersonalInstructions | null {
  const v = (input ?? {}) as Partial<Record<keyof PersonalInstructions, unknown>>;
  const out = { aboutMe: String(v.aboutMe ?? "").trim(), answerStyle: String(v.answerStyle ?? "").trim() };
  return out.aboutMe.length > MAX_INSTRUCTION_CHARS || out.answerStyle.length > MAX_INSTRUCTION_CHARS ? null : out;
}

export const instructionsJson = (i: PersonalInstructions) => JSON.stringify({ aboutMe: i.aboutMe, answerStyle: i.answerStyle });

export const sameInstructions = (a: PersonalInstructions, b: PersonalInstructions) =>
  a.aboutMe === b.aboutMe && a.answerStyle === b.answerStyle;

function block(i: PersonalInstructions): string[] {
  const parts: string[] = [];
  if (i.aboutMe) parts.push(`<about_the_person>\n${i.aboutMe}\n</about_the_person>`);
  if (i.answerStyle) parts.push(`<how_to_answer>\n${i.answerStyle}\n</how_to_answer>`);
  return parts;
}

/**
 * The system prompt a new chat is sealed with. The site's instructions come first and win; the
 * person's text is framed as theirs, to follow where it fits.
 */
export function systemPromptFor(chat: PersonalInstructions): string {
  const site = getSettings().systemPrompt;
  const parts = block(chat);
  if (!parts.length) return site;
  return [
    site,
    "The person you're talking with wrote the following about themselves and how they like answers. " +
      "Follow it where it fits, unless it conflicts with the instructions above.",
    ...parts,
  ].join("\n\n");
}

/**
 * The system note for instructions changed mid-chat. Always worded the same way for the same
 * instructions, so replaying a chat sends exactly what the model saw.
 */
export function instructionsNote(chat: PersonalInstructions): string {
  const parts = block(chat);
  if (!parts.length) {
    return "The person has removed their instructions for this chat. From here on, disregard what they wrote earlier about themselves and how to answer.";
  }
  return [
    "The person has updated their instructions for this chat. From here on, follow these instead of what they wrote earlier, " +
      "where it fits and unless it conflicts with the instructions at the start.",
    ...parts,
  ].join("\n\n");
}
