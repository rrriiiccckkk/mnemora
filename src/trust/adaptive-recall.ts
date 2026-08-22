import { randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";

export interface AdaptiveRecallShadowConfig {
  shadowMode: boolean;
  absoluteFloor: number;
  relativeCutoffRatio: number;
  confidenceGate: number;
  minKeep: number;
  candidateMultiplier: number;
}

export interface RecallShadowCandidate { id: string; score: number; }

export interface RecallShadowMetric {
  id: string;
  scope: string;
  policy_version: "adaptive-relative-v1";
  candidate_count: number;
  fixed_count: number;
  adaptive_count: number;
  overlap_count: number;
  empty: boolean;
  top_scores: number[];
  absolute_floor: number;
  relative_floor: number;
  created_at: number;
}

export interface RecallShadowMetricsPage {
  items: RecallShadowMetric[];
  summary: { total_runs: number; empty_runs: number; empty_rate: number };
}

interface ComputedShadowMetric extends Omit<RecallShadowMetric, "id" | "scope" | "created_at"> {}

/**
 * Computes a deterministic proposed cutoff over already-ranked Mnemora candidates.
 * Candidate IDs participate only in the in-memory overlap calculation and are
 * deliberately never persisted with the metric.
 */
export function evaluateAdaptiveRecallShadow(input: {
  candidates: readonly RecallShadowCandidate[];
  fixed: readonly RecallShadowCandidate[];
  limit: number;
  config: AdaptiveRecallShadowConfig;
}): ComputedShadowMetric {
  const limit = boundedInteger(input.limit, 0, 50);
  const config = normalizeShadowConfig(input.config);
  const candidates = normalizedCandidates(input.candidates);
  const fixed = new Set(input.fixed.filter(item => validId(item.id)).map(item => item.id));
  const topScores = candidates.slice(0, 3).map(item => item.score);
  const anchor = topScores.length ? topScores.reduce((sum, score) => sum + score, 0) / topScores.length : 0;
  const relativeFloor = roundedUnit(Math.max(config.absoluteFloor, anchor * config.relativeCutoffRatio));
  const adaptive = selectAdaptiveRecallCandidates({ candidates, limit, config });
  return {
    policy_version: "adaptive-relative-v1",
    candidate_count: candidates.length,
    fixed_count: fixed.size,
    adaptive_count: adaptive.length,
    overlap_count: adaptive.filter(item => fixed.has(item.id)).length,
    empty: candidates.length === 0,
    top_scores: topScores,
    absolute_floor: config.absoluteFloor,
    relative_floor: relativeFloor
  };
}

/** Deterministic candidate selection shared by redacted evaluation and the guarded canary path. */
export function selectAdaptiveRecallCandidates(input: {
  candidates: readonly RecallShadowCandidate[];
  limit: number;
  config: AdaptiveRecallShadowConfig;
}): RecallShadowCandidate[] {
  const candidates = normalizedCandidates(input.candidates), config = normalizeShadowConfig(input.config);
  const limit = boundedInteger(input.limit, 0, 50);
  const topScores = candidates.slice(0, 3).map(item => item.score);
  const anchor = topScores.length ? topScores.reduce((sum, score) => sum + score, 0) / topScores.length : 0;
  const relativeFloor = roundedUnit(Math.max(config.absoluteFloor, anchor * config.relativeCutoffRatio));
  const eligible = candidates.filter(item => item.score >= config.absoluteFloor);
  let adaptive = eligible.filter(item => item.score >= relativeFloor);
  if (adaptive.length < config.minKeep && candidates[0]?.score >= config.confidenceGate) adaptive = eligible.slice(0, config.minKeep);
  return adaptive.slice(0, limit);
}

/** Owns bounded, redacted shadow metrics; it has no graph or Provider behavior. */
export class RecallShadowRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  record(scope: string, metric: ComputedShadowMetric, createdAt: number): void {
    const normalizedScope = normalizeScope(scope);
    const id = `recall-shadow:${randomUUID()}`;
    const topScores = JSON.stringify(metric.top_scores.slice(0, 3));
    this.db.prepare(`INSERT INTO kg_recall_shadow_runs(
      id,scope,policy_version,candidate_count,fixed_count,adaptive_count,overlap_count,empty,top_scores,absolute_floor,relative_floor,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, normalizedScope, metric.policy_version, metric.candidate_count, metric.fixed_count, metric.adaptive_count,
      metric.overlap_count, metric.empty ? 1 : 0, topScores, metric.absolute_floor, metric.relative_floor, createdAt
    );
    // Bound storage even when an operator leaves shadow mode on indefinitely.
    this.db.exec(`DELETE FROM kg_recall_shadow_runs WHERE id NOT IN (
      SELECT id FROM kg_recall_shadow_runs ORDER BY created_at DESC,id DESC LIMIT 10000
    )`);
  }

  list(scope: string, limit = 20): RecallShadowMetricsPage {
    const normalizedScope = normalizeScope(scope), bounded = boundedInteger(limit, 1, 100);
    const rows = this.db.prepare(`SELECT id,scope,policy_version,candidate_count,fixed_count,adaptive_count,overlap_count,empty,top_scores,absolute_floor,relative_floor,created_at
      FROM kg_recall_shadow_runs WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(normalizedScope, bounded) as Array<Record<string, unknown>>;
    const totals = this.db.prepare(`SELECT COUNT(*) AS total_runs,SUM(empty) AS empty_runs FROM kg_recall_shadow_runs WHERE scope=?`).get(normalizedScope) as Record<string, unknown>;
    const totalRuns = boundedInteger(totals.total_runs, 0, 10000), emptyRuns = boundedInteger(totals.empty_runs, 0, totalRuns);
    return {
      items: rows.flatMap(row => metric(row)),
      summary: { total_runs: totalRuns, empty_runs: emptyRuns, empty_rate: totalRuns === 0 ? 0 : Math.round(emptyRuns / totalRuns * 1e6) / 1e6 }
    };
  }
}

/** Shadow-only policy. Its failures are handled by the caller so recall stays fail-open. */
export class AdaptiveRecallShadowService {
  private readonly config: AdaptiveRecallShadowConfig;

  constructor(private readonly repository: RecallShadowRepository, config: AdaptiveRecallShadowConfig, private readonly now: () => number = Date.now) {
    this.config = normalizeShadowConfig(config);
  }

  get enabled(): boolean { return this.config.shadowMode; }

  candidateLimit(fixedLimit: number): number {
    const bounded = boundedInteger(fixedLimit, 0, 50);
    return bounded === 0 ? 0 : Math.min(50, Math.max(bounded, bounded * this.config.candidateMultiplier));
  }

  observe(scope: string, candidates: readonly RecallShadowCandidate[], fixed: readonly RecallShadowCandidate[], limit: number): void {
    if (!this.enabled) return;
    this.repository.record(scope, evaluateAdaptiveRecallShadow({ candidates, fixed, limit, config: this.config }), this.now());
  }

  list(scope: string, limit?: number): RecallShadowMetricsPage { return this.repository.list(scope, limit); }
}

function normalizeShadowConfig(input: AdaptiveRecallShadowConfig): AdaptiveRecallShadowConfig {
  return {
    shadowMode: input.shadowMode === true,
    absoluteFloor: unit(input.absoluteFloor, 0),
    relativeCutoffRatio: unit(input.relativeCutoffRatio, .6),
    confidenceGate: unit(input.confidenceGate, .6),
    minKeep: boundedInteger(input.minKeep, 0, 10),
    candidateMultiplier: boundedInteger(input.candidateMultiplier, 1, 10)
  };
}
function normalizedCandidates(items: readonly RecallShadowCandidate[]): RecallShadowCandidate[] {
  return items.filter(item => validId(item.id) && Number.isFinite(item.score))
    .map(item => ({ id: item.id, score: roundedUnit(item.score) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 50);
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value); }
function boundedInteger(value: unknown, minimum: number, maximum: number): number { const number = Number(value); return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.trunc(number))) : minimum; }
function unit(value: unknown, fallback: number): number { const number = Number(value); return Number.isFinite(number) ? roundedUnit(number) : fallback; }
function roundedUnit(value: number): number { return Math.round(Math.max(0, Math.min(1, value)) * 1e6) / 1e6; }
function metric(value: Record<string, unknown>): RecallShadowMetric[] {
  if (typeof value.id !== "string" || typeof value.scope !== "string" || value.policy_version !== "adaptive-relative-v1") return [];
  const topScores = parseScores(value.top_scores);
  const createdAt = boundedInteger(value.created_at, 0, Number.MAX_SAFE_INTEGER);
  if (!createdAt) return [];
  return [{
    id: value.id, scope: value.scope, policy_version: "adaptive-relative-v1",
    candidate_count: boundedInteger(value.candidate_count, 0, 50), fixed_count: boundedInteger(value.fixed_count, 0, 50),
    adaptive_count: boundedInteger(value.adaptive_count, 0, 50), overlap_count: boundedInteger(value.overlap_count, 0, 50),
    empty: value.empty === 1, top_scores: topScores, absolute_floor: unit(value.absolute_floor, 0),
    relative_floor: unit(value.relative_floor, 0), created_at: createdAt
  }];
}
function parseScores(value: unknown): number[] {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : []; return Array.isArray(parsed) ? parsed.filter(score => typeof score === "number" && Number.isFinite(score)).slice(0, 3).map(roundedUnit) : []; }
  catch { return []; }
}
