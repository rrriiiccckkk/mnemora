import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { cosineSimilarity, decodeEmbedding, encodeEmbedding, type Embedder } from "../embeddings.js";
import { normalizeScope } from "../scope.js";
import type { ReasoningSemanticHit, ReasoningSemanticProvider, ReasoningSemanticProviderInput } from "./reasoning-semantic.js";

export const REASONING_MEMORY_EMBEDDING_INPUT_VERSION = "reasoning-memory-v1" as const;

export interface ReasoningMemoryEmbeddingBackfillInput {
  scope: string;
  embedder: Embedder;
  maxInputChars: number;
  limit?: number;
  batchSize?: number;
  /** Expected local provider identity. Supplying it lets an explicit reindex
   * refresh records after an operator changes the embedding model. */
  identity?: { provider: string; model: string };
  signal?: AbortSignal;
}

export interface ReasoningMemoryEmbeddingBackfillResult {
  version: "reasoning-memory-embedding-backfill-v1";
  scope: string;
  processed: number;
  indexed: number;
  skipped: number;
}

export interface ReasoningMemoryEmbeddingStatus {
  version: "reasoning-memory-embedding-status-v1";
  scope: string;
  admitted: number;
  indexed: number;
}

/**
 * Local, scope-bound index of approved reasoning strategies.  The input omits
 * lineage, outcomes, and evidence: those remain governed source records and
 * never leave the existing local database through this repository.
 */
export class ReasoningMemoryEmbeddingRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  async backfill(input: ReasoningMemoryEmbeddingBackfillInput): Promise<ReasoningMemoryEmbeddingBackfillResult> {
    abort(input.signal);
    const scope = normalizeScope(input.scope), limit = bounded(input.limit, 25, 1, 100), batchSize = bounded(input.batchSize, 16, 1, 128), maxInputChars = bounded(input.maxInputChars, 4096, 256, 100_000), expectedProvider = clean(input.identity?.provider ?? "", 64), expectedModel = clean(input.identity?.model ?? "", 120), identityRequested = expectedProvider && expectedModel ? 1 : 0;
    const rows = this.db.prepare(`SELECT m.id,m.scope,m.kind,m.strategy,m.applicability_json
      FROM mnemora_reasoning_memories m
      LEFT JOIN mnemora_reasoning_memory_embeddings e ON e.memory_id=m.id
      WHERE m.scope=? AND m.state='admitted' AND (e.memory_id IS NULL OR e.input_version<>? OR (?=1 AND (e.provider<>? OR e.model<>?)))
      ORDER BY m.updated_at ASC,m.id ASC LIMIT ?`).all(scope, REASONING_MEMORY_EMBEDDING_INPUT_VERSION, identityRequested, expectedProvider, expectedModel, limit) as Array<Record<string, unknown>>;
    if (!rows.length) return { version: "reasoning-memory-embedding-backfill-v1", scope, processed: 0, indexed: 0, skipped: 0 };
    const values = rows.map(row => ({ id: String(row.id), input: embeddingInput(row, maxInputChars) })).filter((item): item is { id: string; input: string } => Boolean(item.input));
    if (!values.length) return { version: "reasoning-memory-embedding-backfill-v1", scope, processed: rows.length, indexed: 0, skipped: rows.length };
    const indexed: Array<{ id: string; input: string; vector: number[]; identity: { provider: string; model: string; dimensions: number } }> = [];
    for (let start = 0; start < values.length; start += batchSize) {
      abort(input.signal);
      const batch = values.slice(start, start + batchSize), result = await input.embedder.embed(batch.map(item => item.input), input.signal);
      abort(input.signal);
      if (result.vectors.length !== batch.length || !result.identity.provider || !result.identity.model || !Number.isInteger(result.identity.dimensions) || result.identity.dimensions <= 0) throw new Error("invalid_reasoning_embedding_response");
      if (identityRequested && (result.identity.provider !== expectedProvider || result.identity.model !== expectedModel)) throw new Error("unexpected_reasoning_embedding_identity");
      for (let index = 0; index < batch.length; index++) {
        const vector = result.vectors[index];
        if (!vector || vector.length !== result.identity.dimensions) throw new Error("invalid_reasoning_embedding_response");
        indexed.push({ ...batch[index], vector, identity: result.identity });
      }
    }
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const value of indexed) {
        this.db.prepare(`INSERT INTO mnemora_reasoning_memory_embeddings(memory_id,scope,embedding,provider,model,dimensions,input_version,input_hash,embedded_at)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET scope=excluded.scope,embedding=excluded.embedding,provider=excluded.provider,model=excluded.model,dimensions=excluded.dimensions,input_version=excluded.input_version,input_hash=excluded.input_hash,embedded_at=excluded.embedded_at`).run(value.id, scope, encodeEmbedding(value.vector), value.identity.provider, value.identity.model, value.identity.dimensions, REASONING_MEMORY_EMBEDDING_INPUT_VERSION, digest(value.input), now);
      }
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    return { version: "reasoning-memory-embedding-backfill-v1", scope, processed: rows.length, indexed: values.length, skipped: rows.length - values.length };
  }

  status(scope: string): ReasoningMemoryEmbeddingStatus {
    const safe = normalizeScope(scope), row = this.db.prepare(`SELECT
      SUM(CASE WHEN m.state='admitted' THEN 1 ELSE 0 END) AS admitted,
      SUM(CASE WHEN m.state='admitted' AND e.memory_id IS NOT NULL THEN 1 ELSE 0 END) AS indexed
      FROM mnemora_reasoning_memories m LEFT JOIN mnemora_reasoning_memory_embeddings e ON e.memory_id=m.id WHERE m.scope=?`).get(safe) as Record<string, unknown>;
    return { version: "reasoning-memory-embedding-status-v1", scope: safe, admitted: number(row.admitted), indexed: number(row.indexed) };
  }
}

/** Uses the configured local embedder against Mnemora's separate strategy index.
 * Provider output is still filtered again by ReasoningSemanticRetrievalService. */
export class LocalReasoningSemanticProvider implements ReasoningSemanticProvider {
  readonly id = "mnemora_local_ollama";
  readonly contractVersion = "mnemora-reasoning-semantic-provider/v1" as const;
  constructor(private readonly db: DatabaseSyncInstance, private readonly embedder: Embedder, private readonly options: { minScore: number; maxVectorScan: number }) {}

  async search(input: ReasoningSemanticProviderInput): Promise<readonly ReasoningSemanticHit[]> {
    abort(input.signal);
    const scope = normalizeScope(input.scope), query = clean(input.query, 512), limit = bounded(input.limit, 20, 1, 50);
    if (!query) return [];
    const result = await this.embedder.embed([query], input.signal);
    abort(input.signal);
    const vector = result.vectors[0];
    if (!vector || vector.length !== result.identity.dimensions) throw new Error("invalid_reasoning_embedding_response");
    const rows = this.db.prepare(`SELECT e.memory_id,e.embedding,e.dimensions FROM mnemora_reasoning_memory_embeddings e
      INNER JOIN mnemora_reasoning_memories m ON m.id=e.memory_id AND m.scope=e.scope
      WHERE e.scope=? AND e.provider=? AND e.model=? AND e.dimensions=? AND e.input_version=? AND m.state='admitted'
        AND NOT EXISTS (SELECT 1 FROM mnemora_reasoning_memory_delivery_circuits c WHERE c.scope=m.scope AND c.memory_id=m.id AND c.circuit_open=1)
      ORDER BY e.memory_id ASC LIMIT ?`).all(scope, result.identity.provider, result.identity.model, result.identity.dimensions, REASONING_MEMORY_EMBEDDING_INPUT_VERSION, bounded(this.options.maxVectorScan, 10_000, 100, 100_000)) as Array<Record<string, unknown>>;
    const floor = Math.min(1, Math.max(0, this.options.minScore)), hits: ReasoningSemanticHit[] = [];
    for (const row of rows) {
      abort(input.signal);
      try {
        const score = cosineSimilarity(vector, decodeEmbedding(row.embedding as Uint8Array, Number(row.dimensions)));
        if (score >= floor) hits.push({ memoryId: String(row.memory_id), score });
      } catch { /* malformed local index rows are ignored and never become candidates */ }
    }
    return hits.sort((left, right) => right.score - left.score || left.memoryId.localeCompare(right.memoryId)).slice(0, limit);
  }
}

export function reasoningMemoryEmbeddingInput(value: Record<string, unknown>, maxInputChars = 4096): string {
  return embeddingInput(value, bounded(maxInputChars, 4096, 256, 100_000));
}

function embeddingInput(value: Record<string, unknown>, maxInputChars: number): string {
  const kind = clean(String(value.kind ?? ""), 80), strategy = clean(String(value.strategy ?? ""), Math.max(1, maxInputChars - 192));
  if (!kind || !strategy) return "";
  const taskTypes = applicabilityTaskTypes(value.applicability_json);
  return [`reasoning kind: ${kind}`, `strategy: ${strategy}`, taskTypes.length ? `task types: ${taskTypes.join(", ")}` : ""].filter(Boolean).join("\n").slice(0, maxInputChars);
}
function applicabilityTaskTypes(value: unknown): string[] { try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed?.taskTypes) ? parsed.taskTypes.filter((item: unknown): item is string => typeof item === "string" && item.length <= 80).slice(0, 20) : []; } catch { return []; } }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function clean(value: string, max: number): string { return value.trim().replace(/\s+/g, " ").slice(0, max); }
function bounded(value: unknown, fallback: number, min: number, max: number): number { return Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.trunc(Number(value)))) : fallback; }
function number(value: unknown): number { const result = Number(value); return Number.isFinite(result) ? Math.max(0, Math.trunc(result)) : 0; }
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new Error("aborted"); }
