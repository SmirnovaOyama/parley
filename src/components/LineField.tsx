import { useLayoutEffect, useRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

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
