import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { Icon } from "../icons/Icon.tsx";
import type { Choice, ModelChoice } from "../lib/api.ts";
import { t } from "../lib/i18n.ts";
import { EffortSlider } from "./EffortSlider.tsx";
import "../styles/inline-model-picker.css";

type Props = {
  choices: ModelChoice[];
  value: Choice | null;
  onChange: (choice: Choice) => void;
  disabled?: boolean;
  label: string;
};

/** Model choices expand in the page, with the chat's thinking slider in reach below them */
export function InlineModelPicker({ choices, value, onChange, disabled = false, label }: Props) {
  const id = useId();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const current = choices.find((choice) => choice.keyId === value?.keyId && choice.model === value.model);
  const name = current?.label ?? value?.model ?? t("Choose a model");
  const unavailable = disabled || choices.length === 0;
  const readOnly = choices.length === 1 && !!current && current.efforts.some((level) => level.id === value?.effort);
  const canExpand = !unavailable && !readOnly;

  useEffect(() => {
    if (!canExpand && detailsRef.current) detailsRef.current.open = false;
  }, [canExpand]);

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
    summaryRef.current?.focus({ preventScroll: true });
  };
  const pick = (choice: ModelChoice) => {
    if (disabled) return;
    onChange({
      keyId: choice.keyId, model: choice.model,
      effort: value && choice.efforts.some((level) => level.id === value.effort) ? value.effort : choice.defaultEffort,
    });
    close();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key === "Escape" && detailsRef.current?.open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return (
    <div className="inline-model-picker" data-disabled={disabled || undefined}>
      <details ref={detailsRef} className="inline-model-disclosure" onKeyDown={onKeyDown}>
        <summary
          ref={summaryRef}
          className="inline-model-summary"
          data-read-only={readOnly || undefined}
          aria-label={t("{label}: {model}", { label, model: name })}
          aria-disabled={!canExpand || undefined}
          tabIndex={canExpand ? 0 : -1}
          onClick={(event) => { if (!canExpand) event.preventDefault(); }}
          onKeyDown={(event) => { if (!canExpand && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }}
        >
          <span className="inline-model-name">{name}</span>
          <span className="inline-model-change" aria-hidden="true">{t("Change")}<Icon name="chevron-down" size={16} /></span>
        </summary>
        <fieldset className="inline-model-options" disabled={disabled}>
          <legend className="visually-hidden">{label}</legend>
          {choices.map((choice, index) => {
            const selected = choice === current;
            return (
              <label className="inline-model-option" key={`${choice.keyId}:${choice.model}`} htmlFor={`${id}-model-${index}`}>
                <input
                  id={`${id}-model-${index}`}
                  type="radio"
                  name={`${id}-model`}
                  value={`${choice.keyId}:${choice.model}`}
                  checked={selected}
                  onChange={() => pick(choice)}
                  // Reselecting the same model also repairs a thinking level it no longer offers
                  onClick={() => { if (selected) pick(choice); }}
                />
                <span>{choice.label}</span>
              </label>
            );
          })}
        </fieldset>
      </details>
      {current && current.efforts.length > 1 && (
        <EffortSlider
          levels={current.efforts}
          // A level this model doesn't have shows as its lowest, and any stop picked mends it.
          value={value?.effort ?? ""}
          onChange={(effort) => onChange({ keyId: current.keyId, model: current.model, effort })}
          label={t("{label}: {thinking}", { label, thinking: t("Thinking") })}
          disabled={disabled}
        />
      )}
    </div>
  );
}
