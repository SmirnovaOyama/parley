import type { ComponentProps } from "react";
import { Link } from "react-router";
import { useSlideNavigate, type Direction } from "../lib/slide.ts";

type Props = Omit<ComponentProps<typeof Link>, "to"> & { to: string; direction: Direction };

/** A link into a page ("forward") or back out of one ("back") that slides there (src/lib/slide.ts).
 *  A modified click (a new tab or window) still behaves as a plain link. */
export function SlideLink({ to, direction, replace, state, onClick, ...rest }: Props) {
  const slideTo = useSlideNavigate();
  return (
    <Link
      {...rest}
      to={to}
      replace={replace}
      state={state}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        slideTo(to, direction, { replace, state });
      }}
    />
  );
}
