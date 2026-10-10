// Projects: a person's folders of chats, each with its own instructions and knowledge bases.
import { chatBases } from "./knowledge.ts";
import { db } from "./db.ts";
import type { PersonalInstructions } from "./instructions.ts";
import type { ConversationRow } from "./chat-store.ts";

export const MAX_PROJECTS = 200;
export const MAX_PROJECT_INSTRUCTIONS = 8000;

export type ProjectRow = { id: string; user_id: number; name: string; instructions: string; created_at: string; updated_at: string };

export function ownProject(id: unknown, userId: number): ProjectRow | undefined {
  if (typeof id !== "string" || !id) return undefined;
  return db.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?").get(id, userId) as ProjectRow | undefined;
}

/**
 * What a chat is told now: the person's instructions for it, the project it's in, and the knowledge
 * bases it can search. A project or knowledge it no longer has is said once (null, []), and only
 * when the model was told of one before, so a chat that never had either keeps its old shape.
 */
export function chatSetting(
  personal: PersonalInstructions,
  userId: number,
  conversationId: string | null,
  projectId: string | null,
  before?: PersonalInstructions,
): PersonalInstructions {
  const project = projectId ? ownProject(projectId, userId) : undefined;
  const knowledge = chatBases(userId, conversationId, project?.id ?? null).map((k) => k.name);
  return {
    aboutMe: personal.aboutMe,
    answerStyle: personal.answerStyle,
    ...(project ? { project: { name: project.name, instructions: project.instructions } } : before?.project !== undefined ? { project: null } : {}),
    ...(knowledge.length ? { knowledge } : before?.knowledge !== undefined ? { knowledge: [] } : {}),
  };
}

/** The same, for a chat that exists. */
export const settingOf = (conv: ConversationRow, personal: PersonalInstructions, before?: PersonalInstructions) =>
  chatSetting(personal, conv.user_id, conv.id, conv.project_id, before);
