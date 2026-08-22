import { normalizeScope } from "../scope.js";
import { ProfileHistoryRepository, type ProfileSnapshotSummary } from "./history-repository.js";
import { ProfileProjectionRepository } from "./repository.js";
import type { ProfileProjection } from "./types.js";

export interface ProfileHistoryResult {
  history_version: "profile-history-v1";
  scope: string;
  subject_id?: string;
  status: "ok" | "not_found" | "ambiguous";
  items: ProfileSnapshotSummary[];
}
export interface ProfileDiffResult {
  diff_version: "profile-diff-v1";
  scope: string;
  subject_id?: string;
  status: "ok" | "not_found" | "ambiguous" | "insufficient_history" | "snapshot_not_found";
  before?: ProfileSnapshotSummary;
  after?: ProfileSnapshotSummary;
  changes: Array<{ field: string; kind: "added" | "removed" | "values_changed" | "selection_changed" | "conflict_changed"; before?: unknown; after?: unknown }>;
}

/** Read-only profile-history query and deterministic diff service. */
export class ProfileHistoryService {
  constructor(private readonly projection: ProfileProjectionRepository, private readonly history: ProfileHistoryRepository) {}

  list(input: { subject: string; scope?: string; limit?: number; before_id?: string }): ProfileHistoryResult {
    const scope = normalizeScope(input.scope, "default"), subject = this.projection.resolveSubject(input.subject, scope);
    if (typeof subject === "string") return { history_version: "profile-history-v1", scope, status: subject, items: [] };
    return { history_version: "profile-history-v1", scope, subject_id: subject.id, status: "ok", items: this.history.list({ scope, subject_id: subject.id, limit: input.limit, before_id: input.before_id }) };
  }

  diff(input: { subject: string; scope?: string; before_id?: string; after_id?: string }): ProfileDiffResult {
    const scope = normalizeScope(input.scope, "default"), subject = this.projection.resolveSubject(input.subject, scope);
    if (typeof subject === "string") return { diff_version: "profile-diff-v1", scope, status: subject, changes: [] };
    const listed = this.history.list({ scope, subject_id: subject.id, limit: 2 });
    const after = input.after_id ? this.history.get(input.after_id) : listed[0] ? this.history.get(listed[0].id) : undefined;
    const before = input.before_id ? this.history.get(input.before_id) : listed[1] ? this.history.get(listed[1].id) : undefined;
    if (input.after_id && (!after || after.summary.scope !== scope || after.summary.subject_id !== subject.id) || input.before_id && (!before || before.summary.scope !== scope || before.summary.subject_id !== subject.id)) return { diff_version: "profile-diff-v1", scope, subject_id: subject.id, status: "snapshot_not_found", changes: [] };
    if (!before || !after) return { diff_version: "profile-diff-v1", scope, subject_id: subject.id, status: "insufficient_history", changes: [] };
    return { diff_version: "profile-diff-v1", scope, subject_id: subject.id, status: "ok", before: before.summary, after: after.summary, changes: diff(before.profile, after.profile) };
  }
}

function diff(before: ProfileProjection, after: ProfileProjection): ProfileDiffResult["changes"] {
  const map = (profile: ProfileProjection) => new Map(profile.fields.map(field => [field.key, field]));
  const left = map(before), right = map(after), keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes: ProfileDiffResult["changes"] = [];
  for (const key of keys) {
    const previous = left.get(key), current = right.get(key);
    if (!previous && current) { changes.push({ field: key, kind: "added", after: compactField(current) }); continue; }
    if (previous && !current) { changes.push({ field: key, kind: "removed", before: compactField(previous) }); continue; }
    if (!previous || !current) continue;
    if (JSON.stringify(compactValues(previous)) !== JSON.stringify(compactValues(current))) changes.push({ field: key, kind: "values_changed", before: compactValues(previous), after: compactValues(current) });
    if (JSON.stringify(previous.selection ?? null) !== JSON.stringify(current.selection ?? null)) changes.push({ field: key, kind: "selection_changed", before: previous.selection ?? null, after: current.selection ?? null });
    if (previous.conflict !== current.conflict) changes.push({ field: key, kind: "conflict_changed", before: previous.conflict, after: current.conflict });
  }
  return changes.slice(0, 100);
}
function compactField(field: ProfileProjection["fields"][number]) { return { values: compactValues(field), selection: field.selection ?? null, conflict: field.conflict }; }
function compactValues(field: ProfileProjection["fields"][number]) { return field.values.map(value => ({ entity: value.entity, confidence: value.confidence, freshness: value.freshness, claim_ids: value.provenance.map(item => item.claim_id), conflict_candidate_ids: value.conflict_candidate_ids })); }
