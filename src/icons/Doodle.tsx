// Empty-state scenes in the ink-and-watercolour style of the brand mark (Brand.tsx): ink lines,
// paper-white shapes, one wash set off to the side. Drawn on a 64×64 grid with cc-lineart (the
// motifs live in design/icons); colours come from the theme, so they work in dark mode too.
import type { ReactNode } from "react";
import { HAND_LETTERED, InkFilter, ParleyFlag, useSvgId, WashFilter } from "./Brand.tsx";

export type DoodleName = "flag" | "chat" | "people" | "coins" | "persona" | "folder" | "book" | "gift" | "link";
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
  // Someone holding a mask on a stick up to their face: who you are to the AI.
  persona: {
    wash: "M24.4 9.2 L55.8 11.4 L54 40.6 L26.2 38.6 Z",
    seed: 43,
    ink: (
      <>
        <path className="brand-paper" d="M7.6 59.2 C8.6 49.8 14.6 43.4 23.4 43.2 C32 43 38.4 49.6 39.4 58.8 C29 59.8 18.4 59.9 7.6 59.2 Z" />
        <path className="brand-paper" d="M31.0 36.1 C28.8 39.4 24.6 40.8 20.8 39.5 C17.1 38.3 14.6 34.7 14.8 30.7 C15.0 26.7 17.9 23.5 21.8 22.7 C25.6 21.8 29.3 24.1 31.0 27.4 C32.7 30.7 32.9 35.2 29.8 38.0" />
        <path d="M37.6 32.6 C40.2 40.8 42.6 49.2 45.2 57.8" />
        <g transform="translate(-10.4 1.8) rotate(-7 38 28)">
          <path className="brand-paper" d="M25.2 27.4 C26.8 22.6 32.6 21.4 38.2 23.4 C43.6 21.2 49.6 22.4 51 26.6 C51.8 29.6 49.4 33.4 45 33.6 C42 33.8 40 32.2 38.4 30.4 C36.4 32.6 33.6 34.2 30.4 33.8 C27 33.4 24.6 30.6 25.2 27.4 Z" />
          <path d="M28.6 28.3 C30.2 26.6 32.7 26.3 34.7 27.3" />
          <path d="M41.7 27.5 C42.9 26.4 44.7 25.8 46.3 26.5" />
        </g>
      </>
    ),
  },
  // A folder with a page sticking out and a chat bubble on its front: a project of chats.
  folder: {
    wash: "M3.6 25.6 L40.4 23.2 L42.4 61.2 L5.6 62.4 Z",
    seed: 23,
    ink: (
      <>
        <path className="brand-paper" d="M10.6 21.4 C10.4 18.6 11.4 17 13.8 16.9 C17.4 16.7 21 16.6 24.4 16.6 C26.2 16.6 27.2 17.4 28.2 19 L29.6 21.2 C37.8 20.9 46 20.8 54 21.2 C56 21.3 56.9 22.4 56.9 24.4 C57.1 33.4 56.7 42.6 57 51.4 C42 51.8 26 51.6 10.8 51.8 C10.4 41.6 10.8 31.4 10.6 21.4 Z" />
        <path className="brand-paper" d="M17.6 34 C17.8 27.2 18.2 20.4 18.8 13.8 C27.8 13 37 13.2 46.4 14.2 C46 20.6 45.6 27.4 45.6 34 Z" />
        <path d="M23.6 19.6 C28 19.2 33.2 19.3 38.4 19.8" />
        <path d="M23.4 24.6 C27 24.3 30.4 24.4 33.6 24.8" />
        <path className="brand-paper" d="M7.4 29.4 C21.4 28.4 38.4 28.2 54.6 28.8 C56.8 28.9 57.8 30 57.4 32.2 C56.6 38.8 55.8 45.2 55 51.6 C54.8 53.6 53.6 54.6 51.6 54.6 C38.2 55 24.6 54.8 12.6 54.9 C10.6 54.9 9.6 53.8 9.4 52 C8.4 45.4 7.2 38.8 6.2 32.4 C5.9 30.4 6.2 29.5 7.4 29.4 Z" />
        <path d="M27.2 37.2 C31 36.2 36.6 36.4 39.2 37.9 C40.8 38.9 41 41.2 40.2 42.8 C39.2 44.6 36.8 45.4 33.6 45.4 L29.4 48.6 L30 45 C27.4 44.4 26 42.8 26 40.8 C26 39 26.4 37.6 27.2 37.2 Z" />
      </>
    ),
  },
  // An open book (cc-lineart's book motif): a knowledge base.
  book: {
    wash: "M2 22 L44 19.5 L46.5 61 L4.5 62.5 Z",
    seed: 37,
    ink: (
      <>
        <g transform="translate(4 -6) scale(0.94)">
          <path className="brand-paper" d="M32 16 C24 12 14 12 6 14 C5.5 26 6.4 38 5.8 50 C14 48 24 48 32 52 Z" />
          <path className="brand-paper" d="M32 16 C40 12 50 12 58 14 C58.5 26 57.6 38 58.3 50 C50 48 40 48 32 52 Z" />
          <path d="M12 23 C17 22 22 22 26 23.5" />
          <path d="M12 30 C17 29 22 29 26 30.5" />
          <path d="M38 23.5 C42 22 47 22 52 23" />
          <path d="M38 30.5 C42 29 47 29 52 30" />
        </g>
      </>
    ),
  },
  // A present with an envelope tag tied to its bow: the reward for proving an address.
  gift: {
    wash: "M28.2 6.8 L60.4 9.6 L58.4 45.2 L30.6 42.6 Z",
    seed: 53,
    ink: (
      <>
        <path className="brand-paper" d="M12.4 39.4 C23.8 38.8 36 39 46.8 39.6 C46.6 45.6 46.4 51.6 46.6 57.4 C35.4 58 23.8 57.9 13.2 57.6 C13 51.6 12.6 45.4 12.4 39.4 Z" />
        <path className="brand-paper" d="M9.2 31.8 C22.4 30.6 36.6 30.8 50 31.8 C50.2 34.4 50 37.2 49.8 39.8 C36.6 39.4 22.8 39.4 9.6 40.2 C9.6 37.4 9.2 34.6 9.2 31.8 Z" />
        <path d="M27 40.2 C27.2 45.8 27 51.8 27.2 57.6" />
        <path d="M32.8 40 C32.6 45.8 32.8 51.6 32.6 57.6" />
        <path d="M26.8 31.2 C26.9 34 26.8 36.8 26.6 39.4" />
        <path d="M32.6 31.2 C32.7 34 32.6 36.8 32.8 39.4" />
        <path d="M31.6 30.2 C38.6 30.8 45 33.2 50.2 37.6" />
        <path className="brand-paper" d="M29.4 30.8 C25.2 29.6 20.2 27 20.6 23.2 C21 20.2 25.4 20.2 27.2 22.8 C28.4 24.6 29.2 27.8 29.4 30.8 Z" />
        <path className="brand-paper" d="M30.6 30.6 C32.2 27.4 35 23.2 38.2 22.2 C41 21.4 42.6 24 41 26.4 C39 29 34.6 30.2 30.6 30.6 Z" />
        <path className="brand-paper" d="M46.8 36.4 C50.8 37 54.6 37.8 58.6 38.8 C58 42.4 57.2 45.8 56.4 49.4 C52.4 48.6 48.4 47.6 44.6 46.8 C45.2 43.4 46 39.8 46.8 36.4 Z" />
        <path d="M46.6 37.2 C48.6 39.4 50.4 41.4 51.6 42.6 C53.8 41.6 56.2 40.4 58.4 39.4" />
      </>
    ),
  },
  // A chain link pulled apart: a share link that doesn't open.
  link: {
    wash: "M24.6 13.8 L58.6 16.4 L56.4 50.4 L26.8 48 Z",
    seed: 61,
    ink: (
      <>
        <path className="brand-paper" d="M8.5 43.6 C11.9 40.3 15.8 37.5 19.8 34.8 C22.7 32.5 26.8 33.0 29.1 35.9 C31.3 38.8 30.8 42.9 27.9 45.2 C24.4 48.4 20.5 51.2 16.6 54.0 C13.7 56.3 9.6 55.8 7.3 52.9 C5.1 50.0 5.6 45.9 9.2 42.7" />
        <path className="brand-paper" d="M36.7 19.2 C40.8 17.0 44.7 14.4 48.3 11.4 C51.3 9.4 55.4 10.2 57.5 13.2 C59.5 16.2 58.7 20.3 55.7 22.4 C51.9 25.1 47.8 27.3 44.1 30.2 C41.1 32.2 37.0 31.4 34.9 28.4 C32.9 25.4 33.7 21.3 37.5 18.3" />
        <path d="M13.4 48.1 C16.8 45.5 20.2 42.9 23.5 40.2" />
        <path d="M40.8 24.4 C44.3 22.1 47.7 19.8 51.2 17.4" />
        <path d="M27.4 26.2 C26.6 25 26 23.8 25.6 22.4" />
        <path d="M31.6 25 C31.9 23.6 32.3 22.4 32.9 21.2" />
        <path d="M36.8 38.8 C37.8 39.6 38.8 40.4 40 41" />
        <path d="M32.4 39.6 C32.3 41 32.1 42.4 31.8 43.6" />
      </>
    ),
  },
};
