import type { MnemoraConfig } from "../index.js";
import type { KgMemorySearchResult } from "../types.js";

type RerankerConfig = NonNullable<NonNullable<NonNullable<MnemoraConfig["memory"]>["retrieval"]>["reranker"]>;

const text = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";
const score = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
};

/**
 * A deliberately narrow boundary for optional cross-encoder-style rerank
 * services. It sends only an already-selected, scope-local candidate set and
 * fails open to the local ranking on every transport or response problem.
 */
export class MemoryReranker {
  constructor(private readonly config: RerankerConfig, private readonly fetcher: typeof fetch) {}

  get enabled(): boolean { return this.config.enabled === true && Boolean(this.config.endpoint); }

  async rerank(query: string, candidates: readonly KgMemorySearchResult[], signal?: AbortSignal): Promise<KgMemorySearchResult[]> {
    if (!this.enabled || candidates.length < 2) return [...candidates];
    const endpoint = this.config.endpoint!;
    const maxCandidates = this.config.maxCandidates ?? 12;
    const maxQueryChars = this.config.maxQueryChars ?? 512;
    const maxDocumentChars = this.config.maxDocumentChars ?? 4000;
    const timeoutMs = this.config.timeoutMs ?? 5000;
    const selected = candidates.slice(0, maxCandidates);
    const boundedQuery = text(query, maxQueryChars);
    if (!boundedQuery) return [...candidates];

    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new Error("aborted"));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    try {
      const response = await this.fetcher(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
        },
        body: JSON.stringify({
          ...(this.config.model ? { model: this.config.model } : {}),
          query: boundedQuery,
          documents: selected.map(item => ({ id: item.id, text: text(`${item.title}\n${item.excerpt}`, maxDocumentChars) }))
        }),
        signal: controller.signal
      });
      if (!response.ok) return [...candidates];
      const payload = await boundedJson(response, 65_536);
      const values = parseScores(payload, selected);
      // A partial remote response has no comparable score for every local
      // candidate. Treat it like any other malformed response and preserve
      // the complete local order rather than demoting unscored results.
      if (values.size !== selected.length) return [...candidates];
      const ranked = selected
        .map((item, index) => ({ item, index, rerank: values.get(item.id) }))
        .sort((left, right) => right.rerank! - left.rerank! || left.index - right.index);
      if (ranked.every((value, index) => value.item.id === selected[index].id)) return [...candidates];
      const reranked = ranked.map(({ item, rerank }) => ({ ...item, score: rerank!, rerank_score: rerank! }));
      return [...reranked, ...candidates.slice(selected.length)];
    } catch {
      // Reranking is quality improvement only. Never let an unavailable model
      // make previously useful local recall disappear.
      return [...candidates];
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new Error("oversized_response");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("invalid_response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value) continue;
      bytes += part.value.byteLength;
      if (bytes > maximum) {
        try { await reader.cancel("oversized_response"); } catch { /* best-effort stream teardown */ }
        throw new Error("oversized_response");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), bytes).toString("utf8"));
}

function parseScores(payload: unknown, selected: readonly KgMemorySearchResult[]): Map<string, number> {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
  const values = Array.isArray(record?.results) ? record.results : Array.isArray(record?.data) ? record.data : Array.isArray(payload) ? payload : [];
  const scores = new Map<string, number>();
  for (const value of values.slice(0, selected.length)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const index = Number.isInteger(row.index) ? Number(row.index) : -1;
    const id = typeof row.id === "string" ? row.id : selected[index]?.id;
    const relevance = score(row.relevance_score ?? row.score);
    if (!id || !selected.some(item => item.id === id) || relevance == null) continue;
    scores.set(id, relevance);
  }
  return scores;
}
