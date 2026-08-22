import { normalizeOperationsConfig, type OperationsConfig } from "../operations/types.js";
import { normalizeInspectorRequest, normalizeInspectorResult } from "./validation.js";
import { redactedSource, redactedSummary, safeInspectorCursorKey, safeInspectorId, safeInspectorText } from "./redaction.js";
import type { EntityDetailRequest, EntityDetailSection, GraphPageRequest, GraphPageResult, HealthResult, InspectorReadResult, InspectorRecoveryHealth, InspectorSourceAnchor, ResearchPageRequest, ResearchPageResult, SourceAnchorPageResult } from "./types.js";
import type { SourceAnchorPage } from "../trust/types.js";
import type { NodeType } from "../types.js";
import type { RelationshipType } from "../relationships.js";
import type { KgInsightsResult } from "../types.js";
import { createHash } from "node:crypto";
import { detectCommunities } from "../insights/community.js";
import type { GraphProjection } from "../insights/types.js";
import { normalizeScope } from "../scope.js";

const NODE_TYPES = new Set<NodeType>(["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"]);
const INSPECTOR_COMMUNITY_NODE_LIMIT = 512;
const INSPECTOR_COMMUNITY_EDGE_LIMIT = 2_048;
const INSPECTOR_COMMUNITY_MAX_PASSES = 4;

/** Non-serialized controls for a single bounded inspector read. */
export interface InspectorExecutionOptions { signal?: AbortSignal; deadlineMs?: number; deadlineAt?: number; check?: () => void; }
type GraphPosition = { phase: "edge" | "node"; id: string };
type EntityCursorPosition = { sort: number; id: string };

export interface InspectorStore {
  graphRevision(): number;
  insightGraphProjection?(input: { maxNodes: number; maxEdges: number; confidenceFloor: number; asOf: number; scope?: string }): GraphProjection;
  inspectorOverviewProjection(check?: () => void): { graph_revision: unknown; nodes: unknown; edges: unknown; observations: unknown };
  inspectorHealthProjection(check?: () => void): { graph_revision: unknown; orphans: unknown; conflicts: unknown; duplicate_candidates: unknown };
  inspectorGraphProjection(input: { position?: GraphPosition | null; after_id?: string | null; maxNodes: number; maxEdges: number; maxResponseBytes: number; asOf: number; scope?: string; filters?: GraphPageRequest["filters"]; check?: () => void }): {
    graph_revision: unknown; nodes: unknown[]; edges: unknown[]; next?: unknown; next_id?: unknown; phase?: unknown; skipped_unrepresentable?: unknown; truncated: unknown;
  };
  inspectorEntityProjection(id: string, section: EntityDetailSection | "all", limit: number, asOf: number, after?: EntityCursorPosition | null, check?: () => void, scope?: string): {
    graph_revision: unknown; entity?: { id: unknown; name: unknown; type: unknown; aliases: unknown[]; importance?: unknown }; evidence: unknown[]; relationships?: unknown[]; timeline?: unknown[]; ranking_factors?: unknown; next?: unknown; truncated?: unknown;
  };
  inspectorResearchRevision?(): string;
  inspectorResearchProjection(section: "insights" | "watches" | "history" | "digests", after: { sort: number; id: string } | null, limit: number, check?: () => void, scope?: string): {
    items: unknown[]; next: unknown; truncated?: unknown; insights_state?: unknown;
  };
}

/** The existing analytics service is injected so Inspector never reimplements insight formulas. */
export interface InspectorAnalytics { analyze(input: { explain: false; scope?: string }): Promise<KgInsightsResult>; }
/** Read-only trust boundary. It exposes no stored snapshots or provider payloads. */
export interface InspectorTrustReader {
  revision(): string;
  listForInspector(input: { scope: string; after: { sort: number; id: string } | null; limit: number; check?: () => void }): SourceAnchorPage;
}
export interface InspectorServiceOptions {
  store: InspectorStore;
  analytics?: InspectorAnalytics;
  limits?: Partial<OperationsConfig>;
  now?: () => number;
  signal?: AbortSignal;
  scopeDefault?: string;
  recoveryHealth?: () => InspectorRecoveryHealth;
  trust?: InspectorTrustReader;
}

/** Read-only boundary: normalize input, re-bound hostile projections, redact, normalize output. */
export class InspectorService {
  private readonly limits: OperationsConfig;
  private readonly now: () => number;
  private communityCache: { revision: number; scope: string; projectionKey: string; membership: Record<string, string> } | undefined;

  constructor(private readonly options: InspectorServiceOptions) {
    this.limits = normalizeOperationsConfig(options.limits ?? {});
    this.now = options.now ?? Date.now;
  }

  overview(execution: InspectorExecutionOptions = {}): InspectorReadResult {
    const started = this.now();
    try {
      this.guard(execution, started);
      const check = () => this.guard(execution, started);
      const row = this.options.store.inspectorOverviewProjection(check);
      check();
      const health = this.options.store.inspectorHealthProjection(check);
      check();
      const counts = { orphans: count(health.orphans), conflicts: count(health.conflicts), duplicate_candidates: count(health.duplicate_candidates) };
      return this.result({ kind: "overview", graph_revision: count(row.graph_revision), nodes: count(row.nodes), edges: count(row.edges), observations: count(row.observations), health: { status: counts.orphans || counts.conflicts || counts.duplicate_candidates ? "degraded" : "healthy", counts }, warnings: [] });
    } catch (error) { return this.result({ kind: "overview", graph_revision: 0, nodes: 0, edges: 0, observations: 0, health: { status: "unavailable", counts: { orphans: 0, conflicts: 0, duplicate_candidates: 0 } }, warnings: [{ code: warningFor(error) }] }); }
  }

  graph(input: unknown, execution: InspectorExecutionOptions = {}): GraphPageResult {
    const request = this.request(input, "graph");
    const started = this.now();
    const maxNodes = Math.min(this.limits.maxGraphNodes, request.max_nodes ?? request.limit ?? this.limits.maxGraphNodes);
    const maxEdges = Math.min(this.limits.maxGraphEdges, request.max_edges ?? this.limits.maxGraphEdges);
    const maxBytes = Math.min(this.limits.maxGraphResponseBytes, request.max_response_bytes ?? this.limits.maxGraphResponseBytes);
    if (maxBytes < 128) throw new Error("invalid inspector request");
    const scope = this.scopeFor(request.scope), revision = safeRevision(this.options.store), filter = graphFilterHash(request.filters, scope);
    const position = decodeGraphCursor(request.cursor, revision, filter);
    const deadline = Math.min(this.limits.graphDeadlineMs, request.deadline_ms ?? this.limits.graphDeadlineMs, execution.deadlineMs ?? this.limits.graphDeadlineMs);
    const empty = (warnings: GraphPageResult["warnings"] = [{ code: "truncated" }]): GraphPageResult => this.graphResult({ kind: "graph", nodes: [], edges: [], next_cursor: null, graph_revision: safeRevision(this.options.store), truncated: true, warnings }, maxBytes);
    try { this.guard(execution, started, deadline); } catch (error) { return empty([{ code: warningFor(error) }]); }
    try {
      const check = () => this.guard(execution, started, deadline);
      const raw = this.options.store.inspectorGraphProjection({ position, after_id: position?.phase === "edge" ? position.id : null, maxNodes, maxEdges, maxResponseBytes: maxBytes, asOf: started, scope, filters: request.filters, check });
      check();
      const rawNodes = boundedRows(raw.nodes, maxNodes);
      const rawEdges = boundedRows(raw.edges, maxEdges);
      const nodes: GraphPageResult["nodes"] = [];
      for (let index = 0; index < rawNodes.length; index++) {
        check();
        nodes.push(...graphNode(rawNodes[index]));
      }
      const edges: GraphPageResult["edges"] = [];
      const pageNodeIds = new Set(nodes.map(node => node.id));
      for (let index = 0; index < rawEdges.length; index++) {
        check();
        edges.push(...graphEdge(rawEdges[index], pageNodeIds));
      }
      check();
      const membership = this.communityMembership(nodes, edges, count(raw.graph_revision), started, check, scope);
      const graphNodes = nodes.map(node => ({ ...node, community_id: membership[node.id] ?? null, community_color: membership[node.id] ? communityColor(membership[node.id]) : null }))
        .filter(node => !request.filters?.community_id || node.community_id === request.filters.community_id);
      const nodeIds = new Set(graphNodes.map(node => node.id));
      const coherentEdges = edges.filter(edge => nodeIds.has(edge.source_id) && nodeIds.has(edge.target_id));
      const malformed = nodes.length !== rawNodes.length || edges.length !== rawEdges.length;
      const phase: "edge" | "node" = raw.phase === "node" ? "node" : "edge";
      const projectionNext = graphPosition(raw.next) ?? (safeInspectorId(raw.next_id) ? { phase: "edge", id: safeInspectorId(raw.next_id)! } : null);
      return this.boundGraphPage({ nodes: graphNodes, edges: coherentEdges, rawNodes, rawEdges, phase, projectionNext, graphRevision: count(raw.graph_revision), truncated: raw.truncated === true || rawNodes.length !== raw.nodes.length || rawEdges.length !== raw.edges.length || malformed, malformed, skipped: raw.skipped_unrepresentable === true, revision: count(raw.graph_revision), filter, maxBytes, check });
    } catch (error) { return empty([{ code: warningFor(error) }]); }
  }

  entity(input: unknown, execution: InspectorExecutionOptions = {}): InspectorReadResult {
    const started = this.now();
    try { this.guard(execution, started); } catch (error) { throw new Error(`inspector ${warningFor(error)}`); }
    const request = this.request(input, "entity");
    const limit = Math.min(50, request.limit ?? 50);
    const revision = safeRevision(this.options.store);
    const section = request.section ?? "relationships";
    const scope = this.scopeFor(request.scope), after = decodeEntityCursor(request.cursor, revision, request.id, section, scope);
    try {
      const check = () => this.guard(execution, started);
      const raw = this.options.store.inspectorEntityProjection(request.id, section, limit, this.now(), after, check, scope);
      check();
      const entity = raw.entity;
      const id = safeInspectorId(entity?.id), name = safeInspectorText(entity?.name);
      if (!entity || !id || !name || !NODE_TYPES.has(entity.type as NodeType)) throw new Error("entity not found");
      const rawAliases = boundedRows(entity.aliases, 50);
      const aliases = rawAliases.reduce<string[]>((items, alias) => {
        check();
        const safe = safeInspectorText(alias); if (safe) items.push(safe); return items;
      }, []).slice(0, 50);
      const rawEvidence = boundedRows(raw.evidence, limit), rawRelationships = boundedRows(raw.relationships, limit), rawTimeline = boundedRows(raw.timeline, 50);
      const evidence = rawEvidence.flatMap(value => { check(); return evidenceRow(value); });
      const relationships = rawRelationships.flatMap(value => { check(); return relationshipRow(value); });
      const timeline = rawTimeline.flatMap(value => { check(); return timelineRow(value); });
      const factors = rankingFactors(raw.ranking_factors, entity.importance);
      const malformed = aliases.length !== rawAliases.length || evidence.length !== rawEvidence.length || relationships.length !== rawRelationships.length || timeline.length !== rawTimeline.length;
      const next = entityCursorPosition(raw.next);
      return this.result({ kind: "entity", id, name, type: entity.type as NodeType, aliases, evidence, relationships, timeline, ranking_factors: factors, next_cursor: next ? encodeEntityCursor(count(raw.graph_revision), request.id, section, next, scope) : null, graph_revision: count(raw.graph_revision), truncated: raw.truncated === true || malformed, warnings: malformed ? [{ code: "malformed_row" }] : [] });
    } catch (error) { if (error instanceof InspectorExecutionError) throw new Error(`inspector ${error.code}`); throw new Error("entity not found"); }
  }

  research(input: unknown, execution: InspectorExecutionOptions = {}): ResearchPageResult | Promise<ResearchPageResult> {
    const started = this.now();
    try { this.guard(execution, started); } catch (error) { return this.result({ kind: "research", section: "insights", items: [], next_cursor: null, warnings: [{ code: warningFor(error) }], truncated: true }) as ResearchPageResult; }
    const request = this.request(input, "research");
    const scope = this.scopeFor(request.scope), section = request.section ?? "insights", limit = Math.min(100, request.limit ?? 100), revision = this.options.store.inspectorResearchRevision?.() ?? `graph:${safeRevision(this.options.store)}`, after = decodeResearchCursor(request.cursor, revision, section, scope);
    try {
      const check = () => this.guard(execution, started);
      const raw = this.options.store.inspectorResearchProjection(section, after, limit, check, scope);
      check();
      const insightState = section === "insights" ? researchInsightState(raw.insights_state) : "current";
      if (insightState === "malformed") return this.researchResult(section, revision, raw, limit, check, [{ code: "malformed_row" }], true, scope);
      if (insightState !== "current") {
        if (!this.options.analytics) return this.researchResult(section, revision, raw, limit, check, [{ code: "truncated" }], true, scope);
        return this.options.analytics.analyze({ explain: false, scope }).then(result => {
          check();
          const fallback = insightItems(result, after, limit, check);
          return this.researchResult(section, revision, fallback, limit, check, fallback.truncated || result.truncated ? [{ code: "truncated" }] : [], fallback.truncated || result.truncated === true, scope);
        }).catch(error => {
          if (error instanceof InspectorExecutionError) return this.researchResult(section, revision, { items: [], next: null, truncated: true }, limit, check, [{ code: error.code }], true, scope);
          return this.researchResult(section, revision, { items: [], next: null, truncated: true }, limit, check, [{ code: "truncated" }], true, scope);
        });
      }
      return this.researchResult(section, revision, raw, limit, check, [], false, scope);
    } catch (error) { return this.result({ kind: "research", section, items: [], next_cursor: null, warnings: [{ code: warningFor(error) }], truncated: true }) as ResearchPageResult; }
  }

  sources(input: unknown, execution: InspectorExecutionOptions = {}): SourceAnchorPageResult {
    const started = this.now();
    try { this.guard(execution, started); } catch (error) { return this.sourceResult([], null, [{ code: warningFor(error) }], true); }
    const request = this.request(input, "sources");
    const scope = this.scopeFor(request.scope), revision = this.options.trust?.revision() ?? "trust:0";
    let after: { sort: number; id: string } | null;
    try { after = decodeSourceCursor(request.cursor, revision, scope); }
    catch { return this.sourceResult([], null, [{ code: "stale_cursor" }], true); }
    try {
      const check = () => this.guard(execution, started);
      const limit = Math.min(100, request.limit ?? 100);
      const raw = this.options.trust?.listForInspector({ scope, after, limit, check }) ?? { items: [], next: null, truncated: false };
      check();
      const rows = boundedRows(raw.items, limit);
      const items = rows.flatMap(row => { check(); return sourceAnchorRow(row); });
      const malformed = items.length !== rows.length;
      return this.sourceResult(items, raw.next ? encodeSourceCursor(revision, raw.next, scope) : null, malformed ? [{ code: "malformed_row" }] : [], raw.truncated || malformed);
    } catch (error) { return this.sourceResult([], null, [{ code: warningFor(error) }], true); }
  }

  healthSummary(execution: InspectorExecutionOptions = {}): HealthResult {
    const started = this.now();
    try {
      this.guard(execution, started);
      const row = this.options.store.inspectorHealthProjection(() => this.guard(execution, started));
      const counts = { orphans: count(row.orphans), conflicts: count(row.conflicts), duplicate_candidates: count(row.duplicate_candidates) };
      return this.result({ kind: "health", graph_revision: count(row.graph_revision), status: counts.orphans || counts.conflicts || counts.duplicate_candidates ? "degraded" : "healthy", counts, recovery: this.recoveryHealth() }) as HealthResult;
    } catch { return this.result({ kind: "health", graph_revision: 0, status: "unavailable", counts: { orphans: 0, conflicts: 0, duplicate_candidates: 0 }, recovery: unavailableRecovery() }) as HealthResult; }
  }

  private request<T extends "graph" | "entity" | "research" | "sources">(value: unknown, kind: T): Extract<ReturnType<typeof normalizeInspectorRequest>, { kind: T }> {
    const request = normalizeInspectorRequest(value, this.limits);
    if (!("kind" in request) || request.kind !== kind) throw new Error("invalid inspector request");
    return request as Extract<ReturnType<typeof normalizeInspectorRequest>, { kind: T }>;
  }
  private result(value: InspectorReadResult): InspectorReadResult { return normalizeInspectorResult(value, this.limits); }
  private researchResult(section: NonNullable<ResearchPageRequest["section"]>, revision: string, raw: { items: unknown[]; next: unknown; truncated?: unknown }, limit: number, check: () => void, warnings: Array<{ code: "malformed_row" | "truncated" | "deadline" | "cancelled" | "stale_cursor" | "unrepresentable_item" }> = [], forcedTruncated = false, scope = "default"): ResearchPageResult {
    const rows = boundedRows(raw.items, limit);
    const items = rows.flatMap(item => { check(); return researchItem(item); });
    const next = researchNext(raw.next);
    return this.result({ kind: "research", section, items, next_cursor: next ? encodeResearchCursor(revision, section, next, scope) : null, warnings: [...warnings, ...(items.length !== rows.length ? [{ code: "malformed_row" } as const] : [])], truncated: forcedTruncated || raw.truncated === true || items.length !== rows.length }) as ResearchPageResult;
  }
  private sourceResult(items: InspectorSourceAnchor[], next_cursor: string | null, warnings: Array<{ code: "malformed_row" | "truncated" | "deadline" | "cancelled" | "stale_cursor" | "unrepresentable_item" }>, truncated: boolean): SourceAnchorPageResult {
    return this.result({ kind: "sources", items, next_cursor, warnings, truncated }) as SourceAnchorPageResult;
  }
  private graphResult(value: GraphPageResult, maxBytes: number, check?: () => void): GraphPageResult {
    check?.();
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) throw new Error("inspector graph response too large");
    return normalizeInspectorResult(value, { ...this.limits, maxGraphResponseBytes: maxBytes }) as GraphPageResult;
  }
  private boundGraphPage(input: {
    nodes: GraphPageResult["nodes"]; edges: GraphPageResult["edges"]; rawNodes: unknown[]; rawEdges: unknown[];
    phase: "edge" | "node"; projectionNext: GraphPosition | null; graphRevision: number; truncated: boolean;
    malformed: boolean; skipped: boolean; revision: number; filter: string; maxBytes: number; check: () => void;
  }): GraphPageResult {
    const warnings: GraphPageResult["warnings"] = [
      ...(input.malformed ? [{ code: "malformed_row" } as const] : []),
      ...(input.skipped ? [{ code: "unrepresentable_item" } as const] : [])
    ];
    const candidate = (edgeCount: number, nodeCount: number, next: GraphPosition | null, extra: GraphPageResult["warnings"] = warnings): GraphPageResult => {
      const emittedEdges = input.edges.slice(0, edgeCount);
      const endpointIds = new Set(emittedEdges.flatMap(edge => [edge.source_id, edge.target_id]));
      const emittedNodes = input.phase === "edge" ? input.nodes.filter(node => endpointIds.has(node.id)) : input.nodes.slice(0, nodeCount);
      const next_cursor = next ? encodeGraphCursor(input.revision, input.filter, next) : null;
      return { kind: "graph", nodes: emittedNodes, edges: emittedEdges, next_cursor, graph_revision: input.graphRevision, truncated: input.truncated || edgeCount < input.edges.length || nodeCount < input.nodes.length || next !== null, warnings: extra };
    };
    const choosePrefix = (maximum: number, build: (count: number) => GraphPageResult): number => {
      let low = 0, high = maximum;
      while (low < high) {
        input.check();
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(build(middle)), "utf8") <= input.maxBytes) low = middle;
        else high = middle - 1;
      }
      return low;
    };
    if (input.phase === "edge" && input.edges.length) {
      const prefixNext = (count: number): GraphPosition | null => count < input.edges.length
        ? count > 0 ? { phase: "edge", id: input.edges[count - 1]!.id } : null
        : input.projectionNext;
      const kept = choosePrefix(input.edges.length, count => candidate(count, 0, prefixNext(count)));
      if (kept > 0) return this.graphResult(candidate(kept, 0, prefixNext(kept)), input.maxBytes, input.check);
      // A single oversized edge must not wedge the keyset. Advance past it and
      // tell callers that it was deliberately omitted.
      const first = input.edges[0]!.id;
      const skippedWarnings = [...warnings, { code: "unrepresentable_item" } as const];
      const skipped = candidate(0, 0, { phase: "edge", id: first }, skippedWarnings);
      if (Buffer.byteLength(JSON.stringify(skipped), "utf8") <= input.maxBytes) return this.graphResult(skipped, input.maxBytes, input.check);
      return this.smallestGraphPage(input.graphRevision, input.maxBytes);
    }
    if (input.phase === "node" || input.nodes.length) {
      const prefixNext = (count: number): GraphPosition | null => count < input.nodes.length
        ? count > 0 ? { phase: "node", id: input.nodes[count - 1]!.id } : null
        : input.projectionNext;
      const kept = choosePrefix(input.nodes.length, count => candidate(0, count, prefixNext(count)));
      if (kept > 0 || !input.nodes.length) return this.graphResult(candidate(0, kept, prefixNext(kept)), input.maxBytes, input.check);
      const first = input.nodes[0]!.id;
      const skippedWarnings = [...warnings, { code: "unrepresentable_item" } as const];
      const skipped = candidate(0, 0, { phase: "node", id: first }, skippedWarnings);
      if (Buffer.byteLength(JSON.stringify(skipped), "utf8") <= input.maxBytes) return this.graphResult(skipped, input.maxBytes, input.check);
      return this.smallestGraphPage(input.graphRevision, input.maxBytes);
    }
    return this.graphResult(candidate(0, 0, input.projectionNext), input.maxBytes, input.check);
  }
  private smallestGraphPage(revision: number, maxBytes: number): GraphPageResult {
    const value: GraphPageResult = { kind: "graph", nodes: [], edges: [], next_cursor: null, graph_revision: revision, truncated: true, warnings: [] };
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) throw new Error("invalid inspector request");
    return this.graphResult(value, maxBytes);
  }
  private communityMembership(nodes: GraphPageResult["nodes"], edges: GraphPageResult["edges"], revision: number, asOf: number, check: () => void, scope: string): Record<string, string> {
    const projection = inspectorCommunityProjection(nodes, edges, revision, asOf, check);
    const projectionKey = createHash("sha256").update(JSON.stringify({ nodes: projection.nodes.map(node => node.id), edges: projection.edges.map(edge => edge.id) })).digest("hex");
    if (this.communityCache?.revision === revision && this.communityCache.scope === scope && this.communityCache.projectionKey === projectionKey) return this.communityCache.membership;
    try {
      check();
      const membership = detectCommunities(projection, { check, maxPasses: INSPECTOR_COMMUNITY_MAX_PASSES }).membership;
      check();
      this.communityCache = { revision, projectionKey, membership, scope };
      return membership;
    } catch (error) {
      if (error instanceof InspectorExecutionError) throw error;
      return {};
    }
  }
  private guard(execution: InspectorExecutionOptions, started: number, deadline?: number): void {
    execution.check?.();
    if (this.options.signal?.aborted === true || execution.signal?.aborted === true) throw new InspectorExecutionError("cancelled");
    const deadlineAt = Math.min(execution.deadlineAt ?? Number.POSITIVE_INFINITY, Number.isFinite(deadline) ? started + deadline! : Number.POSITIVE_INFINITY, Number.isFinite(execution.deadlineMs) ? started + execution.deadlineMs! : Number.POSITIVE_INFINITY);
    if (!Number.isFinite(started) || this.now() > deadlineAt) throw new InspectorExecutionError("deadline");
  }
  private scopeFor(scope: string | undefined): string { return normalizeScope(scope, this.options.scopeDefault ?? "default"); }
  private recoveryHealth(): InspectorRecoveryHealth { try { return this.options.recoveryHealth?.() ?? unavailableRecovery(); } catch { return unavailableRecovery(); } }
}

class InspectorExecutionError extends Error { constructor(readonly code: "cancelled" | "deadline") { super(code); } }
function warningFor(error: unknown): "cancelled" | "deadline" | "truncated" { return error instanceof InspectorExecutionError ? error.code : "truncated"; }
function unavailableRecovery(): InspectorRecoveryHealth { return { status: "unavailable", artifacts: { backups: 0, recovery_points: 0, available: 0, missing: 0 }, latest_created_at: null }; }

function count(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function safeRevision(store: InspectorStore): number { try { return count(store.graphRevision()); } catch { return 0; } }
function graphNode(value: unknown): Array<{ id: string; name: string; type: NodeType; community_id: null; community_color: null }> {
  if (!record(value)) return [];
  const id = safeInspectorId(value.id), name = safeInspectorText(value.name);
  return id && name && NODE_TYPES.has(value.type as NodeType) ? [{ id, name, type: value.type as NodeType, community_id: null, community_color: null }] : [];
}
function evidenceRow(value: unknown): Array<{ source: string; confidence: number; valid_from: number | null; valid_to: number | null; summary: string }> {
  if (!record(value)) return [];
  const source = redactedSource(value.source), confidence = finiteUnit(value.confidence), valid_from = temporal(value.valid_from), valid_to = temporal(value.valid_to);
  if (!source || confidence === undefined || valid_from === undefined || valid_to === undefined || valid_from !== null && valid_to !== null && valid_from > valid_to) return [];
  return [{ source, confidence, valid_from, valid_to, summary: redactedSummary(value.relationship_type) }];
}
function graphEdge(value: unknown, nodeIds: Set<string>): Array<{ id: string; source_id: string; target_id: string; type: string; confidence: number; evidence: ReturnType<typeof evidenceRow> }> {
  if (!record(value)) return [];
  const id = safeInspectorId(value.id), source_id = safeInspectorId(value.source_id), target_id = safeInspectorId(value.target_id), type = safeInspectorText(value.type, 100), confidence = finiteUnit(value.confidence);
  if (!id || !source_id || !target_id || !type || confidence === undefined || !nodeIds.has(source_id) || !nodeIds.has(target_id)) return [];
  const evidence = boundedRows(value.evidence, 20).flatMap(evidenceRow);
  return [{ id, source_id, target_id, type, confidence, evidence }];
}
function relationshipRow(value: unknown): Array<{ id: string; direction: "in" | "out"; type: string; other_id: string; other_name: string; other_type: NodeType; confidence: number; evidence: ReturnType<typeof evidenceRow> }> {
  if (!record(value)) return [];
  const id = safeInspectorId(value.id), type = safeInspectorText(value.type, 100), other_id = safeInspectorId(value.other_id), other_name = safeInspectorText(value.other_name), confidence = finiteUnit(value.confidence);
  if (!id || !type || !other_id || !other_name || (value.direction !== "in" && value.direction !== "out") || !NODE_TYPES.has(value.other_type as NodeType) || confidence === undefined) return [];
  return [{ id, direction: value.direction, type, other_id, other_name, other_type: value.other_type as NodeType, confidence, evidence: boundedRows(value.evidence, 20).flatMap(evidenceRow) }];
}
function timelineRow(value: unknown): Array<{ timestamp: number; kind: "observed" | "became_valid" | "became_invalid"; relationship_ids: string[]; evidence_count: number; source_count: number }> {
  if (!record(value) || !Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0 || !["observed", "became_valid", "became_invalid"].includes(value.kind as string) || !Array.isArray(value.relationshipIds) || !Number.isSafeInteger(value.evidenceCount) || !Number.isSafeInteger(value.sourceCount)) return [];
  const relationship_ids = boundedRows(value.relationshipIds, 50).reduce<string[]>((items, id) => { const safe = safeInspectorId(id); if (safe) items.push(safe); return items; }, []);
  return [{ timestamp: value.timestamp as number, kind: value.kind as "observed" | "became_valid" | "became_invalid", relationship_ids, evidence_count: value.evidenceCount as number, source_count: value.sourceCount as number }];
}
function rankingFactors(value: unknown, fallback: unknown): { importance: number; evidence_confidence: number; source_count: number; degree: number; unresolved_conflict: boolean } {
  if (!record(value)) return { importance: finiteUnit(fallback) ?? 0, evidence_confidence: 0, source_count: 0, degree: 0, unresolved_conflict: false };
  return { importance: finiteUnit(value.importance) ?? 0, evidence_confidence: finiteUnit(value.evidence_confidence) ?? 0, source_count: count(value.source_count), degree: count(value.degree), unresolved_conflict: value.unresolved_conflict === true };
}
function researchItem(value: unknown): Array<{ id: string; status: string; kind?: string; score?: number; name?: string; schedule_hint?: string; enabled?: boolean; graph_revision?: number; result_count?: number; duration_ms?: number; created_at?: number; started_at?: number; finished_at?: number | null }> {
  if (!record(value)) return [];
  const id = safeInspectorId(value.id), status = safeInspectorText(value.status, 100);
  if (!id || !status) return [];
  const text = (key: string, max = 100) => safeInspectorText(value[key], max);
  return [{ id, status, ...(text("kind") ? { kind: text("kind")! } : {}), ...(finiteUnit(value.score) !== undefined ? { score: finiteUnit(value.score)! } : {}), ...(text("name", 200) ? { name: text("name", 200)! } : {}), ...(text("schedule_hint") ? { schedule_hint: text("schedule_hint")! } : {}), ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}), ...(Number.isSafeInteger(value.graph_revision) && (value.graph_revision as number) >= 0 ? { graph_revision: value.graph_revision as number } : {}), ...(Number.isSafeInteger(value.result_count) && (value.result_count as number) >= 0 ? { result_count: value.result_count as number } : {}), ...(Number.isSafeInteger(value.duration_ms) && (value.duration_ms as number) >= 0 ? { duration_ms: value.duration_ms as number } : {}), ...(Number.isSafeInteger(value.created_at) && (value.created_at as number) >= 0 ? { created_at: value.created_at as number } : {}), ...(Number.isSafeInteger(value.started_at) && (value.started_at as number) >= 0 ? { started_at: value.started_at as number } : {}), ...(value.finished_at === null || Number.isSafeInteger(value.finished_at) ? { finished_at: value.finished_at as number | null } : {}) }];
}
function sourceAnchorRow(value: unknown): InspectorSourceAnchor[] {
  if (!record(value)) return [];
  const id = safeInspectorId(value.id), source = safeAnchorSource(value.source);
  const sourceStatus = ["available", "missing", "deleted", "changed", "legacy"].includes(value.source_status as string) ? value.source_status as InspectorSourceAnchor["source_status"] : undefined;
  const verificationStatus = ["pending", "verified", "flagged", "rejected", "unverifiable", "contradicted", "stale", "superseded"].includes(value.verification_status as string) ? value.verification_status as InspectorSourceAnchor["verification_status"] : undefined;
  const claimCount = count(value.claim_count), capturedAt = Number.isSafeInteger(value.captured_at) && (value.captured_at as number) >= 0 ? value.captured_at as number : undefined;
  return id && source && sourceStatus && verificationStatus && capturedAt !== undefined && typeof value.snapshot_truncated === "boolean" ? [{ id, source, source_status: sourceStatus, verification_status: verificationStatus, snapshot_truncated: value.snapshot_truncated, claim_count: claimCount, captured_at: capturedAt }] : [];
}
function safeAnchorSource(value: unknown): string | undefined {
  if (typeof value === "string" && value.startsWith("url:")) return safeInspectorText(value.slice(4), 200);
  return redactedSource(value) ?? safeInspectorText(value, 200);
}
function temporal(value: unknown): number | null | undefined { return value === null ? null : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function finiteUnit(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function boundedRows(value: unknown, maximum: number): unknown[] { return Array.isArray(value) ? value.slice(0, Math.max(0, maximum)) : []; }
function graphFilterHash(filters: GraphPageRequest["filters"], scope: string): string { return createHash("sha256").update(JSON.stringify({ scope, filters: filters ?? {} })).digest("base64url").slice(0, 16); }
function encodeGraphCursor(revision: number, filter: string, position: GraphPosition): string { return Buffer.from(JSON.stringify({ v: 2, r: revision, f: filter, p: position.phase, l: position.id })).toString("base64url"); }
function decodeGraphCursor(cursor: string | undefined, revision: number, filter: string): GraphPosition | null {
  if (!cursor) return null;
  try {
    const value = decodeOpaqueCursor(cursor);
    const phase = value.v === 1 ? "edge" : value.p;
    if ((value.v !== 1 && value.v !== 2) || value.r !== revision || value.f !== filter || (phase !== "edge" && phase !== "node") || typeof value.l !== "string" || (phase === "edge" && !safeInspectorId(value.l)) || (phase === "node" && value.l !== "" && !safeInspectorId(value.l))) throw new Error();
    return { phase, id: value.l };
  } catch { throw new Error("invalid inspector cursor"); }
}
function graphPosition(value: unknown): GraphPosition | null {
  if (!record(value) || (value.phase !== "edge" && value.phase !== "node") || typeof value.id !== "string" || (value.phase === "edge" && !safeInspectorId(value.id)) || (value.phase === "node" && value.id !== "" && !safeInspectorId(value.id))) return null;
  return { phase: value.phase, id: value.id };
}
function encodeEntityCursor(revision: number, entity: string, section: EntityDetailSection | "all", last: EntityCursorPosition, scope: string): string { return Buffer.from(JSON.stringify({ v: 3, r: revision, e: entity, s: section, p: scope, o: last.sort, l: last.id })).toString("base64url"); }
function decodeEntityCursor(cursor: string | undefined, revision: number, entity: string, section: EntityDetailSection | "all", scope: string): EntityCursorPosition | null {
  if (!cursor) return null;
  try { const value = decodeOpaqueCursor(cursor); if (value.v !== 3 || value.r !== revision || value.e !== entity || value.s !== section || value.p !== scope || !Number.isSafeInteger(value.o) || (value.o as number) < 0 || !safeInspectorCursorKey(value.l)) throw new Error(); return { sort: value.o as number, id: value.l as string }; } catch { throw new Error("invalid inspector cursor"); }
}
function entityCursorPosition(value: unknown): EntityCursorPosition | null { return record(value) && Number.isSafeInteger(value.sort) && (value.sort as number) >= 0 && !!safeInspectorCursorKey(value.id) ? { sort: value.sort as number, id: value.id as string } : null; }
function encodeResearchCursor(revision: string, section: string, next: { sort: number; id: string }, scope: string): string { return Buffer.from(JSON.stringify({ v: 2, r: revision, s: section, p: scope, o: next.sort, i: next.id })).toString("base64url"); }
function decodeResearchCursor(cursor: string | undefined, revision: string, section: string, scope: string): { sort: number; id: string } | null {
  if (!cursor) return null;
  try { const value = decodeOpaqueCursor(cursor); if (value.v !== 2 || value.r !== revision || value.s !== section || value.p !== scope || !Number.isSafeInteger(value.o) || (value.o as number) < 0 || !safeInspectorId(value.i)) throw new Error(); return { sort: value.o as number, id: value.i as string }; } catch { throw new Error("invalid inspector cursor"); }
}
function encodeSourceCursor(revision: string, next: { sort: number; id: string }, scope: string): string { return Buffer.from(JSON.stringify({ v: 1, r: revision, p: scope, o: next.sort, i: next.id })).toString("base64url"); }
function decodeSourceCursor(cursor: string | undefined, revision: string, scope: string): { sort: number; id: string } | null {
  if (!cursor) return null;
  try { const value = decodeOpaqueCursor(cursor); if (value.v !== 1 || value.r !== revision || value.p !== scope || !Number.isSafeInteger(value.o) || (value.o as number) < 0 || !safeInspectorId(value.i)) throw new Error(); return { sort: value.o as number, id: value.i as string }; } catch { throw new Error("invalid inspector cursor"); }
}
function decodeOpaqueCursor(cursor: string): Record<string, unknown> {
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) throw new Error();
  const value = JSON.parse(bytes.toString("utf8"));
  if (!record(value)) throw new Error();
  return value;
}
function researchNext(value: unknown): { sort: number; id: string } | null { return record(value) && Number.isSafeInteger(value.sort) && (value.sort as number) >= 0 && !!safeInspectorId(value.id) ? { sort: value.sort as number, id: value.id as string } : null; }
function researchInsightState(value: unknown): "current" | "missing" | "stale" | "malformed" {
  return value === "missing" || value === "stale" || value === "malformed" ? value : "current";
}
function insightItems(result: KgInsightsResult, after: { sort: number; id: string } | null, limit: number, check: () => void): { items: Array<Record<string, unknown>>; next: { sort: number; id: string } | null; truncated: boolean } {
  const rawInsights = Array.isArray(result.insights) ? result.insights : [];
  const insights = rawInsights.slice(0, 101).map(item => {
    check();
    return { id: item.id, status: "available", kind: item.kind, score: item.score, sort: Math.floor(item.score * 1_000_000), created_at: 0 };
  }).filter(item => after == null || Number(item.sort) < after.sort || Number(item.sort) === after.sort && String(item.id) < after.id)
    .sort((a, b) => Number(b.sort) - Number(a.sort) || String(b.id).localeCompare(String(a.id)));
  const page = insights.slice(0, limit + 1);
  const last = page[Math.min(limit, page.length) - 1];
  return { items: page, next: page.length > limit && last ? { sort: Number(last.sort), id: String(last.id) } : null, truncated: rawInsights.length > 101 };
}
function inspectorCommunityProjection(value: GraphPageResult["nodes"], edgeRows: GraphPageResult["edges"], revision: number, asOf: number, check: () => void): GraphProjection {
  const nodeRows = value.slice(0, INSPECTOR_COMMUNITY_NODE_LIMIT);
  const nodes = nodeRows.flatMap(row => { check(); const id = safeInspectorId(row.id), name = safeInspectorText(row.name); return id && name && NODE_TYPES.has(row.type as NodeType) ? [{ id, name, type: row.type as NodeType }] : []; });
  const ids = new Set(nodes.map(node => node.id));
  const boundedEdges = edgeRows.slice(0, INSPECTOR_COMMUNITY_EDGE_LIMIT);
  const edges = boundedEdges.flatMap(row => {
    check();
    const id = safeInspectorId(row.id), source = safeInspectorId(row.source_id), target = safeInspectorId(row.target_id), type = safeInspectorText(row.type, 100), weight = finiteUnit(row.confidence);
    return id && source && target && type && weight !== undefined && ids.has(source) && ids.has(target) ? [{ id, source, target, type: type as RelationshipType, weight, confidence: weight, evidenceCount: row.evidence.length, sourceCount: new Set(row.evidence.map(item => item.source)).size, firstSeenAt: 0, lastSeenAt: 0 }] : [];
  });
  return { nodes, edges, graphRevision: revision, asOf, truncated: nodeRows.length !== value.length || boundedEdges.length !== edgeRows.length || edges.length !== boundedEdges.length };
}
function communityColor(id: string): string { return `#${createHash("sha256").update(id).digest().subarray(0, 3).toString("hex")}`; }
