import { useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Icon } from "../icons/Icon.tsx";
import { t } from "../lib/i18n.ts";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "placeholder"> & {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
};

// One hand-drawn stroke, a little off level, used for both the resting line and the ink.
const RULE = "M1.5 4.6C42 3.4 86 5.4 132 4.3s96-1.4 140 .2c17 .6 32 .3 46.5-.5";

/**
 * A field drawn as a single line: the label rests on it and floats up on focus or input,
 * and focus draws an ink line over it from left to right.
 */
export function LineField({ id, label, hint, error, ...input }: Props) {
  return (
    <div className="line-field">
      <div className="line-field-box">
        <input id={id} placeholder=" " aria-invalid={error ? true : undefined} aria-describedby={hint || error ? `${id}-hint` : undefined} {...input} />
        <label htmlFor={id}>{label}</label>
        <svg className="line-field-rule" viewBox="0 0 320 8" preserveAspectRatio="none" aria-hidden="true">
          <path className="base" d={RULE} />
          <path className="ink" d={RULE} pathLength={1} />
        </svg>
      </div>
      {(error || hint) && (
        <p id={`${id}-hint`} className={`line-field-hint${error ? " is-error" : ""}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

type AreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "placeholder" | "rows"> & {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
};

/** The same line field for longer text: it grows with what's written, the line staying under it. */
export function LineArea({ id, label, hint, error, value, ...area }: AreaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <div className="line-field">
      <div className="line-field-box">
        <textarea
          ref={ref}
          id={id}
          rows={1}
          placeholder=" "
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={hint || error ? `${id}-hint` : undefined}
          {...area}
        />
        <label htmlFor={id}>{label}</label>
        <svg className="line-field-rule" viewBox="0 0 320 8" preserveAspectRatio="none" aria-hidden="true">
          <path className="base" d={RULE} />
          <path className="ink" d={RULE} pathLength={1} />
        </svg>
      </div>
      {(error || hint) && (
        <p id={`${id}-hint`} className={`line-field-hint${error ? " is-error" : ""}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

type SearchProps = {
  id: string;
  /** What to search, shown in the field until something is typed. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
};

/**
 * A search on the same line: a magnifier at its start and a cross at its end that clears it, as
 * Escape does. Words still being put together in an input method (pinyin, kana) aren't passed on
 * until they're chosen, so the search doesn't run on half-typed syllables.
 */
export function SearchLine({ id, label, value, onChange, className }: SearchProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const clear = () => {
    setDraft("");
    onChange("");
  };

  return (
    <div className={`line-field search-line${className ? ` ${className}` : ""}`}>
      <div className="line-field-box">
        <Icon name="search" size={18} className="search-line-icon" />
        <input
          ref={ref}
          id={id}
          type="search"
          placeholder={label}
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (!(e.nativeEvent as InputEvent).isComposing) onChange(e.target.value);
          }}
          onCompositionEnd={(e) => onChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && draft) {
              e.preventDefault();
              clear();
            }
          }}
        />
        {draft && (
          <button
            type="button"
            className="search-line-clear"
            aria-label={t("Clear the search")}
            onClick={() => {
              clear();
              ref.current?.focus();
            }}
          >
            <Icon name="close" size={16} />
          </button>
        )}
        <svg className="line-field-rule" viewBox="0 0 320 8" preserveAspectRatio="none" aria-hidden="true">
          <path className="base" d={RULE} />
          <path className="ink" d={RULE} pathLength={1} />
        </svg>
      </div>
    </div>
  );
}
