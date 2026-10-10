// The app's own tools in a chat, offered to every model as functions: memory, knowledge search, the
// tools of MCP servers, and (for models without their own) web search and page reading. A chat's
// list is settled when it starts (conversations.tool_defs), because Claude ties its reasoning to the
// exact tools a chat declares; whether each one still works is decided when it's called.
import { chatBases, searchKnowledge, usableBases } from "./knowledge.ts";
import { callTool, canUseServer, declareTools, getServer, offToolsOf, serversFor } from "./mcp.ts";
import { cleanMemory, deleteMemory, memoryOn, saveMemory } from "./memory.ts";
import type { Source, ToolCall, ToolOutcome, ToolSpec } from "./providers/types.ts";
import { db } from "./db.ts";
import { PROVIDERS } from "./providers/catalog.ts";
import { asSources, readPage, searchResultsText, searchServiceReady, webSearch, WEB_TOOLS } from "./web-tools.ts";

/** The providers whose keys search the web and make files, as JSON for SQL's json_each. */
const TOOL_PROVIDERS = JSON.stringify(PROVIDERS.filter((p) => p.tools).map((p) => p.id));

/**
 * Some key has web search on, so new chats declare it: a Claude or OpenAI key (their own search), or
 * any other key while the site's search service is set up (search through it).
 */
export function searchOnSite(): boolean {
  if (searchServiceReady()) return !!db.prepare("SELECT 1 FROM api_keys WHERE web_search = 1 LIMIT 1").get();
  return !!db.prepare("SELECT 1 FROM api_keys WHERE provider IN (SELECT value FROM json_each(?)) AND web_search = 1 LIMIT 1").get(TOOL_PROVIDERS);
}

/** Some Claude or OpenAI key may make files, so new chats declare running code. */
export function codeOnSite(): boolean {
  return !!db.prepare("SELECT 1 FROM api_keys WHERE provider IN (SELECT value FROM json_each(?)) AND code_execution = 1 LIMIT 1").get(TOOL_PROVIDERS);
}

/** A tool a chat declared, and for an MCP server's, which server and tool it calls. */
export type DeclaredTool = ToolSpec & { mcp?: { server: number; tool: string } };

/** One use of a tool in a reply, shown under it: what happened, in words. */
export type ToolUse = { kind: "memory" | "knowledge" | "page" | "mcp"; text: string; error?: boolean };

export const MEMORY_TOOL: ToolSpec = {
  name: "memory",
  description:
    "Keep notes about the person between chats. action \"save\" stores one lasting fact or preference as a short sentence in the third person, like \"Teaches chemistry to 14-year-olds\". action \"delete\" removes a note by its id, from your notes or from an earlier save in this chat.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["save", "delete"] },
      text: { type: "string", description: "The note to save" },
      id: { type: "integer", description: "The id of the note to delete" },
    },
    required: ["action"],
  },
};

export const KNOWLEDGE_TOOL: ToolSpec = {
  name: "search_knowledge",
  description:
    "Search the knowledge bases connected to this chat (the person's own documents, or ones their admins share). Use it whenever the answer may be in them. It returns the passages that match best, each with the document it's from; name that document when you use it. Search again with other words if the first try misses.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words likely to appear in the passage you need" },
      document: { type: "string", description: "Only search documents whose name contains this" },
    },
    required: ["query"],
  },
};

/** The tools a new chat declares: memory while it's on, knowledge search when the person has any, and the MCP servers open to them. */
export function toolsForNewChat(userId: number): DeclaredTool[] {
  const tools: DeclaredTool[] = [];
  if (memoryOn(userId)) tools.push(MEMORY_TOOL);
  if (usableBases(userId).length) tools.push(KNOWLEDGE_TOOL);
  tools.push(...declareTools(serversFor(userId)));
  return tools;
}

export function declaredOf(json: string | null): DeclaredTool[] {
  if (!json) return [];
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? (list as DeclaredTool[]) : [];
  } catch {
    return [];
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

type ToolkitOptions = {
  userId: number;
  conversationId: string;
  /** The chat's tools, as it declared them. */
  declared: DeclaredTool[];
  signal: AbortSignal;
  /** "searching" with the query, or "tool" with a few words on what it's doing. */
  onStatus: (status: "searching" | "tool", detail: string) => void;
};

/** The functions a reply offers and how to run them, collecting what they did for the reply's record. */
export function chatToolkit(opts: ToolkitOptions) {
  const uses: ToolUse[] = [];
  const searches: string[] = [];
  const found: Source[] = [];
  const declared: ToolSpec[] = opts.declared.map(({ mcp: _mcp, ...spec }) => spec);
  /** What a model is offered: the chat's tools, and web search and page reading where it has no search of its own. */
  const functionsWith = (webTools: boolean): ToolSpec[] => [...declared, ...(webTools ? WEB_TOOLS : [])];
  const byName = new Map(opts.declared.map((t) => [t.name, t]));

  async function runOne(call: ToolCall): Promise<ToolOutcome> {
    const input = call.input;
    const declared = byName.get(call.name);
    if (declared?.mcp) {
      const server = getServer(declared.mcp.server);
      const label = server?.name ?? "a connected service";
      if (!server || !server.enabled || !canUseServer(server, opts.userId) || offToolsOf(server).includes(declared.mcp.tool)) {
        return { content: `${declared.mcp.tool} on ${label} isn't available any more. Tell the person if they were counting on it`, isError: true };
      }
      opts.onStatus("tool", `Using ${server.name}`);
      const outcome = await callTool(server, declared.mcp.tool, input, opts.signal);
      uses.push({ kind: "mcp", text: `Used ${declared.mcp.tool} on ${server.name}`, ...(outcome.isError ? { error: true } : {}) });
      return outcome;
    }

    switch (call.name) {
      case "memory": {
        if (!byName.has("memory")) break;
        if (!memoryOn(opts.userId)) return { content: "Memory is turned off for this person now. Don't save or delete notes", isError: true };
        if (input.action === "delete") {
          const id = Number(input.id);
          const row = db.prepare("SELECT text FROM memories WHERE id = ? AND user_id = ?").get(id, opts.userId) as { text: string } | undefined;
          if (!row || !deleteMemory(opts.userId, id)) return { content: `There's no note ${input.id}`, isError: true };
          opts.onStatus("tool", "Updating memory");
          uses.push({ kind: "memory", text: `Forgot “${row.text}”` });
          return { content: `Deleted note ${id}` };
        }
        const text = cleanMemory(input.text);
        if (!text) return { content: "Write the note to save in text", isError: true };
        opts.onStatus("tool", "Updating memory");
        const saved = saveMemory(opts.userId, text, opts.conversationId);
        if ("error" in saved) return { content: saved.error, isError: true };
        uses.push({ kind: "memory", text: `Remembered “${saved.text}”` });
        return { content: `Saved as note ${saved.id}` };
      }
      case "search_knowledge": {
        if (!byName.has("search_knowledge")) break;
        const query = String(input.query ?? "").trim();
        if (!query) return { content: "Say what to search for", isError: true };
        const conv = db.prepare("SELECT project_id FROM conversations WHERE id = ?").get(opts.conversationId) as { project_id: string | null } | undefined;
        const bases = chatBases(opts.userId, opts.conversationId, conv?.project_id ?? null);
        if (!bases.length) {
          return {
            content: "No knowledge bases are connected to this chat now. Answer from what you know; the person can connect one in the chat's settings",
            isError: true,
          };
        }
        opts.onStatus("tool", `Searching ${bases.length === 1 ? bases[0].name : "your knowledge"}`);
        const doc = typeof input.document === "string" && input.document.trim() ? input.document.trim() : undefined;
        const hits = searchKnowledge(bases.map((b) => b.id), query, 6, doc);
        const names = bases.map((b) => b.name).join(", ");
        uses.push({ kind: "knowledge", text: `Searched ${bases.length === 1 ? bases[0].name : "your knowledge"} for “${query}”${hits.length ? "" : " and found nothing"}` });
        if (!hits.length) return { content: `Nothing in ${names} matches “${query}”. Try other words, or answer from what you know and say the documents didn't cover it` };
        return {
          content: hits
            .map((h) => `<passage document="${h.docName.replace(/"/g, "'")}" knowledge_base="${h.kbName.replace(/"/g, "'")}" part="${h.part} of ${h.parts}">\n${h.text}\n</passage>`)
            .join("\n\n"),
        };
      }
      case "web_search": {
        if (!searchServiceReady()) break;
        const query = String(input.query ?? "").trim();
        if (!query) return { content: "Say what to search for", isError: true };
        opts.onStatus("searching", query);
        if (!searches.includes(query)) searches.push(query);
        const results = await webSearch(query);
        for (const s of asSources(results)) if (found.length < 10 && !found.some((f) => f.url === s.url)) found.push(s);
        return { content: searchResultsText(query, results) };
      }
      case "read_page": {
        if (!searchServiceReady()) break;
        const url = String(input.url ?? "").trim();
        opts.onStatus("tool", `Reading ${hostOf(url)}`);
        const page = await readPage(url);
        uses.push({ kind: "page", text: `Read ${page.title || hostOf(page.url)}` });
        return { content: `${page.title ? `${page.title}\n` : ""}${page.url}\n\n${page.text}` };
      }
    }
    return { content: `There's no tool called ${call.name} in this chat`, isError: true };
  }

  async function run(call: ToolCall): Promise<ToolOutcome> {
    try {
      return await runOne(call);
    } catch (err) {
      if (opts.signal.aborted) return { content: "Stopped", isError: true };
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tools] ${call.name} failed: ${message}`);
      if (call.name === "read_page") uses.push({ kind: "page", text: `Couldn't read ${hostOf(String(call.input.url ?? ""))}`, error: true });
      return { content: message || "The tool failed", isError: true };
    }
  }

  return { functionsWith, run, uses, searches, found };
}
