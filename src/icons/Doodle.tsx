// Empty-state scenes in the Oyama doodle style: one terracotta line, one flat wash set a little
// off the line, a ground stroke. Drawn on a 96×72 canvas and sized in rem.

type Props = { name: "chat" | "people"; size?: number; className?: string };

export function Doodle({ name, size = 7, className }: Props) {
  return (
    <svg
      className={className ? `oy-doodle ${className}` : "oy-doodle"}
      viewBox="0 0 96 72"
      style={{ width: `${size}rem`, height: `${(size * 72) / 96}rem`, strokeWidth: 2.4 }}
      aria-hidden="true"
    >
      {SCENES[name]}
    </svg>
  );
}

const SCENES = {
  chat: (
    <>
      <path className="wash" d="M15 21.5c0-6.6 7-11.2 15.8-11.2 9 0 16 4.4 16 11 0 6.4-7.1 10.9-16 10.9-2 0-3.9-.2-5.6-.7-2.5 1.9-5.3 3-8.4 3.4 1.4-1.6 2.3-3.4 2.8-5.4-2.9-2.2-4.6-5-4.6-8z" />
      <path d="M13.5 20c0-6.8 7.3-11.3 16.3-11.2 9 .1 16 4.6 15.9 11.2-.1 6.4-7.3 10.8-16.1 10.7-1.9 0-3.8-.3-5.4-.8-2.6 2-5.5 3.1-8.6 3.4 1.5-1.7 2.5-3.5 2.9-5.5-3.1-2-5-4.6-5-7.8z" />
      <path d="M38.4 36.3c.2-8.4 9.3-14.6 20.5-14.5 11.4.1 20.8 6.4 20.6 15-.2 8.4-9.6 14.4-21 14.2-2.6 0-5.1-.4-7.4-1.1-3.3 2.5-7.1 3.8-10.9 4.2 1.9-2.1 3.2-4.4 3.7-7-3.6-2.7-5.6-6.3-5.5-10.8z" />
      <path d="M50.8 36.6h.1M58.8 36.2h.1M66.8 36.7h.1" style={{ strokeWidth: 3.4 }} />
      <path d="M9.5 63.6c14-1.4 30.4-1.9 46.5-1.5 10.3.3 20.4.8 30.5 1.7" />
    </>
  ),
  people: (
    <>
      <path className="wash" d="M33.4 15.6c-4.9 0-8.4 3.8-8.1 8.6.3 4.6 4.2 8 8.8 7.6 4.4-.3 7.6-4.1 7.3-8.5-.3-4.4-3.8-7.7-8-7.7z" />
      <path d="M32 14.3c-4.8.1-8.4 4-8.1 8.7.3 4.6 4.3 8 8.8 7.6 4.4-.4 7.6-4.2 7.2-8.6-.3-4.4-3.8-7.8-7.9-7.7z" />
      <path d="M16.6 52.5c1.1-8.7 7.6-14.7 15.9-14.6 8.3.1 14.7 6.2 15.5 14.8" />
      <path d="M62.8 19.5c-3.9.1-6.7 3.3-6.4 7.1.3 3.7 3.5 6.4 7.1 6.1 3.5-.3 6.1-3.4 5.8-6.9-.3-3.5-3.1-6.3-6.5-6.3z" />
      <path d="M51 52.7c.8-6.9 5.9-11.6 12.4-11.6 6.6.1 11.6 4.9 12.3 11.8" />
      <path d="M9.5 63.6c14-1.4 30.4-1.9 46.5-1.5 10.3.3 20.4.8 30.5 1.7" />
    </>
  ),
};
