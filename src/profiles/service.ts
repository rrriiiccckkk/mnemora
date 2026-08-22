import { normalizeScope } from "../scope.js";
import type { ProfileField, ProfileProjection } from "./types.js";
import { ProfileProjectionRepository } from "./repository.js";
import { ProfileSelectionRepository } from "./selection-repository.js";
import { ProfileHistoryRepository } from "./history-repository.js";

export interface ProfileProjectionInput {
  subject: string;
  scope?: string;
  limit?: number;
}

/** Deterministically rebuilds a read-only profile from Mnemora-owned source rows. */
export class ProfileProjectionService {
  constructor(private readonly repository: ProfileProjectionRepository, private readonly selections?: ProfileSelectionRepository, private readonly history?: ProfileHistoryRepository) {}

  project(input: ProfileProjectionInput): ProfileProjection {
    const scope = normalizeScope(input.scope, "default");
    const revisions = this.repository.revisions();
    const subject = this.repository.resolveSubject(input.subject, scope);
    if (subject === "not_found" || subject === "ambiguous") return { projection_version: "profile-projection-v1", status: subject, scope, ...revisions, fields: [] };
    const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 10)));
    const edges = this.repository.fieldEdges(subject.id, scope, Math.min(240, limit * 12 + 1));
    const conflicts = this.repository.conflictIds(edges.map(edge => edge.edge_id));
    const grouped = new Map<string, typeof edges>();
    for (const edge of edges) grouped.set(edge.key, [...(grouped.get(edge.key) ?? []), edge]);
    const selections = this.selections?.list(scope, subject.id) ?? new Map();
    const staleSelections = this.selections?.listStale(scope, subject.id) ?? [];
    const fields: ProfileField[] = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => {
      const selected = values.slice(0, limit);
      const selection = selections.get(key as ProfileField["key"]);
      return {
        key: key as ProfileField["key"],
        values: selected.map(value => ({ entity: value.entity, confidence: value.confidence, freshness: value.freshness, provenance: this.repository.provenance(value.edge_id, scope), conflict_candidate_ids: conflicts.get(value.edge_id) ?? [] })),
        ...(selection ? { selection: { entity: selection.entity, locked: true as const, updated_at: selection.updated_at } } : {}),
        conflict: selected.some(value => (conflicts.get(value.edge_id)?.length ?? 0) > 0),
        truncated: values.length > selected.length
      };
    });
    const projection = { projection_version: "profile-projection-v1" as const, status: "ok" as const, scope, ...revisions, subject, fields, ...(staleSelections.length ? { stale_selections: staleSelections } : {}) };
    try { this.history?.record(projection); } catch { /* profile reads stay available if audit persistence is unavailable */ }
    return projection;
  }
}
