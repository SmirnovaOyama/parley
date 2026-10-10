// Oyama form controls: Segmented, Switch, Tabs, Tick and a labelled Field.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

// ── Segmented ───────────────────────────────────────────────────────

type SegmentedProps<K extends string> = {
  options: readonly { id: K; label: ReactNode }[];
  value: K;
  onChange: (id: K) => void;
  "aria-label"?: string;
};

/** Two to four short options on a pill track; a raised thumb slides to the chosen one. */
export function Segmented<K extends string>({ options, value, onChange, ...rest }: SegmentedProps<K>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const on = trackRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (on) setThumb({ left: on.offsetLeft, width: on.offsetWidth });
  }, [value, options]);

  return (
    <div className="oy-segmented" role="tablist" aria-label={rest["aria-label"]} ref={trackRef}>
      {thumb && <span className="thumb chip-slide" aria-hidden="true" style={thumb} />}
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className="seg"
          role="tab"
          aria-selected={o.id === value}
          onClick={() => onChange(o.id)}
        >
          {/* A bold copy holds the width, so choosing one never nudges the others (as in Tabs). */}
          <span className="seg-label">
            <span className="reserve" aria-hidden="true">
              {o.label}
            </span>
            <span>{o.label}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Switch ──────────────────────────────────────────────────────────

type SwitchProps = { checked: boolean; onChange: (next: boolean) => void; label?: string; id?: string; disabled?: boolean };

export function Switch({ checked, onChange, label, id, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      id={id}
      className="oy-switch switch-track"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

// ── Tabs (page-level) ───────────────────────────────────────────────

type TabsProps<K extends string> = {
  tabs: readonly { id: K; label: string }[];
  value: K;
  onChange: (id: K) => void;
};

/** Labels on a hairline; one terracotta bar slides and stretches to the chosen tab. */
export function Tabs<K extends string>({ tabs, value, onChange }: TabsProps<K>) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const on = stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (on) setBar({ left: on.offsetLeft, width: on.offsetWidth });
  }, [value, tabs]);

  return (
    <div className="oy-tabs" role="tablist" ref={stripRef}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          className="oy-tab"
          role="tab"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
        >
          <span className="oy-tab-label">
            <span className="reserve" aria-hidden="true">
              {t.label}
            </span>
            <span className="shown">{t.label}</span>
          </span>
        </button>
      ))}
      {bar && <span className="oy-tabs-bar chip-slide" aria-hidden="true" style={bar} />}
    </div>
  );
}

// ── Tick ────────────────────────────────────────────────────────────

/** The one tick: drawn short leg first when it turns on, rubbed out when it turns off. */
export function Tick({ on, size = 18 }: { on: boolean; size?: number }) {
  return (
    <svg
      className="tick-draw text-accent"
      data-on={on}
      viewBox="0 0 24 24"
      style={{ width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d="M5.3 12.7c1.5 1.3 2.9 2.8 4.2 4.4 2.9-3.7 6-7.2 9.3-10.5" />
    </svg>
  );
}

// ── Option list ─────────────────────────────────────────────────────

/** A choice's name. It turns medium when chosen; a medium copy holds the room, so the row never
 *  rewraps or grows when it's ticked. */
export function OptionTitle({ label }: { label: ReactNode }) {
  return (
    <span className="title swap">
      <span className="reserve" aria-hidden="true">
        {label}
      </span>
      <span>{label}</span>
    </span>
  );
}

type OptionListProps<K extends string> = {
  label: string;
  /** `features`: what a choice can do, each shown with a small quiet tick under its name.
   *  `disabled`: there but not available now (dimmed rather than taken away, so rows never jump). */
  options: readonly { id: K; label: string; detail?: string; features?: readonly string[]; disabled?: boolean }[];
  value: K;
  onChange: (id: K) => void;
};

/** A short list of choices as plain rows; the chosen one carries the tick. */
export function OptionList<K extends string>({ label, options, value, onChange }: OptionListProps<K>) {
  return (
    <div className="oy-group" role="radiogroup" aria-label={label}>
      <p className="oy-overline">{label}</p>
      <div className="oy-section is-plain">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className="oy-row option-row"
            role="radio"
            aria-checked={o.id === value}
            disabled={o.disabled}
            onClick={() => onChange(o.id)}
          >
            <span className="text">
              <OptionTitle label={o.label} />
              {o.detail && <span className="desc">{o.detail}</span>}
              {o.features?.length ? (
                <span className="option-features">
                  {o.features.map((f) => (
                    <span key={f} className="option-feature">
                      {f}
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5.3 12.7c1.5 1.3 2.9 2.8 4.2 4.4 2.9-3.7 6-7.2 9.3-10.5" />
                      </svg>
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
            <Tick on={o.id === value} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Check list ──────────────────────────────────────────────────────

type CheckListProps = {
  label: string;
  options: readonly { id: string; label: string; detail?: ReactNode }[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  /** Shown instead of rows when there's nothing to pick. */
  empty?: string;
};

/** Several choices as plain rows; each chosen one carries a tick. */
export function CheckList({ label, options, values, onChange, empty }: CheckListProps) {
  const toggle = (id: string) => onChange(values.includes(id) ? values.filter((v) => v !== id) : [...values, id]);
  return (
    <div className="oy-group" role="group" aria-label={label}>
      <p className="oy-overline">{label}</p>
      {options.length === 0 ? (
        <p className="text-muted check-empty">{empty}</p>
      ) : (
        <div className="oy-section is-plain">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className="oy-row option-row"
              role="checkbox"
              aria-checked={values.includes(o.id)}
              onClick={() => toggle(o.id)}
            >
              <span className="text">
                <OptionTitle label={o.label} />
                {o.detail && <span className="desc">{o.detail}</span>}
              </span>
              <Tick on={values.includes(o.id)} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Field ───────────────────────────────────────────────────────────

type FieldProps = { label: string; htmlFor: string; hint?: ReactNode; error?: string | null; children: ReactNode };

export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className="field">
      <label className="oy-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <p className="oy-field-hint text-danger">{error}</p> : hint ? <p className="oy-field-hint">{hint}</p> : null}
    </div>
  );
}
