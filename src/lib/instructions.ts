// What a person writes about themselves and how the AI should answer: a persona's, or one chat's own.

export const MAX_INSTRUCTION_CHARS = 1500;

/** A field's hint, which counts down near the limit. There's always one, so the line under the
 *  field never comes and goes as you type. */
export const charsLeft = (text: string, otherwise: string) => {
  const left = MAX_INSTRUCTION_CHARS - text.length;
  return left <= 200 ? `${left} characters left` : otherwise;
};

export const ABOUT_HINT = "Your work, what you're learning, what you're after";
export const STYLE_HINT = "Length, tone, language, format";

/** A persona's words in a line, for its row. */
export const instructionsSummary = (i: { aboutMe: string; answerStyle: string }) =>
  [i.aboutMe, i.answerStyle].find((t) => t.trim())?.replace(/\s+/g, " ") ?? null;
