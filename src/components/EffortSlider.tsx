import { useRef, type KeyboardEvent, type PointerEvent } from "react";

type Level = { id: string; label: string };

type Props = {
  levels: Level[];
  value: string;
  onChange: (id: string) => void;
};

/** Track padding: the thumb's half-width, so the first and last stops sit fully on the track. */
const PAD = 14;
const at = (i: number, n: number) => `calc(${PAD}px + (100% - ${PAD * 2}px) * ${n > 1 ? i / (n - 1) : 0.5})`;

/**
 * How hard the model thinks, as a slider from faster to smarter: a slim rail with a stop per level,
 * a clay fill up to a round thumb that sits on the chosen stop.
 * Click or drag along the track, or use the arrow keys; it always lands on a level.
 */
export function EffortSlider({ levels, value, onChange }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const n = levels.length;
  const index = Math.max(0, levels.findIndex((l) => l.id === value));
  const current = levels[index];

  const nearest = (clientX: number) => {
    const box = trackRef.current!.getBoundingClientRect();
    const span = box.width - PAD * 2;
    const ratio = Math.min(1, Math.max(0, (clientX - box.left - PAD) / span));
    return Math.round(ratio * (n - 1));
  };
  const select = (i: number) => {
    const level = levels[Math.min(n - 1, Math.max(0, i))];
    if (level && level.id !== value) onChange(level.id);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    select(nearest(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) select(nearest(e.clientX));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (step) {
      e.preventDefault();
      select(index + step);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      select(e.key === "Home" ? 0 : n - 1);
    }
  };

  return (
    <div className="effort-slider">
      <p className="effort-head">
        <span className="effort-head-label">Thinking</span>
        <span className="effort-head-value">{current?.label}</span>
      </p>
      <div className="effort-ends" aria-hidden="true">
        <span>Faster</span>
        <span>Smarter</span>
      </div>
      <div
        ref={trackRef}
        className="effort-track"
        role="slider"
        tabIndex={0}
        aria-label="Thinking"
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={index}
        aria-valuetext={current?.label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKey}
      >
        <span className="effort-rail" aria-hidden="true" />
        {/* The fill runs to the thumb's centre, so its end is always hidden under the thumb. */}
        <span className="effort-fill" style={{ width: `calc(${at(index, n)} - 3px)` }} aria-hidden="true" />
        {levels.map((l, i) => (
          <span
            key={l.id}
            className={`effort-stop${i <= index ? " is-covered" : ""}`}
            style={{ left: at(i, n) }}
            aria-hidden="true"
          />
        ))}
        <span className="effort-thumb" style={{ left: at(index, n) }} aria-hidden="true" />
      </div>
    </div>
  );
}
