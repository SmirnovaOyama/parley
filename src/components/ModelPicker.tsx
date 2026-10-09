import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons/Icon.tsx";
import type { Choice, ModelChoice } from "../lib/api.ts";
import { Tick } from "./Controls.tsx";
import { EffortSlider } from "./EffortSlider.tsx";

type Props = { choices: ModelChoice[]; value: Choice | null; onChange: (choice: Choice) => void; disabled?: boolean };

/**
 * The model for this chat and how hard it thinks: two quiet buttons above the message box. Each
 * opens a small card that floats over the conversation right above it, so opening one moves
 * nothing: the models, ticked, or the thinking slider. One is open at a time.
 */
export function ModelPicker({ choices, value, onChange, disabled }: Props) {
  const [open, setOpen] = useState<"model" | "thinking" | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const current = choices.find((c) => value && c.keyId === value.keyId && c.model === value.model) ?? choices[0];
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
  const toggle = (panel: "model" | "thinking") => setOpen((o) => (o === panel ? null : panel));

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
                  <span className="title">{m.label}</span>
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

      {choices.length > 1 ? (
        <button
          type="button"
          className="model-line is-button"
          aria-expanded={open === "model"}
          aria-label={`Model: ${current.label}. Change`}
          onClick={() => toggle("model")}
          disabled={disabled}
        >
          {current.label}
          <Icon name="chevron-down" size={16} className={`chev${open === "model" ? "" : " is-open"}`} />
        </button>
      ) : (
        <p className="model-line">{current.label}</p>
      )}
      {current.efforts.length > 1 && effortLabel && (
        <button
          type="button"
          className="model-line is-button"
          aria-expanded={open === "thinking"}
          aria-label={`Thinking: ${effortLabel}. Change`}
          onClick={() => toggle("thinking")}
          disabled={disabled}
        >
          <span className="model-line-muted">Thinking</span>
          {effortLabel.toLowerCase()}
          <Icon name="chevron-down" size={16} className={`chev${open === "thinking" ? "" : " is-open"}`} />
        </button>
      )}
    </div>
  );
}
