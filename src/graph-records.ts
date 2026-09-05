import type { KgEdge, KgNode, KgSourceSummary } from "./types.js";
import type { RelationshipType } from "./relationships.js";

export type NodeRow = Omit<KgNode, "aliases"> & { aliases: string };
export type EdgeRow = Omit<KgEdge, "edge_props"> & { edge_props: string };

/** Decode SQLite graph rows at one shared read-model seam. */
export function mapNode(row: NodeRow): KgNode {
  return { ...row, aliases: parseJsonArray(row.aliases), importance: Number(row.importance), deleted_at: row.deleted_at == null ? null : Number(row.deleted_at), created_at: Number(row.created_at), updated_at: Number(row.updated_at) };
}

export function mapEdge(row: EdgeRow): KgEdge {
  return { ...row, type: row.type as RelationshipType, edge_props: parseJsonObject(row.edge_props), weight: Number(row.weight), deleted_at: row.deleted_at == null ? null : Number(row.deleted_at), created_at: Number(row.created_at), updated_at: Number(row.updated_at) };
}

export function mapSourceSummary(row: { source: string; observations: number; average_confidence: number; first_seen_at: number; last_seen_at: number }): KgSourceSummary {
  return {
    source: row.source,
    observations: Number(row.observations),
    average_confidence: Number(row.average_confidence ?? 0),
    first_seen_at: Number(row.first_seen_at),
    last_seen_at: Number(row.last_seen_at)
  };
}

function parseJsonArray(value: string): string[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}
