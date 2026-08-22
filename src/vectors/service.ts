import type { EmbeddingIdentity } from "../embeddings.js";
import { GraphologyStore } from "../store.js";
import type { RankedNode } from "../types.js";
import { VectorBackendRegistry } from "./registry.js";
import type { NodeVectorRecord } from "./types.js";

export interface VectorBackendHealth {
  backend_id: string | null;
  status: "inactive" | "healthy" | "unavailable";
  lifecycle: "supported" | "reconcile_only" | "unsupported";
  indexed_local_nodes: number;
  capabilities?: { upsertNodes: boolean; searchNodes: boolean; deleteNodes: boolean; listNodeIds: boolean };
  detected_version?: string;
  error?: "unavailable" | "timeout" | "cancelled" | "invalid_response" | "operation_failed";
}

/**
 * Keeps SQLite canonical while treating an optional ANN backend as a bounded,
 * replaceable index. External IDs are always re-authorized against local data.
 */
export class VectorBackendService {
  constructor(readonly store: GraphologyStore, readonly registry: VectorBackendRegistry, readonly activeBackendId?: string) {}

  get externalNodeSearchEnabled(): boolean {
    return !!this.activeBackendId && (this.registry.list().find(item => item.id === this.activeBackendId)?.capabilities.searchNodes === true);
  }

  async mirrorNodes(records: readonly NodeVectorRecord[], signal?: AbortSignal): Promise<void> {
    if (!this.activeBackendId || !records.length) return;
    await this.registry.upsertNodes(this.activeBackendId, records, signal);
  }

  async searchNodes(input: { vector: number[]; identity: EmbeddingIdentity; inputVersion: string; scope: string; nodeType?: string; limit: number; minimum: number; maxScanNodes: number }, signal?: AbortSignal): Promise<{ source: "external" | "sqlite"; candidates: RankedNode[] }> {
    if (this.externalNodeSearchEnabled && this.activeBackendId) {
      try {
        const matches = await this.registry.searchNodes(this.activeBackendId, { vector: input.vector, identity: input.identity, inputVersion: input.inputVersion, scope: input.scope, nodeType: input.nodeType, limit: input.limit, minimumScore: input.minimum }, signal);
        const candidates: RankedNode[] = [];
        for (const match of matches) {
          if (match.score < input.minimum) continue;
          const node = this.store.getNodeById(match.id);
          if (!node || (input.nodeType && node.type !== input.nodeType) || !this.store.hasNodeEvidenceInScope(node.id, input.scope)) continue;
          candidates.push({ node, score: match.score });
        }
        if (candidates.length) return { source: "external", candidates: candidates.sort((a, b) => b.score - a.score || b.node.importance - a.node.importance).slice(0, input.limit) };
      } catch (error) {
        // Cancellation belongs to the caller; only an optional index failure is
        // fail-open. This avoids silently doing synchronous local work after a
        // caller has already withdrawn the request.
        if (signal?.aborted) throw error;
      }
    }
    return { source: "sqlite", candidates: this.store.semanticCandidates(input.vector, input.identity, input.inputVersion, input.nodeType, input.limit, input.minimum, input.maxScanNodes, input.scope) };
  }

  async syncStoredNodes(input: { identity: EmbeddingIdentity; inputVersion: string; afterId?: string; limit?: number; signal?: AbortSignal }): Promise<{ backend_id: string | null; processed: number; next_after_id: string | null }> {
    if (!this.activeBackendId) return { backend_id: null, processed: 0, next_after_id: null };
    const limit = Math.min(128, Math.max(1, Math.trunc(input.limit ?? 32)));
    const entries = this.store.listEmbeddingCandidates(input.identity, input.inputVersion, limit + 1, undefined, input.afterId ?? "");
    const truncated = entries.length > limit, page = entries.slice(0, limit);
    await this.mirrorNodes(page.map(item => ({ id: item.node.id, identity: input.identity, inputVersion: input.inputVersion, vector: item.vector })), input.signal);
    return { backend_id: this.activeBackendId, processed: page.length, next_after_id: truncated ? page.at(-1)?.node.id ?? null : null };
  }

  /**
   * Deletes stale opaque ids after a deliberate seed pass. It never deletes a
   * current SQLite embedding and cannot inspect external graph content.
   */
  async reconcileStoredNodes(input: { identity: EmbeddingIdentity; inputVersion: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{ backend_id: string | null; examined: number; deleted: number; next_cursor: string | null; status: "inactive" | "supported" | "unsupported" }> {
    if (!this.activeBackendId) return { backend_id: null, examined: 0, deleted: 0, next_cursor: null, status: "inactive" };
    const capabilities = this.registry.list().find(item => item.id === this.activeBackendId)?.capabilities;
    if (!capabilities?.listNodeIds || !capabilities.deleteNodes) return { backend_id: this.activeBackendId, examined: 0, deleted: 0, next_cursor: null, status: "unsupported" };
    const page = await this.registry.listNodeIds(this.activeBackendId, { identity: input.identity, inputVersion: input.inputVersion, cursor: input.cursor, limit: bounded(input.limit, 32) }, input.signal);
    const stale = page.ids.filter(id => !this.store.hasCurrentEmbedding(id, input.identity, input.inputVersion));
    if (stale.length) await this.registry.deleteNodes(this.activeBackendId, { ids: stale, identity: input.identity, inputVersion: input.inputVersion }, input.signal);
    return { backend_id: this.activeBackendId, examined: page.ids.length, deleted: stale.length, next_cursor: page.nextCursor, status: "supported" };
  }

  /** Bounded live probe plus local canonical count; it never reveals graph text. */
  async health(input: { identity: EmbeddingIdentity; inputVersion: string; signal?: AbortSignal }): Promise<VectorBackendHealth> {
    if (!this.activeBackendId) return { backend_id: null, status: "inactive", lifecycle: "unsupported", indexed_local_nodes: 0 };
    const item = this.registry.list().find(value => value.id === this.activeBackendId);
    const indexedLocalNodes = this.store.embeddingCandidateCount(input.identity, input.inputVersion);
    if (!item) return { backend_id: this.activeBackendId, status: "unavailable", lifecycle: "unsupported", indexed_local_nodes: indexedLocalNodes, error: "unavailable" };
    const lifecycle = item.capabilities.deleteNodes && item.capabilities.listNodeIds ? "supported" : item.capabilities.deleteNodes ? "reconcile_only" : "unsupported";
    try {
      const probe = await this.registry.probe(this.activeBackendId, input.signal);
      return { backend_id: this.activeBackendId, status: "healthy", lifecycle, indexed_local_nodes: indexedLocalNodes, capabilities: { upsertNodes: probe.upsertNodes, searchNodes: probe.searchNodes, deleteNodes: probe.deleteNodes, listNodeIds: probe.listNodeIds }, ...(probe.detectedVersion ? { detected_version: probe.detectedVersion } : {}) };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && ["unavailable", "timeout", "cancelled", "invalid_response", "operation_failed"].includes(String(error.code)) ? String(error.code) as VectorBackendHealth["error"] : "operation_failed";
      return { backend_id: this.activeBackendId, status: "unavailable", lifecycle, indexed_local_nodes: indexedLocalNodes, capabilities: { ...item.capabilities }, error: code };
    }
  }

  async removeNodes(input: { ids: readonly string[]; identity: EmbeddingIdentity; inputVersion: string; signal?: AbortSignal }): Promise<"removed" | "unsupported"> {
    if (!this.activeBackendId || !input.ids.length) return "unsupported";
    const capabilities = this.registry.list().find(item => item.id === this.activeBackendId)?.capabilities;
    if (!capabilities?.deleteNodes) return "unsupported";
    await this.registry.deleteNodes(this.activeBackendId, { ids: input.ids, identity: input.identity, inputVersion: input.inputVersion }, input.signal);
    return "removed";
  }
}

function bounded(value: unknown, fallback: number): number { return Number.isFinite(value) ? Math.max(1, Math.min(128, Math.trunc(value as number))) : fallback; }
