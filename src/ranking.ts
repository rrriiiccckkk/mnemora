import { recencyScore } from "./temporal.js";

export interface RankingWeights { semantic: number; lexical: number; confidence: number; recency: number; source_diversity: number; ppr: number }
export interface QualityRankingCandidate {
  id: string; semantic: number; lexical: number; confidence: number; reference_time: number | null;
  source_count: number; ppr: number; unresolved_conflict: boolean; degree: number; exactLexical?: boolean;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = { semantic: .35, lexical: .20, confidence: .15, recency: .10, source_diversity: .05, ppr: .15 };

/** Applies source trust only to a derived ranking signal; stored fact confidence remains immutable. */
export function sourceTrustConfidence(confidence: number, trustWeight: number): number {
  return finiteClamp(finiteClamp(confidence) * Math.min(2, Math.max(0, finite(trustWeight))));
}

export function sourceDiversityScore(count: number): number {
  return finiteClamp(Math.log1p(Math.max(0, Math.trunc(finite(count)))) / Math.log1p(5));
}

export function hubPenalty(degree: number, p95: number, floor = .6): number {
  if (!Number.isFinite(degree) || !Number.isFinite(p95) || p95 <= 0 || degree <= p95) return 1;
  const boundedFloor = finiteClamp(floor);
  return Math.max(boundedFloor, 1 - (boundedFloor === 1 ? 0 : (degree - p95) / p95 * (1 - boundedFloor)));
}

export function normalizeRankingWeights(input?: Partial<RankingWeights>): RankingWeights {
  if (!input) return { ...DEFAULT_RANKING_WEIGHTS };
  const complete = { ...DEFAULT_RANKING_WEIGHTS, ...input };
  const values = Object.values(complete);
  if (values.some(value => !Number.isFinite(value) || value < 0)) return { ...DEFAULT_RANKING_WEIGHTS };
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return { ...DEFAULT_RANKING_WEIGHTS };
  return Object.fromEntries(Object.entries(complete).map(([key, value]) => [key, value / total])) as unknown as RankingWeights;
}

export function rankQualityCandidates(input: {
  candidates: QualityRankingCandidate[]; weights?: Partial<RankingWeights>; now?: number; halfLifeDays?: number;
  conflictFactor?: number; hubFloor?: number; degreeP95?: number; limit?: number;
}) {
  const weights = normalizeRankingWeights(input.weights);
  const now = Number.isFinite(input.now) ? input.now! : Date.now();
  const halfLifeDays = Number.isFinite(input.halfLifeDays) && input.halfLifeDays! > 0 ? input.halfLifeDays! : 90;
  const conflictFactor = finiteClamp(input.conflictFactor ?? .75);
  const hubFloor = finiteClamp(input.hubFloor ?? .6);
  const degreeP95 = finite(input.degreeP95 ?? 0);
  const ranked = input.candidates.map(candidate => {
    const components = {
      semantic: finiteClamp(candidate.semantic), lexical: finiteClamp(candidate.lexical), confidence: finiteClamp(candidate.confidence),
      recency: recencyScore({ reference_time: Number.isFinite(candidate.reference_time) ? candidate.reference_time : null }, now, halfLifeDays),
      source_diversity: sourceDiversityScore(candidate.source_count), ppr: finiteClamp(candidate.ppr)
    };
    const penalties = { conflict: candidate.unresolved_conflict ? conflictFactor : 1, hub: hubPenalty(candidate.degree, degreeP95, hubFloor) };
    const weighted = Object.entries(weights).reduce((sum, [key, weight]) => sum + components[key as keyof typeof components] * weight, 0);
    const protectedFloor = candidate.exactLexical ? weights.lexical : 0;
    return { id: candidate.id, score: finiteClamp(Math.max(protectedFloor, weighted * penalties.conflict * penalties.hub)), components, penalties, exactLexical: candidate.exactLexical === true };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (input.limit == null) return ranked;
  const limit = Math.max(0, Math.trunc(input.limit));
  const exact = ranked.filter(item => item.exactLexical).slice(0, limit);
  const selected = [...exact, ...ranked.filter(item => !item.exactLexical).slice(0, Math.max(0, limit - exact.length))];
  return selected.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function finite(value: number): number { return Number.isFinite(value) ? value : 0; }
function finiteClamp(value: number): number { return Math.min(1, Math.max(0, finite(value))); }
