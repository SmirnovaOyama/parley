import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "../icons/Icon.tsx";
import { SlideLink } from "./SlideLink.tsx";

type Props = {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** A page reached from another: a back link naming the parent sits above the title. It slides
   *  this page away to the right, the way it slid in. */
  back?: { label: string; to: string; mobileOnly?: boolean };
  /** Replaces the title and actions, e.g. with an inline rename field. */
  editor?: ReactNode;
  /** A line under the bar, e.g. an inline "are you sure". */
  below?: ReactNode;
  /** At the far end, level with the title (its first line, when it wraps). */
  trailing?: ReactNode;
};

/** Large-title header on frosted glass; the hairline shows once content scrolls under it. */
export function PageHeader({ title, subtitle, actions, back, editor, below, trailing }: Props) {
  const [scrolled, setScrolled] = useState(false);
  // Under a back link the title sits lower than the bar's top, so the trailing button joins the
  // title's own row to stay level with it.
  const inTitleRow = !!back && !!trailing && !editor;
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
            <SlideLink className={`back${back.mobileOnly ? " mobile-only" : ""}`} to={back.to} direction="back">
              <Icon name="chevron-left" size={20} />
              {back.label}
            </SlideLink>
          )}
          {editor ??
            (inTitleRow ? (
              <div className="title-row">
                <h1>{title}</h1>
                <div className="bar-trailing">{trailing}</div>
              </div>
            ) : (
              <h1>{title}</h1>
            ))}
          {subtitle && !editor && <p className="subtitle">{subtitle}</p>}
          {/* Actions get their own line under the title, so a long title can use the full width. */}
          {actions && !editor && <div className="actions">{actions}</div>}
        </div>
        {trailing && !editor && !inTitleRow && <div className="bar-trailing">{trailing}</div>}
      </div>
      {below && <div className="oy-page-column header-below">{below}</div>}
    </header>
  );
}
