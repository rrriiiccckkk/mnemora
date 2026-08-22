import type { MnemoraConfig } from "../index.js";
import type { InsightKind, NodeType } from "../types.js";
import type { RelationshipType } from "../relationships.js";

export interface ExplanationCandidateInput {
  id: string;
  kind: InsightKind;
  signals: Record<string, number>;
  entity_names: string[];
  entity_types: NodeType[];
  relationship_types: RelationshipType[];
  community_metrics: Record<string, number>;
}

export interface ExplanationInput { candidates: ExplanationCandidateInput[] }
export interface ExplainOptions { signal?: AbortSignal }

export interface ExplanationPayloadCandidate {
  id: string;
  kind: InsightKind;
  signals: Record<string, number>;
  entity_names: string[];
  entity_types: NodeType[];
  relationship_types: RelationshipType[];
  community_metrics: Record<string, number>;
}

export interface ExplanationPayload { candidates: ExplanationPayloadCandidate[] }

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

const MAX_CANDIDATES = 5;
const MAX_ID_LENGTH = 160;
const MAX_ENTITY_NAMES = 32;
const MAX_ENTITY_NAME_LENGTH = 160;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_TEXT_LENGTH = 600;
const SIGNAL_KEYS = new Set([
  "density", "average_confidence", "evidence_coverage", "source_concentration", "boundary_ratio",
  "recent_count", "baseline_count", "recent_entity_count", "baseline_entity_count",
  "recent_relationship_count", "baseline_relationship_count", "recent_activity_count", "baseline_activity_count",
  "recent_novel_entity_count", "recent_novel_relationship_count", "recent_novel_activity_count",
  "baseline_only_activity_count", "normalized_baseline_count", "absolute_growth", "recent_growth",
  "path_length", "minimum_confidence", "omitted_entity_count"
]);
const COMMUNITY_METRIC_KEYS = new Set([
  "size", "internal_edge_count", "density", "average_confidence", "evidence_coverage",
  "source_concentration", "recent_growth", "bridge_score"
]);
const NODE_TYPES = new Set<NodeType>([
  "person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"
]);
const RELATIONSHIP_TYPES = new Set<RelationshipType>([
  "works_at", "invested_in", "supplies", "supplies_product", "supplied_to", "competes_with",
  "uses", "develops", "owns", "partners_with", "in_portfolio", "related_to"
]);

function boundedMaximum(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(MAX_CANDIDATES, Math.trunc(number))) : MAX_CANDIDATES;
}

function finiteMetrics(value: Record<string, number>, allowed: Set<string>): Record<string, number> {
  return Object.fromEntries(Object.entries(value ?? {}).filter((entry): entry is [string, number] => allowed.has(entry[0]) && Number.isFinite(entry[1])));
}

function knownValues<T extends string>(value: unknown, allowed: Set<T>): T[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<T>();
  const result: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item as T) || seen.has(item as T)) continue;
    seen.add(item as T);
    result.push(item as T);
  }
  return result;
}

export function buildExplanationPayload(input: ExplanationInput, maxCandidates = MAX_CANDIDATES): ExplanationPayload {
  const payload: ExplanationPayload = {
    candidates: (Array.isArray(input?.candidates) ? input.candidates : []).slice(0, boundedMaximum(maxCandidates)).map(item => {
      const entityNames = boundedEntityNames(item.entity_names);
      return {
        id: typeof item.id === "string" ? item.id.slice(0, MAX_ID_LENGTH) : "",
        kind: item.kind,
        signals: {
          ...finiteMetrics(item.signals, SIGNAL_KEYS),
          ...(entityNames.omittedCount > 0 ? { omitted_entity_count: entityNames.omittedCount } : {})
        },
        entity_names: entityNames.names,
        entity_types: knownValues(item.entity_types, NODE_TYPES),
        relationship_types: knownValues(item.relationship_types, RELATIONSHIP_TYPES),
        community_metrics: finiteMetrics(item.community_metrics, COMMUNITY_METRIC_KEYS)
      };
    })
  };
  // UTF-8 can use four bytes per code point, so character ceilings alone do
  // not prove the provider boundary. Remove names deterministically until the
  // complete serialized metadata payload fits the hard byte budget.
  for (let index = payload.candidates.length - 1; Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES;) {
    const candidate = payload.candidates[index];
    if (candidate?.entity_names.length) {
      candidate.entity_names.pop();
      candidate.signals.omitted_entity_count = (candidate.signals.omitted_entity_count ?? 0) + 1;
    }
    index = index <= 0 ? payload.candidates.length - 1 : index - 1;
    if (!payload.candidates.some(item => item.entity_names.length)) break;
  }
  return payload;
}

function boundedEntityNames(value: unknown): { names: string[]; omittedCount: number } {
  if (!Array.isArray(value)) return { names: [], omittedCount: 0 };
  const names = value.filter((item): item is string => typeof item === "string");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const bounded = name.slice(0, MAX_ENTITY_NAME_LENGTH);
    if (seen.has(bounded)) continue;
    seen.add(bounded);
    result.push(bounded);
    if (result.length === MAX_ENTITY_NAMES) break;
  }
  return { names: result, omittedCount: names.length - result.length };
}

class ExplanationTimeoutError extends Error {
  constructor() { super("insight explanation timed out"); }
}

function invalidResponse(): never { throw new Error("invalid explanation response"); }

export class InsightExplainer {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxCandidates: number;

  constructor(
    config: Partial<MnemoraConfig>,
    private readonly fetcher: Fetcher = fetch,
    private readonly runtimeSignal?: AbortSignal
  ) {
    const configuredKey = config.llm?.apiKey?.trim() ?? "";
    this.apiKey = configuredKey || process.env.DEEPSEEK_API_KEY?.trim() || "";
    this.baseURL = config.llm?.baseURL ?? "https://api.deepseek.com/v1";
    this.model = config.llm?.model ?? "deepseek-chat";
    this.timeoutMs = Math.max(1, Number(config.insights?.explanationTimeoutMs ?? 10000));
    this.maxCandidates = boundedMaximum(config.insights?.maxExplanationCandidates ?? MAX_CANDIDATES);
  }

  get available(): boolean { return this.apiKey.length > 0 && this.maxCandidates > 0; }

  async explain(input: ExplanationInput, options: ExplainOptions = {}): Promise<Record<string, string>> {
    if (!this.available) throw new Error("insight explanations unavailable");
    const payload = buildExplanationPayload(input, this.maxCandidates);
    if (payload.candidates.length === 0) return {};
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new ExplanationTimeoutError()), this.timeoutMs);
    const signals = [timeout.signal, options.signal, this.runtimeSignal].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    try {
      const response = await this.fetcher(`${this.baseURL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Explain each graph insight briefly using only the supplied aggregate metadata. Return strict JSON exactly as {\"explanations\":[{\"id\":\"requested-id\",\"text\":\"short explanation\"}]}." },
            { role: "user", content: JSON.stringify(payload) }
          ]
        }),
        signal
      });
      if (!response.ok) throw new Error(`insight explanation failed: ${response.status}`);
      let json: { choices?: Array<{ message?: { content?: unknown } }> };
      try { json = await response.json() as typeof json; } catch { return invalidResponse(); }
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") return invalidResponse();
      let parsed: unknown;
      try { parsed = JSON.parse(content); } catch { return invalidResponse(); }
      return validateExplanations(parsed, new Set(payload.candidates.map(candidate => candidate.id)), payload.candidates.length);
    } finally {
      clearTimeout(timer);
    }
  }
}

function validateExplanations(value: unknown, requested: Set<string>, maximum: number): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("explanations" in value)) return invalidResponse();
  const explanations = (value as { explanations?: unknown }).explanations;
  if (!Array.isArray(explanations) || explanations.length > maximum) return invalidResponse();
  const result: Record<string, string> = {};
  for (const item of explanations) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join(",") !== "id,text") return invalidResponse();
    const { id, text } = item as { id?: unknown; text?: unknown };
    if (typeof id !== "string" || !requested.has(id) || Object.hasOwn(result, id) || typeof text !== "string") return invalidResponse();
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) return invalidResponse();
    result[id] = trimmed;
  }
  return result;
}
