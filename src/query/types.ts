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
