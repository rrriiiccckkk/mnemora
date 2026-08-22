export interface ReasoningQualityPolicy {
  minConfidence: number;
  highRiskMinConfidence: number;
  minEvidenceQuality: number;
  highRiskMinEvidenceQuality: number;
  maxStalenessDays: number;
  excludeConflicted: boolean;
}

export interface ReasoningQualityRecord {
  confidence: number;
  evidenceRefs: number;
  outcomeRefs: number;
  successCount: number;
  failureCount: number;
  updatedAt: number;
  hasOpenReflection: boolean;
}

export type ReasoningQualityExclusion = "confidence" | "evidence" | "staleness" | "conflict";
export interface ReasoningQualityDecision { allowed: boolean; evidenceQuality: number; reasons: string[]; excludedBy?: ReasoningQualityExclusion; }

/** Deterministic, local quality gate used only when a runtime explicitly opts in. */
export class ReasoningQualityPolicyService {
  constructor(private readonly policy: ReasoningQualityPolicy, private readonly now: () => number = Date.now) {}

  evaluate(record: ReasoningQualityRecord, riskLevel?: "low" | "medium" | "high"): ReasoningQualityDecision {
    const highRisk = riskLevel === "high";
    const confidenceFloor = highRisk ? Math.max(this.policy.minConfidence, this.policy.highRiskMinConfidence) : this.policy.minConfidence;
    const evidenceFloor = highRisk ? Math.max(this.policy.minEvidenceQuality, this.policy.highRiskMinEvidenceQuality) : this.policy.minEvidenceQuality;
    const evidenceQuality = Number(Math.min(1, .5 + .25 * Math.min(1, record.evidenceRefs / 2) + .25 * Math.min(1, record.outcomeRefs / 2)).toFixed(4));
    if (record.confidence < confidenceFloor) return { allowed: false, evidenceQuality, excludedBy: "confidence", reasons: [`confidence_below:${confidenceFloor.toFixed(3)}`] };
    if (evidenceQuality < evidenceFloor) return { allowed: false, evidenceQuality, excludedBy: "evidence", reasons: [`evidence_quality_below:${evidenceFloor.toFixed(3)}`] };
    const age = Math.max(0, this.now() - record.updatedAt), maxAge = this.policy.maxStalenessDays * 86_400_000;
    if (age > maxAge) return { allowed: false, evidenceQuality, excludedBy: "staleness", reasons: ["reasoning_memory_stale"] };
    if (this.policy.excludeConflicted && ((record.successCount > 0 && record.failureCount > 0) || record.hasOpenReflection)) return { allowed: false, evidenceQuality, excludedBy: "conflict", reasons: [record.hasOpenReflection ? "open_reflection_proposal" : "contrasting_outcomes"] };
    return { allowed: true, evidenceQuality, reasons: [`evidence_quality:${evidenceQuality.toFixed(3)}`, highRisk ? "high_risk_quality_gate" : "standard_quality_gate"] };
  }
}
