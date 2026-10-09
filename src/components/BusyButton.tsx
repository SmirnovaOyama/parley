import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { BusyMark } from "./Feedback.tsx";

type Props = ComponentProps<"button"> & {
  /** Waiting on the server: the turning mark slides in before the label and clicks are held. */
  busy?: boolean;
};

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const widthOf = (el: Element) => parseFloat(getComputedStyle(el).width);

/**
 * A button that can wait. While `busy` it keeps its colour and focus (it isn't disabled, it's
 * working): the turning mark slides in before the label, `aria-busy` is set, and clicks and Enter
 * are held so a form can't go twice. When the label's words change ("Send code" to "Sending"), the
 * label eases to its new width and fades in, so the button grows or shrinks instead of jumping.
 */
export function BusyButton({ busy = false, className, onClick, children, ...rest }: Props) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const last = useRef<{ text: string | null; width: number; easing?: Animation }>({ text: null, width: 0 });

  // After every render: note the label's width, and when its words changed, ease from the old width.
  useLayoutEffect(() => {
    const label = labelRef.current;
    if (!label) return;
    const was = last.current;
    const moving = was.easing?.playState === "running";
    if (label.textContent === was.text) {
      if (!moving) was.width = widthOf(label);
      return;
    }
    // Changed again mid-way: carry on from where it is now.
    const from = moving ? widthOf(label) : was.width;
    was.easing?.cancel();
    const to = widthOf(label);
    last.current = { text: label.textContent, width: to };
    if (was.text === null || reduceMotion()) return;
    const css = getComputedStyle(label);
    const duration = parseFloat(css.getPropertyValue("--duration-base")) || 220;
    last.current.easing = label.animate(
      { width: [`${from}px`, `${to}px`] },
      { duration, easing: css.getPropertyValue("--ease-out").trim() || "ease-out" },
    );
    // The new words stay unseen for the first frames, while they're still wider than the button.
    label.animate(
      [{ opacity: 0 }, { opacity: 0, offset: 0.15, easing: css.getPropertyValue("--ease-standard").trim() || "ease" }, { opacity: 1 }],
      { duration },
    );
  });

  return (
    <button
      {...rest}
      className={`${className ?? ""} busy-btn`}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={(e) => {
        // Held rather than disabled, which would fade it and drop focus. Enter in a field clicks the
        // submit button too, so this stops a second submit as well.
        if (busy) e.preventDefault();
        else onClick?.(e);
      }}
    >
      <span className="busy-btn-mark">
        <BusyMark label={null} size={16} />
      </span>
      <span className="busy-btn-label" ref={labelRef}>
        {children}
      </span>
    </button>
  );
}
