import { randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { RelationshipType } from "../relationships.js";
import type { ProfileStaleSelection, ProfileSubject } from "./types.js";

export interface StoredProfileSelection {
  key: RelationshipType;
  entity: ProfileSubject;
  locked: true;
  updated_at: number;
}

interface RevisionSnapshot { graph_revision: number; trust_revision: number; }

/** Owns the user-selection layer only; source graph and trust rows remain immutable here. */
export class ProfileSelectionRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  list(scope: string, subjectId: string): Map<RelationshipType, StoredProfileSelection> {
    const rows = this.db.prepare(`SELECT s.field_key,s.updated_at,n.id,n.name,n.type
      FROM kg_profile_selections s JOIN kg_nodes n ON n.id=s.target_id AND n.deleted_at IS NULL
      WHERE s.scope=? AND s.subject_id=? AND s.locked=1 AND EXISTS (
        SELECT 1 FROM kg_edges e JOIN kg_observations o ON o.edge_id=e.id AND o.scope=s.scope
        WHERE e.source_id=s.subject_id AND e.target_id=s.target_id AND e.type=s.field_key AND e.deleted_at IS NULL
      )
      ORDER BY s.field_key,n.name,n.id`).all(normalizeScope(scope), subjectId) as Array<Record<string, unknown>>;
    const values = new Map<RelationshipType, StoredProfileSelection>();
    for (const row of rows) {
      const key = relationshipType(row.field_key), entity = profileSubject(row), updatedAt = nonNegativeInteger(row.updated_at);
      if (key && entity) values.set(key, { key, entity, locked: true, updated_at: updatedAt });
    }
    return values;
  }

  current(scope: string, subjectId: string, fieldKey: RelationshipType): StoredProfileSelection | undefined {
    const row = this.db.prepare(`SELECT s.field_key,s.updated_at,n.id,n.name,n.type
      FROM kg_profile_selections s JOIN kg_nodes n ON n.id=s.target_id
      WHERE s.scope=? AND s.subject_id=? AND s.field_key=? AND s.locked=1`).get(normalizeScope(scope), subjectId, fieldKey) as Record<string, unknown> | undefined;
    const key = relationshipType(row?.field_key), entity = row ? profileSubject(row) : undefined;
    return key && entity ? { key, entity, locked: true, updated_at: nonNegativeInteger(row?.updated_at) } : undefined;
  }

  listStale(scope: string, subjectId: string): ProfileStaleSelection[] {
    const rows = this.db.prepare(`SELECT s.field_key,s.updated_at,n.id,n.name,n.type,n.deleted_at,
        CASE WHEN n.deleted_at IS NULL THEN 'missing_evidence' ELSE 'target_deleted' END AS stale_reason
      FROM kg_profile_selections s JOIN kg_nodes n ON n.id=s.target_id
      WHERE s.scope=? AND s.subject_id=? AND s.locked=1 AND (
        n.deleted_at IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM kg_edges e JOIN kg_observations o ON o.edge_id=e.id AND o.scope=s.scope
          WHERE e.source_id=s.subject_id AND e.target_id=s.target_id AND e.type=s.field_key AND e.deleted_at IS NULL
        )
      ) ORDER BY s.field_key,n.name,n.id`).all(normalizeScope(scope), subjectId) as Array<Record<string, unknown>>;
    const stale: ProfileStaleSelection[] = [];
    for (const row of rows) {
      const key = relationshipType(row.field_key), entity = profileSubject(row), reason = row.stale_reason;
      if (key && entity && (reason === "missing_evidence" || reason === "target_deleted")) stale.push({ key, entity, locked: true, updated_at: nonNegativeInteger(row.updated_at), reason });
    }
    return stale;
  }

  replace(input: { scope: string; subject_id: string; field_key: RelationshipType; target_id?: string; revisions: RevisionSnapshot; now: number }): { audit_id: string; selection?: StoredProfileSelection } {
    const scope = normalizeScope(input.scope), now = nonNegativeInteger(input.now);
    const previous = this.current(scope, input.subject_id, input.field_key);
    const action = input.target_id ? "set" as const : "clear" as const;
    const auditId = `profile-selection:${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.target_id) {
        this.db.prepare(`INSERT INTO kg_profile_selections(scope,subject_id,field_key,target_id,locked,created_at,updated_at)
          VALUES(?,?,?,?,1,?,?) ON CONFLICT(scope,subject_id,field_key) DO UPDATE SET target_id=excluded.target_id,locked=1,updated_at=excluded.updated_at`)
          .run(scope, input.subject_id, input.field_key, input.target_id, now, now);
      } else {
        this.db.prepare("DELETE FROM kg_profile_selections WHERE scope=? AND subject_id=? AND field_key=?").run(scope, input.subject_id, input.field_key);
      }
      this.db.prepare(`INSERT INTO kg_profile_selection_audits(
        id,scope,subject_id,field_key,action,previous_target_id,target_id,graph_revision,trust_revision,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        auditId, scope, input.subject_id, input.field_key, action, previous?.entity.id ?? null, input.target_id ?? null,
        input.revisions.graph_revision, input.revisions.trust_revision, now
      );
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
    return { audit_id: auditId, ...(input.target_id ? { selection: this.current(scope, input.subject_id, input.field_key) } : {}) };
  }
}

function profileSubject(value: Record<string, unknown>): ProfileSubject | undefined {
  const id = boundedText(value.id, 200), name = boundedText(value.name, 200);
  const type = typeof value.type === "string" && ["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"].includes(value.type) ? value.type as ProfileSubject["type"] : undefined;
  return id && name && type ? { id, name, type } : undefined;
}
function relationshipType(value: unknown): RelationshipType | undefined { return typeof value === "string" && ["works_at", "invested_in", "supplies", "supplies_product", "supplied_to", "competes_with", "uses", "develops", "owns", "partners_with", "in_portfolio", "related_to"].includes(value) ? value as RelationshipType : undefined; }
function boundedText(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value) ? value : undefined; }
function nonNegativeInteger(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0; }
