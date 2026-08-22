import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";

export const REASONING_SEMANTIC_PROVIDER_CONTRACT_V1 = "mnemora-reasoning-semantic-provider/v1" as const;
export interface ReasoningSemanticHit { memoryId: string; score: number; }
export interface ReasoningSemanticProviderInput { scope: string; query: string; limit: number; signal: AbortSignal; }
export interface ReasoningSemanticProvider {
  readonly id: string;
  readonly contractVersion: typeof REASONING_SEMANTIC_PROVIDER_CONTRACT_V1;
  search(input: ReasoningSemanticProviderInput): Promise<readonly ReasoningSemanticHit[]>;
}

/**
 * Optional semantic adapter boundary. Provider output is treated only as an
 * index hint and re-authorized against Mnemora's own scope and admission state.
 */
export class ReasoningSemanticRetrievalService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly provider: ReasoningSemanticProvider, private readonly timeoutMs = 5_000) {
    if (!provider || provider.contractVersion !== REASONING_SEMANTIC_PROVIDER_CONTRACT_V1 || !/^[a-z][a-z0-9_-]{1,63}$/.test(provider.id) || typeof provider.search !== "function") throw new Error("invalid_reasoning_semantic_provider");
  }

  async scores(input: { scope: string; query: string; limit?: number; signal?: AbortSignal }): Promise<Record<string, number>> {
    const scope = normalizeScope(input.scope), query = clean(input.query), limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 20)));
    if (!query) return {};
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("aborted");
    const controller = new AbortController(), timeoutMs = Math.min(30_000, Math.max(100, this.timeoutMs)); let rejectTimeout: ((reason?: unknown) => void) | undefined;
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => { const error = new Error("reasoning_semantic_timeout"); controller.abort(error); rejectTimeout?.(error); }, timeoutMs);
    const abort = () => { const reason = input.signal?.reason ?? new Error("aborted"); controller.abort(reason); rejectTimeout?.(reason); };
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const hits = await Promise.race([Promise.resolve(this.provider.search({ scope, query, limit, signal: controller.signal })), timeout]);
      if (!Array.isArray(hits) || hits.length > 100) throw new Error("invalid_reasoning_semantic_response");
      const candidates = new Map<string, number>();
      for (const hit of hits.slice(0, limit * 2)) {
        if (!hit || typeof hit.memoryId !== "string" || hit.memoryId.length > 200 || !Number.isFinite(hit.score)) continue;
        candidates.set(hit.memoryId, Math.max(candidates.get(hit.memoryId) ?? 0, Math.min(1, Math.max(0, hit.score))));
      }
      if (!candidates.size) return {};
      const allowed = new Set((this.db.prepare(`SELECT id FROM mnemora_reasoning_memories WHERE scope=? AND state='admitted' AND id IN (${[...candidates].map(() => "?").join(",")})`).all(scope, ...candidates.keys()) as Array<{ id: string }>).map(row => row.id));
      return Object.fromEntries([...candidates].filter(([id]) => allowed.has(id)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit));
    } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); }
  }
}

function clean(value: unknown): string { return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 512) : ""; }
