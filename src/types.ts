import type { Direction, RelationshipType } from "./relationships.js";
import type { EmbeddingIdentity } from "./embeddings.js";

export type {
  ResearchErrorCandidate,
  ResearchErrorCode,
  ResearchErrorDetails,
  ResearchErrorEnvelope,
  ResearchErrorMatchReason,
  ResearchErrorName,
  ResearchErrorStage,
  ResearchOperationErrorInput
} from "./query/types.js";

export interface IngestionConfig { maxPayloadBytes: number; maxBatchItems: number; allowedFileExtensions: string[]; urlMaxPayloadBytes: number; urlTimeoutMs: number; urlMaxRedirects: number }
export interface QueryConfig {
  maxSteps?: number; maxDepth?: number; maxResults?: number;
  maxNodes?: number; maxEdges?: number; timeoutMs?: number;
  maxResponseBytes?: number; auditRetentionDays?: number;
  maxWatches?: number; maxDigestWatches?: number;
  maxImportBytes?: number; maxImportRecords?: number;
}
export interface KgQueryInput { question?: string; plan?: unknown; scope?: string }
export interface KgTimelineInput { subject: string; from?: number; to?: number; limit?: number; scope?: string }
export interface KgCompareInput { left: string; right: string; max_depth?: number; confidence_min?: number; valid_from?: number; valid_to?: number; limit?: number; as_of?: number; max_response_bytes?: number; scope?: string }
export type KgWatchInput =
  | { operation: "create"; id?: string; name: string; question?: string; plan: unknown; schedule_hint: "manual" | "daily" | "weekly"; enabled?: boolean; scope?: string }
  | { operation: "list"; limit?: number; scope?: string }
  | { operation: "inspect" | "enable" | "disable" | "delete"; id: string }
  | { operation: "update"; id: string; name?: string; plan?: unknown; schedule_hint?: "manual" | "daily" | "weekly"; enabled?: boolean; scope?: string };
export interface KgDigestInput { idempotency_key: string; watch_ids?: string[]; since?: number; limit?: number; scope?: string }
export interface KgExportInput { format: "jsonl" | "csv" | "graphml"; max_bytes?: number; max_records?: number }
export interface KgImportInput { format: "jsonl"; data: string; preview_hash?: string; confirm?: boolean }
export interface KgQueryHistoryInput { limit?: number; scope?: string }
export interface IngestionItem { text: string; source?: string; scope?: string; metadata?: Record<string, string | number | boolean | null>; force?: boolean; sourceRef?: import("./trust/types.js").ExternalSourceRef }
export type IngestionErrorCategory = "invalid_input" | "unsupported_file" | "file_too_large" | "workspace_boundary" | "extraction_disabled" | "extraction_failed" | "persistence_failed" | import("./url-ingestion.js").SafeUrlErrorCategory;
export interface IngestionWarning { category: "embedding_failed" | "candidate_discovery_failed" | "conflict_discovery_failed" | "source_anchoring_failed" | "pre_admission_dropped"; count?: number }
export interface IngestionItemResult {
  status: "succeeded" | "skipped_duplicate" | "failed";
  source: string; fingerprint: string;
  counts: { entities: number; relations: number; observations: number };
  warnings: IngestionWarning[];
  error?: { category: IngestionErrorCategory; summary: string };
}
export interface BatchIngestionResult { processed: number; succeeded: number; skipped: number; failed: number; items: Array<IngestionItemResult & { index: number }>; next_cursor: number | null }

export type NodeType =
  | "person"
  | "company"
  | "product"
  | "technology"
  | "concept"
  | "industry"
  | "fund"
  | "policy"
  | "portfolio";

export interface KgNode {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  aliases: string[];
  importance: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface StoredEmbedding extends EmbeddingIdentity {
  input_version: string;
  embedded_at: number;
  vector: number[];
}

export interface KgEdge {
  id: string;
  source_id: string;
  target_id: string;
  type: RelationshipType;
  edge_props: Record<string, unknown>;
  weight: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface KgObservation {
  id: string;
  edge_id: string | null;
  source_entity_id: string | null;
  payload: Record<string, unknown>;
  source: string;
  scope: string;
  quote: string;
  confidence: number;
  valid_from: number | null;
  valid_to: number | null;
  temporal_confidence: number | null;
  created_at: number;
}

export interface ExtractedEntity {
  name: string;
  type: NodeType;
  description?: string;
  aliases?: string[];
  confidence: number;
  evidence_span: string;
  valid_from?: string | number | null;
  valid_to?: string | number | null;
  temporal_confidence?: number | null;
}

export interface ExtractedRelation {
  source: string;
  target: string;
  type: RelationshipType;
  confidence: number;
  evidence_span: string;
  edge_props?: Record<string, unknown>;
  valid_from?: string | number | null;
  valid_to?: string | number | null;
  temporal_confidence?: number | null;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  suggested_duplicates?: Array<{ entity_a: string; entity_b: string; reason: string; confidence: number }>;
}

export type AutoRunClaim =
  | { status: "claimed"; attempt: number }
  | { status: "busy" }
  | { status: "succeeded" };
export type AutoRunFinishStatus = "succeeded" | "failed";

export interface EvidenceSummary {
  /** Stable internal claim identity; additive for callers that need provenance-aware filtering. */
  observation_id?: string;
  source: string;
  quote: string;
  confidence: number;
  valid_from: number | null;
  valid_to: number | null;
  temporal_confidence: number | null;
  created_at: number;
}

export interface KgSearchResult {
  node: KgNode;
  score: number;
  evidence: EvidenceSummary[];
  score_components?: { semantic: number; lexical: number; confidence: number; freshness: number };
  rank_components?: { semantic: number; lexical: number; confidence: number; recency: number; source_diversity: number; ppr: number };
  penalties?: { conflict: number; hub: number };
}

export interface RankedNode { node: KgNode; score: number }

export interface QualityEvidenceSummary {
  source_count: number;
  confidence: number;
  reference_time: number | null;
  unresolved_conflict: boolean;
  degree: number;
}

export type DuplicateCandidateStatus = "pending" | "ignored" | "rejected" | "merged";
export interface DuplicateSignal { kind: string; score: number; detail: string }
export interface DuplicateCandidate {
  id: string;
  pair_key: string;
  entity_a: string;
  entity_b: string;
  signals: DuplicateSignal[];
  reasons: string[];
  score: number;
  fingerprint_a: string;
  fingerprint_b: string;
  status: DuplicateCandidateStatus;
  discovered_at: number;
  updated_at: number;
  reviewed_at: number | null;
}

export interface DuplicateScanResult {
  processed: number;
  created: number;
  updated: number;
  next_after_id?: string;
  complete: boolean;
}

export type ConflictCandidateStatus = "pending" | "ignored" | "rejected" | "invalid";
export interface ConflictCandidate {
  id: string;
  /** Conflicts are discovered and reviewed only within this evidence scope. */
  scope: string;
  pair_key: string;
  edge_a: string;
  edge_b: string;
  observation_a: string;
  observation_b: string;
  category: "overlapping_single_valued_facts";
  overlap_from: number | null;
  overlap_to: number | null;
  confidence_a: number;
  confidence_b: number;
  source_count_a: number;
  source_count_b: number;
  fingerprint_a: string;
  fingerprint_b: string;
  preview_hash: string;
  status: ConflictCandidateStatus;
  discovered_at: number;
  updated_at: number;
  reviewed_at: number | null;
}

export interface RelationshipAnomaly {
  edge: KgEdge;
  reason: "self_loop" | "invalid_endpoint_types" | "below_edge_confidence";
  evidence: EvidenceSummary[];
}

/** A non-admitted extractor proposal whose endpoints do not match the current
 * domain dictionary. It is visible to review but never participates in graph
 * traversal, ranking, or automatic recall. */
export interface SchemaDriftCandidate {
  id: string;
  scope: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  source_type: string;
  target_type: string;
  expected_source_types: string;
  expected_target_types: string;
  /** Present only when a bounded audit found an already-admitted legacy edge. */
  legacy_edge_id?: string;
  occurrence_count: number;
  first_seen_at: number;
  updated_at: number;
}

export interface SchemaDriftScanResult {
  scanned: number;
  candidates_created: number;
  candidates_updated: number;
  next_edge_id?: string;
}

/** Aggregate-only, human-reviewed proposal to add a pattern to a soft domain
 * vocabulary. It never changes topology or an existing fact by itself. */
export interface SemanticPatternCandidate {
  id: string;
  scope: string;
  domain: "investment" | "code" | "unknown";
  source_type: string;
  predicate: string;
  target_type: string;
  occurrence_count: number;
  status: "pending" | "accepted" | "rejected";
  first_seen_at: number;
  updated_at: number;
  reviewed_at: number | null;
}

export interface SemanticPatternReviewResult {
  confirmed: boolean;
  candidate_id: string;
  decision: "accepted" | "rejected";
  preview_hash: string;
  eligible: boolean;
  reason?: "missing_candidate" | "already_reviewed";
  audit_id?: string;
}

export interface SchemaDriftRepairResult {
  confirmed: boolean;
  candidate_id: string;
  replacement_type: RelationshipType;
  preview_hash: string;
  eligible: boolean;
  reason?: "missing_candidate" | "missing_endpoint" | "missing_scope_evidence" | "invalid_payload" | "legacy_edge_changed" | "already_repaired" | "already_rejected" | "endpoint_now_allowed";
  edge_id?: string;
  observation_id?: string;
  audit_id?: string;
  /** An existing invalid edge is retired only by its matching confirmation. */
  retired_edge_id?: string;
}

export interface QualityCleanupResult {
  confirmed: boolean;
  preview_hash: string;
  cleaned: number;
  edge_ids: string[];
  audit_id?: string;
}

export interface MergeResult {
  confirmed: boolean;
  preview_hash: string;
  canonical_entity_id: string;
  duplicate_entity_id: string;
  moved_observations: number;
  rewired_edges: number;
  deduplicated_edges: number;
  removed_self_loops: number;
  audit_id?: string;
}

export interface MergeUndoResult {
  confirmed: boolean;
  preview_hash: string;
  audit_id: string;
  conflicts: Array<{ kind: string; id: string; reason: string }>;
  restored_nodes: number;
  restored_edges: number;
  restored_observations: number;
}

export interface RelatedEdgeResult {
  edge: KgEdge;
  source: KgNode;
  target: KgNode;
  traversal_direction: Exclude<Direction, "both">;
  evidence: EvidenceSummary[];
}

/** A domain label is evidence-backed, but not a graph-topology arc. */
export interface RelatedSemanticLabelResult {
  id: string;
  /** An explicit built-in predicate or operator-approved neutral label. */
  predicate: string;
  domain: "investment" | "code" | "neutral" | "unknown";
  source: KgNode;
  target: KgNode;
  evidence: EvidenceSummary[];
  /** Schema v59 projects historic semantic edges without rewriting them. */
  legacy: boolean;
  endpoint_match: boolean;
  /** Derived selection score; it never changes the source evidence confidence. */
  score: number;
}

export interface KgRelatedResult {
  root: KgNode;
  nodes: KgNode[];
  edges: RelatedEdgeResult[];
  semantic_labels: RelatedSemanticLabelResult[];
}

export interface KgStatsResult {
  nodes: { total: number; by_type: Record<string, number> };
  edges: { total: number; by_type: Record<string, number>; by_layer: { structural: number; semantic: number } };
  observations: { total: number };
  density: number;
  updated_at: number | null;
  /** Mnemora's public projection adds local provider health; Store totals stay usable alone. */
  embedding_health?: import("./embedding-health/repository.js").EmbeddingHealthStatus;
}

export interface KgContextResult {
  query: string;
  context: string;
  nodes: KgSearchResult[];
  edges: RelatedEdgeResult[];
  semantic_labels: RelatedSemanticLabelResult[];
  sources: KgSourceSummary[];
  memories?: KgMemorySearchResult[];
  truncated: boolean;
}

export interface KgMemoryDocument {
  id: string;
  scope: string;
  title: string;
  content: string;
  source: string;
  metadata: Record<string, string | number | boolean | null>;
  content_hash: string;
  lifecycle_state: "active" | "archived";
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export type MemoryLifecycleAction = "archive" | "recover" | "delete";

/** Redacted, preview-first lifecycle action for one local memory document. */
export interface KgMemoryLifecyclePreview {
  confirmed: false;
  action: MemoryLifecycleAction;
  preview_hash: string;
  document: { id: string; scope: string; title: string; lifecycle_state: "active" | "archived"; content_hash: string; updated_at: number };
  affected_chunks: number;
}

export interface KgMemoryLifecycleConfirm {
  confirmed: true;
  action: MemoryLifecycleAction;
  document_id: string;
  scope: string;
  audit_id: string;
}

export interface KgMemoryExpiryReview {
  items: Array<{ id: string; scope: string; title: string; updated_at: number; age_days: number }>;
  next_after_id: string | null;
  truncated: boolean;
}

/** Deliberately excludes memory content and source strings. */
export interface KgMemoryLifecycleAudit {
  id: string;
  document_id: string;
  scope: string;
  action: MemoryLifecycleAction;
  from_state: "active" | "archived";
  to_state: "active" | "archived" | "deleted";
  content_hash: string;
  created_at: number;
}

export interface LegacyIdentityAuditCandidate {
  entity_id: string;
  type: NodeType;
  name: string;
  name_truncated?: true;
  legacy_id: string;
  expected_id: string;
  reason: "legacy_id_matches_pre_v1_0_1_algorithm";
}

export interface LegacyIdentityAuditResult {
  items: LegacyIdentityAuditCandidate[];
  scanned: number;
  next_after_id: string | null;
  truncated: boolean;
}

export interface KgMemoryChunk {
  id: string;
  document_id: string;
  document_title?: string;
  scope: string;
  ordinal: number;
  content: string;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

export interface KgMemorySearchResult {
  id: string;
  scope: string;
  title: string;
  excerpt: string;
  source: string;
  /** Scalar metadata is included so opt-in local tag filtering remains auditable. */
  metadata?: Record<string, string | number | boolean | null>;
  score: number;
  score_components?: { lexical: number; semantic: number };
  /** Present when a high-confidence lexical hit raised its hybrid score above the weighted blend. */
  lexical_preservation_score?: number;
  /** Present only when an explicitly enabled remote reranker supplied the final score. */
  rerank_score?: number;
  /** Present only when optional Weibull freshness decay adjusted the final score. */
  freshness_score?: number;
  /** Present only when a confirmed recall-feedback record adjusted salience. */
  feedback_score?: number;
  /** Non-destructive retrieval-tier projection, emitted only when enabled. */
  memory_tier?: "core" | "working" | "peripheral";
  memory_access_count?: number;
  memory_expires_at?: number;
  memory_expiry_reason?: string;
  created_at: number;
  updated_at: number;
}

export interface KgScopeSummary {
  id: string;
  observations: number;
  memory_documents: number;
  updated_at: number;
}

/**
 * Bounded, aggregate-only scope discovery. It intentionally contains no
 * entity, evidence, memory, or source text from any scope.
 */
export interface KgScopesResult {
  default_scope: string;
  scopes: KgScopeSummary[];
}

export interface KgSourceSummary {
  source: string;
  observations: number;
  average_confidence: number;
  first_seen_at: number;
  last_seen_at: number;
}

export interface KgForgetResult {
  entity_id: string;
  hard: boolean;
  deleted_nodes: number;
  deleted_edges: number;
  deleted_observations: number;
  /** Optional-index cleanup never affects the canonical SQLite deletion. */
  vector_index_cleanup?: "removed" | "deferred" | "not_indexed";
}

export type InsightKind = "knowledge_gap" | "emerging_topic" | "cross_community_path";

export interface CommunitySummary {
  id: string;
  entity_ids: string[];
  size: number;
  internal_edge_count: number;
  density: number;
  average_confidence: number;
  evidence_coverage: number;
  source_concentration: number;
  recent_growth: number;
  bridge_score: number;
}

export interface KgInsightsInput {
  kind?: "all" | InsightKind;
  limit?: number;
  communityId?: string;
  explain?: "auto" | boolean;
  refresh?: boolean;
  scope?: string;
}

export interface KgInsight {
  id: string;
  kind: InsightKind;
  score: number;
  community_ids: string[];
  entity_ids: string[];
  relationship_ids: string[];
  reason: "isolated" | "weak_evidence" | "source_concentration" | "rapid_growth" | "bridge_path";
  signals: Record<string, number>;
  path?: { entity_ids: string[]; edge_ids: string[] };
  explanation?: string;
}

export interface KgInsightsResult {
  status: "ok" | "empty" | "unavailable";
  graph_revision: number;
  algorithm_version: string;
  cache_hit: boolean;
  truncated: boolean;
  communities: CommunitySummary[];
  insights: KgInsight[];
  warnings: Array<{ category: string; detector?: InsightKind }>;
}
