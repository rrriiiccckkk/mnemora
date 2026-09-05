import type { NodeType } from "../types.js";
import type { OperationRequest } from "../operations/types.js";

export interface OverviewRequest { kind: "overview"; }
export interface GraphFilters {
  community_id?: string;
  node_types?: NodeType[];
  sources?: string[];
  ids?: string[];
  confidence_min?: number;
  valid_from?: number;
  valid_to?: number;
}
export interface GraphPageRequest {
  kind: "graph";
  scope?: string;
  cursor?: string;
  limit?: number;
  max_nodes?: number;
  max_edges?: number;
  max_response_bytes?: number;
  deadline_ms?: number;
  filters?: GraphFilters;
}
export type EntityDetailSection = "aliases" | "evidence" | "relationships" | "timeline";
export interface EntityDetailRequest { kind: "entity"; id: string; scope?: string; section?: EntityDetailSection; cursor?: string; limit?: number; }
export interface ResearchPageRequest { kind: "research"; scope?: string; section?: "insights" | "watches" | "history" | "digests"; cursor?: string; limit?: number; }
export interface SourceAnchorPageRequest { kind: "sources"; scope?: string; cursor?: string; limit?: number; }
export interface HealthRequest { kind: "health"; }

export type InspectorReadRequest = OverviewRequest | GraphPageRequest | EntityDetailRequest | ResearchPageRequest | SourceAnchorPageRequest | HealthRequest;
export type InspectorRequest = InspectorReadRequest | OperationRequest;

/** Evidence is represented only by this bounded redacted projection. */
export interface RedactedEvidenceSummary {
  source: string;
  confidence: number;
  valid_from: number | null;
  valid_to: number | null;
  summary: string;
}
export type InspectorWarningCode = "malformed_row" | "truncated" | "deadline" | "cancelled" | "stale_cursor" | "unrepresentable_item";
export interface InspectorWarning { code: InspectorWarningCode; }
export interface InspectorGraphNode { id: string; name: string; type: NodeType; community_id: string | null; community_color: string | null; }
export interface InspectorGraphEdge { id: string; source_id: string; target_id: string; type: string; confidence: number; evidence: RedactedEvidenceSummary[]; }
export interface GraphPageResult {
  kind: "graph";
  nodes: InspectorGraphNode[];
  edges: InspectorGraphEdge[];
  next_cursor: string | null;
  graph_revision: number;
  truncated: boolean;
  warnings: InspectorWarning[];
}
export interface InspectorHealthSummary { status: "healthy" | "degraded" | "unavailable"; counts: { orphans: number; conflicts: number; duplicate_candidates: number }; }
export interface OverviewResult { kind: "overview"; graph_revision: number; nodes: number; edges: number; observations: number; health: InspectorHealthSummary; warnings: InspectorWarning[]; }
export interface InspectorEntityRelationship { id: string; direction: "in" | "out"; type: string; other_id: string; other_name: string; other_type: NodeType; confidence: number; evidence: RedactedEvidenceSummary[]; }
export interface InspectorTimelineItem { timestamp: number; kind: "observed" | "became_valid" | "became_invalid"; relationship_ids: string[]; evidence_count: number; source_count: number; }
export interface InspectorRankingFactors { importance: number; evidence_confidence: number; source_count: number; degree: number; unresolved_conflict: boolean; }
export interface EntityDetailResult { kind: "entity"; id: string; name: string; type: NodeType; aliases: string[]; evidence: RedactedEvidenceSummary[]; relationships: InspectorEntityRelationship[]; timeline: InspectorTimelineItem[]; ranking_factors: InspectorRankingFactors; next_cursor: string | null; graph_revision: number; truncated: boolean; warnings: InspectorWarning[]; }
export interface InspectorResearchItem { id: string; status: string; kind?: string; score?: number; name?: string; schedule_hint?: string; enabled?: boolean; graph_revision?: number; result_count?: number; duration_ms?: number; created_at?: number; started_at?: number; finished_at?: number | null; }
export interface ResearchPageResult { kind: "research"; section: "insights" | "watches" | "history" | "digests"; items: InspectorResearchItem[]; next_cursor: string | null; warnings: InspectorWarning[]; truncated: boolean; }
/** Bounded, redacted source/verification status; never includes snapshot text. */
export interface InspectorSourceAnchor { id: string; source: string; source_status: "available" | "missing" | "deleted" | "changed" | "legacy"; verification_status: "pending" | "verified" | "flagged" | "rejected" | "unverifiable" | "contradicted" | "stale" | "superseded"; snapshot_truncated: boolean; claim_count: number; captured_at: number; }
export interface SourceAnchorPageResult { kind: "sources"; items: InspectorSourceAnchor[]; next_cursor: string | null; warnings: InspectorWarning[]; truncated: boolean; }
export interface InspectorRecoveryHealth {
  status: "healthy" | "degraded" | "unavailable";
  artifacts: { backups: number; recovery_points: number; available: number; missing: number };
  latest_created_at: number | null;
  load_error?: "manifest_invalid" | "manifest_too_large";
}
export interface HealthResult { kind: "health"; graph_revision: number; status: "healthy" | "degraded" | "unavailable"; counts: { orphans: number; conflicts: number; duplicate_candidates: number }; recovery: InspectorRecoveryHealth; }
export type InspectorReadResult = OverviewResult | GraphPageResult | EntityDetailResult | ResearchPageResult | SourceAnchorPageResult | HealthResult;
