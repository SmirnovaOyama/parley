// Web search and page reading for models without their own (DeepSeek, Gemini, Grok, other
// services), through a search service an admin sets up: Tavily, Brave, Bocha, Jina, or a SearXNG of
// their own. Claude and OpenAI keep their built-in search. Pages are fetched by this server, so
// addresses inside the network it runs in (localhost, 10.x, cloud metadata) are refused.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch } from "undici";
import { decryptSecret } from "./crypto.ts";
import { getSettings, searchKeySealed, type SearchProvider } from "./db.ts";
import { env } from "./env.ts";
import { documentText, htmlText } from "./knowledge.ts";
import type { Source, ToolSpec } from "./providers/types.ts";

export const SEARCH_SERVICES: { id: SearchProvider; label: string; detail: string; needs: "key" | "url" }[] = [
  { id: "tavily", label: "Tavily", detail: "Search made for AI models, with a free monthly allowance", needs: "key" },
  { id: "brave", label: "Brave Search", detail: "Brave's own index of the web", needs: "key" },
  { id: "bocha", label: "Bocha", detail: "博查, a search API that reaches the Chinese web well", needs: "key" },
  { id: "jina", label: "Jina", detail: "Jina's search, which reads the pages it finds", needs: "key" },
  { id: "searxng", label: "SearXNG", detail: "A search engine you host yourself, with JSON output turned on", needs: "url" },
];

const RESULTS = 6;
const TIMEOUT_MS = 20_000;
/** A page is read up to this size, and this much of its text goes to the model. */
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_PAGE_CHARS = 40_000;

/** Whether web search can run for models without their own: a service is chosen and ready. */
export function searchServiceReady(): boolean {
  const s = getSettings();
  if (!s.searchProvider) return false;
  const service = SEARCH_SERVICES.find((x) => x.id === s.searchProvider)!;
  return service.needs === "url" ? !!s.searchUrl : !!searchKeySealed();
}

export const WEB_TOOLS: ToolSpec[] = [
  {
    name: "web_search",
    description:
      "Search the web. Use it for anything recent, or facts you aren't sure of. Returns titles, addresses and short excerpts; read a page with read_page when an excerpt isn't enough. When you use what you found, link the page in your answer as a Markdown link.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for, as you'd type it into a search engine" } },
      required: ["query"],
    },
  },
  {
    name: "read_page",
    description: "Read a web page or online document (HTML, text or PDF) by its address, such as one web_search found or the person gave you.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The full address, starting with https:// or http://" } },
      required: ["url"],
    },
  },
];

type Found = { title: string; url: string; snippet: string };

async function getJson(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(res.status === 401 || res.status === 403 ? "The search service turned down its key" : `The search service answered ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Searches with the site's service. Throws a sentence when it can't. */
export async function webSearch(query: string): Promise<Found[]> {
  const s = getSettings();
  const sealed = searchKeySealed();
  const key = sealed ? decryptSecret(sealed) : "";
  const list = (rows: unknown, map: (r: Record<string, unknown>) => Found) =>
    (Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []).map(map).filter((r) => r.url).slice(0, RESULTS);
  switch (s.searchProvider) {
    case "tavily": {
      const data = await getJson("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: RESULTS, search_depth: "basic" }),
      });
      return list(data.results, (r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content) }));
    }
    case "brave": {
      const data = await getJson(`https://api.search.brave.com/res/v1/web/search?count=${RESULTS}&q=${encodeURIComponent(query)}`, {
        headers: { accept: "application/json", "x-subscription-token": key },
      });
      return list((data.web as { results?: unknown })?.results, (r) => ({ title: str(r.title), url: str(r.url), snippet: htmlText(str(r.description)) }));
    }
    case "bocha": {
      const data = await getJson("https://api.bochaai.com/v1/web-search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, count: RESULTS, summary: true }),
      });
      const pages = ((data.data as { webPages?: { value?: unknown } })?.webPages?.value) ?? [];
      return list(pages, (r) => ({ title: str(r.name), url: str(r.url), snippet: str(r.summary) || str(r.snippet) }));
    }
    case "jina": {
      const data = await getJson(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
        headers: { accept: "application/json", authorization: `Bearer ${key}` },
      });
      return list(data.data, (r) => ({ title: str(r.title), url: str(r.url), snippet: (str(r.description) || str(r.content)).slice(0, 600) }));
    }
    case "searxng": {
      const base = s.searchUrl.replace(/\/+$/, "");
      const data = await getJson(`${base}/search?format=json&q=${encodeURIComponent(query)}`, { headers: { accept: "application/json" } });
      return list(data.results, (r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content) }));
    }
    default:
      throw new Error("Web search isn't set up on this site");
  }
}

/** The results as the model reads them, numbered. */
export function searchResultsText(query: string, results: Found[]): string {
  if (!results.length) return `Nothing came up for “${query}”. Try other words.`;
  return results.map((r, i) => `[${i + 1}] ${r.title || r.url}\n${r.url}\n${r.snippet.replace(/\s+/g, " ").trim().slice(0, 700)}`).join("\n\n");
}

export const asSources = (results: Found[]): Source[] => results.map((r) => ({ url: r.url, title: r.title }));

// ── Reading pages, safely ───────────────────────────────────────────

/**
 * Addresses a page may not be read from: this machine, private networks, link-local (cloud
 * metadata lives there), and IPv6 ranges that are unused, retired, or reach IPv4 by a route of
 * their own. IPv6 addresses that carry an IPv4 one (mapped, NAT64, 6to4) are judged by it.
 */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback, and the retired IPv4-compatible form
  ["::ffff:0:0:0", 96], // IPv4-translated (SIIT)
  ["64:ff9b:1::", 48], // NAT64 for local use, which may put the IPv4 address anywhere
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["fc00::", 7], ["fec0::", 10], ["fe80::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(net, prefix, "ipv6");

/**
 * Proxies that answer every name with a "fake" address of their own (Clash, Surge, sing-box and
 * the like) use this range. Behind one, where a name really points can't be checked, so it's
 * refused unless ALLOW_FAKE_IP says the server runs behind such a proxy.
 */
const FAKE_IP = new BlockList();
FAKE_IP.addSubnet("198.18.0.0", 15, "ipv4");

/** The IPv4 address inside an IPv6 one that carries it: ::ffff:a.b.c.d, NAT64's 64:ff9b::/96, 6to4. */
function embeddedIpv4(ip: string): string | null {
  // The eight 16-bit groups, with "::" filled in and a dotted tail made into two groups.
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const g = [...front, ...Array(tail === undefined ? 0 : 8 - front.length - back.length).fill("0"), ...back].map((x) => parseInt(x, 16));
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return null;
}

export function blockedAddress(ip: string, allowFakeIp = env.allowFakeIp): boolean {
  let v4 = ip;
  if (isIP(ip) === 6) {
    const inside = embeddedIpv4(ip);
    if (!inside) return BLOCKED.check(ip, "ipv6");
    v4 = inside;
  }
  return BLOCKED.check(v4, "ipv4") || (!allowFakeIp && FAKE_IP.check(v4, "ipv4"));
}

/** Every connection checks where the name really points, so a name can't be turned inward between checks. */
const guardedLookup = (hostname: string, options: object, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as LookupAddress[];
    const blocked = list.find((a) => blockedAddress(a.address));
    if (!list.length || blocked) {
      const why = blocked && !blockedAddress(blocked.address, true)
        ? `${hostname} points at a proxy's stand-in address, so where it really leads can't be checked (see ALLOW_FAKE_IP)`
        : `${hostname} points inside this server's network`;
      return callback(Object.assign(new Error(why), { code: "EBLOCKED" }), "");
    }
    if ((options as { all?: boolean }).all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
};
const pageAgent = new Agent({ connect: { lookup: guardedLookup as never, timeout: 30_000 } });

/** Checks an address before it's fetched: http or https, and not a blocked IP written out. */
function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That isn't a web address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https pages can be read");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Pages inside this server's network can't be read");
  }
  if (isIP(host) && blockedAddress(host)) throw new Error("Pages inside this server's network can't be read");
  return url;
}

/** The words of a page's <title>, found by scanning forward only (see htmlText). */
function titleOf(html: string): string {
  const open = /<title[^<>]*>/i.exec(html);
  if (!open) return "";
  const start = open.index + open[0].length;
  const close = /<\/title\s*>/gi;
  close.lastIndex = start;
  const end = close.exec(html);
  return end ? htmlText(html.slice(start, Math.min(end.index, start + 2000))).slice(0, 200) : "";
}

/** A page's text, read by this server: HTML without its markup, text as it is, PDFs' text. */
export async function readPage(raw: string): Promise<{ url: string; title: string; text: string }> {
  let url = checkUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, {
      dispatcher: pageAgent,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "Mozilla/5.0 (compatible; ParleyReader/1.0)", accept: "text/html,text/plain,application/pdf,application/json;q=0.9,*/*;q=0.5" },
    }).catch((err) => {
      // A refused address says why, not just "fetch failed".
      throw err?.cause?.code === "EBLOCKED" ? err.cause : err;
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= 5) throw new Error("The page redirects too many times");
      url = checkUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`The page answered ${res.status}`);
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_PAGE_BYTES) throw new Error("The page is too big to read");
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = reader ? await reader.read() : { value: undefined, done: true };
      if (done || !value) break;
      size += value.length;
      if (size > MAX_PAGE_BYTES) {
        void reader?.cancel();
        break;
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    const type = res.headers.get("content-type") ?? "";
    let title = "";
    let text: string;
    if (/pdf/i.test(type) || bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
      const read = await documentText("page.pdf", bytes);
      if ("error" in read) throw new Error(read.error);
      text = read.text;
    } else {
      const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? "utf-8";
      let raw: string;
      try {
        raw = new TextDecoder(charset).decode(bytes);
      } catch {
        raw = new TextDecoder("utf-8").decode(bytes);
      }
      if (/html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(raw)) {
        title = titleOf(raw);
        text = htmlText(raw);
      } else if (/^(text\/|application\/(json|xml|javascript))/i.test(type) || !type) {
        text = raw;
      } else {
        throw new Error("That address isn't a page or document that can be read");
      }
    }
    if (text.length > MAX_PAGE_CHARS) text = `${text.slice(0, MAX_PAGE_CHARS)}\n\n(The page goes on; this is its first part.)`;
    return { url: url.toString(), title, text: text || "(The page has no text.)" };
  }
}
