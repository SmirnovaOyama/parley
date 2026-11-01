import { Fragment, useEffect, useRef, useState, type FormEvent, type Ref } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { BusyButton } from "../../components/BusyButton.tsx";
import { CheckList, OptionList, Switch } from "../../components/Controls.tsx";
import { DangerRow } from "../../components/DangerRow.tsx";
import { Advisory, Callout, Spinner } from "../../components/Feedback.tsx";
import { LineArea, LineField } from "../../components/LineField.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { SlideLink } from "../../components/SlideLink.tsx";
import { Icon } from "../../icons/Icon.tsx";
import { api } from "../../lib/api.ts";
import { wordDiff, type Piece } from "../../lib/diff.ts";
import { atOrOn, formatNumber, plural } from "../../lib/format.ts";
import { t, tn } from "../../lib/i18n.ts";
import { useSlideNavigate } from "../../lib/slide.ts";
import type { Group } from "./GroupsPage.tsx";

export type McpServer = {
  id: number;
  name: string;
  url: string;
  headerNames: string[];
  enabled: boolean;
  shared: boolean;
  /** readOnly, openWorld: what the server says of the tool (null when it doesn't say). */
  tools: { name: string; title: string | null; description: string; readOnly: boolean | null; openWorld: boolean | null }[];
  offTools: string[];
  /** The tools that run as soon as the model calls them; the rest ask the person first. */
  runTools: string[];
  /** Requests carry the person's email, so the server can tell people apart. */
  sendUser: boolean;
  /** Whose account calls act with: one shared (the headers), or each person's own, signed in (oauth) or pasted (token). */
  authMode: "shared" | "oauth" | "token";
  /** For tokens: what people are told to paste. */
  tokenHint: string;
  /** For signing in: a client an admin registered with the server's sign-in service (its secret never comes back). */
  clientId: string;
  hasClientSecret: boolean;
  /** The address to register as its callback there. */
  callbackUrl: string;
  /** On each person's own account: who has connected theirs. */
  people: { email: string; status: "connected" | "expired"; connectedAt: string; usedAt: string | null }[];
  /** On each person's own account: where your own stands (it's what lists the tools). */
  yours: "connected" | "missing" | "expired" | null;
  groupIds: number[];
  checkedAt: string | null;
  error: string | null;
  /** Tools from the last listing that are new or read differently, which new chats don't get until an admin uses them. */
  pending: { version: string; changes: ToolChange[] } | null;
};

/** A tool as an admin compares it. runs: it would run without asking, as things are set here. */
type ToolText = { title: string | null; description: string; input: string; readOnly: boolean | null; destructive: boolean | null; openWorld: boolean | null; runs: boolean };
type ToolPart = "title" | "description" | "input" | "hints";
/** A tool that's new in a listing, reads differently (in `parts`), or is gone from it. */
type ToolChange = { name: string; change: "new" | "changed" | "gone"; parts: ToolPart[]; before: ToolText | null; after: ToolText | null };

type SearchService = { id: string; label: string; detail: string; needs: "key" | "url" };
type SearchSettings = { provider: string | null; url: string; hasKey: boolean; services: SearchService[] };

/** Admin › Tools: the search service behind web search for models without their own, and MCP servers. */
export function ToolsPage() {
  const slideTo = useSlideNavigate();
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ servers: McpServer[] }>("/admin/mcp").then((r) => setServers(r.servers), (err) => setError((err as Error).message));
  }, []);

  return (
    <>
      <SearchForm />

      <div className="oy-group">
        <div className="group-head">
          <p className="oy-overline">{t("MCP servers")}</p>
          <button type="button" className="btn-ghost is-accent" onClick={() => slideTo("/admin/mcp/new", "forward")}>
            <Icon name="plus" size={16} />
            {t("Add a server")}
          </button>
        </div>
        <p className="group-intro">
          {t("Connect a service that speaks the Model Context Protocol, like GitHub, Notion or one of your own, and every model can use its tools. A chat gets the tools that were on when it started")}
        </p>
        {error ? (
          <Advisory>{error}</Advisory>
        ) : !servers ? (
          <Spinner />
        ) : servers.length === 0 ? (
          <p className="group-empty">{t("None yet")}</p>
        ) : (
          <div className="oy-section is-plain">
            {servers.map((s) => {
              const on = s.tools.length - s.offTools.filter((t) => s.tools.some((x) => x.name === t)).length;
              return (
                <button key={s.id} type="button" className="oy-row" onClick={() => slideTo(`/admin/mcp/${s.id}`, "forward")}>
                  <Icon name="plug" size={20} />
                  <div className="text">
                    <p className="title truncate">
                      {s.name}
                      {!s.enabled && <span className="tag is-warning">{t("Off")}</span>}
                      {s.error && <span className="tag is-warning">{t("Not answering")}</span>}
                      {s.pending && <span className="tag is-warning">{t("Changed tools")}</span>}
                    </p>
                    <div className="desc">
                      {t("{plural} for", { plural: plural(on, "tool", "tools") })} {s.shared ? t("everyone") : s.groupIds.length ? plural(s.groupIds.length, "group", "groups") : t("nobody yet")}
                      {s.authMode !== "shared" &&
                        tn(s.people.length, ", each on their own account. {count} person has connected", ", each on their own account. {count} people have connected", {
                          count: formatNumber(s.people.length),
                        })}
                    </div>
                  </div>
                  <Icon name="chevron-right" size={18} className="chevron" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

/** Which search service DeepSeek, Gemini, Grok and other services search the web through. */
function SearchForm() {
  const [settings, setSettings] = useState<SearchSettings | null>(null);
  const [provider, setProvider] = useState("off");
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<SearchSettings>("/admin/search").then((s) => {
      setSettings(s);
      setProvider(s.provider ?? "off");
      setUrl(s.url);
    }, (err) => setError((err as Error).message));
  }, []);

  if (!settings) return error ? <Advisory>{error}</Advisory> : <Spinner />;
  const service = settings.services.find((s) => s.id === provider);
  const dirty = provider !== (settings.provider ?? "off") || !!key.trim() || (service?.needs === "url" && url !== settings.url);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<SearchSettings>("/admin/search", provider === "off" ? { provider: null } : { provider, key, url });
      setSettings(next);
      setKey("");
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="oy-group">
      <p className="oy-overline">{t("Web search for other models")}</p>
      <p className="group-intro">
        {t("Claude and OpenAI search with their own tools. DeepSeek, Gemini, Grok, OpenCode and other services search through the service picked here, and can read the pages they find, on keys with web search on")}
      </p>
      <form className="form-page" onSubmit={save}>
        <OptionList
          label={t("Search service")}
          value={provider}
          onChange={(p) => {
            setProvider(p);
            setSaved(false);
            setError(null);
          }}
          options={[{ id: "off", label: t("None"), detail: t("Those models answer from what they know") }, ...settings.services.map((s) => ({ id: s.id, label: s.label, detail: s.detail }))]}
        />
        {service?.needs === "key" && (
          <LineField
            id="search-key"
            label={settings.hasKey && settings.provider === provider ? t("A new API key (empty keeps the saved one)") : t("{label} API key", { label: service.label })}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setSaved(false);
            }}
          />
        )}
        {service?.needs === "url" && (
          <LineField
            id="search-url"
            label={t("Your SearXNG's address")}
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setSaved(false);
            }}
            hint={t("Its settings need JSON among the result formats")}
          />
        )}
        {error && <Advisory>{error}</Advisory>}
        <div className="form-actions">
          <p className="oy-field-hint">{t("A test search runs before it's saved")}</p>
          <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!dirty}>
            {saved && !dirty ? t("Saved") : t("Save")}
          </BusyButton>
        </div>
      </form>
    </div>
  );
}

/** What the server says a tool does, beside the choice to let it run without asking. */
function hintOf(tool: { readOnly: boolean | null; openWorld: boolean | null; destructive?: boolean | null }): string {
  if (tool.readOnly) return tool.openWorld ? t("Only reads, the server says, but from services beyond it, so it could pass on what it's sent") : t("Only reads, the server says");
  if (tool.readOnly === false) {
    if (tool.destructive === false) return t("Can add things but not change or delete them, the server says");
    return tool.destructive ? t("Can change or delete things, the server says") : t("Can make changes, the server says");
  }
  return t("The server doesn't say whether it makes changes");
}

const PART_LABELS: Record<ToolPart, string> = { title: t("Title"), description: t("Description"), input: t("Input"), hints: t("What it does") };

/** One part of a tool as words to compare. */
function partText(tool: ToolText, part: ToolPart): string {
  if (part === "title") return tool.title ?? "";
  if (part === "description") return tool.description;
  if (part === "input") return tool.input;
  return tool.runs ? t("{hintOf}\nRuns without asking", { hintOf: hintOf(tool) }) : t("{hintOf}\nAsks the person first", { hintOf: hintOf(tool) });
}

/** Changed words, marked line by line: the space or indent around them would show as stray patches. */
function Marked({ text, as: Mark }: { text: string; as: "del" | "ins" }) {
  return text.split(/(\s*\n\s*)/).map((line, i) => {
    const [, lead, words, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(line)!;
    return (
      <Fragment key={i}>
        {lead}
        {words && <Mark>{words}</Mark>}
        {trail}
      </Fragment>
    );
  });
}

/** A part's text, the words only this version has marked (as removed or added). */
function PartText({ part, pieces, mark }: { part: ToolPart; pieces: Piece[]; mark?: "del" | "ins" }) {
  const Tag = part === "input" ? "pre" : "p";
  return (
    <Tag className={`mcp-text${part === "input" ? " is-code" : ""}`}>
      {pieces.every((p) => !p.text) ? (
        <span className="mcp-none">{t("None")}</span>
      ) : (
        pieces.map((p, i) => <Fragment key={i}>{p.changed && mark ? <Marked text={p.text} as={mark} /> : p.text}</Fragment>)
      )}
    </Tag>
  );
}

/** One tool a listing adds, changes or drops: for a changed one, each part that differs, before and now. */
function ToolChangeView({ change: c }: { change: ToolChange }) {
  return (
    <div className="mcp-change" role="group" aria-label={c.name}>
      <p className="mcp-change-name">
        {c.name}
        {c.change === "new" ? <span className="tag is-accent">{t("New")}</span> : c.change === "changed" ? <span className="tag is-warning">{t("Changed")}</span> : <span className="tag">{t("Gone")}</span>}
      </p>
      {c.change === "gone" && <p className="mcp-change-note">{t("It isn't listed any more. Using the new ones takes it out of new chats")}</p>}
      {c.change === "new" && (
        <>
          <p className="mcp-change-note">{t("No chat gets it until you use the new ones")}</p>
          {c.parts
            .filter((part) => part !== "title" || c.after!.title)
            .map((part) => (
              <div key={part} className="mcp-part">
                <p className="mcp-part-label">{PART_LABELS[part]}</p>
                <PartText part={part} pieces={[{ text: partText(c.after!, part), changed: false }]} />
              </div>
            ))}
        </>
      )}
      {c.change === "changed" &&
        c.parts.map((part) => {
          const diff = wordDiff(partText(c.before!, part), partText(c.after!, part));
          return (
            <div key={part} className="mcp-part">
              <p className="mcp-part-label">{PART_LABELS[part]}</p>
              {/* What it does is a sentence swapped whole, so its words aren't marked. */}
              <div className="mcp-pair">
                <span className="mcp-when">{t("Before")}</span>
                <PartText part={part} pieces={diff.before} mark={part === "hints" ? undefined : "del"} />
                <span className="mcp-when">{t("Now")}</span>
                <PartText part={part} pieces={diff.after} mark={part === "hints" ? undefined : "ins"} />
              </div>
            </div>
          );
        })}
    </div>
  );
}

type ReviewProps = {
  pending: NonNullable<McpServer["pending"]>;
  busy: "use" | "keep" | null;
  error: string | null;
  onSettle: (use: boolean) => void;
  sectionRef: Ref<HTMLElement>;
};

/**
 * Tools a server listed that are new or read differently from the ones kept, each beside what it
 * said before, to use or turn down here on the page. New chats keep the old ones meanwhile.
 */
function ListingReview({ pending, busy, error, onSettle, sectionRef }: ReviewProps) {
  return (
    <section ref={sectionRef} className="oy-group mcp-review" aria-labelledby="mcp-review-title">
      <p className="oy-overline" id="mcp-review-title">
        {t("Tools to look over")}
      </p>
      <p className="group-intro">
        {t("The server listed tools that are new or read differently. New chats keep getting the old ones until you choose. A tool's words reach the model in every chat that has it, so look for instructions that don't belong there")}
      </p>
      <div className="mcp-changes">
        {pending.changes.map((c) => (
          <ToolChangeView key={c.name} change={c} />
        ))}
      </div>
      {error && <Advisory>{error}</Advisory>}
      <div className="form-page-actions">
        <BusyButton type="button" className="btn-secondary" busy={busy === "keep"} disabled={busy === "use"} onClick={() => onSettle(false)}>
          {t("Keep the old ones")}
        </BusyButton>
        <BusyButton type="button" className="btn-primary" busy={busy === "use"} disabled={busy === "keep"} onClick={() => onSettle(true)}>
          {t("Use the new ones")}
        </BusyButton>
      </div>
    </section>
  );
}

/** How a sign-in from this page came back (?result=…, from /api/mcp/callback). */
const SIGN_IN_RESULTS: Record<string, string> = {
  connected: t("You're signed in, and it listed its tools"),
  denied: t("You didn't allow it on its sign-in page, so it can't list its tools yet"),
  failed: t("The sign-in didn't finish. Try again"),
};

/** Who has connected their own account, as a sentence. */
function personText(p: McpServer["people"][number]): string {
  if (p.status === "expired") return t("Their account stopped working, until they connect it again");
  return p.usedAt
    ? t("Connected {connectedAt}, last used {usedAt}", { connectedAt: atOrOn(p.connectedAt), usedAt: atOrOn(p.usedAt) })
    : t("Connected {connectedAt}", { connectedAt: atOrOn(p.connectedAt) });
}

/** Add an MCP server (/admin/mcp/new) or change one (/admin/mcp/:id): where it is, whose account it uses, who can use it, which tools are on. */
export function McpFormPage() {
  const { id } = useParams();
  const adding = id === "new";
  const location = useLocation();
  const navigate = useNavigate();
  const slideTo = useSlideNavigate();
  const [server, setServer] = useState<McpServer | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [authMode, setAuthMode] = useState<McpServer["authMode"]>("shared");
  const [ownToken, setOwnToken] = useState("");
  const [tokenHint, setTokenHint] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [who, setWho] = useState<"everyone" | "groups">("everyone");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [onTools, setOnTools] = useState<string[]>([]);
  const [runTools, setRunTools] = useState<string[]>([]);
  const [sendUser, setSendUser] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [settling, setSettling] = useState<"use" | "keep" | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewRef = useRef<HTMLElement>(null);
  /** Counts up when tools come to look over after something done here, to bring them into view. */
  const [reveal, setReveal] = useState(0);

  useEffect(() => {
    const section = reviewRef.current;
    if (!reveal || !section) return;
    // Its title comes to rest below the page's sticky header, not under it.
    section.style.scrollMarginTop = `${(document.querySelector(".oy-page-header")?.getBoundingClientRect().height ?? 0) + 16}px`;
    section.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [reveal]);
  // Back from the server's sign-in page: how it went, read once from the address.
  const [signedIn] = useState(() => new URLSearchParams(location.search).get("result"));

  const fill = (s: McpServer) => {
    setServer(s);
    setName(s.name);
    setUrl(s.url);
    setAuthMode(s.authMode);
    setTokenHint(s.tokenHint);
    setClientId(s.clientId);
    setOwnToken("");
    setClientSecret("");
    setWho(s.shared ? "everyone" : "groups");
    setGroupIds(s.groupIds.map(String));
    setEnabled(s.enabled);
    setOnTools(s.tools.map((t) => t.name).filter((t) => !s.offTools.includes(t)));
    setRunTools(s.runTools);
    setSendUser(s.sendUser);
  };

  useEffect(() => {
    if (location.search) navigate(location.pathname, { replace: true });
    api.get<{ groups: Group[] }>("/admin/groups").then((r) => setGroups(r.groups), () => {});
    if (adding) return;
    api.get<{ servers: McpServer[] }>("/admin/mcp").then(
      (r) => {
        const found = r.servers.find((s) => String(s.id) === id);
        if (found) fill(found);
        else setLoadError(t("This server doesn't exist any more"));
      },
      (err) => setLoadError((err as Error).message),
    );
  }, [id, adding]);

  /** Goes to the server's sign-in page as yourself, to come back here with its tools listed. False when it couldn't start. */
  const signIn = async (serverId: number) => {
    try {
      const { url: page } = await api.post<{ url: string }>(`/mcp/connections/${serverId}/sign-in`, { from: "admin" });
      window.location.assign(page);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const signInToList = async (serverId: number) => {
    setChecking(true);
    setError(null);
    if (!(await signIn(serverId))) setChecking(false);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name,
        url,
        authMode,
        headers: authMode === "shared" ? headers : undefined,
        ownToken: authMode === "token" ? ownToken : undefined,
        tokenHint: authMode === "token" ? tokenHint : undefined,
        clientId: authMode === "oauth" ? clientId : undefined,
        clientSecret: authMode === "oauth" ? clientSecret : undefined,
        shared: who === "everyone",
        groupIds: groupIds.map(Number),
        sendUser,
      };
      if (adding) {
        const { server: made } = await api.post<{ server: McpServer }>("/admin/mcp", body);
        navigate(`/admin/mcp/${made.id}`, { replace: true });
        fill(made);
        // Its tools are listed once you've signed in to it.
        if (made.authMode === "oauth" && (await signIn(made.id))) return;
      } else {
        const offTools = server!.tools.map((t) => t.name).filter((t) => !onTools.includes(t));
        const { server: next } = await api.patch<{ server: McpServer }>(`/admin/mcp/${id}`, { ...body, keepHeaders: true, enabled, offTools, runTools });
        if (next.authMode === "oauth" && next.yours !== "connected") {
          // A new address, or signing in for the first time: you sign in, so it can list its tools.
          fill(next);
          if (await signIn(next.id)) return;
        } else if (next.pending && next.pending.version !== server?.pending?.version) {
          // A new address or token can bring tools that read differently: those stay here to look over.
          setHeaders("");
          takeServer(next);
        } else slideTo("/admin/tools", "back");
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  /** Shows the server as it is now, keeping what's been changed on the form and not saved yet. */
  const takeServer = (next: McpServer) => {
    const before = new Set(server?.tools.map((t) => t.name));
    const ranBefore = new Set(server?.runTools);
    setServer(next);
    // New tools come on; ones turned off stay off.
    setOnTools((list) => [...list.filter((t) => next.tools.some((x) => x.name === t)), ...next.tools.map((t) => t.name).filter((t) => !before.has(t))]);
    // Whether each runs unasked follows what the server says now, except where it was changed here.
    setRunTools((list) =>
      next.tools
        .map((t) => t.name)
        .filter((t) => (before.has(t) && list.includes(t) !== ranBefore.has(t) ? list.includes(t) : next.runTools.includes(t))),
    );
    if (next.pending && next.pending.version !== server?.pending?.version) {
      setReviewError(null);
      setReveal((n) => n + 1);
    }
  };

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const { server: next } = await api.post<{ server: McpServer }>(`/admin/mcp/${id}/refresh`);
      takeServer(next);
      if (next.error) setError(next.error);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  /** Uses the tools waiting to be looked over, or keeps the old ones. */
  const settle = async (use: boolean) => {
    if (!server?.pending) return;
    setSettling(use ? "use" : "keep");
    setReviewError(null);
    try {
      const { server: next } = await api.post<{ server: McpServer }>(`/admin/mcp/${id}/pending`, { use, version: server.pending.version });
      takeServer(next);
    } catch (err) {
      // Listed again meanwhile, or settled elsewhere: show what's waiting now, and why.
      const fresh = await api.get<{ servers: McpServer[] }>("/admin/mcp").then((r) => r.servers.find((s) => String(s.id) === id), () => undefined);
      if (fresh) takeServer(fresh);
      setReviewError((err as Error).message);
    } finally {
      setSettling(null);
    }
  };

  // Signing in to list its tools stands in for asking again, while you aren't signed in.
  const needsYourSignIn = !adding && server?.authMode === "oauth" && authMode === "oauth" && server.yours !== "connected";
  return (
    <div className="admin-page">
      <PageHeader
        title={adding ? t("New MCP server") : (server?.name ?? t("MCP server"))}
        subtitle={server?.checkedAt ? t("Listed its tools {checkedAt}", { checkedAt: atOrOn(server.checkedAt) }) : undefined}
        back={{ label: t("Tools"), to: "/admin/tools" }}
      />
      <div className="oy-page-column page-body">
        {loadError ? (
          <Advisory>{loadError}</Advisory>
        ) : !adding && !server ? (
          <Spinner />
        ) : (
          <>
            {signedIn === "connected" ? (
              server?.error ? <Advisory>{server.error}</Advisory> : <Callout>{SIGN_IN_RESULTS.connected}</Callout>
            ) : (
              signedIn && SIGN_IN_RESULTS[signedIn] && <Advisory>{SIGN_IN_RESULTS[signedIn]}</Advisory>
            )}
            {server?.pending && <ListingReview sectionRef={reviewRef} pending={server.pending} busy={settling} error={reviewError} onSettle={(use) => void settle(use)} />}
            <form className="form-page" onSubmit={save}>
              <LineField id="mcp-name" label={t("Name")} value={name} maxLength={40} autoComplete="off" onChange={(e) => setName(e.target.value)} hint={t("Tools are named after it, like github__create_issue")} />
              <LineField id="mcp-url" label={t("Address")} value={url} autoComplete="off" spellCheck={false} onChange={(e) => setUrl(e.target.value)} hint={t("Its Streamable HTTP or SSE endpoint, often ending in /mcp")} />
              <OptionList
                label={t("Whose account it uses")}
                value={authMode}
                onChange={setAuthMode}
                options={[
                  { id: "shared", label: t("One shared account"), detail: t("Everyone who can use it acts with the headers below") },
                  { id: "oauth", label: t("Each person signs in"), detail: t("On the server's own sign-in page, from Settings, under Connected services") },
                  { id: "token", label: t("Each person adds a token"), detail: t("A token of their own, from Settings, under Connected services") },
                ]}
              />
              {authMode === "shared" && (
                <LineArea
                  id="mcp-headers"
                  label={server?.headerNames.length ? t("New headers ({headerNames} kept when empty)", { headerNames: server.headerNames.join(", ") }) : t("Headers (optional)")}
                  value={headers}
                  spellCheck={false}
                  onChange={(e) => setHeaders(e.target.value)}
                  hint={t("One per line, like Authorization: Bearer abc123, or just a token. Everyone who can use the server acts with these. Kept encrypted and never shown again")}
                />
              )}
              {authMode === "token" && (
                <>
                  <LineField
                    id="mcp-own-token"
                    label={server?.authMode === "token" && server.yours === "connected" ? t("A new token of yours (yours is kept when empty)") : t("Your own token")}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={ownToken}
                    onChange={(e) => setOwnToken(e.target.value)}
                    hint={t("It lists the server's tools, and your own chats use it. Nobody else's do. Kept encrypted and never shown again")}
                  />
                  <LineField
                    id="mcp-token-hint"
                    label={t("What to tell people (optional)")}
                    value={tokenHint}
                    maxLength={300}
                    autoComplete="off"
                    onChange={(e) => setTokenHint(e.target.value)}
                    hint={t("Shown where they add theirs, like where to make one and what it needs")}
                  />
                </>
              )}
              {authMode === "oauth" && (
                <>
                  <LineField
                    id="mcp-client-id"
                    label={t("Client ID (optional)")}
                    value={clientId}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setClientId(e.target.value)}
                    hint={t("Only for a sign-in service that doesn't let Parley register itself. Register Parley there with {callbackUrl} as its callback address", {
                      callbackUrl: server?.callbackUrl ?? `${window.location.origin}/api/mcp/callback`,
                    })}
                  />
                  {clientId.trim() && (
                    <LineField
                      id="mcp-client-secret"
                      label={server?.hasClientSecret ? t("A new client secret (the saved one is kept when empty)") : t("Client secret (optional)")}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                    />
                  )}
                  <p className="panel-note">
                    {adding
                      ? t("Connecting takes you to its sign-in page. Your own account there lists its tools")
                      : t("A new address, or a new way of signing in, disconnects everyone, so each person connects again")}
                  </p>
                </>
              )}
              <OptionList
                label={t("Who can use it")}
                value={who}
                onChange={setWho}
                options={[
                  { id: "everyone", label: t("Everyone") },
                  { id: "groups", label: t("Only some groups") },
                ]}
              />
              {who === "groups" && (
                <CheckList
                  label={t("Groups")}
                  values={groupIds}
                  onChange={setGroupIds}
                  options={groups.map((g) => ({ id: String(g.id), label: g.name, detail: plural(g.memberIds.length, "person", "people") }))}
                  empty={t("There are no groups yet. Make them under Groups")}
                />
              )}
              <div className="oy-section is-plain">
                {!adding && server && (
                  <div className="oy-row">
                    <div className="text">
                      <label className="title" htmlFor="mcp-enabled">
                        {t("On")}
                      </label>
                      <div className="desc">{t("Off, its tools stop working in every chat until it's back on")}</div>
                    </div>
                    <Switch id="mcp-enabled" checked={enabled} onChange={setEnabled} />
                  </div>
                )}
                <div className="oy-row">
                  <div className="text">
                    <label className="title" htmlFor="mcp-send-user">
                      {t("Tell it who's asking")}
                    </label>
                    <div className="desc">{t("Each request carries the person's email in an X-Parley-User header, so the server can tell people apart")}</div>
                  </div>
                  <Switch id="mcp-send-user" checked={sendUser} onChange={setSendUser} />
                </div>
              </div>
              {!adding && server && (
                <>
                  <CheckList
                    label={t("Tools people can use")}
                    values={onTools}
                    onChange={setOnTools}
                    options={server.tools.map((t) => ({ id: t.name, label: t.title || t.name, detail: t.description.split("\n")[0].slice(0, 160) || undefined }))}
                    empty={needsYourSignIn ? t("Sign in to it to list them") : t("It lists no tools")}
                  />
                  <CheckList
                    label={t("Run without asking")}
                    values={runTools}
                    onChange={setRunTools}
                    options={server.tools.filter((t) => onTools.includes(t.name)).map((t) => ({ id: t.name, label: t.title || t.name, detail: hintOf(t) }))}
                    empty={t("No tools are on")}
                  />
                  <p className="panel-note">{t("The rest ask the person on a line in the chat each time, showing what they'd send")}</p>
                  {needsYourSignIn ? (
                    <BusyButton type="button" className="btn-ghost is-accent push-left mcp-check" busy={checking} onClick={() => void signInToList(server.id)}>
                      <Icon name="plug" size={16} />
                      {server.yours === "expired" ? t("Sign in again to list its tools") : t("Sign in to list its tools")}
                    </BusyButton>
                  ) : (
                    <BusyButton type="button" className="btn-ghost is-accent push-left mcp-check" busy={checking} onClick={() => void check()}>
                      <Icon name="retry" size={16} />
                      {t("Ask it for its tools again")}
                    </BusyButton>
                  )}
                </>
              )}
              {adding && authMode !== "oauth" && <p className="panel-note">{t("Saving connects to it and lists its tools")}</p>}
              {error && <Advisory>{error}</Advisory>}
              <div className="form-page-actions">
                <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!name.trim() || !url.trim() || (adding && authMode === "token" && !ownToken.trim())}>
                  {adding ? t("Connect") : t("Save")}
                </BusyButton>
                <SlideLink to="/admin/tools" direction="back" className="btn-secondary">
                  {t("Cancel")}
                </SlideLink>
              </div>
            </form>
            {!adding && server && server.authMode !== "shared" && (
              <div className="oy-group settings-group">
                <p className="oy-overline">
                  {server.people.length
                    ? tn(server.people.length, "{count} person connected", "{count} people connected", { count: formatNumber(server.people.length) })
                    : t("People connected")}
                </p>
                {server.people.length === 0 ? (
                  <p className="group-empty">{t("Nobody yet. People connect their own account under Settings, in Connected services")}</p>
                ) : (
                  <div className="oy-section is-plain">
                    {server.people.map((p) => (
                      <div key={p.email} className="oy-row">
                        <Icon name="user" size={20} />
                        <div className="text">
                          <p className="title truncate">{p.email}</p>
                          <div className={`desc${p.status === "expired" ? " text-warning" : ""}`}>{personText(p)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <p className="panel-note">{t("You see who has connected, never what with. Each person's token is kept encrypted, like API keys")}</p>
              </div>
            )}
            {!adding && (
              <div className="settings-danger">
                {server && server.authMode !== "shared" && server.people.length > 0 && (
                  <DangerRow
                    label={t("Disconnect everyone")}
                    confirmLabel={t("Disconnect everyone? Each person connects again before chats can use its tools")}
                    action={t("Disconnect")}
                    onConfirm={async () => {
                      const { server: next } = await api.post<{ server: McpServer }>(`/admin/mcp/${id}/disconnect`);
                      fill(next);
                    }}
                  />
                )}
                <DangerRow
                  label={t("Remove this server")}
                  confirmLabel={t("Remove it? Its tools stop working in every chat")}
                  onConfirm={async () => {
                    await api.del(`/admin/mcp/${id}`);
                    slideTo("/admin/tools", "back", { replace: true });
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
