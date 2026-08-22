import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createHash, randomBytes as systemRandomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackupConfirmRequest, BackupPreviewRequest, BackupPreviewResult, BackupResult } from "./types.js";
import { ArtifactRegistry } from "./artifacts.js";
import { SUPPORTED_SCHEMA_VERSION } from "../schema.js";

interface BackupStore { db: DatabaseSyncInstance; graphRevision(): number; inspectorOverviewProjection(): { nodes: unknown; edges: unknown; observations: unknown }; }
interface Options { store: BackupStore; registry: ArtifactRegistry; now?: () => number; randomBytes?: (size: number) => Buffer; ttlMs?: number; portableConfig?: unknown; }
type Pending = { hash: string; graph: number; expires: number };

export class BackupService {
  private readonly now: () => number; private readonly randomBytes: (size: number) => Buffer; private readonly ttl: number; private readonly pending = new Map<string, Pending>();
  constructor(private readonly options: Options) { this.now = options.now ?? Date.now; this.randomBytes = options.randomBytes ?? systemRandomBytes; this.ttl = Math.min(600_000, Math.max(1_000, options.ttlMs ?? 300_000)); }
  preview(input: BackupPreviewRequest): BackupPreviewResult {
    const graph = this.options.store.graphRevision(); if (input.graph_revision !== graph) throw new Error("stale_preview");
    const payloadHash = shaText(JSON.stringify({ operation: "backup", graph })), token = secret(this.randomBytes), counts = this.options.store.inspectorOverviewProjection();
    this.pending.set(token, { hash: payloadHash, graph, expires: this.now() + this.ttl });
    return { operation: "backup", phase: "preview", preview_token: token, payload_hash: payloadHash, graph_revision: graph, affected: { nodes: count(counts.nodes), edges: count(counts.edges), observations: count(counts.observations) }, truncated: false };
  }
  async confirm(input: BackupConfirmRequest): Promise<BackupResult> {
    const pending = this.pending.get(input.preview_token); this.pending.delete(input.preview_token);
    if (!pending || pending.expires < this.now() || input.payload_hash !== pending.hash) throw new Error("invalid_preview");
    if (input.graph_revision !== pending.graph || this.options.store.graphRevision() !== pending.graph) throw new Error("stale_preview");
    const nonce = secret(this.randomBytes).slice(0, 24), artifactId = `artifact:${nonce}`, auditId = `audit:${nonce}`;
    const destination = join(this.options.registry.directory, `.${nonce}.sqlite`);
    try {
      consistentBackup(this.options.store.db, destination);
      verifyDatabase(destination);
      const digest = await shaFile(destination);
      writePortableManifest(destination, { database_sha256: digest, schema_version: SUPPORTED_SCHEMA_VERSION, config: portableConfig(this.options.portableConfig), created_at: this.now() });
      this.options.registry.register({ artifact_id: artifactId, kind: "backup", path: destination, sha256: digest, integrity: "ok", graph_revision: pending.graph, created_at: this.now() });
      return { operation: "backup", phase: "confirm", confirmed: true, graph_revision: pending.graph, audit_id: auditId, artifact: { artifact_id: artifactId } };
    } catch { safeRemove(destination); safeRemove(destination.replace(/\.sqlite$/u, ".manifest.json")); throw new Error("backup_failed"); }
  }
}

function verifyDatabase(path: string): void {
  if (statSync(path).size <= 0) throw new Error("invalid_backup");
  const db = new DatabaseSync(path, { readOnly: true });
  try { const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }; if (row?.integrity_check !== "ok") throw new Error("invalid_backup"); const schema = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='kg_graph_state'").get(); if (!schema) throw new Error("invalid_backup"); } finally { db.close(); }
}
async function shaFile(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer); return hash.digest("hex"); }
function shaText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function secret(randomBytes: (size: number) => Buffer): string { const value = randomBytes(32); if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error("entropy_unavailable"); return value.toString("base64url"); }
function count(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
export function consistentBackup(db: DatabaseSyncInstance, destination: string): void { db.prepare("VACUUM INTO ?").run(destination); }
function safeRemove(path: string): void { try { rmSync(path, { force: true }); } catch { /* best-effort temp cleanup */ } }
function writePortableManifest(databasePath: string, value: { database_sha256: string; schema_version: number; config: unknown; created_at: number }): void {
  const manifest = databasePath.replace(/\.sqlite$/u, ".manifest.json");
  writeFileSync(manifest, JSON.stringify({ format: "mnemora-portable-backup/v1", ...value }), { encoding: "utf8", mode: 0o600 });
}
/** Exported for restore and regression tests; manifest absence remains compatible with old backups. */
export function verifyPortableManifest(databasePath: string, checksum: string): void {
  const manifest = databasePath.replace(/\.sqlite$/u, ".manifest.json");
  if (!existsSync(manifest)) return;
  try {
    const value = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    if (value.format !== "mnemora-portable-backup/v1" || value.database_sha256 !== checksum || !Number.isSafeInteger(value.schema_version) || typeof value.config !== "object" || value.config === null) throw new Error("invalid_portable_manifest");
  } catch { throw new Error("invalid_portable_manifest"); }
}
function portableConfig(value: unknown): unknown {
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 8) return "[TRUNCATED]";
    if (Array.isArray(item)) return item.slice(0, 100).map(value => visit(value, depth + 1));
    if (!item || typeof item !== "object") return typeof item === "string" ? item.slice(0, 4096) : item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).slice(0, 200).map(([key, child]) => /api.?key|secret|token|password/i.test(key) ? [key, "[REDACTED]"] : [key, visit(child, depth + 1)]));
  };
  return visit(value ?? {}, 0);
}
