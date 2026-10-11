// What a chat is told: the site's instructions, then the person's own for that chat. Each chat
// has its own pair, copied from the persona new chats start as (or picked on its settings page).
import { db, getSettings } from "./db.ts";

export const MAX_INSTRUCTION_CHARS = 1500;

/**
 * What a chat is told about the person and its setting. project and knowledge are there only for
 * chats that have had them: the project the chat is in (null once it's moved out) and the names of
 * the knowledge bases it can search ([] once none are). Chats that never had them keep the shape
 * they were sealed with, so their replays never change.
 */
export type PersonalInstructions = {
  aboutMe: string;
  answerStyle: string;
  project?: { name: string; instructions: string } | null;
  knowledge?: string[];
};

const EMPTY: PersonalInstructions = { aboutMe: "", answerStyle: "" };

/** What new chats start with: the persona the person picked for them (Settings › Personas), if any. */
export function getInstructions(userId: number): PersonalInstructions {
  const row = db
    .prepare("SELECT p.about_me, p.answer_style FROM users u JOIN personas p ON p.id = u.persona_id WHERE u.id = ?")
    .get(userId) as { about_me: string; answer_style: string } | undefined;
  return { aboutMe: row?.about_me ?? "", answerStyle: row?.answer_style ?? "" };
}

export type Persona = { id: string; name: string; aboutMe: string; answerStyle: string; /** New chats start as this one. */ forNewChats: boolean };

/** A person's personas, oldest first. */
export function personasOf(userId: number): Persona[] {
  const current = (db.prepare("SELECT persona_id FROM users WHERE id = ?").get(userId) as { persona_id: string | null } | undefined)?.persona_id;
  const rows = db.prepare("SELECT id, name, about_me, answer_style FROM personas WHERE user_id = ? ORDER BY created_at").all(userId) as {
    id: string;
    name: string;
    about_me: string;
    answer_style: string;
  }[];
  return rows.map((p) => ({ id: p.id, name: p.name, aboutMe: p.about_me, answerStyle: p.answer_style, forNewChats: p.id === current }));
}

export function parseInstructions(json: string | null | undefined): PersonalInstructions {
  if (!json) return EMPTY;
  try {
    const v = JSON.parse(json) as Partial<PersonalInstructions>;
    const out: PersonalInstructions = { aboutMe: String(v.aboutMe ?? ""), answerStyle: String(v.answerStyle ?? "") };
    if (v.project !== undefined) {
      out.project = v.project ? { name: String(v.project.name ?? ""), instructions: String(v.project.instructions ?? "") } : null;
    }
    if (Array.isArray(v.knowledge)) out.knowledge = v.knowledge.map(String);
    return out;
  } catch {
    return EMPTY;
  }
}

/** Only the person's own two, as they're edited (Account, a chat's settings). */
export const personalOnly = (i: PersonalInstructions): PersonalInstructions => ({ aboutMe: i.aboutMe, answerStyle: i.answerStyle });

/** Trimmed and checked; null when something's too long. */
export function cleanInstructions(input: unknown): PersonalInstructions | null {
  const v = (input ?? {}) as Partial<Record<keyof PersonalInstructions, unknown>>;
  const out = { aboutMe: String(v.aboutMe ?? "").trim(), answerStyle: String(v.answerStyle ?? "").trim() };
  return out.aboutMe.length > MAX_INSTRUCTION_CHARS || out.answerStyle.length > MAX_INSTRUCTION_CHARS ? null : out;
}

export const instructionsJson = (i: PersonalInstructions) =>
  JSON.stringify({
    aboutMe: i.aboutMe,
    answerStyle: i.answerStyle,
    ...(i.project !== undefined ? { project: i.project } : {}),
    ...(i.knowledge !== undefined ? { knowledge: i.knowledge } : {}),
  });

export const sameInstructions = (a: PersonalInstructions, b: PersonalInstructions) => instructionsJson(a) === instructionsJson(b);

function block(i: PersonalInstructions): string[] {
  const parts: string[] = [];
  if (i.aboutMe) parts.push(`<about_the_person>\n${i.aboutMe}\n</about_the_person>`);
  if (i.answerStyle) parts.push(`<how_to_answer>\n${i.answerStyle}\n</how_to_answer>`);
  return parts;
}

/** The project a chat is in and the knowledge it can search, as blocks for the prompt or a note. */
function settingBlocks(chat: PersonalInstructions): string[] {
  const parts: string[] = [];
  if (chat.project) {
    const name = chat.project.name.replace(/"/g, "'");
    parts.push(
      chat.project.instructions
        ? `<project name="${name}">\nThis chat is part of the person's project “${chat.project.name}”. Its instructions:\n${chat.project.instructions}\n</project>`
        : `<project name="${name}">\nThis chat is part of the person's project “${chat.project.name}”.\n</project>`,
    );
  } else if (chat.project === null) parts.push("This chat isn't part of a project any more.");
  if (chat.knowledge?.length) {
    parts.push(`<knowledge>\nKnowledge bases connected to this chat, which search_knowledge looks through: ${chat.knowledge.join(", ")}\n</knowledge>`);
  } else if (chat.knowledge) parts.push("No knowledge bases are connected to this chat now.");
  return parts;
}

/**
 * The system prompt a new chat is sealed with. The site's instructions come first and win; the
 * person's text is framed as theirs, to follow where it fits. Then the project and knowledge the
 * chat starts with, and what the AI remembers about the person when memory is on.
 */
export function systemPromptFor(chat: PersonalInstructions, memory?: string | null): string {
  const site = getSettings().systemPrompt;
  const parts = block(chat);
  return [
    site,
    ...(parts.length
      ? [
          "The person you're talking with wrote the following about themselves and how they like answers. " +
            "Follow it where it fits, unless it conflicts with the instructions above.",
          ...parts,
        ]
      : []),
    ...settingBlocks(chat),
    ...(memory ? [memory] : []),
  ].join("\n\n");
}

/**
 * The system note for instructions changed mid-chat. Always worded the same way for the same
 * instructions, so replaying a chat sends exactly what the model saw.
 */
export function instructionsNote(chat: PersonalInstructions): string {
  const parts = block(chat);
  // A note that also carries the project or knowledge restates everything in force from here.
  if (chat.project !== undefined || chat.knowledge !== undefined) {
    return [
      "The setting of this chat has changed. From here on, follow what's below instead of what came before, " +
        "where it fits and unless it conflicts with the instructions at the start.",
      ...(parts.length ? parts : ["The person has no instructions of their own for this chat."]),
      ...settingBlocks(chat),
    ].join("\n\n");
  }
  if (!parts.length) {
    return "The person has removed their instructions for this chat. From here on, disregard what they wrote earlier about themselves and how to answer.";
  }
  return [
    "The person has updated their instructions for this chat. From here on, follow these instead of what they wrote earlier, " +
      "where it fits and unless it conflicts with the instructions at the start.",
    ...parts,
  ].join("\n\n");
}
