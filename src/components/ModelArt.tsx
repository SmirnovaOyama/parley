// Headers for the model cards on the admin overview: a tinted band per model family with a
// hand-drawn mark (one ink line and a pale wash set a little off it, like the empty-state doodles,
// on a 96×72 canvas). DeepSeek wears the site owner's own picture instead, as a round avatar.

type ModelFamily = "fable" | "opus" | "sonnet" | "haiku" | "deepseek" | "other";

function familyOf(model: string): ModelFamily {
  for (const f of ["fable", "opus", "sonnet", "haiku", "deepseek"] as const) if (model.includes(f)) return f;
  return "other";
}

/** `model` is the model id, e.g. "claude-opus-5-5". */
export function ModelArt({ model }: { model: string }) {
  const family = familyOf(model);
  return (
    <div className={`model-art is-${family}`} aria-hidden="true">
      {family === "deepseek" ? (
        <img className="model-art-avatar" src="/models/deepseek-avatar.jpg" alt="" width={88} height={88} />
      ) : (
        <svg className="oy-doodle model-art-doodle" viewBox="0 0 96 72">
          {SCENES[family]}
        </svg>
      )}
    </div>
  );
}

const SCENES: Record<Exclude<ModelFamily, "deepseek">, React.ReactNode> = {
  // An open book.
  fable: (
    <>
      <path className="wash" d="M50 25c7.6-4 16-5.3 25.4-4.4.4 9.8.3 19.8-.2 29.7-9-.7-17.4.7-25.2 4.7z" />
      <path d="M48 22.4c-8-4.6-17-6.1-27-5.2-.4 10.5-.3 21.3.2 31.8 9.6-.9 18.6.7 26.9 5.1" />
      <path d="M48 22.4c8.2-4.4 17.2-5.9 27.1-5 .4 10.6.3 21.3-.2 31.9-9.7-.8-18.7.8-27 5" />
      <path d="M48 22.6c-.2 10.7-.1 21.3.1 31.5" />
      <path d="M27.2 26.3c4.8-.4 9.4.3 13.8 1.8M27.4 33.4c4.6-.3 9 .4 13.4 1.7M27.6 40.4c3.2-.2 6.2.2 9.2 1" />
      <path d="M55.2 27.9c4.4-1.4 8.9-2 13.6-1.7M55.4 35c4.2-1.3 8.6-1.8 13.2-1.6" />
    </>
  ),
  // A mountain with a flag on the top.
  opus: (
    <>
      <path className="wash" d="M47.2 39.4c4.4-6.6 8.6-12.9 13.2-19.1 7.2 12.2 14.3 24.4 21.8 36.3-15.7.6-31.5.6-47.3.3z" />
      <path d="M13.4 57c8.7-10.6 15.7-21.1 22.8-31.8 3.3 4.4 6.4 8.9 9.5 13.5 4.3-6.5 8.5-12.8 13-18.9 7.4 12.4 14.6 24.9 22.4 37" />
      <path d="M31.9 31.4c1.6 1.2 3.2 1.5 4.8.4 1.4 1 3 1.3 4.6.5" />
      <path d="M58.8 19.6c-.1-4.4 0-8.8-.1-13.2" />
      <path d="M58.9 6.5c3.3.7 6.4 1.9 9.7 2.7-3.1 1.1-6.3 2.1-9.5 3" />
      <path d="M9.6 60.6c25.4-1.6 51.2-1.6 76.6.3" />
    </>
  ),
  // A quill writing a line.
  sonnet: (
    <>
      <path className="wash" d="M64.4 12.6c-9.8 4.6-17.4 12.4-22.8 22.6-3.2 6-5.1 12.4-6 19.2 6.6-1.5 12.8-4.2 18.2-8.5 8.6-6.9 13.7-17.2 15.5-28.4.3-1.7-.2-3.4-1.3-4.3-1.1-.9-2.4-1.1-3.6-.6z" />
      <path d="M62 10c-10.7 4.6-19 12.8-24.9 23.6-3.5 6.5-5.6 13.4-6.6 20.7 7.2-1.4 14-4.2 20-8.8 9.4-7.2 15-18.2 17.1-30.2.3-1.8-.2-3.6-1.4-4.6-1.3-1-2.8-1.3-4.2-.7z" />
      <path d="M28.4 58.6c7.4-12.4 16.2-23.7 26.6-33.6" />
      <path d="M44.4 39.2c2.6.4 5 1.3 7.2 2.6M49.6 31c2.4.2 4.6.8 6.8 1.9" />
      <path d="M13.6 62.2c4.2-2.8 7.4.2 10.8-2.1 3.2-2.2 6.2.9 9.4-.8" />
      <path d="M40.2 61.6c14.6-.8 29.4-.7 43.9.5" />
    </>
  ),
  // A sprig with three leaves.
  haiku: (
    <>
      <path className="wash" d="M38.4 48.8c-8-1.6-13-7.8-13.2-15.6 8 .4 13.8 6.6 13.2 15.6z" />
      <path className="wash" d="M52.6 37.4c1.8 7.8 8.4 12.2 16 11.2-1.4-7.8-8.2-12.8-16-11.2z" />
      <path d="M22.8 61c8.6-9.8 18-18.8 28.4-26.6 7-5.2 14.4-9.6 22.2-13" />
      <path d="M36.4 47.2c-8.2-1.4-13.4-7.6-13.8-15.6 8.2.2 14.4 6.4 13.8 15.6z" />
      <path d="M35.6 46.2c-3.4-3.8-6.6-7.8-10.8-11.6" />
      <path d="M50.4 35.6c1.6 8.2 8.6 13 16.6 12.2-1.2-8.2-8.4-13.6-16.6-12.2z" />
      <path d="M51.6 36.4c4.2 3.4 8.4 6.8 13 10.2" />
      <path d="M61.8 27.4c-3.4-7.6-.4-15.6 6.8-19.4 3.2 7.4.2 15.6-6.8 19.4z" />
      <path d="M62.6 26.2c1.6-4.8 3.4-9.6 5.4-14.2" />
    </>
  ),
  // Any other model: a chat bubble.
  other: (
    <>
      <path className="wash" d="M27.6 30c0-8.4 9-14.4 20.4-14.3 11.6.1 20.8 6.2 20.6 14.4-.2 8.2-9.4 14-20.8 13.8-2.4 0-4.8-.4-7-1-3.2 2.4-6.8 3.8-10.6 4.2 1.8-2 3-4.2 3.6-6.6-4-2.8-6.2-6.4-6.2-10.5z" />
      <path d="M25.6 28.4c0-8.6 9.2-14.6 20.6-14.5 11.6.1 20.6 6.2 20.5 14.6-.1 8.2-9.4 14-20.7 13.9-2.5 0-4.9-.4-7.1-1.1-3.3 2.5-7 3.9-10.9 4.3 1.9-2.1 3.1-4.4 3.7-6.9-3.9-2.7-6.1-6.2-6.1-10.3z" />
      <path d="M37.4 28.8h.1M46.4 28.4h.1M55.4 28.9h.1" style={{ strokeWidth: 3.4 }} />
      <path d="M9.6 60.6c25.4-1.6 51.2-1.6 76.6.3" />
    </>
  ),
};
