import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons/Icon.tsx";
import type { Choice, ModelChoice } from "../lib/api.ts";
import { compactNumber } from "../lib/format.ts";
import { OptionTitle, Tick } from "./Controls.tsx";
import { EffortSlider } from "./EffortSlider.tsx";

type Props = {
  choices: ModelChoice[];
  value: Choice | null;
  onChange: (choice: Choice) => void;
  disabled?: boolean;
  /** How much of the model's context the chat fills, in tokens; the meter shows once there's a reply. */
  contextUsed?: number | null;
};

/** From here the meter turns amber and the message box suggests a new chat. */
export const CONTEXT_NEARLY_FULL = 0.8;

/**
 * The model for this chat and how hard it thinks: two quiet buttons above the message box. Each
 * opens a small card that floats over the conversation right above it, so opening one moves
 * nothing: the models, ticked, or the thinking slider. One is open at a time.
 */
export function ModelPicker({ choices, value, onChange, disabled, contextUsed }: Props) {
  const [open, setOpen] = useState<"model" | "thinking" | "context" | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const current = choices.find((c) => value && c.keyId === value.keyId && c.model === value.model) ?? choices[0];
  // On a narrow screen the model's name gives way first: it fades out at the edge, never wraps.
  const [nameRef, nameClipped] = useClipped(current?.label);
  const effort =
    current && value && current.efforts.some((e) => e.id === value.effort) ? value.effort : current?.defaultEffort;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    // Pressing anywhere else (the conversation, the message box) puts the panel away.
    const onPointer = (e: PointerEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(null);
  }, [disabled]);

  if (!current) return null;
  const effortLabel = current.efforts.find((e) => e.id === effort)?.label;
  const toggle = (panel: "model" | "thinking" | "context") => setOpen((o) => (o === panel ? null : panel));
  const used = contextUsed && contextUsed > 0 ? contextUsed : null;
  const ratio = used && current.context ? used / current.context : null;

  // Moving to another model keeps the thinking level when that model has it, else takes its own.
  const pickModel = (m: ModelChoice) => {
    onChange({ keyId: m.keyId, model: m.model, effort: m.efforts.some((e) => e.id === effort) ? effort! : m.defaultEffort });
    setOpen(null);
  };

  return (
    <div ref={pickerRef} className="model-picker">
      {choices.length > 1 && (
        <div className="picker-pop is-model" data-open={open === "model"} inert={open !== "model"}>
          <div className="oy-section is-plain model-options" role="radiogroup" aria-label="Model for this chat">
            {choices.map((m) => (
              <button
                key={`${m.keyId}:${m.model}`}
                type="button"
                className="oy-row option-row"
                role="radio"
                aria-checked={m === current}
                onClick={() => pickModel(m)}
              >
                <span className="text">
                  <OptionTitle label={m.label} />
                </span>
                <Tick on={m === current} />
              </button>
            ))}
          </div>
        </div>
      )}
      {current.efforts.length > 1 && effort && (
        <div className="picker-pop is-thinking" data-open={open === "thinking"} inert={open !== "thinking"}>
          <EffortSlider
            levels={current.efforts}
            value={effort}
            onChange={(id) => onChange({ keyId: current.keyId, model: current.model, effort: id })}
          />
        </div>
      )}

      {used && (
        <div className="picker-pop is-context" data-open={open === "context"} inert={open !== "context"}>
          <div className="context-card" role="note">
            <p className="context-card-head">
              <span>Context</span>
              {ratio != null && <span className={`context-card-value${ratio >= CONTEXT_NEARLY_FULL ? " is-full" : ""}`}>{Math.max(1, Math.round(ratio * 100))}% full</span>}
            </p>
            {ratio != null && (
              <span className={`allowance-meter${ratio >= CONTEXT_NEARLY_FULL ? " is-full" : ""}`} aria-hidden="true">
                <span style={{ width: `${Math.min(100, Math.max(1, ratio * 100))}%` }} />
              </span>
            )}
            <p className="context-card-text">
              {ratio != null
                ? `This chat fills ${compactNumber(used)} of the ${compactNumber(current.context!)} tokens ${current.label} reads at once. `
                : `This chat is about ${compactNumber(used)} tokens long so far. `}
              {ratio != null && ratio >= CONTEXT_NEARLY_FULL
                ? "It's nearly full, so start a new chat soon, maybe with a summary of this one"
                : "Each message sends the whole chat again, so long chats cost more and early details can fade"}
            </p>
          </div>
        </div>
      )}

      {choices.length > 1 ? (
        <button
          type="button"
          className="model-line is-button model-name"
          aria-expanded={open === "model"}
          aria-label={`Model: ${current.label}. Change`}
          onClick={() => toggle("model")}
          disabled={disabled}
        >
          <span ref={nameRef} className="model-name-label" data-clipped={nameClipped || undefined}>
            {current.label}
          </span>
          <Icon name="chevron-down" size={16} className={`chev${open === "model" ? "" : " is-open"}`} />
        </button>
      ) : (
        <p className="model-line model-name">
          <span ref={nameRef} className="model-name-label" data-clipped={nameClipped || undefined}>
            {current.label}
          </span>
        </p>
      )}
      {/* Left of Thinking: when it first appears it takes the row's empty middle, so nothing moves. */}
      {used && (
        <button
          type="button"
          className={`model-line is-button context-line${ratio != null && ratio >= CONTEXT_NEARLY_FULL ? " is-full" : ""}`}
          aria-expanded={open === "context"}
          aria-label={ratio != null ? `Context ${Math.round(ratio * 100)}% full. Details` : `About ${compactNumber(used)} tokens of context. Details`}
          onClick={() => toggle("context")}
        >
          <ContextRing ratio={ratio ?? 0} />
          {ratio != null ? `${Math.max(1, Math.round(ratio * 100))}%` : compactNumber(used)}
        </button>
      )}
      {current.efforts.length > 1 && effortLabel && (
        <button
          type="button"
          className="model-line is-button thinking-line"
          aria-expanded={open === "thinking"}
          aria-label={`Thinking: ${effortLabel}. Change`}
          onClick={() => toggle("thinking")}
          disabled={disabled}
        >
          <span className="model-line-muted">Thinking</span>
          {/* As wide as its longest level, so moving the slider never moves the button. */}
          <span className="swap">
            {current.efforts.map((e) => (
              <span key={e.id} className={e.id === effort ? undefined : "reserve"} aria-hidden={e.id === effort ? undefined : true}>
                {e.label.toLowerCase()}
              </span>
            ))}
          </span>
          <Icon name="chevron-down" size={16} className={`chev${open === "thinking" ? "" : " is-open"}`} />
        </button>
      )}
    </div>
  );
}

/** A small ring that fills clockwise as the chat fills the model's context. */
function ContextRing({ ratio }: { ratio: number }) {
  const r = 6;
  const length = 2 * Math.PI * r;
  return (
    <svg className="context-ring" viewBox="0 0 16 16" width={14} height={14} aria-hidden="true">
      <circle cx="8" cy="8" r={r} className="context-ring-track" />
      <circle
        cx="8"
        cy="8"
        r={r}
        className="context-ring-fill"
        strokeDasharray={`${Math.min(1, Math.max(0.03, ratio)) * length} ${length}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

/** A ref for one line of text, and whether that text runs past its edge (so it can fade out there). */
function useClipped(text: string | undefined) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    if (!el) return;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    return () => resize.disconnect();
  }, [el, text]);
  return [setEl, clipped] as const;
}
