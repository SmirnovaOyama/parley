// Empty-state scenes in the ink-and-watercolour style of the brand mark (Brand.tsx): ink lines,
// paper-white shapes, one wash set off to the side. Drawn on a 64×64 grid with cc-lineart (the
// motifs live in design/icons); colours come from the theme, so they work in dark mode too.
import type { ReactNode } from "react";
import { HAND_LETTERED, InkFilter, ParleyFlag, useSvgId, WashFilter } from "./Brand.tsx";

export type DoodleName = "flag" | "chat" | "people" | "coins";
type Props = { name: DoodleName; className?: string };

export function Doodle({ name, className }: Props) {
  const id = useSvgId();
  // The flag is Parley's own mark; on a renamed site the empty chat shows the plain bubbles.
  if (name === "flag" && HAND_LETTERED) return <ParleyFlag className={className ? `lineart ${className}` : "lineart"} />;
  const scene = SCENES[name === "flag" ? "chat" : name];
  return (
    <svg className={className ? `lineart ${className}` : "lineart"} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <WashFilter id={`${id}-wash`} seed={scene.seed} />
        <InkFilter id={`${id}-ink`} seed={scene.seed + 11} />
      </defs>
      <g filter={`url(#${id}-wash)`}>
        <path className="lineart-wash" d={scene.wash} />
        <path className="lineart-wash-edge" d={scene.wash} />
      </g>
      <g className="brand-ink" filter={`url(#${id}-ink)`}>
        {scene.ink}
      </g>
    </svg>
  );
}

// Paint order inside each: what sits behind first, paper shapes back to front, details on top.
const SCENES: Record<Exclude<DoodleName, "flag">, { wash: string; seed: number; ink: ReactNode }> = {
  // Two speech bubbles, the back one larger (cc-lineart's chat motif).
  chat: {
    wash: "M25 27 L60 25 L62 61 L27 62.5 Z",
    seed: 7,
    ink: (
      <>
        <path className="brand-paper" d="M30 8.5 C44 7.5 56.5 11.5 56.5 21.5 C56.5 30.5 47.5 35 38.5 35 L37 42 L31.5 34.6 C24 33 19 28 19.5 21.5 C20 13 25 9 30 8.5 Z" />
        <path className="brand-paper" d="M24 26 C14 25.5 7 30 7 37.5 C7 44 12.5 48 19 48.5 L18 56.5 L25.5 49 C34 49 41.5 45 41.5 37.5 C41.5 30 34 26.3 24 26 Z" />
        <circle className="brand-dot" cx="16.5" cy="38" r="1.9" />
        <circle className="brand-dot" cx="24" cy="38" r="1.9" />
        <circle className="brand-dot" cx="31.5" cy="38" r="1.9" />
      </>
    ),
  },
  // Two people, one stepping in front of the other, the back one saying something.
  people: {
    wash: "M31.5 12.6 L59.4 15 L57.2 47.8 L29.6 45.6 Z",
    seed: 19,
    ink: (
      <>
        <path className="brand-paper" d="M28.6 53.2 C29.4 44.2 34.6 37.4 42.2 37.2 C49.6 37 54.8 43.4 56 52.6 C47 53.6 37.6 53.8 28.6 53.2 Z" />
        <path className="brand-paper" d="M37.3 30.1 C35.2 27.9 34.7 24.7 36.3 22.1 C37.8 19.5 40.9 18.4 43.8 19.2 C46.6 20 48.5 22.6 48.5 25.6 C48.4 28.5 46.3 30.9 43.6 31.6 C40.9 32.3 37.6 31.6 36.1 28.9" />
        <path className="brand-paper" d="M8.8 59.4 C9.6 49.6 15.6 42.6 24.6 42.4 C33.4 42.2 39.6 49.2 40.6 58.8 C30 59.8 19.6 59.9 8.8 59.4 Z" />
        <path className="brand-paper" d="M26.7 37.3 C23.6 38.3 20.1 37.4 18.2 34.6 C16.4 31.8 17 28.2 19.1 25.7 C21.3 23.3 24.8 22.3 27.8 23.8 C30.9 25.3 32.2 28.7 31.6 31.9 C31 35.1 28.1 37.2 25 37.4" />
        <path className="brand-paper" d="M47.6 6.6 C51.6 5.8 56.4 6 58.6 7.4 C60 8.4 60.2 10.6 59.4 12 C58.4 13.6 55.6 14.2 52.6 14 L49.2 17 L49.8 13.6 C47.6 13.2 46.6 11.8 46.6 10 C46.6 8.4 46.8 7.1 47.6 6.6 Z" />
      </>
    ),
  },
  // Two coins, the front one stamped with a speech bubble: what people spend on chats.
  coins: {
    wash: "M30.5 12.5 L61 15.2 L59.2 54.4 L32.4 56.2 Z",
    seed: 31,
    ink: (
      <>
        <path className="brand-paper" d="M58.1 24.1 C56.7 28.9 52 31.8 47.2 31.6 C42.3 31.4 38.1 28 37 23.2 C35.9 18.5 38.2 13.6 42.5 11.3 C46.8 9 52.1 9.7 55.5 13.3 C58.9 16.9 60.1 22.4 57.4 26.8" />
        <path className="brand-paper" d="M40 31.3 C35.6 29.3 32.4 24.7 33.3 19.7 C34.1 14.7 38.4 11.3 43.3 10.8 C48.1 10.3 52.6 13.2 54.3 17.6 C56.1 22.1 54.9 27.4 50.9 30.3 C46.9 33.2 41.4 33.4 37.5 30.2" />
        <path className="brand-paper" d="M15.2 31.2 C18 24.2 25.2 20.3 32.5 21.2 C39.7 22 44.8 28.1 45.8 35 C46.9 41.9 44.3 49.6 37.4 52.6 C30.5 55.7 22.8 52.8 18.3 47.3 C13.8 41.7 12.1 33.5 16.6 27.2" />
        <path className="brand-paper" d="M41.8 42 C40 49 33.5 53.4 26.5 53.5 C19.6 53.5 13.6 48.7 11.7 42.1 C9.9 35.5 11.8 27.8 18.1 24.1 C24.3 20.3 32.5 20.9 37.9 26.1 C43.3 31.3 43.1 39.3 39.8 45.3" />
        <path className="brand-paper" d="M20.4 31.2 C24.6 29.9 30.6 30 33.6 31.6 C35.4 32.6 35.8 35 35.3 37.2 C34.7 39.6 32.6 41.2 29.6 41.5 C27.4 41.7 25.4 41.6 23.6 41.2 L19.8 45.4 L20.4 40.4 C18.6 39.4 17.6 37.6 17.8 35.4 C18 33.4 18.9 31.8 20.4 31.2 Z" />
      </>
    ),
  },
};
