import { randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { ReasoningRuntimeTaskContext } from "./reasoning-runtime.js";
import { ReasoningRuntimeService } from "./reasoning-runtime.js";
import type { ReasoningRuntimeResult } from "./reasoning-runtime.js";
import type { ReasoningQualityPolicy } from "./reasoning-quality.js";
import type { ReasoningSemanticProvider } from "./reasoning-semantic.js";

export interface ReasoningRuntimeTelemetryConfig extends ReasoningQualityPolicy {
  tokenBudget: number; maxItems: number; retentionDays: number;
  readiness: { minimumRuns: number; maxErrorRate: number; maxEmptyRate: number; maxP95Ms: number; };
}
export interface ReasoningShadowMetrics { version: "reasoning-shadow-metrics-v1"; scope: string; runs: number; triggered: number; selected: number; qualityExcluded: number; semanticCandidates: number; unmatched: number; taskTypeExcluded: number; empty: number; failures: number; triggerRate: number; emptyRate: number; errorRate: number; p95Ms: number; }
export interface ReasoningRuntimeReadiness { version: "reasoning-runtime-readiness-v1"; scope: string; ready: boolean; reasons: string[]; metrics: ReasoningShadowMetrics; thresholds: ReasoningRuntimeTelemetryConfig["readiness"]; deliveryEnabled: false; }

export class ReasoningRuntimeTelemetryRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}
  record(input: { scope: string; status: "succeeded" | "failed"; triggered: boolean; highRisk: boolean; candidateCount: number; selectedCount: number; qualityExcluded: number; semanticCandidates?: number; unmatched?: number; taskTypeExcluded?: number; empty: boolean; estimatedTokens: number; durationMs: number; errorCategory?: "aborted" | "operation_failed" }): void {
    this.db.prepare(`INSERT INTO mnemora_reasoning_runtime_shadow_runs(
      id,scope,policy_version,status,triggered,high_risk,candidate_count,selected_count,quality_excluded,semantic_candidates,unmatched,task_type_excluded,empty_result,estimated_tokens,duration_ms,error_category,created_at
    ) VALUES(
      ?, ?, 'reasoning-quality-v1',
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?
    )`).run(randomUUID(), normalizeScope(input.scope), input.status, flag(input.triggered), flag(input.highRisk), bounded(input.candidateCount, 200), bounded(input.selectedCount, 20), bounded(input.qualityExcluded, 200), bounded(input.semanticCandidates ?? 0, 200), bounded(input.unmatched ?? 0, 200), bounded(input.taskTypeExcluded ?? 0, 200), flag(input.empty), bounded(input.estimatedTokens, 1600), bounded(input.durationMs, 30000), input.errorCategory ?? null, this.now());
  }
  prune(retentionDays: number): number { const cutoff = this.now() - Math.max(1, Math.min(365, Math.trunc(retentionDays))) * 86_400_000; return Number(this.db.prepare("DELETE FROM mnemora_reasoning_runtime_shadow_runs WHERE created_at<?").run(cutoff).changes); }
  metrics(scope: string, limit = 500): ReasoningShadowMetrics {
    const normalized = normalizeScope(scope), rows = this.db.prepare("SELECT status,triggered,selected_count,quality_excluded,semantic_candidates,unmatched,task_type_excluded,empty_result,duration_ms FROM mnemora_reasoning_runtime_shadow_runs WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?").all(normalized, Math.min(5000, Math.max(1, Math.trunc(limit)))) as Array<Record<string, unknown>>;
    const runs = rows.length, triggered = sum(rows, "triggered"), selected = sum(rows, "selected_count"), qualityExcluded = sum(rows, "quality_excluded"), semanticCandidates = sum(rows, "semantic_candidates"), unmatched = sum(rows, "unmatched"), taskTypeExcluded = sum(rows, "task_type_excluded"), empty = sum(rows, "empty_result"), failures = rows.filter(row => row.status === "failed").length;
    const durations = rows.map(row => Number(row.duration_ms)).sort((a, b) => a - b), p95Ms = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * .95) - 1)] : 0;
    return { version: "reasoning-shadow-metrics-v1", scope: normalized, runs, triggered, selected, qualityExcluded, semanticCandidates, unmatched, taskTypeExcluded, empty, failures, triggerRate: ratio(triggered, runs), emptyRate: ratio(empty, Math.max(1, triggered)), errorRate: ratio(failures, runs), p95Ms };
  }
  readiness(scope: string, thresholds: ReasoningRuntimeTelemetryConfig["readiness"]): ReasoningRuntimeReadiness {
    const metrics = this.metrics(scope), reasons: string[] = [];
    if (metrics.runs < thresholds.minimumRuns) reasons.push("insufficient_shadow_runs");
    if (metrics.triggered === 0) reasons.push("no_triggered_shadow_runs");
    if (metrics.errorRate > thresholds.maxErrorRate) reasons.push("error_rate_above_threshold");
    if (metrics.emptyRate > thresholds.maxEmptyRate) reasons.push("empty_rate_above_threshold");
    if (metrics.p95Ms > thresholds.maxP95Ms) reasons.push("latency_above_threshold");
    return { version: "reasoning-runtime-readiness-v1", scope: metrics.scope, ready: reasons.length === 0, reasons, metrics, thresholds, deliveryEnabled: false };
  }
}

/** Captures only bounded aggregates. It never returns or attaches model context. */
export class ReasoningRuntimeShadowService {
  private readonly runtime: ReasoningRuntimeService; private readonly telemetry: ReasoningRuntimeTelemetryRepository;
  constructor(db: DatabaseSyncInstance, private readonly config: ReasoningRuntimeTelemetryConfig, now: () => number = Date.now) { this.runtime = new ReasoningRuntimeService(db, { qualityPolicy: config, now }); this.telemetry = new ReasoningRuntimeTelemetryRepository(db, now); }
  capture(input: ReasoningRuntimeTaskContext): void { this.evaluate(input); }
  async captureWithSemantic(input: ReasoningRuntimeTaskContext, provider: ReasoningSemanticProvider, timeoutMs: number, maxCandidates?: number): Promise<void> { await this.evaluateWithSemantic(input, provider, timeoutMs, maxCandidates); }
  evaluate(input: ReasoningRuntimeTaskContext): ReasoningRuntimeResult | undefined {
    const started = Date.now(), scope = normalizeScope(input.scope);
    try {
      const result = this.runtime.prepare({ ...input, tokenBudget: this.config.tokenBudget, maxItems: this.config.maxItems });
      this.recordResult(scope, result, Date.now() - started);
      this.telemetry.prune(this.config.retentionDays);
      return result;
    } catch (error) {
      this.recordFailure(scope, input, Date.now() - started);
      if (input.signal?.aborted) throw error;
      return undefined;
    }
  }
  async evaluateWithSemantic(input: ReasoningRuntimeTaskContext, provider: ReasoningSemanticProvider, timeoutMs: number, maxCandidates?: number): Promise<ReasoningRuntimeResult | undefined> {
    const started = Date.now(), scope = normalizeScope(input.scope);
    try {
      const result = await this.runtime.prepareWithSemanticFallback({ ...input, tokenBudget: this.config.tokenBudget, maxItems: this.config.maxItems }, provider, timeoutMs, maxCandidates);
      this.recordResult(scope, result, Date.now() - started);
      this.telemetry.prune(this.config.retentionDays);
      return result;
    } catch (error) {
      this.recordFailure(scope, input, Date.now() - started);
      if (input.signal?.aborted) throw error;
      return undefined;
    }
  }
  private recordResult(scope: string, result: ReasoningRuntimeResult, durationMs: number): void {
    const diagnostics = result.context?.diagnostics, selected = result.context?.items.length ?? 0;
    this.telemetry.record({ scope, status: "succeeded", triggered: result.decision.shouldRetrieve, highRisk: result.decision.riskLevel === "high", candidateCount: diagnostics?.retrievalCandidates ?? 0, selectedCount: selected, qualityExcluded: diagnostics?.qualityExcluded ?? 0, semanticCandidates: diagnostics?.semanticCandidates ?? 0, unmatched: diagnostics?.unmatched ?? 0, taskTypeExcluded: diagnostics?.taskTypeExcluded ?? 0, empty: result.decision.shouldRetrieve && selected === 0, estimatedTokens: result.context?.estimatedTokens ?? 0, durationMs });
  }
  private recordFailure(scope: string, input: ReasoningRuntimeTaskContext, durationMs: number): void {
    this.telemetry.record({ scope, status: "failed", triggered: false, highRisk: input.riskLevel === "high", candidateCount: 0, selectedCount: 0, qualityExcluded: 0, empty: false, estimatedTokens: 0, durationMs, errorCategory: input.signal?.aborted ? "aborted" : "operation_failed" });
  }
}
function flag(value: boolean): number { return value ? 1 : 0; }
function bounded(value: number, max: number): number { return Math.min(max, Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0))); }
function sum(rows: Array<Record<string, unknown>>, key: string): number { return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0); }
function ratio(value: number, total: number): number { return total ? Number((value / total).toFixed(4)) : 0; }
