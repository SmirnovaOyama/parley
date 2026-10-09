import { useEffect, useState, type FormEvent } from "react";
import type { Instructions } from "../lib/api.ts";
import { Advisory } from "./Feedback.tsx";
import { LineArea } from "./LineField.tsx";

export const MAX_INSTRUCTION_CHARS = 1500;

/** Counts down only near the limit. */
export const charsLeft = (text: string) => {
  const left = MAX_INSTRUCTION_CHARS - text.length;
  return left <= 200 ? `${left} characters left` : undefined;
};

type Props = {
  /** Field ids must be unique on the page. */
  idPrefix: string;
  /** Starts from these each time `open` turns on. */
  value: Instructions;
  open: boolean;
  note: string;
  onSave: (next: Instructions) => Promise<void>;
  onCancel: () => void;
};

/** About you and how to answer, as two growing line fields with Save and Cancel. */
export function InstructionsForm({ idPrefix, value, open, note, onSave, onCancel }: Props) {
  const [aboutMe, setAboutMe] = useState(value.aboutMe);
  const [answerStyle, setAnswerStyle] = useState(value.answerStyle);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setAboutMe(value.aboutMe);
      setAnswerStyle(value.answerStyle);
      setError(null);
    }
  }, [open, value]);

  const unchanged = aboutMe.trim() === value.aboutMe && answerStyle.trim() === value.answerStyle;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({ aboutMe: aboutMe.trim(), answerStyle: answerStyle.trim() });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="instructions-form" onSubmit={save}>
      <LineArea
        id={`${idPrefix}-about`}
        label="What should the AI know about you?"
        value={aboutMe}
        maxLength={MAX_INSTRUCTION_CHARS}
        onChange={(e) => setAboutMe(e.target.value)}
        hint={charsLeft(aboutMe)}
      />
      <LineArea
        id={`${idPrefix}-style`}
        label="How should it answer?"
        value={answerStyle}
        maxLength={MAX_INSTRUCTION_CHARS}
        onChange={(e) => setAnswerStyle(e.target.value)}
        hint={charsLeft(answerStyle)}
      />
      {error && <Advisory>{error}</Advisory>}
      <p className="panel-note">{note}</p>
      <div className="form-page-actions">
        <button type="submit" className="btn-primary" disabled={busy || unchanged}>
          Save
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
