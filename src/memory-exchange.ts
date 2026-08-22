import { createHash } from "node:crypto";
import { normalizeScope } from "./scope.js";
import type { GraphologyStore } from "./store.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_RECORDS = 1000;

export interface MemoryExchangeLimits { maxBytes?: number; maxRecords?: number; }
export interface MemoryExportResult { format: "memory-jsonl"; scope: string; data: string; record_count: number; truncated: false; omissions: string[]; }
export interface MemoryImportPreview {
  scope: string;
  counts: { total: number; valid: number; archived: number };
  errors: Array<{ line: number; category: "invalid_json" | "invalid_record" | "duplicate_record" }>;
  payload_hash: string;
  preview_hash: string;
}
export interface MemoryImportResult { scope: string; imported: number; archived: number; audit_id: string; }

type MemoryRecord = {
  format_version: 1;
  kind: "memory_document";
  document: { title: string; content: string; source: string; metadata: Record<string, string | number | boolean | null>; lifecycle_state: "active" | "archived" };
};

export function exportMemoryDocuments(store: GraphologyStore, input: { scope: string; maxBytes?: number; maxRecords?: number }): MemoryExportResult {
  const limits = normalizeLimits(input);
  const scope = normalizeScope(input.scope);
  const documents = store.listMemoryDocumentsForExchange(scope, limits.maxRecords + 1);
  if (documents.length > limits.maxRecords) throw new Error("memory export record bound exceeded");
  const omissions = new Set<string>();
  const records: MemoryRecord[] = documents.map(document => {
    const source = sanitizeSource(document.source);
    if (source.omitted) omissions.add(source.omitted);
    return { format_version: 1, kind: "memory_document", document: { title: document.title, content: document.content, source: source.value, metadata: document.metadata, lifecycle_state: document.lifecycle_state } };
  });
  const data = records.map(canonicalStringify).join("\n") + (records.length ? "\n" : "");
  if (Buffer.byteLength(data, "utf8") > limits.maxBytes) throw new Error("memory export byte bound exceeded");
  return { format: "memory-jsonl", scope, data, record_count: records.length, truncated: false, omissions: [...omissions].sort() };
}

export function previewMemoryImport(store: GraphologyStore, input: string | Uint8Array, scopeInput: string, limitsInput: MemoryExchangeLimits = {}): MemoryImportPreview {
  const scope = normalizeScope(scopeInput);
  const parsed = parse(input, limitsInput);
  const scopeUpdatedAt = store.memoryScopeUpdatedAt(scope);
  const base = { scope, counts: parsed.counts, errors: parsed.errors, payload_hash: parsed.payload_hash, scope_updated_at: scopeUpdatedAt };
  const preview_hash = sha(Buffer.from(canonicalStringify(base)));
  const preview: MemoryImportPreview = { scope, counts: parsed.counts, errors: parsed.errors, payload_hash: parsed.payload_hash, preview_hash };
  store.saveMemoryImportPreview({ preview_hash, scope, scope_updated_at: scopeUpdatedAt, summary: canonicalStringify({ scope, counts: parsed.counts, errors: parsed.errors }), payload_hash: parsed.payload_hash });
  return preview;
}

export function confirmMemoryImport(store: GraphologyStore, input: { data: string | Uint8Array; scope: string; preview_hash: string; confirm: boolean; maxBytes?: number; maxRecords?: number }): MemoryImportResult {
  if (input.confirm !== true || !/^[a-f0-9]{64}$/.test(input.preview_hash)) throw new Error("invalid_memory_import_preview");
  const scope = normalizeScope(input.scope);
  const parsed = parse(input.data, input);
  const saved = store.getMemoryImportPreview(input.preview_hash);
  if (!saved || saved.scope !== scope || saved.payload_hash !== parsed.payload_hash || saved.scope_updated_at !== store.memoryScopeUpdatedAt(scope)) throw new Error("stale_memory_import_preview");
  const base = { scope, counts: parsed.counts, errors: parsed.errors, payload_hash: parsed.payload_hash, scope_updated_at: saved.scope_updated_at };
  if (sha(Buffer.from(canonicalStringify(base))) !== input.preview_hash || parsed.errors.length) throw new Error("invalid_memory_import_preview");
  const result = store.importMemoryDocuments({ scope, payload_hash: parsed.payload_hash, documents: parsed.records.map(record => record.document) });
  store.deleteMemoryImportPreview(input.preview_hash);
  return { scope, imported: result.imported, archived: result.archived, audit_id: result.audit_id };
}

function parse(input: string | Uint8Array, limitsInput: MemoryExchangeLimits): { records: MemoryRecord[]; counts: MemoryImportPreview["counts"]; errors: MemoryImportPreview["errors"]; payload_hash: string } {
  const limits = normalizeLimits(limitsInput);
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (bytes.byteLength > limits.maxBytes) throw new Error("memory import byte bound exceeded");
  let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("invalid UTF-8 memory import"); }
  const lines = text.split(/\n/); if (lines.at(-1) === "") lines.pop();
  if (lines.length > limits.maxRecords) throw new Error("memory import record bound exceeded");
  const records: MemoryRecord[] = []; const errors: MemoryImportPreview["errors"] = []; const seen = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    if (!line.trim()) { errors.push({ line: index + 1, category: "invalid_record" }); continue; }
    let value: unknown; try { value = JSON.parse(line); } catch { errors.push({ line: index + 1, category: "invalid_json" }); continue; }
    if (!validRecord(value)) { errors.push({ line: index + 1, category: "invalid_record" }); continue; }
    const record = value as MemoryRecord;
    const fingerprint = sha(Buffer.from(canonicalStringify(record)));
    if (seen.has(fingerprint)) { errors.push({ line: index + 1, category: "duplicate_record" }); continue; }
    seen.add(fingerprint); records.push(record);
  }
  return { records, counts: { total: lines.length, valid: records.length, archived: records.filter(record => record.document.lifecycle_state === "archived").length }, errors, payload_hash: sha(bytes) };
}

function validRecord(value: unknown): value is MemoryRecord {
  if (!plain(value) || !sameKeys(value, ["format_version", "kind", "document"]) || value.format_version !== 1 || value.kind !== "memory_document" || !plain(value.document)) return false;
  const document = value.document as Record<string, unknown>;
  if (!sameKeys(document, ["title", "content", "source", "metadata", "lifecycle_state"]) || typeof document.title !== "string" || !document.title.trim() || document.title.length > 200 || typeof document.content !== "string" || !document.content.trim() || document.content.length > 100000 || typeof document.source !== "string" || !document.source.trim() || document.source.length > 256 || (document.lifecycle_state !== "active" && document.lifecycle_state !== "archived") || !plain(document.metadata) || Object.keys(document.metadata).length > 50) return false;
  return Object.values(document.metadata).every(item => item == null || ["string", "number", "boolean"].includes(typeof item));
}

function normalizeLimits(input: MemoryExchangeLimits): Required<MemoryExchangeLimits> {
  const bound = (value: number | undefined, ceiling: number) => Number.isSafeInteger(value) && value! >= 1 ? Math.min(value!, ceiling) : ceiling;
  return { maxBytes: bound(input.maxBytes, MAX_BYTES), maxRecords: bound(input.maxRecords, MAX_RECORDS) };
}
function sanitizeSource(source: string): { value: string; omitted?: string } {
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(source)) return { value: "local:omitted", omitted: "local_source_paths" };
  if (!/^https?:\/\//i.test(source)) return { value: source };
  try {
    const url = new URL(source), omissions = new Set<string>();
    if (url.username || url.password) { url.username = ""; url.password = ""; omissions.add("source_url_credentials"); }
    if (url.hash) { url.hash = ""; omissions.add("source_url_fragment"); }
    const sensitive = new Set(["apikey", "xapikey", "accesstoken", "token", "auth", "authorization", "password", "passwd", "secret", "credential", "sig", "signature", "key"]);
    for (const key of [...url.searchParams.keys()]) if (sensitive.has(key.toLowerCase().replace(/[-_.]/g, ""))) { url.searchParams.delete(key); omissions.add("source_url_sensitive_query"); }
    if (!omissions.size) return { value: source };
    url.searchParams.sort(); return { value: url.toString(), omitted: [...omissions].sort().join(",") };
  } catch { return { value: "source:omitted", omitted: "invalid_source" }; }
}
function canonicalStringify(value: unknown): string { return JSON.stringify(sort(value)); }
function sort(value: unknown): unknown { if (Array.isArray(value)) return value.map(sort); if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key]) ])); return value; }
function sameKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function sha(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
