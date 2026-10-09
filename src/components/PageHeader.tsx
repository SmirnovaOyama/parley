import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Icon } from "../icons/Icon.tsx";
import { useSlideNavigate } from "../lib/slide.ts";

type Props = {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** A page reached from another: a back link naming the parent sits above the title. `slide`
   *  slides this page away to the right on the way back (for pages that slid in). */
  back?: { label: string; to: string; mobileOnly?: boolean; slide?: boolean };
  /** Replaces the title and actions, e.g. with an inline rename field. */
  editor?: ReactNode;
  /** A line under the bar, e.g. an inline "are you sure". */
  below?: ReactNode;
  /** At the far end of the bar, level with the back link (or the title when there's none). */
  trailing?: ReactNode;
};

/** Large-title header on frosted glass; the hairline shows once content scrolls under it. */
export function PageHeader({ title, subtitle, actions, back, editor, below, trailing }: Props) {
  const [scrolled, setScrolled] = useState(false);
  const slideTo = useSlideNavigate();
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`oy-page-header${scrolled ? " is-scrolled" : ""}`}>
      <div className="oy-page-column bar">
        <div style={{ minWidth: 0, flex: 1 }}>
          {back && (
            <Link
              className={`back${back.mobileOnly ? " mobile-only" : ""}`}
              to={back.to}
              onClick={
                back.slide
                  ? (e) => {
                      // A plain click slides back; a modified click (new tab) behaves as a link.
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                      e.preventDefault();
                      slideTo(back.to, "back");
                    }
                  : undefined
              }
            >
              <Icon name="chevron-left" size={20} />
              {back.label}
            </Link>
          )}
          {editor ?? <h1>{title}</h1>}
          {subtitle && !editor && <p className="subtitle">{subtitle}</p>}
          {/* Actions get their own line under the title, so a long title can use the full width. */}
          {actions && !editor && <div className="actions">{actions}</div>}
        </div>
        {trailing && !editor && <div className="bar-trailing">{trailing}</div>}
      </div>
      {below && <div className="oy-page-column header-below">{below}</div>}
    </header>
  );
}
