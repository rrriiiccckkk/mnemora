import { resolveMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { getMemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { normalizeEmbeddingVector, type Embedder, type EmbeddingResult } from "./embeddings.js";

/** The subset of an OpenClaw embedding provider instance that Mnemora calls. */
interface HostEmbeddingInstance {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedBatch(inputs: string[], options?: { signal?: AbortSignal; inputType?: "query" | "document" }): Promise<number[][]>;
}

export type HostEmbeddingSelection =
  | { ok: true; provider: string; model: string; create(): Promise<HostEmbeddingInstance> }
  | { ok: false; reason: "memory_search_disabled" | "provider_none" | "provider_unknown" | "host_unavailable" };

/**
 * Resolve the embedding provider that OpenClaw's own memory search uses
 * (`memory.search.provider`, `model`, `remote`, with the agent's overrides),
 * without creating it: no network and no credential access. The stored vector
 * identity is `host:<provider>` plus the model, so vectors from another
 * provider or model are never compared with these.
 */
export function selectHostEmbedding(hostConfig: unknown, agentId: string): HostEmbeddingSelection {
  if (!hostConfig || typeof hostConfig !== "object") return { ok: false, reason: "host_unavailable" };
  let resolved: ReturnType<typeof resolveMemorySearchConfig>;
  try { resolved = resolveMemorySearchConfig(hostConfig as never, agentId); }
  catch { return { ok: false, reason: "host_unavailable" }; }
  if (!resolved) return { ok: false, reason: "memory_search_disabled" };
  const provider = String(resolved.provider ?? "").trim();
  if (!provider || provider === "none") return { ok: false, reason: "provider_none" };
  let adapter: ReturnType<typeof getMemoryEmbeddingProvider>;
  try { adapter = getMemoryEmbeddingProvider(provider, hostConfig as never); }
  catch { return { ok: false, reason: "host_unavailable" }; }
  if (!adapter) return { ok: false, reason: "provider_unknown" };
  const model = String(resolved.model || adapter.defaultModel || "").trim();
  if (!model) return { ok: false, reason: "provider_unknown" };
  return {
    ok: true,
    provider: `host:${adapter.id}`,
    model,
    async create() {
      const created = await adapter!.create({
        config: hostConfig as never,
        provider,
        model,
        ...(resolved!.remote ? { remote: resolved!.remote } : {}),
        ...(resolved!.local ? { local: resolved!.local } : {}),
        ...(resolved!.inputType ? { inputType: resolved!.inputType } : {}),
        ...(resolved!.queryInputType ? { queryInputType: resolved!.queryInputType } : {}),
        ...(resolved!.documentInputType ? { documentInputType: resolved!.documentInputType } : {}),
        ...(typeof resolved!.outputDimensionality === "number" ? { dimensions: resolved!.outputDimensionality } : {})
      } as never) as { provider: HostEmbeddingInstance | null };
      if (!created?.provider) throw new Error("host embedding provider unavailable");
      return created.provider;
    }
  };
}

/** Failed creation (for example a missing API key) is retried at most once a minute. */
const CREATE_RETRY_MS = 60_000;

/**
 * Embedder backed by the host's embedding provider. The instance is created on
 * first use; credentials stay with OpenClaw. Failures surface as ordinary
 * embedding errors, so recall falls back to lexical and health records them.
 */
export class HostEmbedder implements Embedder {
  private instance?: Promise<HostEmbeddingInstance>;
  private failedAt = 0;

  constructor(private readonly selection: Extract<HostEmbeddingSelection, { ok: true }>, private readonly now: () => number = Date.now) {}

  private resolveInstance(): Promise<HostEmbeddingInstance> {
    if (!this.instance && this.failedAt && this.now() - this.failedAt < CREATE_RETRY_MS) return Promise.reject(new Error("host embedding provider unavailable"));
    if (!this.instance) {
      this.instance = this.selection.create();
      this.instance.catch(() => { this.instance = undefined; this.failedAt = this.now(); });
    }
    return this.instance;
  }

  async embed(inputs: string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    if (inputs.length === 0) throw new Error("invalid embedding vectors: count mismatch");
    const instance = await this.resolveInstance();
    // A token is at least one character for every supported tokenizer, so this
    // keeps each input inside the provider's limit; Mnemora's own
    // maxInputChars bound still applies before this.
    const limit = instance.maxInputTokens && instance.maxInputTokens > 0 ? instance.maxInputTokens : undefined;
    const bounded = limit ? inputs.map(input => input.length > limit ? input.slice(0, limit) : input) : inputs;
    const raw = await instance.embedBatch(bounded, { ...(signal ? { signal } : {}) });
    if (!Array.isArray(raw) || raw.length !== inputs.length) throw new Error("invalid embedding vectors: count mismatch");
    const vectors = raw.map(normalizeEmbeddingVector);
    if (vectors.some(vector => vector.length !== vectors[0]!.length)) throw new Error("invalid embedding vectors: inconsistent dimensions");
    return { identity: { provider: this.selection.provider, model: this.selection.model, dimensions: vectors[0]!.length }, vectors };
  }
}
