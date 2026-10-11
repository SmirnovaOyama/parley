import { Children, isValidElement, memo, useDeferredValue, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { Icon } from "../icons/Icon.tsx";
import { t } from "../lib/i18n.ts";
import { prepareMath } from "../lib/math.ts";

type Props = {
  text: string;
  /**
   * Still arriving: formulas and highlighting wait for the whole reply, so half-written TeX
   * doesn't flash up as errors (it shows as plain code until then).
   */
  streaming?: boolean;
};

const REMARK = [remarkGfm, remarkMath];
const REHYPE_DONE = [
  [rehypeKatex, { throwOnError: false, strict: "ignore" }],
  [rehypeHighlight, { detect: false }],
] as ComponentProps<typeof ReactMarkdown>["rehypePlugins"];

/** Renders a reply. Raw HTML in the text is never rendered, only Markdown. */
export const Markdown = memo(function Markdown({ text, streaming }: Props) {
  // While a reply streams, parsing the growing text waits behind scrolling and typing: React
  // renders the newest text when it has a moment, and the element is reused until then.
  const deferred = useDeferredValue(text);
  const source = useMemo(() => prepareMath(deferred), [deferred]);
  return useMemo(() => (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={streaming ? undefined : REHYPE_DONE}
        components={{
          // A bare number linking out is a web citation marker, "[2](url)": shown as a small chip.
          a: ({ node: _node, children, ...props }) => (
            <a
              {...props}
              className={typeof children === "string" && /^\d{1,3}$/.test(children) && /^https?:/.test(props.href ?? "") ? "cite" : undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          // A finished block that can run (a page, a picture, a component, a diagram) offers a preview.
          pre: (props) => <CodeBlock {...props} done={!streaming} />,
          table: ({ node: _node, ...props }) => (
            <div className="md-table">
              <table {...props} />
            </div>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  ), [source, streaming]);
});

const LANGUAGE_NAMES: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", jsx: "JSX", ts: "TypeScript", typescript: "TypeScript", tsx: "TSX",
  py: "Python", python: "Python", rb: "Ruby", ruby: "Ruby", go: "Go", rs: "Rust", rust: "Rust", java: "Java",
  kt: "Kotlin", kotlin: "Kotlin", swift: "Swift", c: "C", cpp: "C++", "c++": "C++", cs: "C#", csharp: "C#",
  php: "PHP", sh: "Shell", bash: "Bash", zsh: "Zsh", shell: "Shell", console: "Console", ps1: "PowerShell",
  powershell: "PowerShell", sql: "SQL", html: "HTML", xml: "XML", css: "CSS", scss: "SCSS", json: "JSON",
  yaml: "YAML", yml: "YAML", toml: "TOML", ini: "INI", md: "Markdown", markdown: "Markdown", diff: "Diff",
  dockerfile: "Dockerfile", makefile: "Makefile", lua: "Lua", r: "R", math: t("Math"), latex: "LaTeX", tex: "LaTeX",
  graphql: "GraphQL", text: t("Text"), plaintext: t("Text"), txt: t("Text"), csv: "CSV", tsv: "TSV", svg: "SVG",
};

/** What a downloaded block is called, by language: a plain name and the usual extension. */
const FILE_NAMES: Record<string, string> = {
  py: "script.py", python: "script.py", csv: "data.csv", tsv: "data.tsv", json: "data.json",
  ts: "code.ts", typescript: "code.ts", tsx: "component.tsx", js: "code.js", javascript: "code.js",
  jsx: "component.jsx", html: "page.html", css: "styles.css", scss: "styles.scss", md: "notes.md",
  markdown: "notes.md", sql: "query.sql", sh: "script.sh", bash: "script.sh", zsh: "script.sh", shell: "script.sh",
  ps1: "script.ps1", powershell: "script.ps1", yaml: "config.yaml", yml: "config.yaml", toml: "config.toml",
  ini: "config.ini", xml: "data.xml", svg: "image.svg", rb: "script.rb", ruby: "script.rb", go: "main.go",
  rs: "main.rs", rust: "main.rs", java: "Main.java", kt: "Main.kt", kotlin: "Main.kt", swift: "main.swift",
  c: "main.c", cpp: "main.cpp", "c++": "main.cpp", cs: "Program.cs", csharp: "Program.cs", php: "index.php",
  lua: "script.lua", r: "script.R", latex: "document.tex", tex: "document.tex", graphql: "schema.graphql",
  dockerfile: "Dockerfile", makefile: "Makefile", diff: "changes.diff",
};

/**
 * The name to save a block under. A first line that names the file ("# filename: grid.py",
 * "// app.ts") wins, reduced to a bare name; otherwise the language's usual name.
 */
function fileNameFor(lang: string | undefined, text: string): string {
  const first = text.split("\n", 1)[0].trim();
  const named = /^(?:#|\/\/|--|;|<!--)\s*(?:file(?:name)?\s*:\s*)?([\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7})\s*(?:-->)?$/.exec(first)?.[1];
  const safe = named?.replace(/^\.+/, "").slice(0, 80);
  if (safe) return safe;
  return (lang && FILE_NAMES[lang]) || "snippet.txt";
}

const MIME: Record<string, string> = { csv: "text/csv", json: "application/json", html: "text/html", svg: "image/svg+xml" };

type PreviewKind = "html" | "svg" | "react" | "mermaid" | "script";

/** What a block can be shown as, by its language: a page, a picture, a React component, a diagram, or a script's output. */
function previewKind(lang: string | undefined, text: () => string): PreviewKind | null {
  switch (lang) {
    case "html":
    case "htm":
      return "html";
    case "svg":
      return "svg";
    case "xml":
      return /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text()) ? "svg" : null;
    case "jsx":
    case "tsx":
      return "react";
    case "mermaid":
      return "mermaid";
    case "js":
    case "javascript":
      return "script";
    default:
      return null;
  }
}

/** The text of a rendered block's code, as written. */
const textOf = (node: unknown): string => {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: unknown }).children);
  return "";
};

/** A code block with a quiet header: the language on the left, preview, download and copy on the right. */
function CodeBlock({ node: _node, children, done, ...props }: ComponentProps<"pre"> & { node?: unknown; done?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const code = Children.toArray(children).find(isValidElement) as { props?: { className?: string; children?: unknown } } | undefined;
  const lang = /language-([\w+#-]+)/.exec(code?.props?.className ?? "")?.[1]?.toLowerCase();
  const label = lang ? (LANGUAGE_NAMES[lang] ?? lang) : t("Code");
  const source = () => textOf(code?.props?.children).replace(/\n$/, "");
  const kind = done ? previewKind(lang, source) : null;

  const download = (e: React.MouseEvent<HTMLButtonElement>) => {
    const text = e.currentTarget.closest(".md-code")?.querySelector("code")?.textContent ?? "";
    const name = fileNameFor(lang, text);
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const url = URL.createObjectURL(new Blob([text], { type: `${MIME[ext] ?? "text/plain"};charset=utf-8` }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copy = (e: React.MouseEvent<HTMLButtonElement>) => {
    const text = e.currentTarget.closest(".md-code")?.querySelector("code")?.textContent ?? "";
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{label}</span>
        {kind && (
          <button
            type="button"
            className="btn-ghost md-preview-toggle"
            aria-pressed={previewing}
            onClick={() => setPreviewing((p) => !p)}
            title={previewing ? t("Show the code") : t("Run it here, sandboxed")}
          >
            <Icon name={previewing ? "code" : "eye"} size={14} />
            <span className="swap">
              <span className={previewing ? "reserve" : undefined} aria-hidden={previewing || undefined}>
                {t("Preview")}
              </span>
              <span className={previewing ? undefined : "reserve"} aria-hidden={!previewing || undefined}>
                {t("Code")}
              </span>
            </span>
          </button>
        )}
        {/* There all along, resting while the code shows, so the toggle never moves under the pointer. */}
        {kind && (
          <button
            type="button"
            className={`btn-ghost msg-action md-copy${previewing ? "" : " is-resting"}`}
            onClick={() => openPreview(kind, source())}
            aria-label={t("Open the preview in a new tab")}
            title={t("Open in a new tab")}
            aria-hidden={!previewing || undefined}
            tabIndex={previewing ? undefined : -1}
          >
            <Icon name="expand" size={14} />
          </button>
        )}
        <button type="button" className={`btn-ghost msg-action md-copy${kind ? "" : " md-download"}`} onClick={download} aria-label={t("Download as a file")}>
          <Icon name="download" size={14} />
        </button>
        <button
          type="button"
          className="btn-ghost msg-action md-copy"
          onClick={copy}
          aria-label={copied ? t("Copied") : t("Copy code")}
          title={copied ? t("Copied") : t("Copy")}
        >
          <Icon name={copied ? "check" : "copy"} size={14} className={copied ? "draw-in" : undefined} />
        </button>
      </div>
      {kind && previewing ? <PreviewFrame kind={kind} code={source()} /> : <pre {...props}>{children}</pre>}
    </div>
  );
}

const dark = () => {
  const theme = document.documentElement.dataset.theme;
  return theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
};

/**
 * The preview page (server/preview.ts). Its own Content-Security-Policy sandboxes it: an origin of
 * its own, so the code can't act as this site. (The frame carries no sandbox attribute as well:
 * some embedded browsers refuse to load a frame that has one.)
 */
const PREVIEW_URL = "/api/preview";

/** A block running in a sandboxed frame that grows to fit what it shows, within limits. */
function PreviewFrame({ kind, code }: { kind: PreviewKind; code: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(kind === "react" || kind === "html" ? 420 : 240);
  // The code goes over when the page says it's ready, and again once it has loaded, in case the
  // first word came before this was listening. The page takes only the first: writing the code
  // replaces it, listener and all.
  const send = () => ref.current?.contentWindow?.postMessage({ type: "preview-code", kind, code, dark: dark() }, "*");
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      if (e.data?.type === "preview-ready") send();
      else if (e.data?.type === "preview-size" && typeof e.data.height === "number") setHeight(Math.min(Math.max(e.data.height, 80), 720));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [kind, code]);
  return <iframe ref={ref} className="md-preview" src={PREVIEW_URL} title={t("Preview")} style={{ height }} onLoad={send} />;
}

/** The same preview in a tab of its own, handed the code once it's ready. */
function openPreview(kind: PreviewKind, code: string) {
  const tab = window.open(PREVIEW_URL, "_blank");
  if (!tab) return;
  const onMessage = (e: MessageEvent) => {
    if (e.source !== tab || e.data?.type !== "preview-ready") return;
    tab.postMessage({ type: "preview-code", kind, code, dark: dark() }, "*");
    window.removeEventListener("message", onMessage);
  };
  window.addEventListener("message", onMessage);
  setTimeout(() => window.removeEventListener("message", onMessage), 60_000);
}
