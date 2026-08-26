import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import { ReasoningContextCompiler, type CompileReasoningContextInput, type CompiledReasoningContext } from "./reasoning-adapters.js";
import type { ReasoningQualityPolicy } from "./reasoning-quality.js";
import { ReasoningSemanticRetrievalService, type ReasoningSemanticProvider } from "./reasoning-semantic.js";
import { classifyReasoningTask, isHighRiskReasoningOperation, reasoningTaskType } from "./reasoning-task-types.js";

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
    const scope = normalizeScope(input.scope), query = clean(input.query), explicitTaskType = reasoningTaskType(input.taskType), classifiedTaskType = explicitTaskType ?? classifyReasoningTask(query);
    const highRisk = input.riskLevel === "high" || isHighRiskReasoningOperation(query), riskLevel = highRisk ? "high" : input.riskLevel ?? (classifiedTaskType ? "medium" : "low");
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
    const context = this.compiler.compile(compilationInput(input, decision, this.options));
    return { version: "reasoning-runtime-v1", decision, context };
  }

  /** Optional bounded semantic hinting. Provider results never bypass scope, admission, or quality policy. */
  async prepareWithSemantic(input: ReasoningRuntimeTaskContext, provider: ReasoningSemanticProvider, timeoutMs = 5_000, maxCandidates?: number): Promise<ReasoningRuntimeResult> {
    const decision = this.plan(input);
    if (!decision.shouldRetrieve) return { version: "reasoning-runtime-v1", decision };
    const limit = maxCandidates === undefined ? Math.min(50, (input.maxItems ?? 6) * 4) : Math.min(50, Math.max(1, Math.trunc(maxCandidates)));
    const semanticScores = await new ReasoningSemanticRetrievalService(this.db, provider, timeoutMs).scores({ scope: decision.scope, query: clean(input.query), limit, signal: input.signal });
    const context = this.compiler.compile({ ...compilationInput(input, decision, this.options), semanticScores });
    return { version: "reasoning-runtime-v1", decision, context };
  }

  /** Runtime-only fail-open wrapper. The explicit semantic API above retains
   * timeout/error visibility for callers; host assembly may safely continue
   * with the deterministic lexical path when a local provider is unavailable. */
  async prepareWithSemanticFallback(input: ReasoningRuntimeTaskContext, provider: ReasoningSemanticProvider, timeoutMs = 5_000, maxCandidates?: number): Promise<ReasoningRuntimeResult> {
    try { return await this.prepareWithSemantic(input, provider, timeoutMs, maxCandidates); }
    catch (error) { if (input.signal?.aborted) throw error; return this.prepare(input); }
  }
}

function clean(value: unknown): string { return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 4096) : ""; }
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new Error("aborted"); }
function compilationInput(input: ReasoningRuntimeTaskContext, decision: ReasoningRuntimeDecision, options: { qualityPolicy?: ReasoningQualityPolicy; now?: () => number }): CompileReasoningContextInput {
  const explicitTaskType = reasoningTaskType(input.taskType), highRiskDetected = decision.triggers.includes("high_risk_operation");
  return {
    ...input,
    scope: decision.scope,
    query: clean(input.query),
    taskType: explicitTaskType,
    inferredTaskType: explicitTaskType ? undefined : decision.taskType,
    riskLevel: highRiskDetected ? "high" : input.riskLevel,
    inferredRiskLevel: highRiskDetected || input.riskLevel !== undefined ? undefined : decision.riskLevel,
    qualityRiskLevel: decision.riskLevel,
    qualityPolicy: options.qualityPolicy,
    now: options.now
  };
}
