import type { GraphologyStore, QueryGraphProjection } from "../store.js";
import type { QueryConfig } from "../types.js";
import { relationshipDefinitions } from "../relationships.js";
import type { QueryExecutionResult, QueryStep } from "./types.js";
import { normalizeQueryPlan } from "./validation.js";

export interface ExecuteQueryOptions { limits: QueryConfig; now: number; scope?: string; signal?: AbortSignal }
const integer = (v: number | undefined, fallback: number, hard: number, min = 1) => Number.isFinite(v) ? Math.min(hard, Math.max(min, Math.trunc(v!))) : fallback;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const lower = (value: string) => value.toLowerCase();
const nodeTypes = new Set(["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"]);
const edgeTypes = new Set(Object.keys(relationshipDefinitions));

function sanitizeProjection(p: QueryGraphProjection, maxNodes: number, maxEdges: number, check: () => void): QueryGraphProjection {
  const rawNodes = Array.isArray(p.nodes) ? p.nodes : [];
  const rawEdges = Array.isArray(p.edges) ? p.edges : [];
  const byId = new Map<string, QueryGraphProjection["nodes"][number]>();
  for (let i = 0; i < rawNodes.length; i++) {
    if ((i & 255) === 0) check();
    const n = rawNodes[i];
    if (typeof n?.id === "string" && typeof n.name === "string" && nodeTypes.has(n.type) && Array.isArray(n.aliases) && n.aliases.every(a => typeof a === "string") && Number.isFinite(n.createdAt) && Number.isFinite(n.updatedAt) && !byId.has(n.id)) byId.set(n.id, n);
  }
  const validNodes = [...byId.values()].sort((a, b) => compare(a.id, b.id));
  const nodes = validNodes.slice(0, maxNodes);
  const ids = new Set(nodes.map(n => n.id));
  const seen = new Set<string>();
  const validEdges: QueryGraphProjection["edges"] = [];
  for (let i = 0; i < rawEdges.length; i++) {
    if ((i & 255) === 0) check();
    const e = rawEdges[i];
    if (typeof e?.id === "string" && !seen.has(e.id) && ids.has(e.source) && ids.has(e.target) && e.source !== e.target && edgeTypes.has(e.type) && Number.isFinite(e.confidence) && e.confidence >= 0 && e.confidence <= 1 && Number.isFinite(e.evidenceCount) && e.evidenceCount >= 0 && Number.isFinite(e.sourceCount) && e.sourceCount >= 0 && Number.isFinite(e.firstSeenAt) && Number.isFinite(e.lastSeenAt) && (e.validFrom == null || Number.isFinite(e.validFrom)) && (e.validTo == null || Number.isFinite(e.validTo))) { seen.add(e.id); validEdges.push(e); }
  }
  validEdges.sort((a, b) => compare(a.id, b.id));
  return { graphRevision: Number.isFinite(p.graphRevision) ? p.graphRevision : 0, nodes, edges: validEdges.slice(0, maxEdges), truncated: Boolean(p.truncated) || rawNodes.length > maxNodes || rawEdges.length > maxEdges || validNodes.length > maxNodes || validEdges.length > maxEdges };
}

export function executeQueryPlan(store: Pick<GraphologyStore, "queryGraphProjection">, raw: unknown, options: ExecuteQueryOptions): QueryExecutionResult {
  const started = Date.now();
  const timeout = Number.isFinite(options.limits.timeoutMs) ? Math.min(10000, Math.max(0, Math.trunc(options.limits.timeoutMs!))) : 10000;
  const check = () => { if (options.signal?.aborted) throw new Error("query cancelled"); if (timeout === 0 || Date.now() - started >= timeout) throw new Error("query timeout"); };
  const limits = { ...options.limits, maxDepth: integer(options.limits.maxDepth, 4, 4, 0), maxResults: integer(options.limits.maxResults, 50, 50), maxNodes: integer(options.limits.maxNodes, 10000, 10000), maxEdges: integer(options.limits.maxEdges, 50000, 50000), maxResponseBytes: integer(options.limits.maxResponseBytes, 1048576, 1048576) };
  check();
  const plan = normalizeQueryPlan(raw, limits);
  let previousAllowed = false;
  for (const step of plan.steps) { if (step.op === "traverse" && step.from.includes("$previous") && !previousAllowed) throw new Error("unsupported $previous placement"); if (step.op === "lookup" && step.mode !== undefined && step.mode !== "lexical") throw new Error("unsupported lookup mode"); previousAllowed = step.op === "lookup" || step.op === "traverse"; }
  const projection = sanitizeProjection(store.queryGraphProjection({ maxNodes: limits.maxNodes!, maxEdges: limits.maxEdges!, asOf: options.now, scope: options.scope }), limits.maxNodes!, limits.maxEdges!, check);
  const nodeMap = new Map(projection.nodes.map(n => [n.id, n]));
  let selected = new Set<string>(), previous = new Set<string>(), selectedEdges = new Map<string, QueryGraphProjection["edges"][number]>(), scores = new Map<string, number>();
  let aggregate: Extract<QueryStep, { op: "aggregate" }> | undefined;
  for (const step of plan.steps) {
    check();
    if (step.op === "lookup") {
      const q = lower(step.query), matches: string[] = [];
      for (let i = 0; i < projection.nodes.length; i++) { if ((i & 255) === 0) check(); const n = projection.nodes[i]; if ((!step.node_types || step.node_types.includes(n.type)) && [n.id, n.name, ...n.aliases].some(v => lower(v).includes(q))) matches.push(n.id); }
      previous = new Set(matches); selected = new Set(previous); scores = new Map([...previous].map(id => [id, 0]));
    } else if (step.op === "traverse") {
      let frontier = new Set(step.from.flatMap(id => id === "$previous" ? [...previous] : nodeMap.has(id) ? [id] : [])); selected = new Set(frontier); selectedEdges = new Map(); scores = new Map([...frontier].map(id => [id, 0]));
      for (let depth = 0; depth < Math.min(4, step.depth) && frontier.size; depth++) {
        check(); const next = new Set<string>();
        for (let i = 0; i < projection.edges.length; i++) { if ((i & 255) === 0) check(); const edge = projection.edges[i]; if (step.edge_types && !step.edge_types.includes(edge.type)) continue; const out = (step.direction === "out" || step.direction === "both") && frontier.has(edge.source); const incoming = (step.direction === "in" || step.direction === "both") && frontier.has(edge.target); if (!out && !incoming) continue; const id = out ? edge.target : edge.source; selectedEdges.set(edge.id, edge); next.add(id); selected.add(id); scores.set(id, Math.max(scores.get(id) ?? 0, edge.confidence)); }
        frontier = next;
      }
      previous = new Set(selected);
    } else if (step.op === "filter") {
      if (step.node_types) {
        const typed = new Set<string>(); let index = 0;
        for (const id of selected) { if ((index++ & 255) === 0) check(); if (step.node_types.includes(nodeMap.get(id)!.type)) typed.add(id); }
        selected = typed;
      }
      const filteredEdges = new Map<string, QueryGraphProjection["edges"][number]>(), endpoints = new Set<string>(); let edgeIndex = 0;
      for (const [id, e] of selectedEdges) {
        if ((edgeIndex++ & 255) === 0) check();
        if (selected.has(e.source) && selected.has(e.target) && (step.confidence_min == null || e.confidence >= step.confidence_min) && (step.valid_from == null || e.validTo == null || e.validTo >= step.valid_from) && (step.valid_to == null || e.validFrom == null || e.validFrom <= step.valid_to)) { filteredEdges.set(id, e); endpoints.add(e.source); endpoints.add(e.target); }
      }
      selectedEdges = filteredEdges;
      if (selectedEdges.size) { const retained = new Set<string>(); let nodeIndex = 0; for (const id of selected) { if ((nodeIndex++ & 255) === 0) check(); if (endpoints.has(id)) retained.add(id); } selected = retained; }
    } else aggregate = step;
  }
  const compareNodes = (a: string, b: string) => plan.order_by === "name" ? compare(nodeMap.get(a)!.name, nodeMap.get(b)!.name) || compare(a, b) : plan.order_by === "recency" ? nodeMap.get(b)!.updatedAt - nodeMap.get(a)!.updatedAt || compare(a, b) : (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || compare(a, b);
  const entityIds = [...selected].sort(compareNodes).slice(0, Math.min(50, plan.limit));
  const included = new Set(entityIds);
  const edgeValues = [...selectedEdges.values()].filter(e => included.has(e.source) && included.has(e.target)).sort((a, b) => plan.order_by === "recency" ? b.lastSeenAt - a.lastSeenAt || compare(a.id, b.id) : plan.order_by === "name" ? compare(a.id, b.id) : b.confidence - a.confidence || compare(a.id, b.id)).slice(0, Math.min(50, plan.limit));
  const entities = entityIds.map(id => ({ id, name: nodeMap.get(id)!.name, type: nodeMap.get(id)!.type, score: scores.get(id) ?? 0 }));
  let relationships = edgeValues.map(e => ({ id: e.id, source_id: e.source, target_id: e.target, type: e.type, confidence: e.confidence, evidence_count: e.evidenceCount, source_count: e.sourceCount }));
  const aggregateRows = () => {
    check();
    if (!aggregate) return [];
    const groups = new Map<string, Set<string>>(), add = (key: string, value: string) => { const set = groups.get(key) ?? new Set<string>(); set.add(value); groups.set(key, set); };
    if (aggregate.by === "node_type") { if (aggregate.metric === "relationships") for (let i = 0; i < relationships.length; i++) { if ((i & 255) === 0) check(); const e = relationships[i]; add(nodeMap.get(e.source_id)!.type, e.id); add(nodeMap.get(e.target_id)!.type, e.id); } else for (const e of entities) add(e.type, e.id); }
    else if (aggregate.by === "relationship_type") for (const e of relationships) aggregate.metric === "entities" ? (add(e.type, e.source_id), add(e.type, e.target_id)) : add(e.type, e.id);
    else for (const e of relationships) add(e.source_id, aggregate.metric === "entities" ? e.target_id : e.id);
    return [...groups].sort(([a], [b]) => compare(a, b)).map(([key, values]) => ({ key, count: values.size }));
  };
  const result: QueryExecutionResult = { interpreted_plan: plan, graph_revision: projection.graphRevision, entities, relationships, aggregates: aggregateRows(), truncated: projection.truncated, warnings: projection.truncated ? [{ category: "projection_truncated" }] : [] };
  while (Buffer.byteLength(JSON.stringify(result)) > limits.maxResponseBytes! && (result.relationships.length || result.entities.length)) { check(); result.truncated = true; if (result.relationships.length) result.relationships.pop(); else result.entities.pop(); const ids = new Set(result.entities.map(e => e.id)); result.relationships = relationships = result.relationships.filter(e => ids.has(e.source_id) && ids.has(e.target_id)); result.aggregates = aggregateRows(); }
  if (Buffer.byteLength(JSON.stringify(result)) > limits.maxResponseBytes!) throw new Error("response byte limit too small");
  check(); return result;
}
