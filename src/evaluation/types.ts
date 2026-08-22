export const PERSONAL_MEMORY_EVALUATION_VERSION = 1 as const;

export type EvaluationCaseKind =
  | "simple_find"
  | "complex_search"
  | "source_recovery"
  | "long_session_recall"
  | "empty_recall"
  | "scope_isolation";

/**
 * A labelled retrieval lane for a like-for-like operator evaluation.  The
 * label is aggregate-only: reports never include the query or document text.
 */
export type EvaluationCohort = "explicit" | "auto_extract";

export interface EvaluationCase {
  id: string;
  kind: EvaluationCaseKind;
  scope: string;
  query: string;
  expectedRefs: string[];
  forbiddenRefs?: string[];
  topK?: number;
  cohort?: EvaluationCohort;
}

export interface EvaluationDataset {
  version: typeof PERSONAL_MEMORY_EVALUATION_VERSION;
  id: string;
  description?: string;
  seed?: number;
  cases: EvaluationCase[];
}

export interface EvaluationRetrievalRequest {
  query: string;
  scope: string;
  limit: number;
  signal: AbortSignal;
}

export interface EvaluationCandidate {
  contextRef: string;
  score?: number;
  sourceRecovered?: boolean;
  estimatedTokens?: number;
  bytes?: number;
}

export interface EvaluationRetrievalResult {
  candidates: EvaluationCandidate[];
  /** A search planner may correctly choose zero subqueries. */
  plannedQueries?: number;
}

export interface EvaluationSubject {
  find(request: EvaluationRetrievalRequest): Promise<EvaluationRetrievalResult>;
  search?(request: EvaluationRetrievalRequest): Promise<EvaluationRetrievalResult>;
}

export type EvaluationFailureCategory = "aborted" | "deadline" | "provider" | "invalid_response";
export type EvaluationFallbackCategory = "search_unavailable" | "search_deadline" | "search_provider" | "search_invalid_response";
export type EvaluationRoute = "find" | "search" | "find_fallback";

/** Privacy-safe per-case output: no query, content, scope, path, or Provider body. */
export interface EvaluationCaseResult {
  caseId: string;
  kind: EvaluationCaseKind;
  cohort?: EvaluationCohort;
  route: EvaluationRoute;
  status: "succeeded" | "failed";
  fallbackCategory?: EvaluationFallbackCategory;
  failureCategory?: EvaluationFailureCategory;
  latencyMs: number;
  expected: number;
  returned: number;
  relevantReturned: number;
  /** Rank-bounded counts used for the release recall/precision curve. */
  relevantAt: { k3: number; k5: number; k10: number };
  returnedAt: { k3: number; k5: number; k10: number };
  irrelevantReturned: number;
  forbiddenReturned: number;
  invalidReferences: number;
  crossScopeReturned: number;
  firstRelevantRank: number | null;
  sourceRecovered: boolean;
  selectedTokens: number;
  selectedBytes: number;
}

export interface EvaluationMetrics {
  cases: number;
  succeeded: number;
  failed: number;
  fallbackRate: number;
  recallAtK: number;
  precisionAtK: number;
  recallCurve: { k3: number; k5: number; k10: number };
  precisionCurve: { k3: number; k5: number; k10: number };
  meanReciprocalRank: number;
  emptyRecallPrecision: number;
  irrelevantInjectionRate: number;
  sourceRecoveryRate: number;
  scopeLeakageRate: number;
  latencyMs: { p50: number; p95: number; p99: number };
  selectedTokens: { average: number; maximum: number };
  selectedBytes: { average: number; maximum: number };
}

/** Reproducible, privacy-safe report suitable for JSON persistence. */
export interface EvaluationReport {
  version: typeof PERSONAL_MEMORY_EVALUATION_VERSION;
  dataset: { id: string; version: typeof PERSONAL_MEMORY_EVALUATION_VERSION; seed: number | null };
  configuration: { caseLimit: number; candidateLimit: number; operationTimeoutMs: number; deadlineMs: number };
  startedAt: number;
  completedAt: number;
  results: EvaluationCaseResult[];
  metrics: EvaluationMetrics;
  /** Present only when the submitted data explicitly labels both lanes. */
  cohorts?: Partial<Record<EvaluationCohort, EvaluationMetrics>>;
}

export interface EvaluationRunOptions {
  caseLimit?: number;
  candidateLimit?: number;
  operationTimeoutMs?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}
