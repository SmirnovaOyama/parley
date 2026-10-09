// Parley's mark and its hand-lettered name, in the ink-and-watercolour style of the cc-lineart
// icons (design/icons/parley.svg): ink lines, paper-white shapes, one wash set off to the side.
// Colours come from the theme, so both work in dark mode. With `draw`, the lines draw themselves
// one pen stroke at a time and the wash soaks in under them last.
import { useId, type CSSProperties } from "react";
import { APP_NAME } from "../lib/brand.ts";

/** The lettering spells "Parley", so it only stands in for the name while the site is called that. */
export const HAND_LETTERED = APP_NAME.trim().toLowerCase() === "parley";

/** When a stroke starts and how long the pen takes over it, for the drawing-in animation. */
const pen = (at: number, len = 0) => ({ "--at": `${at}ms`, ...(len ? { "--len": `${len}ms` } : null) }) as CSSProperties;

/** SVG ids from useId carry characters `url(#…)` can't take. */
export const useSvgId = () => useId().replace(/[^\w-]/g, "");

/** The wash: its edge pushed about by noise, its body mottled by the same noise, like pigment on paper. */
export function WashFilter({ id, seed }: { id: string; seed: number }) {
  return (
    <filter id={id} x="-8%" y="-8%" width="116%" height="116%">
      <feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves={3} seed={seed} result="n" />
      <feDisplacementMap in="SourceGraphic" in2="n" scale={2.6} xChannelSelector="R" yChannelSelector="G" result="d" />
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.1 1.45" result="a" />
      <feComposite in="d" in2="a" operator="in" />
    </filter>
  );
}

/** A slight tremor on the ink, so no line is ruler-true. */
export function InkFilter({ id, seed }: { id: string; seed: number }) {
  return (
    <filter id={id} x="-8%" y="-8%" width="116%" height="116%">
      <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves={2} seed={seed} result="n" />
      <feDisplacementMap in="SourceGraphic" in2="n" scale={1.5} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );
}

const WASH = "M14.5 24 L46.5 22.2 L48 52.6 L16.2 54.2 Z";

/** The truce flag whose cloth is a speech bubble: talks under a flag of truce, which is what a parley is. */
export function ParleyFlag({ size = 60, draw = false, className }: { size?: number; draw?: boolean; className?: string }) {
  const id = useSvgId();
  return (
    <svg
      className={`brand-flag${draw ? " is-drawing" : ""}${className ? ` ${className}` : ""}`}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <defs>
        <WashFilter id={`${id}-wash`} seed={40} />
        <InkFilter id={`${id}-ink`} seed={51} />
      </defs>
      <g filter={`url(#${id}-wash)`}>
        <g className="brand-wash" style={pen(950)}>
          <path className="brand-wash-fill" d={WASH} />
          <path className="brand-wash-edge" d={WASH} />
        </g>
      </g>
      <g className="brand-ink" filter={`url(#${id}-ink)`}>
        <path
          className="brand-stroke brand-paper"
          pathLength={1}
          style={pen(460, 700)}
          d="M22.6 12.2 C28.5 9.6 33.5 14.4 40.5 12 C46 10.2 51.5 10.4 55.4 12.6 C58.2 16.4 58.4 24.2 55.9 28.4 C53.6 31.4 49.8 31.6 46.6 31.2 C48.4 34.2 49.9 37 50.8 39.4 C47.6 36.6 44.8 33.9 41.4 31.7 C35.6 33.4 29.2 29.2 20.8 31.6 C21.4 25 21.9 18.5 22.6 12.2 Z"
        />
        <path className="brand-stroke" pathLength={1} style={pen(160, 380)} d="M17.4 58.3 C18.6 42 20.3 26 22.3 10.8" />
        <circle className="brand-dot" style={pen(540)} cx="22.5" cy="8.4" r="2" />
        <circle className="brand-dot" style={pen(1150)} cx="31.6" cy="21.4" r="1.9" />
        <circle className="brand-dot" style={pen(1220)} cx="38.6" cy="21.9" r="1.9" />
        <circle className="brand-dot" style={pen(1290)} cx="45.6" cy="21.3" r="1.9" />
        <path className="brand-stroke" pathLength={1} style={pen(0, 220)} d="M11.2 58.6 C15.8 57.6 20.6 57.8 25.4 58.9" />
      </g>
    </svg>
  );
}

// "Parley" in the same ink, one path per pen stroke, in the order a hand writes them. Drawn upright
// on a 112×62 grid (baseline 44) and slanted as a whole; the y's tail sweeps back under the word.
const LETTERS = [
  "M8.6 45.4 C8.2 33.6 8.4 21.6 9.2 10.4",
  "M9.4 11 C15 9 21.8 10.6 22.2 16.8 C22.6 22.8 15.8 25.8 10.4 25.4",
  "M39.4 26.4 C37.6 22.4 31.6 22.4 29.8 28.2 C28.4 33.4 30.2 42.4 35.2 42.4 C37.6 42.4 39 40.4 39.8 37.4",
  "M39.8 22.6 C39.6 29.4 39.5 36.2 40.4 41.4 C40.8 43.6 42.2 44.6 44 43.8",
  "M48 23.2 C47.8 30.2 47.8 37.2 48 44.4",
  "M48.2 32 C49.2 26.2 52.2 22.8 56.4 23.4 C57.6 23.6 58.2 24.4 58.2 25.6",
  "M63.2 8.8 C62.6 20 62.4 30.8 63 38.8 C63.4 42.8 65.2 44.6 68.2 43.4",
  "M71.2 34.2 C75.8 34.2 80.2 33.4 83.4 31.8 C83.6 26.8 80.6 22.8 76.8 23 C72.4 23.2 70.2 28.2 70.6 34 C71 40.2 74.8 44.6 79.2 44 C81.4 43.7 83 42.6 84.4 40.8",
  "M88.2 23 C89.4 29.6 91.8 36.2 95.2 42.4",
  "M102.6 22.6 C99.6 33.8 96.2 44.4 92.4 52.6 C90.8 55.8 87.6 57.4 83.4 57 C79.4 56.6 76 55.4 73.2 53.8",
];
// How long the pen spends on each stroke (longer for the e's loop and the y's tail), and when each
// starts: one after another like handwriting, the next just before the last one lifts.
const STROKE_MS = [145, 160, 175, 120, 95, 110, 135, 210, 105, 225];
const STROKE_AT = STROKE_MS.map((_, i) => STROKE_MS.slice(0, i).reduce((sum, ms) => sum + ms - 25, 0));

/**
 * The site's name: hand-lettered while it's Parley, plain text once an admin renames the site.
 * `start` delays the drawing-in, so it can follow the flag.
 */
export function Wordmark({ draw = false, start = 0 }: { draw?: boolean; start?: number }) {
  const id = useSvgId();
  if (!HAND_LETTERED) return <>{APP_NAME}</>;
  return (
    <svg className={`brand-word${draw ? " is-drawing" : ""}`} viewBox="0 0 112 62" role="img" aria-label={APP_NAME}>
      <defs>
        <InkFilter id={`${id}-ink`} seed={23} />
      </defs>
      <g filter={`url(#${id}-ink)`}>
        <g className="brand-ink" transform="translate(6 0) skewX(-8)">
          {LETTERS.map((d, i) => (
            <path key={i} className="brand-stroke" pathLength={1} style={pen(start + STROKE_AT[i], STROKE_MS[i])} d={d} />
          ))}
        </g>
      </g>
    </svg>
  );
}
