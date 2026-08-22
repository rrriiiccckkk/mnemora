import type { MnemoraConfig } from "../index.js";
import type { GraphologyStore } from "../store.js";
import type { KgQueryResult, QueryPlanV1 } from "./types.js";
import { executeQueryPlan } from "./executor.js";
import { QueryPlanner } from "./planner.js";
import { normalizeQueryPlan } from "./validation.js";
import { boundedQueryQuestion } from "./question.js";
import { normalizeScope } from "../scope.js";

export interface GraphQueryServiceOptions {
  store: GraphologyStore;
  config: Partial<MnemoraConfig>;
  planner?: Pick<QueryPlanner, "plan">;
  now?: () => number;
  signal?: AbortSignal;
}

export class GraphQueryService {
  private readonly planner: Pick<QueryPlanner, "plan">;
  private readonly now: () => number;
  constructor(private readonly options: GraphQueryServiceOptions) {
    this.planner = options.planner ?? new QueryPlanner(options.config, fetch, options.signal);
    this.now = options.now ?? Date.now;
  }

  async query(input: { question?: string; plan?: unknown; scope?: string; signal?: AbortSignal }): Promise<KgQueryResult> {
    const started = this.now();
    const scope = normalizeScope(input.scope, this.options.config.scope?.default ?? "default");
    const source = input.plan === undefined ? "llm" : "provided";
    let plan: QueryPlanV1 | undefined;
    try {
      if (input.signal?.aborted || this.options.signal?.aborted) throw new Error("aborted");
      plan = input.plan === undefined
        ? normalizeQueryPlan(await this.planner.plan(boundedQueryQuestion(input.question), { signal: composedSignal(input.signal, this.options.signal) }), this.options.config.query)
        : normalizeQueryPlan(input.plan, this.options.config.query);
      if (plan.steps.some(step => step.op === "lookup" && step.mode !== undefined && step.mode !== "lexical")) throw new Error("invalid_plan");
      const result = executeQueryPlan(this.options.store, plan, { limits: this.options.config.query ?? {}, now: started, scope, signal: composedSignal(input.signal, this.options.signal) });
      const output: KgQueryResult = { ...result, status: result.entities.length || result.relationships.length || result.aggregates.length ? "ok" : "empty", plan_source: source };
      this.options.store.recordQueryRun({ plan, scope, status: output.truncated ? "truncated" : "succeeded", graph_revision: output.graph_revision, result_count: output.entities.length + output.relationships.length + output.aggregates.length, duration_ms: duration(this.now() - started), created_at: started, retention_days: this.options.config.query?.auditRetentionDays ?? 30 });
      return output;
    } catch (error) {
      const category = errorCategory(error, input.signal, this.options.signal);
      if (plan) this.options.store.recordQueryRun({ plan, scope, status: "failed", error_category: category, graph_revision: this.options.store.graphRevision(), result_count: 0, duration_ms: duration(this.now() - started), created_at: started, retention_days: this.options.config.query?.auditRetentionDays ?? 30 });
      throw new Error(category);
    }
  }
}

function duration(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0; }
function composedSignal(...values: Array<AbortSignal | undefined>): AbortSignal | undefined { const signals = values.filter((v): v is AbortSignal => v != null); return signals.length < 2 ? signals[0] : AbortSignal.any(signals); }
function errorCategory(error: unknown, ...signals: Array<AbortSignal | undefined>): "unavailable" | "timeout" | "aborted" | "provider" | "invalid_plan" {
  if (signals.some(signal => signal?.aborted)) return "aborted";
  const message = error instanceof Error ? error.message : "";
  if (["unavailable", "timeout", "aborted", "provider", "invalid_plan"].includes(message)) return message as ReturnType<typeof errorCategory>;
  if (message.includes("timeout")) return "timeout";
  if (message.includes("cancel")) return "aborted";
  return "invalid_plan";
}
