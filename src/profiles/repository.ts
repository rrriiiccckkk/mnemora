import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { NodeType } from "../types.js";
import type { RelationshipType } from "../relationships.js";
import type { ProfileClaimVerification, ProfileClaimProvenance, ProfileSubject } from "./types.js";

interface ProfileEdge {
  edge_id: string;
  key: RelationshipType;
  entity: ProfileSubject;
  confidence: number;
  freshness: number;
}

/** Owns profile reads only; it never mutates graph, evidence, or verification rows. */
export class ProfileProjectionRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  revisions(): { graph_revision: number; trust_revision: number } {
    const graph = this.db.prepare("SELECT value FROM kg_graph_state WHERE key='content_revision'").get() as { value?: unknown } | undefined;
    const trust = this.db.prepare("SELECT revision FROM kg_trust_state WHERE id=1").get() as { revision?: unknown } | undefined;
    return { graph_revision: nonNegativeInteger(graph?.value), trust_revision: nonNegativeInteger(trust?.revision) };
  }

  resolveSubject(input: string, scope: string): "not_found" | "ambiguous" | ProfileSubject {
    const text = typeof input === "string" ? input.trim().slice(0, 160) : "";
    if (!text) return "not_found";
    const normalizedScope = normalizeScope(scope);
    const rows = this.db.prepare(`SELECT DISTINCT n.id,n.name,n.type
      FROM kg_nodes n LEFT JOIN kg_entity_identities i ON i.node_id=n.id
      WHERE n.deleted_at IS NULL AND (n.id=? OR i.value_normalized=lower(?))
        AND (EXISTS (SELECT 1 FROM kg_observations o WHERE o.scope=? AND o.source_entity_id=n.id)
          OR EXISTS (SELECT 1 FROM kg_edges e JOIN kg_observations o ON o.edge_id=e.id AND o.scope=?
            WHERE e.deleted_at IS NULL AND (e.source_id=n.id OR e.target_id=n.id)))
      ORDER BY n.id LIMIT 3`).all(text, text, normalizedScope, normalizedScope) as Array<Record<string, unknown>>;
    const subjects = rows.flatMap(subject);
    return subjects.length === 1 ? subjects[0] : subjects.length > 1 ? "ambiguous" : "not_found";
  }

  fieldEdges(subjectId: string, scope: string, maximum: number): ProfileEdge[] {
    const bounded = Math.max(1, Math.min(240, Math.trunc(maximum)));
    const rows = this.db.prepare(`SELECT e.id AS edge_id,e.type,t.id AS target_id,t.name AS target_name,t.type AS target_type,
        MAX(o.confidence) AS confidence,MAX(o.created_at) AS freshness
      FROM kg_edges e JOIN kg_nodes t ON t.id=e.target_id AND t.deleted_at IS NULL
      JOIN kg_observations o ON o.edge_id=e.id AND o.scope=?
      WHERE e.deleted_at IS NULL AND e.source_id=?
      GROUP BY e.id,e.type,t.id,t.name,t.type
      ORDER BY e.type,confidence DESC,freshness DESC,t.name,t.id LIMIT ?`).all(normalizeScope(scope), subjectId, bounded) as Array<Record<string, unknown>>;
    return rows.flatMap(edge);
  }

  provenance(edgeId: string, scope: string, maximum = 5): ProfileClaimProvenance[] {
    const bounded = Math.max(1, Math.min(10, Math.trunc(maximum)));
    const rows = this.db.prepare(`SELECT o.id AS claim_id,o.source,o.confidence,o.created_at,v.status AS verification_status
      FROM kg_observations o LEFT JOIN kg_claim_verifications v ON v.claim_id=o.id AND v.scope=o.scope
      WHERE o.edge_id=? AND o.scope=?
      ORDER BY o.confidence DESC,o.created_at DESC,o.id,v.status LIMIT ?`).all(edgeId, normalizeScope(scope), bounded * 8) as Array<Record<string, unknown>>;
    const grouped = new Map<string, { claim_id: string; source: string; confidence: number; observed_at: number; statuses: string[] }>();
    for (const row of rows) {
      const claim = claimRow(row);
      if (!claim) continue;
      const previous = grouped.get(claim.claim_id) ?? { ...claim, statuses: [] };
      if (claim.status) previous.statuses.push(claim.status);
      grouped.set(claim.claim_id, previous);
    }
    return [...grouped.values()].sort((a, b) => b.confidence - a.confidence || b.observed_at - a.observed_at || a.claim_id.localeCompare(b.claim_id))
      .slice(0, bounded).map(item => ({ claim_id: item.claim_id, source: item.source, confidence: item.confidence, observed_at: item.observed_at, verification: verification(item.statuses) }));
  }

  conflictIds(edgeIds: readonly string[]): Map<string, string[]> {
    const ids = [...new Set(edgeIds.filter(id => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, 240);
    const found = new Map(ids.map(id => [id, [] as string[]]));
    if (!ids.length) return found;
    const rows = this.db.prepare(`SELECT id,edge_a,edge_b FROM kg_conflict_candidates
      WHERE status='pending' AND (edge_a IN (${ids.map(() => "?").join(",")}) OR edge_b IN (${ids.map(() => "?").join(",")}))
      ORDER BY id LIMIT 100`).all(...ids, ...ids) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = boundedId(row.id), a = boundedId(row.edge_a), b = boundedId(row.edge_b);
      if (!id) continue;
      if (a && found.has(a)) found.get(a)!.push(id);
      if (b && found.has(b)) found.get(b)!.push(id);
    }
    for (const values of found.values()) values.sort();
    return found;
  }
}

function subject(value: Record<string, unknown>): ProfileSubject[] {
  const id = boundedId(value.id), name = boundedText(value.name, 200), type = nodeType(value.type);
  return id && name && type ? [{ id, name, type }] : [];
}
function edge(value: Record<string, unknown>): ProfileEdge[] {
  const edgeId = boundedId(value.edge_id), key = relationshipType(value.type), entity = subject({ id: value.target_id, name: value.target_name, type: value.target_type })[0];
  const confidence = boundedConfidence(value.confidence), freshness = nonNegativeInteger(value.freshness);
  return edgeId && key && entity ? [{ edge_id: edgeId, key, entity, confidence, freshness }] : [];
}
function claimRow(value: Record<string, unknown>): { claim_id: string; source: string; confidence: number; observed_at: number; status?: string } | undefined {
  const claim_id = boundedId(value.claim_id), source = boundedText(value.source, 256);
  return claim_id && source ? { claim_id, source, confidence: boundedConfidence(value.confidence), observed_at: nonNegativeInteger(value.created_at), ...(typeof value.verification_status === "string" ? { status: value.verification_status } : {}) } : undefined;
}
function verification(statuses: string[]): ProfileClaimVerification {
  const known = new Set(statuses);
  for (const status of ["contradicted", "rejected", "stale", "flagged", "unverifiable", "pending", "superseded", "verified"] as const) if (known.has(status)) return status;
  return "not_anchored";
}
function relationshipType(value: unknown): RelationshipType | undefined { return typeof value === "string" && ["works_at", "invested_in", "supplies", "supplies_product", "supplied_to", "competes_with", "uses", "develops", "owns", "partners_with", "in_portfolio", "related_to"].includes(value) ? value as RelationshipType : undefined; }
function nodeType(value: unknown): NodeType | undefined { return typeof value === "string" && ["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"].includes(value) ? value as NodeType : undefined; }
function boundedId(value: unknown): string | undefined { return boundedText(value, 200); }
function boundedText(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value) ? value : undefined; }
function nonNegativeInteger(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0; }
function boundedConfidence(value: unknown): number { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0; }
