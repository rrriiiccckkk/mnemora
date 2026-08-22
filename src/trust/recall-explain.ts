import { createHash } from "node:crypto";
import type { KgContextResult, KgSearchResult, RelatedEdgeResult } from "../types.js";
import { normalizeScope } from "../scope.js";
import { VerificationRepository, type RecallClaimVerificationTrace } from "./verification.js";
import type { RecallPolicyDecision } from "./recall-policy.js";

export interface RecallExplainResult {
  trace_version: "recall-explain-v1";
  query_hash: string;
  scope: string;
  automatic_recall_configured: boolean;
  strict_verification_enabled: boolean;
  policy: Pick<RecallPolicyDecision, "allowed" | "evaluated_sources" | "excluded_sources" | "reason">;
  candidates: RecallExplainCandidate[];
  memories: Array<{ id: string; score: number; decision: "included" }>;
  truncated: boolean;
}

export interface RecallExplainCandidate {
  kind: "node" | "edge";
  id: string;
  score?: number;
  score_components?: { lexical: number; semantic: number; confidence?: number; freshness?: number };
  claim_ids: string[];
  decision: "included" | "excluded";
  reason: "verification_disabled" | "verified_evidence" | "unverified_evidence" | "no_claim_evidence";
  pending_conflict: boolean;
  claims: RecallClaimVerificationTrace[];
}

/**
 * Builds a bounded, redacted explanation of the normal automatic-recall
 * policy. It reads only existing context and trust rows and never writes
 * recall metrics, canary runs, claim counters, or profile state.
 */
export class RecallExplanationService {
  constructor(private readonly verification: VerificationRepository, private readonly strictVerificationEnabled: boolean, private readonly automaticRecallConfigured: boolean) {}

  explain(context: KgContextResult, scope: string, policy: Omit<RecallPolicyDecision, "context">): RecallExplainResult {
    const normalizedScope = normalizeScope(scope);
    const items = [
      ...context.nodes.map(item => candidate("node", item.node.id, item, this.strictVerificationEnabled)),
      ...context.edges.map(item => candidate("edge", item.edge.id, item, this.strictVerificationEnabled))
    ].slice(0, 40);
    const claimIds = [...new Set(items.flatMap(item => item.claim_ids))].slice(0, 200);
    const traces = this.verification.recallTrace(normalizedScope, claimIds);
    for (const item of items) {
      item.claims = item.claim_ids.flatMap(id => traces.get(id) ?? []);
      item.pending_conflict = item.claims.some(trace => trace.pending_conflict);
      if (this.strictVerificationEnabled) {
        const permitted = item.claims.some(trace => trace.eligible);
        item.decision = permitted ? "included" : "excluded";
        item.reason = item.claim_ids.length === 0 ? "no_claim_evidence" : permitted ? "verified_evidence" : "unverified_evidence";
      }
    }
    const memories = (context.memories ?? []).slice(0, 10).map(memory => ({ id: memory.id, score: boundedScore(memory.score), decision: "included" as const }));
    return {
      trace_version: "recall-explain-v1",
      query_hash: createHash("sha256").update(context.query).digest("hex"),
      scope: normalizedScope,
      automatic_recall_configured: this.automaticRecallConfigured,
      strict_verification_enabled: this.strictVerificationEnabled,
      policy: { allowed: policy.allowed, evaluated_sources: policy.evaluated_sources, excluded_sources: policy.excluded_sources, reason: policy.reason },
      candidates: items,
      memories,
      truncated: context.truncated || context.nodes.length + context.edges.length > items.length
    };
  }
}

function candidate(kind: "node", id: string, item: KgSearchResult, strict: boolean): RecallExplainCandidate;
function candidate(kind: "edge", id: string, item: RelatedEdgeResult, strict: boolean): RecallExplainCandidate;
function candidate(kind: "node" | "edge", id: string, item: KgSearchResult | RelatedEdgeResult, strict: boolean): RecallExplainCandidate {
  const claimIds = [...new Set(item.evidence.map(evidence => evidence.observation_id).filter((value): value is string => typeof value === "string" && value.length > 0))].slice(0, 8);
  const scoreItem = kind === "node" ? item as KgSearchResult : undefined;
  return {
    kind, id, ...(scoreItem ? { score: boundedScore(scoreItem.score), ...(scoreItem.score_components ? { score_components: scoreComponents(scoreItem.score_components) } : {}) } : {}),
    claim_ids: claimIds,
    decision: strict ? "excluded" : "included",
    reason: strict ? claimIds.length ? "unverified_evidence" : "no_claim_evidence" : "verification_disabled",
    pending_conflict: false,
    claims: []
  };
}

function scoreComponents(value: NonNullable<KgSearchResult["score_components"]>): RecallExplainCandidate["score_components"] {
  return {
    lexical: boundedScore(value.lexical), semantic: boundedScore(value.semantic),
    ...(value.confidence === undefined ? {} : { confidence: boundedScore(value.confidence) }),
    ...(value.freshness === undefined ? {} : { freshness: boundedScore(value.freshness) })
  };
}
function boundedScore(value: unknown): number { const score = Number(value); return Number.isFinite(score) ? Math.max(0, Math.min(1, Math.round(score * 1e6) / 1e6)) : 0; }
