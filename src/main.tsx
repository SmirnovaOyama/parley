import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { APP_NAME } from "./lib/brand.ts";
import "./styles/tokens.css";
import "./styles/oyama.css";
import "./styles/app.css";

document.title = APP_NAME;

createRoot(document.getElementById("root")!).render(<App />);

// Lets the site be installed as an app, and shows a page of its own when there's no connection
// (public/sw.js). Development leaves it out, so nothing comes between Vite and the page.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
