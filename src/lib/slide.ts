// Opening a chat from the list slides it in from the right; going back slides it away again.
// It's the browser's View Transitions API: the old page is held as a picture while the new one
// renders, and app.css moves the two sideways. Where the API is missing, or the person asks for
// less motion, the page simply changes.
import { flushSync } from "react-dom";
import { useNavigate, type NavigateOptions } from "react-router";

type Direction = "forward" | "back";
type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

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
    // The new page has to be on screen when the callback returns, so the route change renders
    // synchronously here (BrowserRouter runs with useTransitions off for this).
    const transition = doc.startViewTransition(() => flushSync(() => navigate(to, options)));
    void transition.finished.finally(() => {
      if (root.dataset.slide === direction) delete root.dataset.slide;
    });
  };
}
