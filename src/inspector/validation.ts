import { INSPECTOR_HARD_LIMITS, normalizeOperationsConfig, type ArtifactReference, type InspectorOperation, type MaintenancePayload, type OperationAffectedCounts, type OperationRequest, type OperationResult, type OperationsConfig, type RestorePayload, type SourceTrustPayload } from "../operations/types.js";
import type { NodeType } from "../types.js";
import type { EntityDetailRequest, EntityDetailResult, GraphFilters, GraphPageRequest, GraphPageResult, HealthResult, InspectorGraphEdge, InspectorGraphNode, InspectorReadResult, InspectorRequest, InspectorSourceAnchor, InspectorWarning, OverviewResult, RedactedEvidenceSummary, ResearchPageRequest, ResearchPageResult, SourceAnchorPageRequest, SourceAnchorPageResult } from "./types.js";

const nodeTypes = new Set<NodeType>(["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"]);
const operations = new Set<InspectorOperation>(["source_trust", "backup", "restore", "orphan_cleanup", "weight_recompute"]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const nonNegativeSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positiveSafeInteger = (value: unknown): value is number => nonNegativeSafeInteger(value) && value > 0;
const boundedString = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const invalid = (): never => { throw new Error("invalid inspector request"); };
const invalidResult = (): never => { throw new Error("invalid inspector result"); };
const invalidOperationResult = (): never => { throw new Error("invalid operation result"); };
const optionalInteger = (value: unknown, maximum: number): number | undefined => {
  if (value === undefined) return undefined;
  return nonNegativeSafeInteger(value) && value <= maximum ? value : invalid();
};
const optionalPositive = (value: unknown, maximum: number): number | undefined => {
  if (value === undefined) return undefined;
  return positiveSafeInteger(value) && value <= maximum ? value : invalid();
};
const optionalCursor = (value: unknown): string | undefined => value === undefined ? undefined : typeof value === "string" && /^[A-Za-z0-9._~-]{1,512}$/.test(value) ? value : invalid();
const optionalScope = (value: unknown): string | undefined => value === undefined ? undefined : typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,79}$/.test(value) ? value : invalid();
const present = <T extends object>(object: T, key: string, value: unknown) => value === undefined ? object : { ...object, [key]: value };

function normalizeFilters(value: unknown): GraphFilters | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnly(value, ["community_id", "node_types", "sources", "ids", "confidence_min", "valid_from", "valid_to"])) return invalid();
  if (value.community_id !== undefined && !boundedString(value.community_id, 200)) return invalid();
  if (value.node_types !== undefined && (!Array.isArray(value.node_types) || value.node_types.length > 9 || !value.node_types.every(type => nodeTypes.has(type as NodeType)))) return invalid();
  if (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.length > 20 || !value.sources.every(source => boundedString(source, 200)))) return invalid();
  if (value.ids !== undefined && (!Array.isArray(value.ids) || value.ids.length > 100 || !value.ids.every(id => boundedString(id, 200)))) return invalid();
  if (value.confidence_min !== undefined && (typeof value.confidence_min !== "number" || !Number.isFinite(value.confidence_min) || value.confidence_min < 0 || value.confidence_min > 1)) return invalid();
  const validFrom = optionalInteger(value.valid_from, Number.MAX_SAFE_INTEGER);
  const validTo = optionalInteger(value.valid_to, Number.MAX_SAFE_INTEGER);
  if (validFrom !== undefined && validTo !== undefined && validFrom > validTo) return invalid();
  return {
    ...(value.community_id === undefined ? {} : { community_id: value.community_id }), ...(value.node_types === undefined ? {} : { node_types: [...value.node_types] as NodeType[] }),
    ...(value.sources === undefined ? {} : { sources: [...value.sources] as string[] }),
    ...(value.ids === undefined ? {} : { ids: [...value.ids] as string[] }),
    ...(value.confidence_min === undefined ? {} : { confidence_min: value.confidence_min }),
    ...(validFrom === undefined ? {} : { valid_from: validFrom }),
    ...(validTo === undefined ? {} : { valid_to: validTo })
  };
}

function normalizeGraph(value: Record<string, unknown>, limits: OperationsConfig): GraphPageRequest {
  if (!hasOnly(value, ["kind", "scope", "cursor", "limit", "max_nodes", "max_edges", "max_response_bytes", "deadline_ms", "filters"])) return invalid();
  const scope = optionalScope(value.scope);
  const cursor = optionalCursor(value.cursor);
  const limit = optionalPositive(value.limit, limits.maxGraphNodes);
  const maxNodes = optionalPositive(value.max_nodes, limits.maxGraphNodes);
  const maxEdges = optionalPositive(value.max_edges, limits.maxGraphEdges);
  const maxResponseBytes = optionalPositive(value.max_response_bytes, limits.maxGraphResponseBytes);
  const deadlineMs = optionalPositive(value.deadline_ms, limits.graphDeadlineMs);
  const filters = normalizeFilters(value.filters);
  return {
    kind: "graph", ...present({}, "scope", scope), ...present({}, "cursor", cursor), ...present({}, "limit", limit),
    ...present({}, "max_nodes", maxNodes), ...present({}, "max_edges", maxEdges), ...present({}, "max_response_bytes", maxResponseBytes), ...present({}, "deadline_ms", deadlineMs), ...present({}, "filters", filters)
  };
}

function normalizeEntity(value: Record<string, unknown>): EntityDetailRequest {
  if (!hasOnly(value, ["kind", "id", "scope", "section", "cursor", "limit"]) || !boundedString(value.id, 200) || (value.section !== undefined && !["aliases", "evidence", "relationships", "timeline"].includes(value.section as string))) return invalid();
  const scope = optionalScope(value.scope);
  const cursor = optionalCursor(value.cursor);
  const limit = optionalPositive(value.limit, 100);
  return { kind: "entity", id: value.id, ...present({}, "scope", scope), ...(value.section === undefined ? {} : { section: value.section as EntityDetailRequest["section"] }), ...present({}, "cursor", cursor), ...present({}, "limit", limit) };
}

function normalizeResearch(value: Record<string, unknown>): ResearchPageRequest {
  if (!hasOnly(value, ["kind", "scope", "section", "cursor", "limit"]) || (value.section !== undefined && !["insights", "watches", "history", "digests"].includes(value.section as string))) return invalid();
  const scope = optionalScope(value.scope);
  const cursor = optionalCursor(value.cursor);
  const limit = optionalPositive(value.limit, 100);
  return { kind: "research", ...present({}, "scope", scope), ...(value.section === undefined ? {} : { section: value.section as ResearchPageRequest["section"] }), ...present({}, "cursor", cursor), ...present({}, "limit", limit) };
}

function normalizeSources(value: Record<string, unknown>): SourceAnchorPageRequest {
  if (!hasOnly(value, ["kind", "scope", "cursor", "limit"])) return invalid();
  const scope = optionalScope(value.scope);
  const cursor = optionalCursor(value.cursor);
  const limit = optionalPositive(value.limit, 100);
  return { kind: "sources", ...present({}, "scope", scope), ...present({}, "cursor", cursor), ...present({}, "limit", limit) };
}

function normalizePayload(operation: InspectorOperation, value: unknown): SourceTrustPayload | RestorePayload | MaintenancePayload | Record<string, never> {
  if (!isRecord(value)) return invalid();
  if (operation === "source_trust") {
    if (!hasOnly(value, ["source", "weight"]) || !boundedString(value.source, 200) || typeof value.weight !== "number" || !Number.isFinite(value.weight) || value.weight < 0 || value.weight > 2) return invalid();
    return { source: value.source, weight: value.weight };
  }
  if (operation === "restore") {
    if (!hasOnly(value, ["artifact_id"]) || !boundedString(value.artifact_id, 160) || !value.artifact_id.startsWith("artifact:")) return invalid();
    return { artifact_id: value.artifact_id };
  }
  if (operation === "backup") {
    if (!hasOnly(value, [])) return invalid();
    return {};
  }
  if (!hasOnly(value, ["limit"])) return invalid();
  const limit = optionalPositive(value.limit, 1000);
  return limit === undefined ? {} : { limit };
}

function normalizeOperation(value: Record<string, unknown>): OperationRequest {
  if (typeof value.operation !== "string" || !operations.has(value.operation as InspectorOperation) || (value.phase !== "preview" && value.phase !== "confirm")) return invalid();
  const operation = value.operation as InspectorOperation;
  const payload = normalizePayload(operation, value.payload);
  if (!nonNegativeSafeInteger(value.graph_revision)) return invalid();
  const sourceTrust = operation === "source_trust";
  if (sourceTrust && !nonNegativeSafeInteger(value.config_revision)) return invalid();
  if (value.phase === "preview") {
    if (!hasOnly(value, sourceTrust ? ["operation", "phase", "graph_revision", "config_revision", "payload"] : ["operation", "phase", "graph_revision", "payload"])) return invalid();
    return sourceTrust
      ? { operation, phase: "preview", graph_revision: value.graph_revision, config_revision: value.config_revision as number, payload: payload as SourceTrustPayload }
      : { operation: operation as Exclude<InspectorOperation, "source_trust">, phase: "preview", graph_revision: value.graph_revision, payload } as OperationRequest;
  }
  if (!hasOnly(value, sourceTrust ? ["operation", "phase", "preview_token", "payload_hash", "graph_revision", "config_revision", "payload"] : ["operation", "phase", "preview_token", "payload_hash", "graph_revision", "payload"])) return invalid();
  if (!boundedString(value.preview_token, 256) || typeof value.payload_hash !== "string" || !/^[a-f0-9]{64}$/i.test(value.payload_hash)) return invalid();
  return sourceTrust
    ? { operation, phase: "confirm", preview_token: value.preview_token, payload_hash: value.payload_hash, graph_revision: value.graph_revision, config_revision: value.config_revision as number, payload: payload as SourceTrustPayload }
    : { operation: operation as Exclude<InspectorOperation, "source_trust">, phase: "confirm", preview_token: value.preview_token, payload_hash: value.payload_hash, graph_revision: value.graph_revision, payload } as OperationRequest;
}

/** Validates every Inspector HTTP/service boundary independently of TypeBox. */
export function normalizeInspectorRequest(value: unknown, configuredLimits: Partial<OperationsConfig> = {}): InspectorRequest {
  const limits = normalizeOperationsConfig(configuredLimits);
  if (!isRecord(value)) return invalid();
  if (typeof value.kind === "string") {
    if (value.kind === "overview" && hasOnly(value, ["kind"])) return { kind: "overview" };
    if (value.kind === "health" && hasOnly(value, ["kind"])) return { kind: "health" };
    if (value.kind === "graph") return normalizeGraph(value, limits);
    if (value.kind === "entity") return normalizeEntity(value);
    if (value.kind === "research") return normalizeResearch(value);
    if (value.kind === "sources") return normalizeSources(value);
    return invalid();
  }
  return normalizeOperation(value);
}

const safeCount = (value: unknown): value is number => nonNegativeSafeInteger(value);
const nullableSafeInteger = (value: unknown): value is number | null => value === null || nonNegativeSafeInteger(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const boundedResultString = (value: unknown, maximum: number): value is string => boundedString(value, maximum) && !/[\u0000-\u001f]/.test(value);
const resultHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const opaqueArtifactId = (value: unknown): value is string => typeof value === "string" && /^artifact:[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(value);
const opaqueAuditId = (value: unknown): value is string => typeof value === "string" && /^audit:[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(value);

function resultBytes<T>(value: T, maximum: number, fail: () => never): T {
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= maximum ? value : fail();
}

function normalizeEvidenceResult(value: unknown): RedactedEvidenceSummary {
  if (!isRecord(value) || !hasOnly(value, ["source", "confidence", "valid_from", "valid_to", "summary"]) || !boundedResultString(value.source, 200) || !finite(value.confidence) || value.confidence < 0 || value.confidence > 1 || !nullableSafeInteger(value.valid_from) || !nullableSafeInteger(value.valid_to) || (typeof value.valid_from === "number" && typeof value.valid_to === "number" && value.valid_from > value.valid_to) || !boundedResultString(value.summary, 500)) return invalidResult();
  return { source: value.source, confidence: value.confidence, valid_from: value.valid_from, valid_to: value.valid_to, summary: value.summary };
}

function normalizeGraphNodeResult(value: unknown): InspectorGraphNode {
  if (!isRecord(value) || !hasOnly(value, ["id", "name", "type", "community_id", "community_color"]) || !boundedResultString(value.id, 200) || !boundedResultString(value.name, 200) || !nodeTypes.has(value.type as NodeType) || (value.community_id !== null && !boundedResultString(value.community_id, 200)) || (value.community_color !== null && (typeof value.community_color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.community_color)))) return invalidResult();
  return { id: value.id, name: value.name, type: value.type as NodeType, community_id: value.community_id as string | null, community_color: value.community_color as string | null };
}

function normalizeGraphEdgeResult(value: unknown): InspectorGraphEdge {
  if (!isRecord(value) || !hasOnly(value, ["id", "source_id", "target_id", "type", "confidence", "evidence"]) || !boundedResultString(value.id, 200) || !boundedResultString(value.source_id, 200) || !boundedResultString(value.target_id, 200) || !boundedResultString(value.type, 100) || !finite(value.confidence) || value.confidence < 0 || value.confidence > 1 || !Array.isArray(value.evidence) || value.evidence.length > 20) return invalidResult();
  return { id: value.id, source_id: value.source_id, target_id: value.target_id, type: value.type, confidence: value.confidence, evidence: value.evidence.map(normalizeEvidenceResult) };
}
function normalizeWarnings(value: unknown): InspectorWarning[] {
  if (!Array.isArray(value) || value.length > 20) return invalidResult();
  return value.map(item => {
    if (!isRecord(item) || !hasOnly(item, ["code"]) || !["malformed_row", "truncated", "deadline", "cancelled", "stale_cursor", "unrepresentable_item"].includes(item.code as string)) return invalidResult();
    return { code: item.code as InspectorWarning["code"] };
  });
}

/** Validates public Inspector read results before they cross a service or HTTP boundary. */
export function normalizeInspectorResult(value: unknown, configuredLimits: Partial<OperationsConfig> = {}): InspectorReadResult {
  const limits = normalizeOperationsConfig(configuredLimits);
  if (!isRecord(value) || typeof value.kind !== "string") return invalidResult();
  if (value.kind === "overview") {
    if (!hasOnly(value, ["kind", "graph_revision", "nodes", "edges", "observations", "health", "warnings"]) || !safeCount(value.graph_revision) || !safeCount(value.nodes) || !safeCount(value.edges) || !safeCount(value.observations) || !isRecord(value.health) || !hasOnly(value.health, ["status", "counts"]) || !["healthy", "degraded", "unavailable"].includes(value.health.status as string) || !isRecord(value.health.counts) || !hasOnly(value.health.counts, ["orphans", "conflicts", "duplicate_candidates"]) || !safeCount(value.health.counts.orphans) || !safeCount(value.health.counts.conflicts) || !safeCount(value.health.counts.duplicate_candidates)) return invalidResult();
    return resultBytes({ kind: "overview", graph_revision: value.graph_revision, nodes: value.nodes, edges: value.edges, observations: value.observations, health: { status: value.health.status as OverviewResult["health"]["status"], counts: { orphans: value.health.counts.orphans, conflicts: value.health.counts.conflicts, duplicate_candidates: value.health.counts.duplicate_candidates } }, warnings: normalizeWarnings(value.warnings) } satisfies OverviewResult, limits.maxGraphResponseBytes, invalidResult);
  }
  if (value.kind === "graph") {
    if (!hasOnly(value, ["kind", "nodes", "edges", "next_cursor", "graph_revision", "truncated", "warnings"]) || !Array.isArray(value.nodes) || value.nodes.length > limits.maxGraphNodes || !Array.isArray(value.edges) || value.edges.length > limits.maxGraphEdges || (value.next_cursor !== null && !optionalCursor(value.next_cursor)) || !safeCount(value.graph_revision) || typeof value.truncated !== "boolean") return invalidResult();
    return resultBytes({ kind: "graph", nodes: value.nodes.map(normalizeGraphNodeResult), edges: value.edges.map(normalizeGraphEdgeResult), next_cursor: value.next_cursor as string | null, graph_revision: value.graph_revision, truncated: value.truncated, warnings: normalizeWarnings(value.warnings) } satisfies GraphPageResult, limits.maxGraphResponseBytes, invalidResult);
  }
  if (value.kind === "entity") {
    if (!hasOnly(value, ["kind", "id", "name", "type", "aliases", "evidence", "relationships", "timeline", "ranking_factors", "next_cursor", "graph_revision", "truncated", "warnings"]) || !boundedResultString(value.id, 200) || !boundedResultString(value.name, 200) || !nodeTypes.has(value.type as NodeType) || !Array.isArray(value.aliases) || value.aliases.length > 50 || !value.aliases.every(alias => boundedResultString(alias, 200)) || !Array.isArray(value.evidence) || value.evidence.length > 50 || !Array.isArray(value.relationships) || value.relationships.length > 50 || !Array.isArray(value.timeline) || value.timeline.length > 50 || !isRecord(value.ranking_factors) || !hasOnly(value.ranking_factors, ["importance", "evidence_confidence", "source_count", "degree", "unresolved_conflict"]) || !finite(value.ranking_factors.importance) || !finite(value.ranking_factors.evidence_confidence) || !safeCount(value.ranking_factors.source_count) || !safeCount(value.ranking_factors.degree) || typeof value.ranking_factors.unresolved_conflict !== "boolean" || (value.next_cursor !== null && !optionalCursor(value.next_cursor)) || !safeCount(value.graph_revision) || typeof value.truncated !== "boolean") return invalidResult();
    const relationships = value.relationships.map(item => { if (!isRecord(item) || !hasOnly(item, ["id", "direction", "type", "other_id", "other_name", "other_type", "confidence", "evidence"]) || !boundedResultString(item.id, 200) || !["in", "out"].includes(item.direction as string) || !boundedResultString(item.type, 100) || !boundedResultString(item.other_id, 200) || !boundedResultString(item.other_name, 200) || !nodeTypes.has(item.other_type as NodeType) || !finite(item.confidence) || item.confidence < 0 || item.confidence > 1 || !Array.isArray(item.evidence) || item.evidence.length > 20) return invalidResult(); return { id: item.id, direction: item.direction as "in" | "out", type: item.type, other_id: item.other_id, other_name: item.other_name, other_type: item.other_type as NodeType, confidence: item.confidence, evidence: item.evidence.map(normalizeEvidenceResult) }; });
    const timeline = value.timeline.map(item => { if (!isRecord(item) || !hasOnly(item, ["timestamp", "kind", "relationship_ids", "evidence_count", "source_count"]) || !safeCount(item.timestamp) || !["observed", "became_valid", "became_invalid"].includes(item.kind as string) || !Array.isArray(item.relationship_ids) || item.relationship_ids.length > 50 || !item.relationship_ids.every(id => boundedResultString(id, 200)) || !safeCount(item.evidence_count) || !safeCount(item.source_count)) return invalidResult(); return { timestamp: item.timestamp, kind: item.kind as "observed" | "became_valid" | "became_invalid", relationship_ids: [...item.relationship_ids] as string[], evidence_count: item.evidence_count, source_count: item.source_count }; });
    return resultBytes({ kind: "entity", id: value.id, name: value.name, type: value.type as NodeType, aliases: [...value.aliases] as string[], evidence: value.evidence.map(normalizeEvidenceResult), relationships, timeline, ranking_factors: { importance: value.ranking_factors.importance, evidence_confidence: value.ranking_factors.evidence_confidence, source_count: value.ranking_factors.source_count, degree: value.ranking_factors.degree, unresolved_conflict: value.ranking_factors.unresolved_conflict }, next_cursor: value.next_cursor as string | null, graph_revision: value.graph_revision, truncated: value.truncated, warnings: normalizeWarnings(value.warnings) } satisfies EntityDetailResult, limits.maxGraphResponseBytes, invalidResult);
  }
  if (value.kind === "research") {
    if (!hasOnly(value, ["kind", "section", "items", "next_cursor", "warnings", "truncated"]) || !["insights", "watches", "history", "digests"].includes(value.section as string) || !Array.isArray(value.items) || value.items.length > 100 || (value.next_cursor !== null && !optionalCursor(value.next_cursor)) || typeof value.truncated !== "boolean") return invalidResult();
    const items = value.items.map(item => {
      if (!isRecord(item) || !hasOnly(item, ["id", "status", "kind", "score", "name", "schedule_hint", "enabled", "graph_revision", "result_count", "duration_ms", "created_at", "started_at", "finished_at"]) || !boundedResultString(item.id, 200) || !boundedResultString(item.status, 100) || item.kind !== undefined && !boundedResultString(item.kind, 100) || item.score !== undefined && (!finite(item.score) || item.score < 0 || item.score > 1) || item.name !== undefined && !boundedResultString(item.name, 200) || item.schedule_hint !== undefined && !boundedResultString(item.schedule_hint, 100) || item.enabled !== undefined && typeof item.enabled !== "boolean" || item.graph_revision !== undefined && !safeCount(item.graph_revision) || item.result_count !== undefined && !safeCount(item.result_count) || item.duration_ms !== undefined && !safeCount(item.duration_ms) || item.created_at !== undefined && !safeCount(item.created_at) || item.started_at !== undefined && !safeCount(item.started_at) || item.finished_at !== undefined && !nullableSafeInteger(item.finished_at)) return invalidResult();
      return { id: item.id, status: item.status, ...(item.kind === undefined ? {} : { kind: item.kind }), ...(item.score === undefined ? {} : { score: item.score }), ...(item.name === undefined ? {} : { name: item.name }), ...(item.schedule_hint === undefined ? {} : { schedule_hint: item.schedule_hint }), ...(item.enabled === undefined ? {} : { enabled: item.enabled }), ...(item.graph_revision === undefined ? {} : { graph_revision: item.graph_revision }), ...(item.result_count === undefined ? {} : { result_count: item.result_count }), ...(item.duration_ms === undefined ? {} : { duration_ms: item.duration_ms }), ...(item.created_at === undefined ? {} : { created_at: item.created_at }), ...(item.started_at === undefined ? {} : { started_at: item.started_at }), ...(item.finished_at === undefined ? {} : { finished_at: item.finished_at }) };
    });
    return resultBytes({ kind: "research", section: value.section as ResearchPageResult["section"], items, next_cursor: value.next_cursor as string | null, warnings: normalizeWarnings(value.warnings), truncated: value.truncated } satisfies ResearchPageResult, limits.maxGraphResponseBytes, invalidResult);
  }
  if (value.kind === "health") {
    if (!hasOnly(value, ["kind", "graph_revision", "status", "counts", "recovery"]) || !safeCount(value.graph_revision) || !["healthy", "degraded", "unavailable"].includes(value.status as string) || !isRecord(value.counts) || !hasOnly(value.counts, ["orphans", "conflicts", "duplicate_candidates"]) || !safeCount(value.counts.orphans) || !safeCount(value.counts.conflicts) || !safeCount(value.counts.duplicate_candidates) || !isRecord(value.recovery) || !hasOnly(value.recovery, ["status", "artifacts", "latest_created_at", "load_error"]) || !["healthy", "degraded", "unavailable"].includes(value.recovery.status as string) || !isRecord(value.recovery.artifacts) || !hasOnly(value.recovery.artifacts, ["backups", "recovery_points", "available", "missing"]) || !safeCount(value.recovery.artifacts.backups) || !safeCount(value.recovery.artifacts.recovery_points) || !safeCount(value.recovery.artifacts.available) || !safeCount(value.recovery.artifacts.missing) || !nullableSafeInteger(value.recovery.latest_created_at) || (value.recovery.load_error !== undefined && value.recovery.load_error !== "manifest_invalid" && value.recovery.load_error !== "manifest_too_large")) return invalidResult();
    return resultBytes({ kind: "health", graph_revision: value.graph_revision, status: value.status as HealthResult["status"], counts: { orphans: value.counts.orphans, conflicts: value.counts.conflicts, duplicate_candidates: value.counts.duplicate_candidates }, recovery: { status: value.recovery.status as HealthResult["recovery"]["status"], artifacts: { backups: value.recovery.artifacts.backups, recovery_points: value.recovery.artifacts.recovery_points, available: value.recovery.artifacts.available, missing: value.recovery.artifacts.missing }, latest_created_at: value.recovery.latest_created_at as number | null, ...(value.recovery.load_error === undefined ? {} : { load_error: value.recovery.load_error as "manifest_invalid" | "manifest_too_large" }) } } satisfies HealthResult, limits.maxGraphResponseBytes, invalidResult);
  }
  if (value.kind === "sources") {
    if (!hasOnly(value, ["kind", "items", "next_cursor", "warnings", "truncated"]) || !Array.isArray(value.items) || value.items.length > 100 || (value.next_cursor !== null && !optionalCursor(value.next_cursor)) || typeof value.truncated !== "boolean") return invalidResult();
    const statuses = new Set(["available", "missing", "deleted", "changed", "legacy"]), verification = new Set(["pending", "verified", "flagged", "rejected", "unverifiable", "contradicted", "stale", "superseded"]);
    const items = value.items.map(item => {
      if (!isRecord(item) || !hasOnly(item, ["id", "source", "source_status", "verification_status", "snapshot_truncated", "claim_count", "captured_at"]) || !boundedResultString(item.id, 200) || !boundedResultString(item.source, 200) || !statuses.has(item.source_status as string) || !verification.has(item.verification_status as string) || typeof item.snapshot_truncated !== "boolean" || !safeCount(item.claim_count) || !safeCount(item.captured_at)) return invalidResult();
      return { id: item.id, source: item.source, source_status: item.source_status as InspectorSourceAnchor["source_status"], verification_status: item.verification_status as InspectorSourceAnchor["verification_status"], snapshot_truncated: item.snapshot_truncated, claim_count: item.claim_count, captured_at: item.captured_at };
    });
    return resultBytes({ kind: "sources", items, next_cursor: value.next_cursor as string | null, warnings: normalizeWarnings(value.warnings), truncated: value.truncated } satisfies SourceAnchorPageResult, limits.maxGraphResponseBytes, invalidResult);
  }
  return invalidResult();
}

function normalizeAffected(value: unknown): OperationAffectedCounts {
  if (!isRecord(value) || !hasOnly(value, ["nodes", "edges", "observations"]) || !safeCount(value.nodes) || !safeCount(value.edges) || !safeCount(value.observations)) return invalidOperationResult();
  return { nodes: value.nodes, edges: value.edges, observations: value.observations };
}

function normalizeArtifact(value: unknown): ArtifactReference {
  if (!isRecord(value) || !hasOnly(value, ["artifact_id"]) || !opaqueArtifactId(value.artifact_id)) return invalidOperationResult();
  return { artifact_id: value.artifact_id };
}

function commonPreview(value: Record<string, unknown>, allowed: readonly string[]): { preview_token: string; payload_hash: string; graph_revision: number; affected: OperationAffectedCounts; truncated: boolean } {
  if (!hasOnly(value, allowed) || !boundedResultString(value.preview_token, 256) || !resultHash(value.payload_hash) || !safeCount(value.graph_revision) || typeof value.truncated !== "boolean") return invalidOperationResult();
  return { preview_token: value.preview_token, payload_hash: value.payload_hash, graph_revision: value.graph_revision, affected: normalizeAffected(value.affected), truncated: value.truncated };
}

/** Validates the closed, redacted operation output union. */
export function normalizeOperationResult(value: unknown): OperationResult {
  if (!isRecord(value) || typeof value.operation !== "string" || !operations.has(value.operation as InspectorOperation) || (value.phase !== "preview" && value.phase !== "confirm")) return invalidOperationResult();
  const operation = value.operation as InspectorOperation;
  if (value.phase === "preview") {
    if (operation === "source_trust") {
      const common = commonPreview(value, ["operation", "phase", "preview_token", "payload_hash", "graph_revision", "config_revision", "affected", "rank_deltas", "truncated"]);
      if (!safeCount(value.config_revision) || !Array.isArray(value.rank_deltas) || value.rank_deltas.length > 100) return invalidOperationResult();
      const rank_deltas = value.rank_deltas.map(delta => {
        if (!isRecord(delta) || !hasOnly(delta, ["id", "delta"]) || !boundedResultString(delta.id, 200) || !finite(delta.delta) || delta.delta < -1 || delta.delta > 1) return invalidOperationResult();
        return { id: delta.id, delta: delta.delta };
      });
      return resultBytes({ operation, phase: "preview", ...common, config_revision: value.config_revision, rank_deltas } as OperationResult, INSPECTOR_HARD_LIMITS.maxGraphResponseBytes, invalidOperationResult);
    }
    const common = commonPreview(value, ["operation", "phase", "preview_token", "payload_hash", "graph_revision", "affected", "truncated"]);
    return resultBytes({ operation: operation as Exclude<InspectorOperation, "source_trust">, phase: "preview", ...common } as OperationResult, INSPECTOR_HARD_LIMITS.maxGraphResponseBytes, invalidOperationResult);
  }
  if (!hasOnly(value, operation === "source_trust" ? ["operation", "phase", "confirmed", "graph_revision", "config_revision", "audit_id", "affected"] : operation === "backup" ? ["operation", "phase", "confirmed", "graph_revision", "audit_id", "artifact"] : operation === "restore" ? ["operation", "phase", "confirmed", "graph_revision", "audit_id", "recovery_point"] : ["operation", "phase", "confirmed", "graph_revision", "audit_id", "affected"]) || typeof value.confirmed !== "boolean" || !safeCount(value.graph_revision) || !opaqueAuditId(value.audit_id)) return invalidOperationResult();
  if (operation === "source_trust") {
    if (!safeCount(value.config_revision)) return invalidOperationResult();
    return resultBytes({ operation, phase: "confirm", confirmed: value.confirmed, graph_revision: value.graph_revision, config_revision: value.config_revision, audit_id: value.audit_id, affected: normalizeAffected(value.affected) } as OperationResult, INSPECTOR_HARD_LIMITS.maxGraphResponseBytes, invalidOperationResult);
  }
  if (operation === "backup") return resultBytes({ operation, phase: "confirm", confirmed: value.confirmed, graph_revision: value.graph_revision, audit_id: value.audit_id, artifact: normalizeArtifact(value.artifact) } as OperationResult, INSPECTOR_HARD_LIMITS.maxGraphResponseBytes, invalidOperationResult);
  if (operation === "restore") return resultBytes({ operation, phase: "confirm", confirmed: value.confirmed, graph_revision: value.graph_revision, audit_id: value.audit_id, recovery_point: normalizeArtifact(value.recovery_point) } as OperationResult, INSPECTOR_HARD_LIMITS.maxGraphResponseBytes, invalidOperationResult);
  return resultBytes({ operation: operation as "orphan_cleanup" | "weight_recompute", phase: "confirm", confirmed: value.confirmed, graph_revision: value.graph_revision, audit_id: value.audit_id, affected: normalizeAffected(value.affected) } as OperationResult, INSPECTOR_HARD_LIMITS.maxGraphResponseBytes, invalidOperationResult);
}

export { INSPECTOR_HARD_LIMITS };
