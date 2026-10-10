// Knowledge bases: documents a chat can search. A person keeps their own, and admins can share
// theirs with everyone on the site. Each document's text (PDF, Word or plain text) is cut into
// overlapping parts and kept in a full-text index; the search_knowledge tool finds the parts that
// match what the model looks for. Trigram matching means Chinese and Japanese need no word breaks.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { sniff } from "./attachments.ts";
import { db, nowIso } from "./db.ts";
import { FILES_DIR, safeName } from "./files.ts";
import { isZip, readZip } from "./zip.ts";

export const MAX_DOC_BYTES = 30 * 1024 * 1024;
export const MAX_DOCS = 300;
/** Text past this is left out of a document's index (a few hundred pages of prose). */
const MAX_DOC_CHARS = 3_000_000;
/** A part is about this many characters, and each starts this far back into the one before. */
const PART_CHARS = 1400;
const OVERLAP_CHARS = 200;

export type KnowledgeBaseRow = {
  id: string;
  user_id: number;
  name: string;
  description: string;
  shared: number;
  created_at: string;
  updated_at: string;
};

export type KnowledgeDocRow = {
  id: string;
  kb_id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  chars: number;
  parts: number;
  created_at: string;
};

const folderOf = (kbId: string) => join(FILES_DIR, "knowledge", kbId);

export function getBase(id: string): KnowledgeBaseRow | undefined {
  return db.prepare("SELECT * FROM knowledge_bases WHERE id = ?").get(id) as KnowledgeBaseRow | undefined;
}

/** The knowledge bases a person can search: their own, and the ones admins shared with everyone. */
export function usableBases(userId: number): KnowledgeBaseRow[] {
  return db
    .prepare("SELECT * FROM knowledge_bases WHERE user_id = ? OR shared = 1 ORDER BY shared, lower(name)")
    .all(userId) as KnowledgeBaseRow[];
}

export const canUse = (kb: KnowledgeBaseRow | undefined, userId: number) => !!kb && (kb.user_id === userId || kb.shared === 1);
/** Only its owner changes a knowledge base; a shared one is an admin's, so other admins may too. */
export const canEdit = (kb: KnowledgeBaseRow | undefined, user: { id: number; role: string }) =>
  !!kb && (kb.user_id === user.id || (kb.shared === 1 && user.role === "admin"));

export function docsOf(kbId: string): KnowledgeDocRow[] {
  return db.prepare("SELECT * FROM knowledge_docs WHERE kb_id = ? ORDER BY created_at DESC").all(kbId) as KnowledgeDocRow[];
}

export function createBase(userId: number, name: string, description: string, shared: boolean): KnowledgeBaseRow {
  const id = randomBytes(9).toString("base64url");
  const now = nowIso();
  db.prepare("INSERT INTO knowledge_bases (id, user_id, name, description, shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    userId,
    name,
    description,
    shared ? 1 : 0,
    now,
    now,
  );
  return getBase(id)!;
}

export function deleteBase(kbId: string) {
  db.prepare("DELETE FROM knowledge_chunks WHERE kb_id = ?").run(kbId);
  db.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(kbId);
  rmSync(folderOf(kbId), { recursive: true, force: true });
}

export function deleteDoc(doc: KnowledgeDocRow) {
  db.prepare("DELETE FROM knowledge_chunks WHERE doc_id = ?").run(doc.id);
  db.prepare("DELETE FROM knowledge_docs WHERE id = ?").run(doc.id);
  db.prepare("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?").run(nowIso(), doc.kb_id);
  try {
    if (existsSync(doc.path)) unlinkSync(doc.path);
  } catch (err) {
    console.error(`[knowledge] couldn't remove ${doc.path}:`, err);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    // A number past the last character there is stays as it's written.
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });

// The markup is taken apart with patterns that can't look past the next "<" (and scans that only
// go forward), so the time they take grows with the text and nothing else. Patterns like
// <[^>]+> or a lazy <!--[\s\S]*?--> try again from every "<" when nothing closes it: a few
// megabytes of "<a<a<a" kept the server busy for most of an hour.

/** The largest word/document.xml opened: thousands of pages, and far past what a knowledge base keeps. */
const MAX_DOCX_XML_BYTES = 64 * 1024 * 1024;

/** A Word document's words, a paragraph to a line. */
function docxText(bytes: Buffer): string | null {
  const entry = readZip(bytes)?.find((e) => e.name === "word/document.xml");
  if (!entry) return null;
  const xml = entry.read(MAX_DOCX_XML_BYTES).toString("utf8");
  return decodeEntities(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br[^<>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^<>]+>/g, ""),
  );
}

/**
 * Takes out every script, style, noscript, svg and template element and every comment. One that
 * never closes stays (its tags go with the rest) and isn't looked for again.
 */
function withoutHidden(html: string): string {
  const open = /<(script|style|noscript|svg|template)\b|<!--/gi;
  const unclosed = new Set<string>();
  const kept: string[] = [];
  let from = 0;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const kind = m[1]?.toLowerCase() ?? "comment";
    if (unclosed.has(kind)) continue;
    const close = kind === "comment" ? /-->/g : new RegExp(`</${kind}\\s*>`, "gi");
    close.lastIndex = open.lastIndex;
    if (!close.exec(html)) {
      unclosed.add(kind);
      continue;
    }
    kept.push(html.slice(from, m.index), " ");
    from = open.lastIndex = close.lastIndex;
  }
  kept.push(html.slice(from));
  return kept.join("");
}

/** A web page's words, without its markup, scripts or styles. */
export function htmlText(html: string): string {
  return decodeEntities(
    withoutHidden(html)
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/blockquote|\/pre)[^<>]*>/gi, "\n")
      .replace(/<li[^<>]*>/gi, "\n• ")
      .replace(/<[^<>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text of a document, by what its bytes are: PDF, Word, or text. Null with a reason when it can't be read. */
export async function documentText(name: string, bytes: Buffer): Promise<{ text: string; mime: string } | { error: string }> {
  const { kind } = sniff(bytes);
  const ext = extname(name).toLowerCase();
  try {
    if (kind === "pdf") {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: false });
      const pages = (Array.isArray(text) ? text : [text]).map((p) => p.trim());
      const joined = pages.join("\n\n").trim();
      if (!joined) return { error: `${name} has no text to read. A scanned PDF needs its text recognised first` };
      return { text: joined, mime: "application/pdf" };
    }
    if (isZip(bytes) && ext === ".docx") {
      const text = docxText(bytes);
      if (text?.trim()) return { text, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
      return { error: `${name} has no text to read` };
    }
    if (!bytes.includes(0)) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
      if (!text.trim()) return { error: `${name} is empty` };
      if (ext === ".html" || ext === ".htm") return { text: htmlText(text), mime: "text/html" };
      return { text, mime: "text/plain" };
    }
  } catch (err) {
    console.error(`[knowledge] couldn't read ${name}:`, err);
    return { error: `${name} couldn't be read. It may be damaged or protected` };
  }
  return { error: "Knowledge takes PDFs, Word documents (.docx) and text files like .txt, .md, .csv or code" };
}

/**
 * Cuts text into parts of about PART_CHARS, each ending at a paragraph or sentence where one is
 * near, and starting a little before the last one ended so nothing falls between two parts.
 */
export function partsOf(text: string): string[] {
  const clean = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const parts: string[] = [];
  let at = 0;
  while (at < clean.length) {
    let end = Math.min(clean.length, at + PART_CHARS);
    if (end < clean.length) {
      const window = clean.slice(at + Math.floor(PART_CHARS * 0.6), end);
      const breaks = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), Math.max(window.lastIndexOf("。"), window.lastIndexOf(". "), window.lastIndexOf("！"), window.lastIndexOf("？"))];
      const cut = breaks.find((b) => b > 0);
      if (cut != null) end = at + Math.floor(PART_CHARS * 0.6) + cut + 1;
    }
    const part = clean.slice(at, end).trim();
    if (part) parts.push(part);
    if (end >= clean.length) break;
    at = Math.max(end - OVERLAP_CHARS, at + 1);
  }
  return parts;
}

/** Keeps a document in a knowledge base and indexes its text. A sentence comes back when it can't. */
export async function addDocument(kb: KnowledgeBaseRow, rawName: string, bytes: Buffer): Promise<KnowledgeDocRow | { error: string }> {
  if (!bytes.length) return { error: "This file is empty" };
  if (bytes.length > MAX_DOC_BYTES) return { error: `Documents can be up to ${MAX_DOC_BYTES / (1024 * 1024)} MB` };
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM knowledge_docs WHERE kb_id = ?").get(kb.id) as { n: number };
  if (n >= MAX_DOCS) return { error: `A knowledge base holds up to ${MAX_DOCS} documents` };
  const name = safeName(rawName);
  const read = await documentText(name, bytes);
  if ("error" in read) return read;
  const text = read.text.slice(0, MAX_DOC_CHARS);
  const parts = partsOf(text);
  if (!parts.length) return { error: `${name} has no text to read` };

  const id = randomBytes(9).toString("base64url");
  const folder = folderOf(kb.id);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${id}${extname(name).slice(0, 12)}`);
  writeFileSync(path, bytes);
  const now = nowIso();
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO knowledge_docs (id, kb_id, name, mime, size, path, chars, parts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, kb.id, name, read.mime, bytes.length, path, text.length, parts.length, now);
    const put = db.prepare("INSERT INTO knowledge_chunks (text, doc_id, kb_id, part) VALUES (?, ?, ?, ?)");
    parts.forEach((p, i) => put.run(p, id, kb.id, i + 1));
    db.prepare("UPDATE knowledge_bases SET updated_at = ? WHERE id = ?").run(now, kb.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    rmSync(path, { force: true });
    throw err;
  }
  return db.prepare("SELECT * FROM knowledge_docs WHERE id = ?").get(id) as KnowledgeDocRow;
}

const CJK_CHARS = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff";
/** A run of Chinese, Japanese or Korean, or a run of other letters and digits. */
const TOKEN = new RegExp(`[${CJK_CHARS}]+|(?:(?![${CJK_CHARS}])[\\p{L}\\p{N}_.+#-])+`, "gu");
const CJK = new RegExp(`[${CJK_CHARS}]`, "u");

/**
 * What to look for in a query: words of three characters or more for the trigram index, and the
 * short ones (two-character Chinese words, "AI") to match plainly. A run of Chinese or Japanese is
 * read as its overlapping three-character pieces, so a phrase finds text that shares most of it.
 */
function termsOf(query: string): { long: string[]; short: string[] } {
  const long = new Set<string>();
  const short = new Set<string>();
  for (const token of query.toLowerCase().match(TOKEN) ?? []) {
    const chars = [...token];
    if (CJK.test(token) && chars.length > 3) {
      for (let i = 0; i + 3 <= chars.length && long.size < 40; i++) long.add(chars.slice(i, i + 3).join(""));
    } else if (chars.length >= 3) long.add(token);
    else if (chars.length === 2) short.add(token);
  }
  return { long: [...long], short: [...short].slice(0, 12) };
}

export type KnowledgeHit = { docId: string; docName: string; kbName: string; part: number; parts: number; text: string };

/** The parts of these knowledge bases' documents that best match the query, best first. */
export function searchKnowledge(kbIds: string[], query: string, limit = 6, docName?: string): KnowledgeHit[] {
  if (!kbIds.length) return [];
  const { long, short } = termsOf(query);
  if (!long.length && !short.length) return [];
  const inBases = `kb_id IN (SELECT value FROM json_each(?))`;
  const scores = new Map<number, number>();
  if (long.length) {
    const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    const rows = db
      .prepare(`SELECT rowid, bm25(knowledge_chunks) AS score FROM knowledge_chunks WHERE knowledge_chunks MATCH ? AND ${inBases} ORDER BY score LIMIT 200`)
      .all(match, JSON.stringify(kbIds)) as { rowid: number; score: number }[];
    // bm25 is lower for better matches.
    for (const r of rows) scores.set(r.rowid, -r.score);
  }
  for (const term of short) {
    const rows = db
      .prepare(`SELECT rowid FROM knowledge_chunks WHERE text LIKE ? AND ${inBases} LIMIT 400`)
      .all(`%${term.replace(/[%_]/g, "")}%`, JSON.stringify(kbIds)) as { rowid: number }[];
    for (const r of rows) scores.set(r.rowid, (scores.get(r.rowid) ?? 0) + 1);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([rowid]) => rowid);
  const get = db.prepare(
    `SELECT c.text, c.doc_id, c.part, d.name AS doc_name, d.parts, k.name AS kb_name
     FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id JOIN knowledge_bases k ON k.id = d.kb_id WHERE c.rowid = ?`,
  );
  const hits: KnowledgeHit[] = [];
  for (const rowid of ranked) {
    const r = get.get(rowid) as { text: string; doc_id: string; part: number; doc_name: string; parts: number; kb_name: string } | undefined;
    if (!r) continue;
    if (docName && !r.doc_name.toLowerCase().includes(docName.toLowerCase())) continue;
    hits.push({ docId: r.doc_id, docName: r.doc_name, kbName: r.kb_name, part: Number(r.part), parts: r.parts, text: r.text });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * The knowledge bases a chat searches: the ones picked for it and its project's, as long as the
 * person can still use them.
 */
export function chatBases(userId: number, conversationId: string | null, projectId: string | null): KnowledgeBaseRow[] {
  return db
    .prepare(
      `SELECT k.* FROM knowledge_bases k
       WHERE (k.user_id = ? OR k.shared = 1)
         AND (k.id IN (SELECT kb_id FROM conversation_knowledge WHERE conversation_id = ?)
           OR k.id IN (SELECT kb_id FROM project_knowledge WHERE project_id = ?))
       ORDER BY lower(k.name)`,
    )
    .all(userId, conversationId, projectId) as KnowledgeBaseRow[];
}

/** Removes index entries whose document is gone (its owner's account was deleted, say). */
export function clearOrphanedKnowledge() {
  db.prepare("DELETE FROM knowledge_chunks WHERE doc_id NOT IN (SELECT id FROM knowledge_docs)").run();
}
