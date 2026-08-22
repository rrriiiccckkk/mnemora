import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { RelationshipDefinition } from "../relationships.js";
import { normalizeScope } from "../scope.js";
import type { ExtractedRelation, KgNode, SchemaDriftCandidate } from "../types.js";

const idFor = (scope: string, sourceId: string, targetId: string, relationshipType: string, legacyEdgeId = "") => {
  // Preserve v6.13-v6.17 ids for extractor proposals. Historic edge scans get
  // a distinct durable id only when they name a concrete legacy edge.
  const parts = [scope, sourceId, targetId, relationshipType];
  if (legacyEdgeId) parts.push(legacyEdgeId);
  return `schema-drift:${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40)}`;
};

/** This repository records an observed ontology mismatch without turning an
 * extractor proposal into an admitted graph fact. */
export class SchemaDriftRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  record(input: { scope: string; source: KgNode; target: KgNode; relation: ExtractedRelation; definition: RelationshipDefinition; now?: number }): SchemaDriftCandidate {
    const scope = normalizeScope(input.scope), now = input.now ?? Date.now();
    const id = idFor(scope, input.source.id, input.target.id, input.relation.type);
    this.db.prepare(`INSERT INTO kg_schema_drift_candidates(
      id,scope,source_entity_id,target_entity_id,relationship_type,source_type,target_type,expected_source_types,expected_target_types,legacy_edge_id,relation_payload,occurrence_count,first_seen_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT(scope,source_entity_id,target_entity_id,relationship_type,legacy_edge_id) DO UPDATE SET
        source_type=excluded.source_type,target_type=excluded.target_type,
        expected_source_types=excluded.expected_source_types,expected_target_types=excluded.expected_target_types,
        relation_payload=excluded.relation_payload,occurrence_count=kg_schema_drift_candidates.occurrence_count+1,updated_at=excluded.updated_at`)
      .run(id, scope, input.source.id, input.target.id, input.relation.type, input.source.type, input.target.type, input.definition.source, input.definition.target, "", JSON.stringify(input.relation), now, now);
    return this.get(id, scope)!;
  }

  /** A scan of a pre-existing edge is repeatable. Re-running it must not make
   * a historical edge look like fresh independent extractor support. */
  recordLegacy(input: { scope: string; source: KgNode; target: KgNode; relation: ExtractedRelation; definition: RelationshipDefinition; legacyEdgeId: string; now?: number }): SchemaDriftCandidate {
    const scope = normalizeScope(input.scope), now = input.now ?? Date.now();
    const id = idFor(scope, input.source.id, input.target.id, input.relation.type, input.legacyEdgeId);
    this.db.prepare(`INSERT INTO kg_schema_drift_candidates(
      id,scope,source_entity_id,target_entity_id,relationship_type,source_type,target_type,expected_source_types,expected_target_types,legacy_edge_id,relation_payload,occurrence_count,first_seen_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT(scope,source_entity_id,target_entity_id,relationship_type,legacy_edge_id) DO UPDATE SET
        source_type=excluded.source_type,target_type=excluded.target_type,
        expected_source_types=excluded.expected_source_types,expected_target_types=excluded.expected_target_types,
        legacy_edge_id=excluded.legacy_edge_id,relation_payload=excluded.relation_payload,updated_at=excluded.updated_at`)
      .run(id, scope, input.source.id, input.target.id, input.relation.type, input.source.type, input.target.type, input.definition.source, input.definition.target, input.legacyEdgeId, JSON.stringify(input.relation), now, now);
    return this.get(id, scope)!;
  }

  list(scope: string, limit = 20): SchemaDriftCandidate[] {
    const safe = normalizeScope(scope), take = Math.min(100, Math.max(1, Math.trunc(limit)));
    return (this.db.prepare("SELECT * FROM kg_schema_drift_candidates WHERE scope=? ORDER BY updated_at DESC,id DESC LIMIT ?").all(safe, take) as Array<Record<string, unknown>>).map(mapCandidate);
  }

  get(id: string, scope: string): SchemaDriftCandidate | undefined {
    const row = this.db.prepare("SELECT * FROM kg_schema_drift_candidates WHERE id=? AND scope=?").get(id, scope) as Record<string, unknown> | undefined;
    return row ? mapCandidate(row) : undefined;
  }

  relation(id: string, scope: string): ExtractedRelation | undefined {
    const row = this.db.prepare("SELECT relation_payload FROM kg_schema_drift_candidates WHERE id=? AND scope=?").get(id, normalizeScope(scope)) as { relation_payload?: unknown } | undefined;
    if (typeof row?.relation_payload !== "string") return undefined;
    try {
      const value = JSON.parse(row.relation_payload) as Partial<ExtractedRelation>;
      return typeof value.source === "string" && typeof value.target === "string" && typeof value.type === "string" && typeof value.confidence === "number" && typeof value.evidence_span === "string"
        ? value as ExtractedRelation : undefined;
    } catch { return undefined; }
  }

  repair(id: string, scope: string): { replacement_type: string; preview_hash: string; edge_id: string; observation_id: string; audit_id: string; retired_edge_id: string | null } | undefined {
    return this.db.prepare("SELECT replacement_type,preview_hash,edge_id,observation_id,audit_id,retired_edge_id FROM kg_schema_drift_repairs WHERE candidate_id=? AND scope=?").get(id, normalizeScope(scope)) as { replacement_type: string; preview_hash: string; edge_id: string; observation_id: string; audit_id: string; retired_edge_id: string | null } | undefined;
  }
}

function mapCandidate(row: Record<string, unknown>): SchemaDriftCandidate {
  return {
    id: String(row.id), scope: String(row.scope), source_entity_id: String(row.source_entity_id), target_entity_id: String(row.target_entity_id), relationship_type: String(row.relationship_type), source_type: String(row.source_type), target_type: String(row.target_type), expected_source_types: String(row.expected_source_types), expected_target_types: String(row.expected_target_types), ...(typeof row.legacy_edge_id === "string" && row.legacy_edge_id ? { legacy_edge_id: row.legacy_edge_id } : {}), occurrence_count: Number(row.occurrence_count), first_seen_at: Number(row.first_seen_at), updated_at: Number(row.updated_at)
  };
}
