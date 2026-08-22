import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import { ReasoningContextCompiler, type CompileReasoningContextInput, type CompiledReasoningContext } from "./reasoning-adapters.js";
import type { ReasoningQualityPolicy } from "./reasoning-quality.js";
import { ReasoningSemanticRetrievalService, type ReasoningSemanticProvider } from "./reasoning-semantic.js";

export type ReasoningRuntimeTrigger = "explicit_task_type" | "task_classification" | "high_risk_operation" | "failure_recovery";
export interface ReasoningRuntimeTaskContext extends CompileReasoningContextInput { failureSignal?: boolean; }
export interface ReasoningRuntimeDecision {
  version: "reasoning-runtime-decision-v1";
  mode: "shadow";
  scope: string;
  shouldRetrieve: boolean;
  taskType?: string;
  riskLevel: "low" | "medium" | "high";
  triggers: ReasoningRuntimeTrigger[];
  reasons: string[];
}
export interface ReasoningRuntimeResult { version: "reasoning-runtime-v1"; decision: ReasoningRuntimeDecision; context?: CompiledReasoningContext; }

/**
 * Deterministic runtime retrieval policy. It is deliberately shadow-only:
 * callers may inspect its compiled output, but this service never attaches it
 * to a prompt, records a query, or changes a ReasoningMemory record.
 */
export class ReasoningRuntimeService {
  private readonly compiler: ReasoningContextCompiler;
  constructor(private readonly db: DatabaseSyncInstance, private readonly options: { qualityPolicy?: ReasoningQualityPolicy; now?: () => number } = {}) { this.compiler = new ReasoningContextCompiler(db); }

  plan(input: ReasoningRuntimeTaskContext): ReasoningRuntimeDecision {
    abort(input.signal);
    if (input.riskLevel !== undefined && !["low", "medium", "high"].includes(input.riskLevel)) throw new Error("invalid_reasoning_runtime");
    const scope = normalizeScope(input.scope), query = clean(input.query), explicitTaskType = identifier(input.taskType), classifiedTaskType = explicitTaskType ?? classify(query);
    const highRisk = input.riskLevel === "high" || highRiskOperation(query), riskLevel = input.riskLevel ?? (highRisk ? "high" : classifiedTaskType ? "medium" : "low");
    const triggers: ReasoningRuntimeTrigger[] = [], reasons: string[] = [];
    if (explicitTaskType) { triggers.push("explicit_task_type"); reasons.push("task_type_declared"); }
    else if (classifiedTaskType) { triggers.push("task_classification"); reasons.push(`task_type_classified:${classifiedTaskType}`); }
    if (highRisk) { triggers.push("high_risk_operation"); reasons.push("high_risk_operation_detected"); }
    if (input.failureSignal === true) { triggers.push("failure_recovery"); reasons.push("failure_signal_declared"); }
    if (!triggers.length) reasons.push("no_runtime_retrieval_trigger");
    return { version: "reasoning-runtime-decision-v1", mode: "shadow", scope, shouldRetrieve: triggers.length > 0, ...(classifiedTaskType ? { taskType: classifiedTaskType } : {}), riskLevel, triggers, reasons };
  }

  prepare(input: ReasoningRuntimeTaskContext): ReasoningRuntimeResult {
    const decision = this.plan(input);
    if (!decision.shouldRetrieve) return { version: "reasoning-runtime-v1", decision };
    abort(input.signal);
    const context = this.compiler.compile({ ...input, scope: decision.scope, query: clean(input.query), taskType: decision.taskType, riskLevel: decision.riskLevel, qualityPolicy: this.options.qualityPolicy, now: this.options.now });
    return { version: "reasoning-runtime-v1", decision, context };
  }

  /** Optional bounded semantic hinting. Provider results never bypass scope, admission, or quality policy. */
  async prepareWithSemantic(input: ReasoningRuntimeTaskContext, provider: ReasoningSemanticProvider, timeoutMs = 5_000): Promise<ReasoningRuntimeResult> {
    const decision = this.plan(input);
    if (!decision.shouldRetrieve) return { version: "reasoning-runtime-v1", decision };
    const semanticScores = await new ReasoningSemanticRetrievalService(this.db, provider, timeoutMs).scores({ scope: decision.scope, query: clean(input.query), limit: Math.min(50, (input.maxItems ?? 6) * 4), signal: input.signal });
    const context = this.compiler.compile({ ...input, scope: decision.scope, query: clean(input.query), taskType: decision.taskType, riskLevel: decision.riskLevel, semanticScores, qualityPolicy: this.options.qualityPolicy, now: this.options.now });
    return { version: "reasoning-runtime-v1", decision, context };
  }
}

function clean(value: unknown): string { return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 4096) : ""; }
function identifier(value: unknown): string | undefined { return typeof value === "string" && /^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined; }
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new Error("aborted"); }
function classify(query: string): string | undefined {
  const lower = query.toLowerCase();
  for (const [taskType, terms] of Object.entries({ database_migration: ["migration", "migrate", "schema", "ddl"], deployment: ["deploy", "deployment", "rollout"], destructive_operation: ["delete", "deletion", "drop table", "erase"], security_operation: ["security", "credential", "permission", "vulnerability"], financial_operation: ["payment", "transfer", "financial transaction"], software_debugging: ["debug", "bug", "regression", "stack trace"] })) if (terms.some(term => lower.includes(term))) return taskType;
  return undefined;
}
function highRiskOperation(query: string): boolean { return /\b(production|deploy(?:ment)?|migration|migrate|delete|deletion|drop|security|credential|permission|payment|transfer|rollback)\b/i.test(query); }
