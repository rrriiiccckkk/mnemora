import { relationshipDefinitions, type RelationshipType } from "../relationships.js";
import type { NodeType, QueryConfig } from "../types.js";
import type { QueryPlanV1, QueryStep } from "./types.js";

const nodeTypes = new Set<NodeType>(["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"]);
const relationshipTypes = new Set(Object.keys(relationshipDefinitions));
const searchModes = new Set(["lexical", "semantic", "hybrid"]);
const directions = new Set(["out", "in", "both"]);
const orderings = new Set(["relevance", "confidence", "recency", "name"]);
const aggregateBy = new Set(["node_type", "relationship_type", "source"]);
const aggregateMetrics = new Set(["count", "entities", "relationships"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const validStrings = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string" && item.length > 0);
const validNodeTypes = (value: unknown) => Array.isArray(value) && value.every(item => nodeTypes.has(item as NodeType));
const validEdgeTypes = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === "string" && relationshipTypes.has(item));
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const invalid = (): never => { throw new Error("invalid query plan"); };

function normalizeStep(value: unknown, maxDepth: number): QueryStep {
  if (!isRecord(value) || typeof value.op !== "string") return invalid();
  if (value.op === "lookup") {
    if (!hasOnly(value, ["op", "query", "node_types", "mode"]) || typeof value.query !== "string" || value.query.trim().length === 0) return invalid();
    if (value.node_types !== undefined && !validNodeTypes(value.node_types)) return invalid();
    if (value.mode !== undefined && !searchModes.has(value.mode as string)) return invalid();
    return { op: "lookup", query: value.query.trim(), ...(value.node_types === undefined ? {} : { node_types: value.node_types as NodeType[] }), ...(value.mode === undefined ? {} : { mode: value.mode as "lexical" | "semantic" | "hybrid" }) };
  }
  if (value.op === "traverse") {
    if (!hasOnly(value, ["op", "from", "edge_types", "direction", "depth"]) || !validStrings(value.from) || !directions.has(value.direction as string) || !finite(value.depth)) return invalid();
    if (value.edge_types !== undefined && !validEdgeTypes(value.edge_types)) return invalid();
    return { op: "traverse", from: [...value.from as string[]], ...(value.edge_types === undefined ? {} : { edge_types: value.edge_types as RelationshipType[] }), direction: value.direction as "out" | "in" | "both", depth: clamp(Math.trunc(value.depth), 0, maxDepth) };
  }
  if (value.op === "filter") {
    if (!hasOnly(value, ["op", "node_types", "confidence_min", "valid_from", "valid_to"])) return invalid();
    if (value.node_types !== undefined && !validNodeTypes(value.node_types)) return invalid();
    for (const key of ["confidence_min", "valid_from", "valid_to"] as const) if (value[key] !== undefined && !finite(value[key])) return invalid();
    if (finite(value.valid_from) && finite(value.valid_to) && value.valid_from > value.valid_to) return invalid();
    return { op: "filter", ...(value.node_types === undefined ? {} : { node_types: value.node_types as NodeType[] }), ...(finite(value.confidence_min) ? { confidence_min: clamp(value.confidence_min, 0, 1) } : {}), ...(finite(value.valid_from) ? { valid_from: value.valid_from } : {}), ...(finite(value.valid_to) ? { valid_to: value.valid_to } : {}) };
  }
  if (value.op === "aggregate") {
    if (!hasOnly(value, ["op", "by", "metric"]) || !aggregateBy.has(value.by as string) || !aggregateMetrics.has(value.metric as string)) return invalid();
    return { op: "aggregate", by: value.by as "node_type" | "relationship_type" | "source", metric: value.metric as "count" | "entities" | "relationships" };
  }
  return invalid();
}

export function normalizeQueryPlan(value: unknown, limits: Partial<QueryConfig> = {}): QueryPlanV1 {
  if (!isRecord(value) || !hasOnly(value, ["version", "steps", "order_by", "limit"]) || value.version !== 1 || !Array.isArray(value.steps)) return invalid();
  const maxSteps = clamp(finite(limits.maxSteps) ? Math.trunc(limits.maxSteps) : 8, 1, 8);
  const maxDepth = clamp(finite(limits.maxDepth) ? Math.trunc(limits.maxDepth) : 4, 0, 4);
  const maxResults = clamp(finite(limits.maxResults) ? Math.trunc(limits.maxResults) : 50, 1, 50);
  if (value.steps.length === 0 || value.steps.length > maxSteps) return invalid();
  if (value.order_by !== undefined && !orderings.has(value.order_by as string)) return invalid();
  if (value.limit !== undefined && !finite(value.limit)) return invalid();
  return { version: 1, steps: value.steps.map(step => normalizeStep(step, maxDepth)), order_by: (value.order_by ?? "relevance") as QueryPlanV1["order_by"], limit: clamp(Math.trunc((value.limit as number | undefined) ?? maxResults), 1, maxResults) };
}
