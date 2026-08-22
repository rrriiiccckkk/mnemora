import type { MnemoraConfig } from "../index.js";
import type { QueryPlanV1 } from "./types.js";
import { normalizeQueryPlan } from "./validation.js";
import { boundedQueryQuestion } from "./question.js";

export interface QueryPlanOptions { signal?: AbortSignal }
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;
type Category = "unavailable" | "timeout" | "aborted" | "provider" | "invalid_plan";

const nodeType = { type: "string", enum: ["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"] };
const edgeType = { type: "string", enum: ["works_at", "invested_in", "supplies", "supplies_product", "supplied_to", "competes_with", "uses", "develops", "owns", "partners_with", "in_portfolio", "related_to"] };
export const queryPlanJsonSchema = {
  type: "object", additionalProperties: false, required: ["version", "steps"],
  properties: {
    version: { const: 1 },
    steps: { type: "array", minItems: 1, maxItems: 8, items: { oneOf: [
      { type: "object", additionalProperties: false, required: ["op", "query"], properties: { op: { const: "lookup" }, query: { type: "string", minLength: 1 }, node_types: { type: "array", items: nodeType }, mode: { type: "string", enum: ["lexical"] } } },
      { type: "object", additionalProperties: false, required: ["op", "from", "direction", "depth"], properties: { op: { const: "traverse" }, from: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, edge_types: { type: "array", items: edgeType }, direction: { type: "string", enum: ["out", "in", "both"] }, depth: { type: "integer", minimum: 0, maximum: 4 } } },
      { type: "object", additionalProperties: false, required: ["op"], properties: { op: { const: "filter" }, node_types: { type: "array", items: nodeType }, confidence_min: { type: "number", minimum: 0, maximum: 1 }, valid_from: { type: "number" }, valid_to: { type: "number" } } },
      { type: "object", additionalProperties: false, required: ["op", "by", "metric"], properties: { op: { const: "aggregate" }, by: { type: "string", enum: ["node_type", "relationship_type", "source"] }, metric: { type: "string", enum: ["count", "entities", "relationships"] } } }
    ] } },
    order_by: { type: "string", enum: ["relevance", "confidence", "recency", "name"] },
    limit: { type: "integer", minimum: 1, maximum: 50 }
  }
} as const;
const systemPrompt = `Return exactly one JSON object conforming to this closed JSON Schema: ${JSON.stringify(queryPlanJsonSchema)}. Lookup mode MUST be lexical; semantic and hybrid are unsupported. Never output SQL, code, prose, credentials, filesystem paths, provider metadata, or additional properties. Omit optional properties rather than using null.`;

export class QueryPlanner {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: Partial<MnemoraConfig>, private readonly fetcher: Fetcher = fetch, private readonly runtimeSignal?: AbortSignal) {
    this.apiKey = config.llm?.apiKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim() || "";
    this.baseURL = config.llm?.baseURL ?? "https://api.deepseek.com/v1";
    this.model = config.llm?.model ?? "deepseek-chat";
    const timeoutMs = config.query?.timeoutMs;
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.min(10000, Math.max(1, Math.trunc(timeoutMs!))) : 10000;
  }

  get available(): boolean { return this.apiKey.length > 0; }

  async plan(question: string, options: QueryPlanOptions = {}): Promise<QueryPlanV1> {
    if (!this.available) throw bounded("unavailable");
    try { question = boundedQueryQuestion(question); } catch { throw bounded("invalid_plan"); }
    if (options.signal?.aborted || this.runtimeSignal?.aborted) throw bounded("aborted");
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const signals = [timeout.signal, options.signal, this.runtimeSignal].filter((signal): signal is AbortSignal => signal != null);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    try {
      const response = await this.fetcher(`${this.baseURL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: question }] }),
        signal
      });
      if (!response.ok) throw bounded("provider");
      let body: { choices?: Array<{ message?: { content?: unknown } }> };
      try { body = await response.json() as typeof body; } catch { throw bounded("invalid_plan"); }
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw bounded("invalid_plan");
      let parsed: unknown;
      try { parsed = JSON.parse(content); } catch { throw bounded("invalid_plan"); }
      const plan = normalizeQueryPlan(parsed, this.config.query);
      if (plan.steps.some(step => step.op === "lookup" && step.mode !== undefined && step.mode !== "lexical")) throw bounded("invalid_plan");
      return plan;
    } catch (error) {
      if (error instanceof QueryPlannerError) throw error;
      if (options.signal?.aborted || this.runtimeSignal?.aborted) throw bounded("aborted");
      if (timeout.signal.aborted) throw bounded("timeout");
      if (error instanceof Error && error.message === "invalid query plan") throw bounded("invalid_plan");
      throw bounded("provider");
    } finally { clearTimeout(timer); }
  }
}

class QueryPlannerError extends Error { constructor(readonly category: Category) { super(category); } }
const bounded = (category: Category) => new QueryPlannerError(category);
