import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { APP_NAME } from "./lib/brand.ts";
import "./styles/tokens.css";
import "./styles/oyama.css";
import "./styles/app.css";

document.title = APP_NAME;

createRoot(document.getElementById("root")!).render(<App />);
