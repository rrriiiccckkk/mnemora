import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createHash, randomBytes as systemRandomBytes } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import { join } from "node:path";
import type { RestoreConfirmRequest, RestorePreviewRequest, RestorePreviewResult, RestoreResult } from "./types.js";
import { ArtifactRegistry } from "./artifacts.js";
import { inspectDatabaseCompatibility } from "./migration.js";
import { consistentBackup, verifyPortableManifest } from "./backup.js";

interface RestoreStore { db: DatabaseSyncInstance; graphRevision(): number; inspectorOverviewProjection(): { nodes: unknown; edges: unknown; observations: unknown }; replaceDatabaseFrom(path: string): void; }
interface Options { store: RestoreStore; registry: ArtifactRegistry; now?: () => number; randomBytes?: (size: number) => Buffer; ttlMs?: number; }
type Pending = { hash: string; graph: number; artifact: string; checksum: string; expires: number };

export class RestoreService {
  private readonly now: () => number; private readonly randomBytes: (size: number) => Buffer; private readonly ttl: number; private readonly pending = new Map<string, Pending>();
  constructor(private readonly options: Options) { this.now = options.now ?? Date.now; this.randomBytes = options.randomBytes ?? systemRandomBytes; this.ttl = Math.min(600_000, Math.max(1_000, options.ttlMs ?? 300_000)); }
  preview(input: RestorePreviewRequest): RestorePreviewResult {
    const graph = this.options.store.graphRevision(); if (input.graph_revision !== graph) throw new Error("stale_preview");
    const artifact = this.options.registry.resolve(input.payload.artifact_id); inspectDatabaseCompatibility(artifact.path);
    const hash = shaText(JSON.stringify({ artifact: artifact.artifact_id, checksum: artifact.sha256, graph })), token = secret(this.randomBytes), counts = this.options.store.inspectorOverviewProjection();
    this.pending.set(token, { hash, graph, artifact: artifact.artifact_id, checksum: artifact.sha256, expires: this.now() + this.ttl });
    return { operation: "restore", phase: "preview", preview_token: token, payload_hash: hash, graph_revision: graph, affected: { nodes: count(counts.nodes), edges: count(counts.edges), observations: count(counts.observations) }, truncated: false };
  }
  async confirm(input: RestoreConfirmRequest): Promise<RestoreResult> {
    const pending = this.pending.get(input.preview_token); this.pending.delete(input.preview_token);
    if (!pending || pending.expires < this.now() || pending.hash !== input.payload_hash || pending.artifact !== input.payload.artifact_id) throw new Error("invalid_preview");
    if (pending.graph !== input.graph_revision || this.options.store.graphRevision() !== pending.graph) throw new Error("stale_preview");
    const artifact = this.options.registry.resolve(pending.artifact);
    if (await shaFile(artifact.path) !== pending.checksum) throw new Error("invalid_artifact");
    verifyPortableManifest(artifact.path, pending.checksum);
    inspectDatabaseCompatibility(artifact.path);
    const nonce = secret(this.randomBytes).slice(0, 24), recoveryId = `artifact:recovery-${nonce}`, recoveryPath = join(this.options.registry.directory, `.recovery-${nonce}.sqlite`);
    try {
      consistentBackup(this.options.store.db, recoveryPath); inspectDatabaseCompatibility(recoveryPath); const recoveryHash = await shaFile(recoveryPath);
      this.options.registry.register({ artifact_id: recoveryId, kind: "recovery", path: recoveryPath, sha256: recoveryHash, integrity: "ok", graph_revision: pending.graph, created_at: this.now() });
      this.options.store.replaceDatabaseFrom(artifact.path);
      return { operation: "restore", phase: "confirm", confirmed: true, graph_revision: this.options.store.graphRevision(), audit_id: `audit:restore-${nonce}`, recovery_point: { artifact_id: recoveryId } };
    } catch { try { rmSync(recoveryPath, { force: true }); } catch { /* best effort */ } throw new Error("restore_failed"); }
  }
}
async function shaFile(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer); return hash.digest("hex"); }
function shaText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function secret(randomBytes: (size: number) => Buffer): string { const value = randomBytes(32); if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error("entropy_unavailable"); return value.toString("base64url"); }
function count(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
