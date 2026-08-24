import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";
import { ReasoningAgentAdapterRegistry, type CompiledReasoningContext } from "./reasoning-adapters.js";
import { ReasoningDeliveryFeedbackRepository } from "./reasoning-delivery-feedback.js";
import type { ReasoningRuntimeTaskContext } from "./reasoning-runtime.js";
import { ReasoningRuntimeShadowService, ReasoningRuntimeTelemetryRepository, type ReasoningRuntimeTelemetryConfig } from "./reasoning-runtime-telemetry.js";

export interface ReasoningDeliveryConfig { enabled: boolean; scopes: string[]; adapter: "openclaw"; calibrationMaxAgeHours: number; maxConsecutiveDeliveries: number; itemRetentionDays: number; }
export interface ReasoningRuntimeGovernanceConfig extends ReasoningRuntimeTelemetryConfig { delivery: ReasoningDeliveryConfig; }
export interface ReasoningRuntimeCalibration { id: string; scope: string; policyHash: string; status: "ready" | "rejected"; createdAt: number; expiresAt: number; metrics: { runs: number; triggered: number; selected: number; emptyRate: number; errorRate: number; p95Ms: number; }; }
export interface ReasoningRuntimeCanaryStatus { version: "reasoning-runtime-canary-v1"; scope: string; configured: boolean; active: boolean; circuitOpen: boolean; reason: string; calibration?: ReasoningRuntimeCalibration; recentDeliveries: number; harmfulFeedback: number; }
export interface ReasoningDeliveryResult { appendSystemContext: string; deliveryRunId: string; deliveryItemRefs: string[]; }

type CalibrationPreview = { version: "reasoning-runtime-calibration-preview-v1"; scope: string; policyHash: string; status: "ready" | "rejected"; metrics: ReasoningRuntimeCalibration["metrics"]; preview_hash: string; };

/** Owns only aggregate calibration/canary/delivery rows; no query, strategy, memory id, or source ref is persisted. */
export class ReasoningRuntimeGovernanceRepository {
  private readonly telemetry: ReasoningRuntimeTelemetryRepository;
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) { this.telemetry = new ReasoningRuntimeTelemetryRepository(db, now); }

  previewCalibration(scope: string, config: ReasoningRuntimeGovernanceConfig): CalibrationPreview {
    const normalized = normalizeScope(scope), readiness = this.telemetry.readiness(normalized, config.readiness), metrics = { runs: readiness.metrics.runs, triggered: readiness.metrics.triggered, selected: readiness.metrics.selected, emptyRate: readiness.metrics.emptyRate, errorRate: readiness.metrics.errorRate, p95Ms: readiness.metrics.p95Ms }, value = { version: "reasoning-runtime-calibration-preview-v1" as const, scope: normalized, policyHash: reasoningRuntimePolicyHash(config), status: readiness.ready ? "ready" as const : "rejected" as const, metrics };
    return { ...value, preview_hash: digest(value) };
  }

  confirmCalibration(scope: string, config: ReasoningRuntimeGovernanceConfig, previewHash: string): { status: "stale_preview"; preview: CalibrationPreview } | { status: "confirmed"; calibration: ReasoningRuntimeCalibration } {
    const preview = this.previewCalibration(scope, config); if (preview.preview_hash !== previewHash) return { status: "stale_preview", preview };
    const createdAt = this.now(), calibration: ReasoningRuntimeCalibration = { id: `reasoning-calibration:${randomUUID()}`, scope: preview.scope, policyHash: preview.policyHash, status: preview.status, createdAt, expiresAt: createdAt + config.delivery.calibrationMaxAgeHours * 3_600_000, metrics: preview.metrics };
    this.db.prepare(`INSERT INTO mnemora_reasoning_runtime_calibrations(id,scope,policy_hash,policy_version,status,total_runs,triggered_runs,selected_count,empty_rate,error_rate,p95_ms,created_at,expires_at) VALUES(?,? ,?,'reasoning-runtime-v1',?,?,?,?,?,?,?,?,?)`).run(calibration.id, calibration.scope, calibration.policyHash, calibration.status, calibration.metrics.runs, calibration.metrics.triggered, calibration.metrics.selected, calibration.metrics.emptyRate, calibration.metrics.errorRate, calibration.metrics.p95Ms, calibration.createdAt, calibration.expiresAt);
    return { status: "confirmed", calibration };
  }

  calibration(id: string): ReasoningRuntimeCalibration | undefined { const row = this.db.prepare("SELECT id,scope,policy_hash,status,total_runs,triggered_runs,selected_count,empty_rate,error_rate,p95_ms,created_at,expires_at FROM mnemora_reasoning_runtime_calibrations WHERE id=?").get(id) as Record<string, unknown> | undefined; return row ? calibration(row) : undefined; }

  enablePreview(scope: string, calibrationId: string, config: ReasoningRuntimeGovernanceConfig): { status: "not_ready" } | { status: "preview"; preview_hash: string } {
    const normalized = normalizeScope(scope), candidate = this.calibration(calibrationId), current = this.db.prepare("SELECT circuit_open,updated_at FROM mnemora_reasoning_runtime_canaries WHERE scope=?").get(normalized) as Record<string, unknown> | undefined;
    const newAfterCircuit = !current || Number(current.circuit_open) !== 1 || candidate && candidate.createdAt > Number(current.updated_at);
    if (!deliveryConfigured(normalized, config.delivery) || !candidate || candidate.scope !== normalized || candidate.status !== "ready" || candidate.expiresAt <= this.now() || candidate.policyHash !== reasoningRuntimePolicyHash(config) || !newAfterCircuit || !this.telemetry.readiness(normalized, config.readiness).ready) return { status: "not_ready" };
    return { status: "preview", preview_hash: digest({ version: "reasoning-runtime-canary-enable-v1", scope: normalized, calibrationId, policyHash: candidate.policyHash }) };
  }

  enable(scope: string, calibrationId: string, config: ReasoningRuntimeGovernanceConfig, previewHash: string): { status: "not_ready" | "stale_preview"; preview_hash?: string } | { status: "confirmed"; calibration: ReasoningRuntimeCalibration } {
    const preview = this.enablePreview(scope, calibrationId, config); if (preview.status !== "preview") return preview;
    if (preview.preview_hash !== previewHash) return { status: "stale_preview", preview_hash: preview.preview_hash };
    const normalized = normalizeScope(scope), now = this.now(), candidate = this.calibration(calibrationId)!;
    this.db.prepare(`INSERT INTO mnemora_reasoning_runtime_canaries(scope,calibration_id,enabled,circuit_open,reason_code,created_at,updated_at) VALUES(?,?,1,0,'activated',?,?) ON CONFLICT(scope) DO UPDATE SET calibration_id=excluded.calibration_id,enabled=1,circuit_open=0,reason_code='activated',updated_at=excluded.updated_at`).run(normalized, calibrationId, now, now);
    this.event(normalized, calibrationId, "ACTIVATE", "operator_confirmed", now); return { status: "confirmed", calibration: candidate };
  }

  authorize(scope: string, config: ReasoningRuntimeGovernanceConfig): { allowed: false; reason: string } | { allowed: true; calibration: ReasoningRuntimeCalibration } {
    const normalized = normalizeScope(scope); if (!deliveryConfigured(normalized, config.delivery)) return { allowed: false, reason: "not_configured" };
    if (process.env.MNEMORA_DISABLE_REASONING_DELIVERY === "1") return { allowed: false, reason: "environment_circuit_breaker" };
    const row = this.db.prepare("SELECT calibration_id,enabled,circuit_open FROM mnemora_reasoning_runtime_canaries WHERE scope=?").get(normalized) as Record<string, unknown> | undefined;
    if (!row || Number(row.enabled) !== 1 || Number(row.circuit_open) === 1) return { allowed: false, reason: "no_active_canary" };
    const candidate = this.calibration(String(row.calibration_id)); if (!candidate) return this.open(normalized, undefined, "calibration_missing");
    if (candidate.status !== "ready") return this.open(normalized, candidate.id, "readiness_regression");
    if (candidate.expiresAt <= this.now()) return this.open(normalized, candidate.id, "calibration_expired");
    if (candidate.policyHash !== reasoningRuntimePolicyHash(config)) return this.open(normalized, candidate.id, "policy_changed");
    if (!this.telemetry.readiness(normalized, config.readiness).ready) return this.open(normalized, candidate.id, "readiness_regression");
    return { allowed: true, calibration: candidate };
  }

  rollback(scope: string): ReasoningRuntimeCanaryStatus { const normalized = normalizeScope(scope), now = this.now(), row = this.db.prepare("SELECT calibration_id FROM mnemora_reasoning_runtime_canaries WHERE scope=?").get(normalized) as { calibration_id?: string } | undefined; this.db.prepare("UPDATE mnemora_reasoning_runtime_canaries SET enabled=0,circuit_open=1,reason_code='operator_rollback',updated_at=? WHERE scope=?").run(now, normalized); this.event(normalized, row?.calibration_id, "ROLLBACK", "operator_rollback", now); return this.status(normalized, undefined); }

  status(scope: string, config?: ReasoningRuntimeGovernanceConfig): ReasoningRuntimeCanaryStatus {
    const normalized = normalizeScope(scope), row = this.db.prepare("SELECT calibration_id,enabled,circuit_open,reason_code FROM mnemora_reasoning_runtime_canaries WHERE scope=?").get(normalized) as Record<string, unknown> | undefined, candidate = row?.calibration_id ? this.calibration(String(row.calibration_id)) : undefined, delivery = this.deliveryMetrics(normalized);
    const configured = config ? deliveryConfigured(normalized, config.delivery) : false, liveReady = config ? this.telemetry.readiness(normalized, config.readiness).ready : true;
    const valid = Boolean(row && Number(row.enabled) === 1 && Number(row.circuit_open) === 0 && candidate && candidate.status === "ready" && candidate.expiresAt > this.now() && (!config || configured && candidate.policyHash === reasoningRuntimePolicyHash(config) && liveReady));
    const reason = !row ? "not_activated" : candidate?.expiresAt !== undefined && candidate.expiresAt <= this.now() ? "calibration_expired" : config && candidate && candidate.policyHash !== reasoningRuntimePolicyHash(config) ? "policy_changed" : config && !liveReady ? "readiness_regression" : String(row.reason_code);
    return { version: "reasoning-runtime-canary-v1", scope: normalized, configured, active: valid, circuitOpen: Number(row?.circuit_open) === 1, reason, ...(candidate ? { calibration: candidate } : {}), recentDeliveries: delivery.delivered, harmfulFeedback: delivery.harmful };
  }

  recordDelivery(input: { id?: string; scope: string; calibrationId: string; status: "delivered" | "withheld" | "failed"; selectedCount: number; estimatedTokens: number; durationMs: number; reasonCode: "delivered" | "no_trigger" | "empty" | "budget" | "cadence" | "operation_failed" }): string {
    const id = input.id ?? `reasoning-delivery:${randomUUID()}`; this.db.prepare("INSERT INTO mnemora_reasoning_runtime_delivery_runs(id,scope,calibration_id,status,selected_count,estimated_tokens,duration_ms,reason_code,feedback,created_at) VALUES(?,?,?,?,?,?,?,?, 'unknown',?)").run(id, normalizeScope(input.scope), input.calibrationId, input.status, integer(input.selectedCount, 20), integer(input.estimatedTokens, 1600), integer(input.durationMs, 30000), input.reasonCode, this.now()); return id;
  }
  deliveries(scope: string, limit = 50): Array<Record<string, unknown>> { return this.db.prepare("SELECT id,scope,status,selected_count,estimated_tokens,duration_ms,reason_code,feedback,created_at,feedback_at FROM mnemora_reasoning_runtime_delivery_runs WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?").all(normalizeScope(scope), integer(limit, 100)) as Array<Record<string, unknown>>; }
  feedbackPreview(id: string, scope: string, feedback: "helpful" | "neutral" | "harmful"): { status: "not_found" } | { status: "preview"; preview_hash: string } { const row = this.db.prepare("SELECT id,scope,feedback FROM mnemora_reasoning_runtime_delivery_runs WHERE id=? AND scope=?").get(id, normalizeScope(scope)) as Record<string, unknown> | undefined; if (!row || row.feedback !== "unknown") return { status: "not_found" }; return { status: "preview", preview_hash: digest({ version: "reasoning-delivery-feedback-v1", id, scope: normalizeScope(scope), feedback }) }; }
  feedback(id: string, scope: string, feedback: "helpful" | "neutral" | "harmful", previewHash: string): { status: "not_found" | "stale_preview" } | { status: "confirmed"; circuitOpened: boolean } { const preview = this.feedbackPreview(id, scope, feedback); if (preview.status !== "preview") return preview; if (preview.preview_hash !== previewHash) return { status: "stale_preview" }; const normalized = normalizeScope(scope), now = this.now(), changed = this.db.prepare("UPDATE mnemora_reasoning_runtime_delivery_runs SET feedback=?,feedback_at=? WHERE id=? AND scope=? AND feedback='unknown'").run(feedback, now, id, normalized).changes; if (!changed) return { status: "not_found" }; if (feedback === "harmful") this.open(normalized, undefined, "harmful_feedback"); return { status: "confirmed", circuitOpened: feedback === "harmful" }; }

  private open(scope: string, calibrationId: string | undefined, reason: "calibration_missing" | "calibration_expired" | "policy_changed" | "readiness_regression" | "harmful_feedback"): { allowed: false; reason: string } { const now = this.now(); this.db.prepare("UPDATE mnemora_reasoning_runtime_canaries SET enabled=0,circuit_open=1,reason_code=?,updated_at=? WHERE scope=?").run(reason, now, scope); this.event(scope, calibrationId, "CIRCUIT_OPEN", reason, now); return { allowed: false, reason }; }
  private event(scope: string, calibrationId: string | undefined, action: "ACTIVATE" | "ROLLBACK" | "CIRCUIT_OPEN", reason: string, now: number): void { this.db.prepare("INSERT INTO mnemora_reasoning_runtime_canary_events(id,scope,calibration_id,action,reason_code,created_at) VALUES(?,?,?,?,?,?)").run(`reasoning-canary-event:${randomUUID()}`, scope, calibrationId ?? null, action, reason, now); }
  private deliveryMetrics(scope: string): { delivered: number; harmful: number } { const row = this.db.prepare("SELECT SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,SUM(CASE WHEN feedback='harmful' THEN 1 ELSE 0 END) AS harmful FROM mnemora_reasoning_runtime_delivery_runs WHERE scope=?").get(scope) as Record<string, unknown>; return { delivered: integer(row?.delivered, 1000000), harmful: integer(row?.harmful, 1000000) }; }
}

/** The only v5 delivery path. It renders a bounded host adapter sidecar and never mutates ReasoningMemory. */
export class ReasoningGovernedDeliveryService {
  private readonly shadow: ReasoningRuntimeShadowService; private readonly governance: ReasoningRuntimeGovernanceRepository; private readonly feedback: ReasoningDeliveryFeedbackRepository;
  constructor(db: DatabaseSyncInstance, private readonly config: ReasoningRuntimeGovernanceConfig, now: () => number = Date.now) { this.shadow = new ReasoningRuntimeShadowService(db, config, now); this.governance = new ReasoningRuntimeGovernanceRepository(db, now); this.feedback = new ReasoningDeliveryFeedbackRepository(db, now); }
  handle(input: ReasoningRuntimeTaskContext, options: { deliveryAllowed?: boolean } = {}): ReasoningDeliveryResult | undefined {
    const started = Date.now(), result = this.shadow.evaluate(input), authorization = this.governance.authorize(input.scope, this.config); if (!authorization.allowed) return undefined;
    if (!result) { this.governance.recordDelivery({ scope: input.scope, calibrationId: authorization.calibration.id, status: "failed", selectedCount: 0, estimatedTokens: 0, durationMs: Date.now() - started, reasonCode: "operation_failed" }); return undefined; }
    if (!result.decision.shouldRetrieve) { this.governance.recordDelivery({ scope: input.scope, calibrationId: authorization.calibration.id, status: "withheld", selectedCount: 0, estimatedTokens: 0, durationMs: Date.now() - started, reasonCode: "no_trigger" }); return undefined; }
    if (!result.context?.items.length) { this.governance.recordDelivery({ scope: input.scope, calibrationId: authorization.calibration.id, status: "withheld", selectedCount: 0, estimatedTokens: 0, durationMs: Date.now() - started, reasonCode: "empty" }); return undefined; }
    if (options.deliveryAllowed === false) { this.governance.recordDelivery({ scope: input.scope, calibrationId: authorization.calibration.id, status: "withheld", selectedCount: 0, estimatedTokens: 0, durationMs: Date.now() - started, reasonCode: "cadence" }); return undefined; }
    const planned = result.context.items.map(item => ({ id: `reasoning-delivery-item:${randomUUID()}`, memoryId: item.id }));
    const presentation = fitPresentation(result.context, this.config.tokenBudget, this.config.delivery.adapter, planned); if (!presentation) { this.governance.recordDelivery({ scope: input.scope, calibrationId: authorization.calibration.id, status: "withheld", selectedCount: 0, estimatedTokens: 0, durationMs: Date.now() - started, reasonCode: "budget" }); return undefined; }
    const deliveryRunId = `reasoning-delivery:${randomUUID()}`;
    this.governance.recordDelivery({ id: deliveryRunId, scope: input.scope, calibrationId: authorization.calibration.id, status: "delivered", selectedCount: presentation.items, estimatedTokens: presentation.tokens, durationMs: Date.now() - started, reasonCode: "delivered" });
    const items = this.feedback.createItems({ scope: input.scope, deliveryRunId, items: planned.slice(0, presentation.items), retentionDays: this.config.delivery.itemRetentionDays });
    return { appendSystemContext: presentation.content, deliveryRunId, deliveryItemRefs: items.map(item => item.ref) };
  }
}

export function reasoningRuntimePolicyHash(config: ReasoningRuntimeGovernanceConfig): string { return digest({ version: "reasoning-runtime-policy-v1", tokenBudget: config.tokenBudget, maxItems: config.maxItems, minConfidence: config.minConfidence, highRiskMinConfidence: config.highRiskMinConfidence, minEvidenceQuality: config.minEvidenceQuality, highRiskMinEvidenceQuality: config.highRiskMinEvidenceQuality, maxStalenessDays: config.maxStalenessDays, excludeConflicted: config.excludeConflicted, readiness: config.readiness, adapter: config.delivery.adapter, maxConsecutiveDeliveries: config.delivery.maxConsecutiveDeliveries, itemRetentionDays: config.delivery.itemRetentionDays }); }
function fitPresentation(context: CompiledReasoningContext, tokenBudget: number, adapter: "openclaw", planned: Array<{ id: string; memoryId: string }>): { content: string; tokens: number; items: number } | undefined { const registry = new ReasoningAgentAdapterRegistry(); for (let count = context.items.length; count > 0; count--) { const selected = context.items.slice(0, count).map((item, index) => ({ ...item, deliveryItemRef: planned[index] ? createMnemoraContextRef({ scope: context.scope, kind: "reasoning-delivery-item", id: planned[index].id }) : undefined })), rendered = registry.render(adapter, { ...context, items: selected, estimatedTokens: selected.reduce((sum, item) => sum + item.estimatedTokens, 0) }); if (rendered.estimatedTokens <= tokenBudget) return { content: rendered.content, tokens: rendered.estimatedTokens, items: selected.length }; } return undefined; }
function deliveryConfigured(scope: string, config: ReasoningDeliveryConfig): boolean { return config.enabled && config.scopes.length > 0 && config.scopes.includes(scope); }
function calibration(row: Record<string, unknown>): ReasoningRuntimeCalibration { return { id: String(row.id), scope: normalizeScope(row.scope), policyHash: String(row.policy_hash), status: row.status === "ready" ? "ready" : "rejected", createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), metrics: { runs: integer(row.total_runs, 5000), triggered: integer(row.triggered_runs, 5000), selected: integer(row.selected_count, 100000), emptyRate: unit(row.empty_rate), errorRate: unit(row.error_rate), p95Ms: integer(row.p95_ms, 30000) } }; }
function integer(value: unknown, maximum: number): number { const number = Number(value); return Number.isFinite(number) ? Math.min(maximum, Math.max(0, Math.trunc(number))) : 0; }
function unit(value: unknown): number { const number = Number(value); return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
