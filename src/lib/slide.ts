// Going into a page from a list or a menu (a chat, a project, a person, a key) slides it in from
// the right; every way back (the back link, Cancel, Save) slides it away again. It's the browser's
// View Transitions API: the old page is held as a picture while the new one renders, and app.css
// moves the two sideways. Where the API is missing, or the person asks for less motion, the page
// simply changes.
import { flushSync } from "react-dom";
import { useNavigate, type NavigateOptions } from "react-router";

export type Direction = "forward" | "back";
type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

/** Inside a conversation the composer owns the bottom of the screen, so the tab bar steps aside. */
export const isUnderChat = (pathname: string) => pathname === "/chat" || pathname.startsWith("/chat/");

export function useSlideNavigate() {
  const navigate = useNavigate();
  return (to: string, direction: Direction, options?: NavigateOptions) => {
    const doc = document as ViewTransitionDocument;
    if (!doc.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      navigate(to, options);
      return;
    }
    const root = document.documentElement;
    root.dataset.slide = direction;
    // Between two pages with the tab bar, the bar holds still while they slide under it; into or
    // out of a chat it goes with the page it's on.
    const bar = !isUnderChat(window.location.pathname) && !isUnderChat(new URL(to, window.location.href).pathname);
    if (bar) root.dataset.slideBar = "";
    else delete root.dataset.slideBar;
    // The new page has to be on screen when the callback returns, so the route change renders
    // synchronously here (BrowserRouter runs with useTransitions off for this).
    const transition = doc.startViewTransition(() => flushSync(() => navigate(to, options)));
    void transition.finished.finally(() => {
      if (root.dataset.slide !== direction) return;
      delete root.dataset.slide;
      delete root.dataset.slideBar;
    });
  };
}
