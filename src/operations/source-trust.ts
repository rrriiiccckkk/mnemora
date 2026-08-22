import { createHash, randomBytes as systemRandomBytes } from "node:crypto";
import type { OperationAffectedCounts, OperationRankDelta, SourceTrustConfirmRequest, SourceTrustConfirmResult, SourceTrustPreviewRequest, SourceTrustPreviewResult } from "./types.js";

export interface SourceTrustStore {
  graphRevision(): number;
  sourceTrustRevision(): number;
  previewSourceTrust(source: string, weight: number, limit: number): { affected: OperationAffectedCounts; rank_deltas: OperationRankDelta[]; truncated: boolean };
  confirmSourceTrust(input: { source: string; source_hash: string; weight: number; graph_revision: number; config_revision: number; audit_id: string }): { graph_revision: number; config_revision: number; affected: OperationAffectedCounts };
}

export interface SourceTrustServiceOptions { store: SourceTrustStore; now?: () => number; randomBytes?: (size: number) => Buffer; ttlMs?: number; }
type Pending = { hash: string; source: string; weight: number; graph: number; config: number; expires: number };

export class SourceTrustService {
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly ttlMs: number;
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly options: SourceTrustServiceOptions) {
    this.now = options.now ?? Date.now; this.randomBytes = options.randomBytes ?? systemRandomBytes; this.ttlMs = Math.min(10 * 60_000, Math.max(1_000, options.ttlMs ?? 5 * 60_000));
  }

  preview(input: SourceTrustPreviewRequest): SourceTrustPreviewResult {
    const normalized = normalize(input.payload.source, input.payload.weight);
    const graph = this.options.store.graphRevision(), config = this.options.store.sourceTrustRevision();
    if (input.graph_revision !== graph || input.config_revision !== config) throw new Error("stale_preview");
    const payloadHash = hash({ source: normalized.source, weight: normalized.weight, graph, config });
    const token = secret(this.randomBytes), projection = this.options.store.previewSourceTrust(normalized.source, normalized.weight, 100);
    this.pending.set(token, { hash: payloadHash, ...normalized, graph, config, expires: this.now() + this.ttlMs });
    return { operation: "source_trust", phase: "preview", preview_token: token, payload_hash: payloadHash, graph_revision: graph, config_revision: config, affected: counts(projection.affected), rank_deltas: projection.rank_deltas.slice(0, 100).flatMap(delta), truncated: projection.truncated || projection.rank_deltas.length > 100 };
  }

  confirm(input: SourceTrustConfirmRequest): SourceTrustConfirmResult {
    const pending = this.pending.get(input.preview_token);
    this.pending.delete(input.preview_token);
    if (!pending || pending.expires < this.now()) throw new Error("invalid_preview");
    const normalized = normalize(input.payload.source, input.payload.weight);
    const candidate = hash({ source: normalized.source, weight: normalized.weight, graph: input.graph_revision, config: input.config_revision });
    if (candidate !== pending.hash || input.payload_hash !== pending.hash || input.graph_revision !== pending.graph || input.config_revision !== pending.config) throw new Error("invalid_preview");
    const auditId = `audit:${secret(this.randomBytes).slice(0, 32)}`;
    const result = this.options.store.confirmSourceTrust({ source: normalized.source, source_hash: hash(normalized.source), weight: normalized.weight, graph_revision: pending.graph, config_revision: pending.config, audit_id: auditId });
    return { operation: "source_trust", phase: "confirm", confirmed: true, graph_revision: result.graph_revision, config_revision: result.config_revision, audit_id: auditId, affected: counts(result.affected) };
  }
}

function normalize(source: string, weight: number): { source: string; weight: number } {
  if (typeof source !== "string" || !Number.isFinite(weight)) throw new Error("invalid_source_trust");
  const text = source.trim(); if (!text || text.length > 200 || weight < 0 || weight > 2) throw new Error("invalid_source_trust");
  let normalized = text.toLowerCase();
  try { const url = new URL(text); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(); url.username = ""; url.password = ""; url.hash = ""; url.hostname = url.hostname.toLowerCase(); if (url.protocol === "https:" && url.port === "443" || url.protocol === "http:" && url.port === "80") url.port = ""; normalized = url.toString(); } catch { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) throw new Error("invalid_source_trust"); }
  return { source: normalized, weight };
}
function hash(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function secret(randomBytes: (size: number) => Buffer): string { const value = randomBytes(32); if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error("entropy_unavailable"); return value.toString("base64url"); }
function counts(value: OperationAffectedCounts): OperationAffectedCounts { const safe = (n: number) => Number.isSafeInteger(n) && n >= 0 ? n : 0; return { nodes: safe(value.nodes), edges: safe(value.edges), observations: safe(value.observations) }; }
function delta(value: OperationRankDelta): OperationRankDelta[] { return typeof value?.id === "string" && value.id.length <= 200 && Number.isFinite(value.delta) ? [{ id: value.id, delta: Math.max(-1, Math.min(1, value.delta)) }] : []; }
