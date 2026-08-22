import type { RelationshipType } from "../relationships.js";
import type { NodeType } from "../types.js";
import type { SearchMode } from "../index.js";
import type { KgSearchResult } from "../types.js";

export type ResearchErrorCode =
  | "COMPARE_SUBJECT_AMBIGUOUS"
  | "COMPARE_SUBJECT_NOT_FOUND"
  | "COMPARE_SAME_SUBJECT"
  | "COMPARE_LIMIT_EXCEEDED"
  | "QUERY_INVALID_PLAN"
  | "QUERY_PLANNER_UNAVAILABLE"
  | "QUERY_TIMEOUT"
  | "WATCH_INVALID_INPUT"
  | "DIGEST_ALREADY_RUNNING"
  | "IMPORT_INVALID"
  | "IMPORT_STALE"
  | "IMPORT_CONFIRMATION_REQUIRED"
  | "EXPORT_LIMIT"
  | "RESEARCH_OPERATION_FAILED";

export type ResearchErrorStage =
  | "input_validation"
  | "subject_resolution"
  | "planning"
  | "execution"
  | "persistence"
  | "serialization"
  | "authorization";

export type ResearchErrorName =
  | "ambiguous_subject"
  | "subject_not_found"
  | "same_subject"
  | "limit_exceeded"
  | "invalid_plan"
  | "planner_unavailable"
  | "timeout"
  | "invalid_input"
  | "already_running"
  | "invalid_import"
  | "stale_import"
  | "confirmation_required"
  | "export_limit"
  | "operation_failed";

export type ResearchErrorMatchReason = "id_exact" | "name_exact" | "alias_exact" | "prefix" | "lexical" | "semantic";
export interface ResearchErrorCandidate {
  readonly id: string;
  readonly name: string;
  readonly type: NodeType | "community";
  readonly aliases: readonly string[];
  readonly match_reason: ResearchErrorMatchReason;
}

export type ResearchErrorDetails =
  | { readonly side: "left" | "right"; readonly candidates: readonly ResearchErrorCandidate[]; readonly truncated: boolean }
  | { readonly limit: number }
  | Record<string, never>;

export interface ResearchErrorEnvelope {
  readonly error: ResearchErrorName;
  readonly error_code: ResearchErrorCode;
  readonly stage: ResearchErrorStage;
  readonly retryable: boolean;
  readonly summary: string;
  readonly details: ResearchErrorDetails;
}

export interface ResearchOperationErrorInput {
  readonly error_code: ResearchErrorCode;
  readonly retryable: boolean;
  readonly details: ResearchErrorDetails;
}

export type QueryDirection = "out" | "in" | "both";
export type QueryAggregate = "count" | "entities" | "relationships";
export type QueryStep =
  | { op: "lookup"; query: string; node_types?: NodeType[]; mode?: SearchMode }
  | { op: "traverse"; from: string[]; edge_types?: RelationshipType[]; direction: QueryDirection; depth: number }
  | { op: "filter"; node_types?: NodeType[]; confidence_min?: number; valid_from?: number; valid_to?: number }
  | { op: "aggregate"; by: "node_type" | "relationship_type" | "source"; metric: QueryAggregate };

export interface QueryPlanV1 {
  version: 1;
  steps: QueryStep[];
  order_by: "relevance" | "confidence" | "recency" | "name";
  limit: number;
}

export interface QueryExecutionResult {
  interpreted_plan: QueryPlanV1;
  graph_revision: number;
  entities: Array<{ id: string; name: string; type: NodeType; score: number }>;
  relationships: Array<{ id: string; source_id: string; target_id: string; type: RelationshipType; confidence: number; evidence_count: number; source_count: number }>;
  aggregates: Array<{ key: string; count: number }>;
  truncated: boolean;
  warnings: Array<{ category: string }>;
}

export interface KgQueryResult extends QueryExecutionResult {
  status: "ok" | "empty";
  plan_source: "provided" | "llm";
}

export type TimelineEventKind = "observed" | "became_valid" | "became_invalid";
export interface KgTimelineResult {
  subject: { id: string; name: string; type: NodeType };
  range: { from: number; to: number; inclusive: true };
  events: Array<{ id: string; timestamp: number; kind: TimelineEventKind; relationship_ids: string[]; observation_ids: string[]; evidence_count: number; source_count: number }>;
  temporal_note: string;
  graph_revision: number;
  truncated: boolean;
}

export interface KgCompareItem {
  entity_id: string; name: string; relationship_types: RelationshipType[];
  relationship_ids: string[]; evidence_count: number; source_count: number; average_confidence: number;
}
export interface KgCompareResult {
  subjects: Array<{ id: string; name: string; type: NodeType | "community"; member_count: number }>;
  shared: KgCompareItem[]; only_left: KgCompareItem[]; only_right: KgCompareItem[];
  graph_revision: number; truncated: boolean; warnings: Array<{ category: string }>;
}

export interface CompareCandidate {
  readonly id: string;
  readonly name: string;
  readonly type: NodeType | "community";
  readonly aliases: readonly string[];
  readonly match_reason: ResearchErrorMatchReason;
}

export interface ResolvedSubject {
  readonly id: string;
  readonly name: string;
  readonly type: NodeType | "community";
  readonly members: readonly string[];
}

export type CompareSearch = (input: string) => Promise<ReadonlyArray<Pick<KgSearchResult, "node" | "score_components">>>;

export type QueryAuditStepV1 =
  | { op: "lookup"; query_redacted: true; node_types?: NodeType[]; mode?: SearchMode }
  | { op: "traverse"; from_previous: boolean; explicit_entity_count: number; edge_types?: RelationshipType[]; direction: QueryDirection; depth: number }
  | { op: "filter"; node_types?: NodeType[]; confidence_min?: number; valid_from?: number; valid_to?: number }
  | { op: "aggregate"; by: "node_type" | "relationship_type" | "source"; metric: QueryAggregate };

/** Redacted structural metadata for audit display only. It is intentionally not executable as QueryPlanV1. */
export interface QueryAuditPlanV1 {
  kind: "query_audit_plan";
  version: 1;
  steps: QueryAuditStepV1[];
  order_by: QueryPlanV1["order_by"];
  limit: number;
}
