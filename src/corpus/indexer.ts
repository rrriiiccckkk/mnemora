import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { MnemoraConfig } from "../index.js";
import { createMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";

type CorpusConfig = {
  enabled: boolean; workspaceRoot: string; syncOnSearch: boolean; syncIntervalMs: number;
  maxFileBytes: number; maxFiles: number; maxSessionFilesPerAgent: number;
  maxChunkChars: number; maxChunkLines: number; includeSessions: boolean; includeDreamingArtifacts: boolean;
};
type SourceKind = "memory" | "session" | "dreaming";
type Candidate = { absolutePath: string; logicalPath: string; sourceKind: SourceKind; byteLength: number; mtimeMs: number };
type CorpusChunk = { id: string; startLine: number; endLine: number; content: string; contentHash: string };

export interface CorpusStatus {
  status: "disabled" | "ready" | "configuration_required";
  scope: string;
  documents: number;
  chunks: number;
  last_synced_at: number | null;
  sync_on_search: boolean;
  user_md_exclusive: boolean;
}
export interface CorpusSyncResult extends CorpusStatus {
  status: "disabled" | "ready" | "configuration_required";
  scanned: number;
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
}
export interface CorpusSearchResult {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  snippet: string;
  source: `canonical_corpus:${SourceKind}`;
  citation: string;
  context_ref: string;
}

/**
 * Bounded, local-only canonical corpus cache. It deliberately has no graph
 * writer and no prompt-injection callback: callers request citations directly.
 */
export class CanonicalCorpusIndexer {
  private readonly config: CorpusConfig;
  constructor(private readonly db: DatabaseSyncInstance, config: NonNullable<MnemoraConfig["corpus"]>, private readonly boundary: boolean, private readonly now: () => number = Date.now) {
    // normalizeConfig supplies all values; keep this narrow module independent
    // from the broad optional public configuration type.
    this.config = config as CorpusConfig;
  }

  status(scopeInput?: string): CorpusStatus {
    const scope = normalizeScope(scopeInput, "default");
    const row = this.db.prepare("SELECT COUNT(*) AS documents, COALESCE(SUM((SELECT COUNT(*) FROM mnemora_corpus_chunks c WHERE c.document_id=d.id)),0) AS chunks, MAX(last_synced_at) AS last_synced_at FROM mnemora_corpus_documents d WHERE scope=?").get(scope) as { documents?: number; chunks?: number; last_synced_at?: number | null };
    return {
      status: !this.config.enabled ? "disabled" : !this.config.workspaceRoot ? "configuration_required" : "ready",
      scope,
      documents: Number(row?.documents ?? 0),
      chunks: Number(row?.chunks ?? 0),
      last_synced_at: row?.last_synced_at == null ? null : Number(row.last_synced_at),
      sync_on_search: this.config.syncOnSearch,
      user_md_exclusive: this.boundary
    };
  }

  async sync(scopeInput?: string): Promise<CorpusSyncResult> {
    const state = this.status(scopeInput);
    if (state.status !== "ready") return { ...state, scanned: 0, indexed: 0, unchanged: 0, removed: 0, skipped: 0 };
    const scope = state.scope;
    const root = await safeRealpath(this.config.workspaceRoot);
    if (!root) return { ...state, status: "configuration_required", scanned: 0, indexed: 0, unchanged: 0, removed: 0, skipped: 0 };
    const found = await this.discover(root);
    const candidates = found.candidates;
    const now = this.now();
    this.ensureScope(scope, now);
    let indexed = 0, unchanged = 0, skipped = found.skipped;
    const seen = new Set<string>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of candidates) {
        const text = await boundedText(candidate.absolutePath, candidate.byteLength);
        if (text == null || text.includes("\0")) { skipped++; continue; }
        const id = stableId(`${scope}\0${candidate.logicalPath}`);
        const contentHash = hash(text);
        seen.add(id);
        const existing = this.db.prepare("SELECT content_hash FROM mnemora_corpus_documents WHERE id=? AND scope=?").get(id, scope) as { content_hash?: string } | undefined;
        if (existing?.content_hash === contentHash) {
          this.db.prepare("UPDATE mnemora_corpus_documents SET last_synced_at=?,byte_length=?,line_count=? WHERE id=? AND scope=?").run(now, Buffer.byteLength(text, "utf8"), lineCount(text), id, scope);
          unchanged++;
          continue;
        }
        if (existing) this.removeDocument(id);
        this.db.prepare("INSERT INTO mnemora_corpus_documents(id,scope,logical_path,source_kind,content_hash,byte_length,line_count,last_synced_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(id, scope, candidate.logicalPath, candidate.sourceKind, contentHash, Buffer.byteLength(text, "utf8"), lineCount(text), now);
        for (const chunk of chunkText(id, text, this.config.maxChunkChars, this.config.maxChunkLines)) {
          this.db.prepare("INSERT INTO mnemora_corpus_chunks(id,document_id,scope,start_line,end_line,content,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)")
            .run(chunk.id, id, scope, chunk.startLine, chunk.endLine, chunk.content, chunk.contentHash, now);
          this.db.prepare("INSERT INTO mnemora_corpus_chunks_fts(id,content) VALUES(?,?)").run(chunk.id, chunk.content);
        }
        indexed++;
      }
      // A disabled source class must stop being searchable on the next explicit
      // sync, rather than leaving a prior session/dream cache silently live.
      const sourceKinds: SourceKind[] = ["memory", "session", "dreaming"];
      const current = this.db.prepare(`SELECT id FROM mnemora_corpus_documents WHERE scope=? AND source_kind IN (${sourceKinds.map(() => "?").join(",")})`).all(scope, ...sourceKinds) as Array<{ id: string }>;
      let removed = 0;
      for (const row of current) if (!seen.has(row.id)) { this.removeDocument(row.id); removed++; }
      this.db.exec("COMMIT");
      return { ...this.status(scope), scanned: candidates.length, indexed, unchanged, removed, skipped };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async search(input: { query: string; scope?: string; limit?: number; sync?: boolean }): Promise<{ status: CorpusStatus["status"]; sync?: CorpusSyncResult; results: CorpusSearchResult[] }> {
    const scope = normalizeScope(input.scope, "default");
    let state = this.status(scope);
    if (state.status !== "ready") return { status: state.status, results: [] };
    let sync: CorpusSyncResult | undefined;
    const shouldSync = input.sync === true || (input.sync !== false && this.config.syncOnSearch && (state.last_synced_at == null || this.now() - state.last_synced_at >= this.config.syncIntervalMs));
    if (shouldSync) { sync = await this.sync(scope); state = sync; if (state.status !== "ready") return { status: state.status, sync, results: [] }; }
    const query = String(input.query ?? "").trim().slice(0, 512);
    if (!query) return { status: "ready", ...(sync ? { sync } : {}), results: [] };
    const limit = Math.min(20, Math.max(1, Math.trunc(input.limit ?? 5)));
    const fts = ftsQuery(query);
    let rows: Array<Record<string, unknown>> = [];
    if (fts) try {
      rows = this.db.prepare("SELECT c.id,c.start_line,c.end_line,c.content,d.logical_path,d.source_kind FROM mnemora_corpus_chunks_fts JOIN mnemora_corpus_chunks c ON c.id=mnemora_corpus_chunks_fts.id JOIN mnemora_corpus_documents d ON d.id=c.document_id WHERE mnemora_corpus_chunks_fts MATCH ? AND c.scope=? ORDER BY bm25(mnemora_corpus_chunks_fts),d.logical_path,c.start_line LIMIT ?").all(fts, scope, limit) as Array<Record<string, unknown>>;
    } catch { rows = []; }
    if (rows.length === 0) rows = this.db.prepare("SELECT c.id,c.start_line,c.end_line,c.content,d.logical_path,d.source_kind FROM mnemora_corpus_chunks c JOIN mnemora_corpus_documents d ON d.id=c.document_id WHERE c.scope=? AND instr(lower(c.content),lower(?))>0 ORDER BY d.logical_path,c.start_line LIMIT ?").all(scope, query, limit) as Array<Record<string, unknown>>;
    return {
      status: "ready",
      ...(sync ? { sync } : {}),
      results: rows.map(row => {
        const path = String(row.logical_path);
        const startLine = Number(row.start_line), endLine = Number(row.end_line);
        const sourceKind = String(row.source_kind) as SourceKind;
        return { id: String(row.id), path, start_line: startLine, end_line: endLine, snippet: safeSnippet(String(row.content)), source: `canonical_corpus:${sourceKind}` as const, citation: `${path}:L${startLine}-L${endLine}`, context_ref: createMnemoraContextRef({ scope, kind: "corpus-chunk", id: String(row.id) }) };
      })
    };
  }

  private async discover(root: string): Promise<{ candidates: Candidate[]; skipped: number }> {
    const candidates: Candidate[] = [];
    let skipped = 0;
    const add = async (absolutePath: string, sourceKind: SourceKind) => {
      if (candidates.length >= this.config.maxFiles) { skipped++; return; }
      const candidate = await candidateFile(root, absolutePath, sourceKind, this.config.maxFileBytes, this.boundary);
      if (candidate) candidates.push(candidate); else skipped++;
    };
    await add(join(root, "MEMORY.md"), "memory");
    for (const path of await walk(join(root, "memory"), new Set([".md"]), this.config.maxFiles)) await add(path, "memory");
    if (this.config.includeSessions) {
      const sessions = await walk(join(root, "sessions"), new Set([".jsonl"]), this.config.maxFiles);
      const byAgent = new Map<string, string[]>();
      for (const path of sessions) {
        const logical = toLogical(root, path);
        const agent = logical.split("/")[1] || "default";
        const list = byAgent.get(agent) ?? []; list.push(path); byAgent.set(agent, list);
      }
      for (const list of byAgent.values()) {
        const sorted = await sortNewest(list);
        for (const path of sorted.slice(0, this.config.maxSessionFilesPerAgent)) await add(path, "session");
      }
    }
    if (this.config.includeDreamingArtifacts) for (const path of await walk(join(root, "dreaming"), new Set([".md", ".txt", ".jsonl"]), this.config.maxFiles)) await add(path, "dreaming");
    return { candidates, skipped };
  }

  private ensureScope(scope: string, now: number): void { this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(scope, now, now); }
  private removeDocument(id: string): void {
    const chunks = this.db.prepare("SELECT id FROM mnemora_corpus_chunks WHERE document_id=?").all(id) as Array<{ id: string }>;
    const erase = this.db.prepare("DELETE FROM mnemora_corpus_chunks_fts WHERE id=?");
    for (const chunk of chunks) erase.run(chunk.id);
    this.db.prepare("DELETE FROM mnemora_corpus_documents WHERE id=?").run(id);
  }
}

async function safeRealpath(path: string): Promise<string | undefined> { try { return await realpath(resolve(path)); } catch { return undefined; } }
async function boundedText(path: string, byteLength: number): Promise<string | undefined> { try { const content = await readFile(path, "utf8"); return Buffer.byteLength(content, "utf8") === byteLength ? content : undefined; } catch { return undefined; } }
async function candidateFile(root: string, path: string, sourceKind: SourceKind, maxBytes: number, exclusiveUserMd: boolean): Promise<Candidate | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return undefined;
    const resolved = await realpath(path);
    if (!within(root, resolved)) return undefined;
    const logicalPath = toLogical(root, resolved);
    if (!logicalPath || (exclusiveUserMd && basename(logicalPath).toLowerCase() === "user.md")) return undefined;
    return { absolutePath: resolved, logicalPath, sourceKind, byteLength: stat.size, mtimeMs: stat.mtimeMs };
  } catch { return undefined; }
}
async function walk(directory: string, extensions: Set<string>, cap: number): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    if (found.length >= cap) return;
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= cap) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path);
      else if (entry.isFile() && !entry.isSymbolicLink() && extensions.has(extname(entry.name).toLowerCase())) found.push(path);
    }
  };
  await visit(directory);
  return found;
}
async function sortNewest(paths: string[]): Promise<string[]> { const decorated = await Promise.all(paths.map(async path => ({ path, mtime: (await lstat(path)).mtimeMs }))); return decorated.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).map(item => item.path); }
function within(root: string, path: string): boolean { const value = relative(root, path); return value !== "" && !isAbsolute(value) && !value.startsWith(`..${sep}`) && value !== ".."; }
function toLogical(root: string, path: string): string { const value = relative(root, path); return value && !value.startsWith("..") ? value.split(sep).join("/") : ""; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableId(value: string): string { return `corpus_${hash(value).slice(0, 48)}`; }
function contentLines(value: string): string[] { const lines = value.split(/\r?\n/u); if (value.endsWith("\n")) lines.pop(); return lines; }
function lineCount(value: string): number { return value ? contentLines(value).length : 0; }
function ftsQuery(value: string): string { return [...new Set(value.match(/[\p{L}\p{N}_-]+/gu) ?? [])].slice(0, 12).map(term => `"${term.replaceAll('"', '""')}"`).join(" AND "); }
function safeSnippet(value: string): string { const clean = value.replace(/\u0000/g, "").trim(); return clean.length <= 700 ? clean : `${clean.slice(0, 697)}...`; }
function chunkText(documentId: string, text: string, maxChars: number, maxLines: number): CorpusChunk[] {
  const lines = contentLines(text); const chunks: CorpusChunk[] = []; let current = "", start = 1, end = 1;
  const push = () => { if (!current) return; const content = current.trimEnd(); const contentHash = hash(content); chunks.push({ id: stableId(`${documentId}\0${start}\0${end}\0${contentHash}`), startLine: start, endLine: end, content, contentHash }); current = ""; };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]; let offset = 0;
    while (offset < line.length || (line.length === 0 && offset === 0)) {
      const space = Math.max(1, maxChars - current.length - (current ? 1 : 0));
      const piece = line.slice(offset, offset + space); const next = current ? `${current}\n${piece}` : piece;
      if (current && (next.length > maxChars || index + 1 - start + 1 > maxLines)) { push(); start = index + 1; }
      current = current ? `${current}\n${piece}` : piece; end = index + 1; offset += Math.max(1, piece.length);
      if (current.length >= maxChars || end - start + 1 >= maxLines) {
        // A chunk ending at a physical line boundary starts at the next line.
        // A character-bound continuation of the same long line keeps that
        // line number, so source citations remain exact in both cases.
        const completedLine = offset >= line.length;
        push(); start = completedLine ? end + 1 : end;
      }
      if (line.length === 0) break;
    }
  }
  push(); return chunks;
}
