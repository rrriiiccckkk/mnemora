import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import { captureText } from "../journal/capture-policy.js";
import type { JournalCapturePolicy } from "../journal/types.js";

export interface Artifact { id: string; scope: string; sourceEventId?: string; kind: string; mimeType: string; byteLength: number; contentHash: string; preview: string; createdAt: number; archivedAt?: number; }
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex");
const text = (value: Buffer) => value.toString("utf8");
const map = (row: Record<string, unknown>): Artifact => ({ id: String(row.id), scope: String(row.scope), ...(row.source_event_id ? { sourceEventId: String(row.source_event_id) } : {}), kind: String(row.kind), mimeType: String(row.mime_type), byteLength: Number(row.byte_length), contentHash: String(row.content_hash), preview: String(row.preview), createdAt: Number(row.created_at), ...(row.archived_at ? { archivedAt: Number(row.archived_at) } : {}) });

export class ArtifactRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly policy: JournalCapturePolicy) {}
  put(input: { scope: string; sourceEventId?: string; kind: string; mimeType?: string; content: string | Buffer; now?: number }): Artifact {
    const scope = normalizeScope(input.scope), raw = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, "utf8");
    if (!input.kind.trim() || raw.byteLength > MAX_WRITE_BYTES) throw new Error("invalid_artifact");
    if (input.sourceEventId && !this.db.prepare("SELECT 1 FROM mnemora_conversation_events WHERE id=? AND scope=? AND deleted_at IS NULL").get(input.sourceEventId, scope)) throw new Error("invalid_artifact_source");
    const captured = captureText(text(raw), this.policy); if (captured.outcome === "drop") throw new Error("artifact_dropped_by_policy");
    const body = Buffer.from(captured.text ?? "", "utf8"), now = input.now ?? Date.now(), id = randomUUID(), digest = hash(body);
    this.db.exec("BEGIN IMMEDIATE");
    try { this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(scope, now, now); this.db.prepare("INSERT INTO mnemora_artifacts(id,scope,source_event_id,kind,mime_type,content,content_hash,byte_length,preview,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, scope, input.sourceEventId ?? null, input.kind.trim().slice(0, 80), (input.mimeType ?? "text/plain").slice(0, 160), body, digest, body.byteLength, text(body).slice(0, 512), now); this.db.exec("COMMIT"); } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    return this.metadata(id, scope)!;
  }
  metadata(id: string, scope: string): Artifact | undefined { const row = this.db.prepare("SELECT id,scope,source_event_id,kind,mime_type,byte_length,content_hash,preview,created_at,archived_at FROM mnemora_artifacts WHERE id=? AND scope=? AND deleted_at IS NULL").get(id, normalizeScope(scope)) as Record<string, unknown> | undefined; return row ? map(row) : undefined; }
  readRange(id: string, scope: string, offset = 0, length = MAX_READ_BYTES): { artifact: Artifact; offset: number; content: string; truncated: boolean } | undefined { const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : -1, take = Number.isInteger(length) && length > 0 && length <= MAX_READ_BYTES ? length : -1; if (safeOffset < 0 || take < 0) throw new Error("invalid_artifact_range"); const row = this.db.prepare("SELECT id,scope,source_event_id,kind,mime_type,byte_length,content_hash,preview,created_at,archived_at,content FROM mnemora_artifacts WHERE id=? AND scope=? AND deleted_at IS NULL").get(id, normalizeScope(scope)) as Record<string, unknown> | undefined; if (!row) return undefined; const content = Buffer.from(row.content as Uint8Array), segment = content.subarray(safeOffset, safeOffset + take); return { artifact: map(row), offset: safeOffset, content: text(segment), truncated: safeOffset + segment.byteLength < content.byteLength }; }
  search(scope: string, query: string, limit = 20): Artifact[] { const term = query.trim().slice(0, 512), take = Math.min(100, Math.max(1, limit)); if (!term) return []; const rows = this.db.prepare("SELECT id,scope,source_event_id,kind,mime_type,byte_length,content_hash,preview,created_at,archived_at FROM mnemora_artifacts WHERE scope=? AND deleted_at IS NULL AND instr(CAST(content AS TEXT),?)>0 ORDER BY created_at DESC,id DESC LIMIT ?").all(normalizeScope(scope), term, take) as Array<Record<string, unknown>>; return rows.map(map); }
  placeholder(artifact: Artifact): string { return `[artifact:${artifact.id} ${artifact.mimeType} ${artifact.byteLength}B; use bounded artifact read]`; }
}
