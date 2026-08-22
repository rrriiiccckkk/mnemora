import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import { selectAdaptiveRecallCandidates, type AdaptiveRecallShadowConfig, type RecallShadowCandidate } from "./adaptive-recall.js";

export interface AdaptiveRecallCanaryConfig {
  enabled: boolean;
  modelId: string;
  scopes: string[];
}

export interface RecallCalibrationCriteria {
  minimum_runs?: number;
  max_empty_rate?: number;
  min_overlap_rate?: number;
}

export interface RecallCalibrationSummary {
  total_runs: number;
  empty_runs: number;
  empty_rate: number;
  mean_overlap_rate: number;
}

export interface RecallCalibration {
  id: string;
  scope: string;
  model_id: string;
  policy_version: "adaptive-relative-v1";
  criteria: Required<RecallCalibrationCriteria>;
  summary: RecallCalibrationSummary;
  status: "ready" | "rejected";
  created_at: number;
}

export interface RecallCanaryStatus {
  scope: string;
  configured: boolean;
  active: boolean;
  calibration?: RecallCalibration;
  recent_runs: number;
}

type CalibrationPreview = { calibration: Omit<RecallCalibration, "id" | "created_at">; preview_hash: string; };

/** Owns redacted calibration/canary rows only. It persists no queries, prompts, entity ids, or evidence. */
export class RecallCanaryRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  evaluate(scope: string, modelId: string, criteria: RecallCalibrationCriteria): CalibrationPreview {
    const normalizedScope = normalizeScope(scope), model = modelIdentity(modelId), normalizedCriteria = normalizeCriteria(criteria);
    const rows = this.db.prepare(`SELECT candidate_count,adaptive_count,overlap_count,empty
      FROM kg_recall_shadow_runs WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT 10000`).all(normalizedScope) as Array<Record<string, unknown>>;
    const totalRuns = rows.length;
    const emptyRuns = rows.filter(row => row.empty === 1).length;
    const overlapSamples = rows.filter(row => boundedInteger(row.adaptive_count, 0, 50) > 0);
    const meanOverlap = overlapSamples.length === 0 ? 0 : roundedUnit(overlapSamples.reduce((sum, row) => sum + boundedInteger(row.overlap_count, 0, 50) / boundedInteger(row.adaptive_count, 1, 50), 0) / overlapSamples.length);
    const summary: RecallCalibrationSummary = {
      total_runs: totalRuns, empty_runs: emptyRuns,
      empty_rate: totalRuns === 0 ? 0 : roundedUnit(emptyRuns / totalRuns), mean_overlap_rate: meanOverlap
    };
    const calibration = {
      scope: normalizedScope, model_id: model, policy_version: "adaptive-relative-v1" as const, criteria: normalizedCriteria, summary,
      status: totalRuns >= normalizedCriteria.minimum_runs && summary.empty_rate <= normalizedCriteria.max_empty_rate && summary.mean_overlap_rate >= normalizedCriteria.min_overlap_rate ? "ready" as const : "rejected" as const
    };
    return { calibration, preview_hash: hash({ version: "recall-calibration-v1", ...calibration }) };
  }

  create(preview: CalibrationPreview, now: number): RecallCalibration {
    const id = `recall-calibration:${randomUUID()}`;
    this.db.prepare(`INSERT INTO kg_recall_calibrations(
      id,scope,model_id,policy_version,minimum_runs,max_empty_rate,min_overlap_rate,total_runs,empty_runs,empty_rate,mean_overlap_rate,status,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, preview.calibration.scope, preview.calibration.model_id, preview.calibration.policy_version,
      preview.calibration.criteria.minimum_runs, preview.calibration.criteria.max_empty_rate, preview.calibration.criteria.min_overlap_rate,
      preview.calibration.summary.total_runs, preview.calibration.summary.empty_runs, preview.calibration.summary.empty_rate,
      preview.calibration.summary.mean_overlap_rate, preview.calibration.status, now
    );
    return { id, ...preview.calibration, created_at: now };
  }

  getCalibration(id: string): RecallCalibration | undefined {
    const row = this.db.prepare(`SELECT id,scope,model_id,policy_version,minimum_runs,max_empty_rate,min_overlap_rate,total_runs,empty_runs,empty_rate,mean_overlap_rate,status,created_at
      FROM kg_recall_calibrations WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    return row ? calibration(row)[0] : undefined;
  }

  listCalibrations(scope: string, limit = 20): RecallCalibration[] {
    const rows = this.db.prepare(`SELECT id,scope,model_id,policy_version,minimum_runs,max_empty_rate,min_overlap_rate,total_runs,empty_runs,empty_rate,mean_overlap_rate,status,created_at
      FROM kg_recall_calibrations WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(normalizeScope(scope), boundedInteger(limit, 1, 100)) as Array<Record<string, unknown>>;
    return rows.flatMap(calibration);
  }

  active(scope: string): RecallCalibration | undefined {
    const row = this.db.prepare(`SELECT c.id,c.scope,c.model_id,c.policy_version,c.minimum_runs,c.max_empty_rate,c.min_overlap_rate,c.total_runs,c.empty_runs,c.empty_rate,c.mean_overlap_rate,c.status,c.created_at
      FROM kg_recall_canaries a JOIN kg_recall_calibrations c ON c.id=a.calibration_id
      WHERE a.scope=? AND a.enabled=1`).get(normalizeScope(scope)) as Record<string, unknown> | undefined;
    return row ? calibration(row)[0] : undefined;
  }

  activate(scope: string, calibrationId: string, now: number): void {
    this.db.prepare(`INSERT INTO kg_recall_canaries(scope,calibration_id,enabled,created_at,updated_at)
      VALUES(?,?,1,?,?) ON CONFLICT(scope) DO UPDATE SET calibration_id=excluded.calibration_id,enabled=1,updated_at=excluded.updated_at`)
      .run(normalizeScope(scope), calibrationId, now, now);
  }

  rollback(scope: string, now: number): void {
    this.db.prepare("UPDATE kg_recall_canaries SET enabled=0,updated_at=? WHERE scope=?").run(now, normalizeScope(scope));
  }

  record(scope: string, calibrationId: string, baselineCount: number, adaptiveCount: number, fallback: boolean, now: number): void {
    this.db.prepare(`INSERT INTO kg_recall_canary_runs(id,scope,calibration_id,baseline_count,adaptive_count,fallback,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(`recall-canary:${randomUUID()}`, normalizeScope(scope), calibrationId, boundedInteger(baselineCount, 0, 50), boundedInteger(adaptiveCount, 0, 50), fallback ? 1 : 0, now);
    this.db.exec(`DELETE FROM kg_recall_canary_runs WHERE id NOT IN (
      SELECT id FROM kg_recall_canary_runs ORDER BY created_at DESC,id DESC LIMIT 10000
    )`);
  }

  recentRuns(scope: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM kg_recall_canary_runs WHERE scope=?").get(normalizeScope(scope)) as { total?: unknown };
    return boundedInteger(row?.total, 0, 10000);
  }
}

/** Enforces configuration, calibration and persisted scope activation before any adaptive context can be injected. */
export class AdaptiveRecallCanaryService {
  constructor(
    private readonly repository: RecallCanaryRepository,
    private readonly shadowConfig: AdaptiveRecallShadowConfig,
    private readonly config: AdaptiveRecallCanaryConfig,
    private readonly now: () => number = Date.now
  ) {}

  get configured(): boolean { return this.config.enabled; }

  status(scope: string): RecallCanaryStatus {
    const normalizedScope = normalizeScope(scope), active = this.enabledCalibration(normalizedScope);
    return { scope: normalizedScope, configured: this.config.enabled && scopeAllowed(normalizedScope, this.config.scopes), active: active != null, ...(active ? { calibration: active } : {}), recent_runs: this.repository.recentRuns(normalizedScope) };
  }

  evaluate(scope: string, criteria: RecallCalibrationCriteria = {}): CalibrationPreview { return this.repository.evaluate(scope, this.config.modelId, criteria); }

  calibrate(scope: string, criteria: RecallCalibrationCriteria, previewHash?: string): { status: "stale_preview"; preview: CalibrationPreview } | { status: "confirmed"; calibration: RecallCalibration } {
    const preview = this.evaluate(scope, criteria);
    if (preview.preview_hash !== previewHash) return { status: "stale_preview", preview };
    return { status: "confirmed", calibration: this.repository.create(preview, this.now()) };
  }

  enable(scope: string, calibrationId: string, previewHash?: string): { status: "not_ready" | "stale_preview"; preview?: string } | { status: "confirmed"; calibration: RecallCalibration } {
    const normalizedScope = normalizeScope(scope), calibration = this.repository.getCalibration(calibrationId);
    if (!calibration || calibration.scope !== normalizedScope || calibration.model_id !== this.config.modelId || calibration.status !== "ready") return { status: "not_ready" };
    const preview = hash({ version: "recall-canary-enable-v1", scope: normalizedScope, calibration_id: calibration.id, configured: this.config.enabled, scope_allowed: scopeAllowed(normalizedScope, this.config.scopes) });
    if (preview !== previewHash) return { status: "stale_preview", preview };
    if (!this.config.enabled || !scopeAllowed(normalizedScope, this.config.scopes)) return { status: "not_ready" };
    this.repository.activate(normalizedScope, calibration.id, this.now());
    return { status: "confirmed", calibration };
  }

  rollback(scope: string): RecallCanaryStatus {
    const normalizedScope = normalizeScope(scope);
    this.repository.rollback(normalizedScope, this.now());
    return this.status(normalizedScope);
  }

  apply(scope: string, candidates: readonly RecallShadowCandidate[], baseline: readonly RecallShadowCandidate[], limit: number, options: { record?: boolean } = {}): { applied: boolean; selected: RecallShadowCandidate[] } {
    const normalizedScope = normalizeScope(scope), calibration = this.enabledCalibration(normalizedScope);
    if (!calibration) return { applied: false, selected: [...baseline] };
    const selected = selectAdaptiveRecallCandidates({ candidates, limit, config: this.shadowConfig });
    const fallback = selected.length === 0 && baseline.length > 0;
    const result = fallback ? [...baseline] : selected;
    if (options.record !== false) this.repository.record(normalizedScope, calibration.id, baseline.length, result.length, fallback, this.now());
    return { applied: true, selected: result };
  }

  private enabledCalibration(scope: string): RecallCalibration | undefined {
    if (!this.config.enabled || !scopeAllowed(scope, this.config.scopes)) return undefined;
    const calibration = this.repository.active(scope);
    return calibration?.model_id === this.config.modelId && calibration.status === "ready" ? calibration : undefined;
  }
}

function calibration(value: Record<string, unknown>): RecallCalibration[] {
  const id = text(value.id, 200), scope = safeScope(value.scope), modelId = modelIdentity(value.model_id);
  const status = value.status === "ready" || value.status === "rejected" ? value.status : undefined;
  if (!id || !scope || value.policy_version !== "adaptive-relative-v1" || !status) return [];
  return [{ id, scope, model_id: modelId, policy_version: "adaptive-relative-v1", criteria: normalizeCriteria({ minimum_runs: value.minimum_runs, max_empty_rate: value.max_empty_rate, min_overlap_rate: value.min_overlap_rate }), summary: {
    total_runs: boundedInteger(value.total_runs, 0, 10000), empty_runs: boundedInteger(value.empty_runs, 0, 10000), empty_rate: unit(value.empty_rate, 0), mean_overlap_rate: unit(value.mean_overlap_rate, 0)
  }, status, created_at: boundedInteger(value.created_at, 0, Number.MAX_SAFE_INTEGER) }];
}
function normalizeCriteria(input: { minimum_runs?: unknown; max_empty_rate?: unknown; min_overlap_rate?: unknown }): Required<RecallCalibrationCriteria> { return { minimum_runs: Math.max(1, boundedInteger(input.minimum_runs, 25, 10000)), max_empty_rate: unit(input.max_empty_rate, .2), min_overlap_rate: unit(input.min_overlap_rate, .7) }; }
function modelIdentity(value: unknown): string { const textValue = text(value, 120); return textValue ?? "default"; }
function scopeAllowed(scope: string, scopes: string[]): boolean { return scopes.length === 0 || scopes.includes(scope); }
function safeScope(value: unknown): string | undefined { try { return normalizeScope(value); } catch { return undefined; } }
function text(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value) ? value : undefined; }
function boundedInteger(value: unknown, fallback: number, maximum: number): number { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.trunc(number))) : fallback; }
function unit(value: unknown, fallback: number): number { const number = Number(value); return Number.isFinite(number) ? roundedUnit(number) : fallback; }
function roundedUnit(value: number): number { return Math.round(Math.max(0, Math.min(1, value)) * 1e6) / 1e6; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
