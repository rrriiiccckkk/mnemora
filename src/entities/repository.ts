import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { NodeType } from "../types.js";

/**
 * Indexed identity/alias access for graph entities.  The table is maintained by
 * SQLite triggers so every supported write path, including restore/import, has
 * the same lookup behavior without scanning the active node set.
 */
export class EntityRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  findExisting(type: NodeType, names: readonly string[]): string | undefined {
    const values = normalizedValues(names);
    if (!values.length) return undefined;
    // Keep the lookup driven by idx_kg_entity_identities_lookup.  Sorting on
    // kg_nodes.id here used to make SQLite scan the active-node side as the
    // graph grew; we only need to know whether the identity is unambiguous.
    const rows = this.db.prepare(`SELECT i.node_id AS id FROM kg_entity_identities i
      JOIN kg_nodes n ON n.id=i.node_id AND n.deleted_at IS NULL
      WHERE i.type=? AND i.value_normalized IN (${values.map(() => "?").join(",")})
      GROUP BY i.node_id LIMIT 2`).all(type, ...values) as Array<{ id: string }>;
    return rows.length === 1 ? rows[0]?.id : undefined;
  }

  resolveExact(input: string, scope?: string): string | undefined {
    const query = normalizedValue(input);
    if (!query) return undefined;
    const normalizedScope = scope == null ? null : normalizeScope(scope);
    const rows = this.db.prepare(`SELECT DISTINCT n.id FROM kg_nodes n
      LEFT JOIN kg_entity_identities i ON i.node_id=n.id
      WHERE n.deleted_at IS NULL
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
          WHERE o.scope=? AND (o.source_entity_id=n.id OR e.source_id=n.id OR e.target_id=n.id)
        ))
        AND (lower(n.id)=? OR i.value_normalized=?)
      ORDER BY n.id LIMIT 2`).all(normalizedScope, normalizedScope, query, query) as Array<{ id: string }>;
    return rows.length === 1 ? rows[0]?.id : undefined;
  }

  /** Rebuild is only used by the v1.6 migration and explicit database restore. */
  rebuild(): void {
    this.db.exec("DELETE FROM kg_entity_identities");
    this.db.exec(`INSERT OR IGNORE INTO kg_entity_identities(node_id,type,value_normalized,value_display,kind,created_at,updated_at)
      SELECT id,type,lower(trim(name)),name,'name',created_at,updated_at
      FROM kg_nodes WHERE typeof(name)='text' AND length(trim(name))>0`);
    this.db.exec(`INSERT OR IGNORE INTO kg_entity_identities(node_id,type,value_normalized,value_display,kind,created_at,updated_at)
      SELECT n.id,n.type,lower(trim(CAST(a.value AS TEXT))),CAST(a.value AS TEXT),'alias',n.created_at,n.updated_at
      FROM kg_nodes n JOIN json_each(CASE WHEN json_valid(n.aliases) THEN n.aliases ELSE '[]' END) a
      WHERE typeof(a.value)='text' AND length(trim(CAST(a.value AS TEXT)))>0`);
  }
}

export function normalizedEntityIdentity(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizedValue(value: unknown): string | undefined {
  const normalized = normalizedEntityIdentity(value);
  return normalized && normalized.length <= 512 && !/[\u0000-\u001f]/.test(normalized) ? normalized : undefined;
}
function normalizedValues(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizedValue).filter((value): value is string => Boolean(value)))].slice(0, 32);
}
