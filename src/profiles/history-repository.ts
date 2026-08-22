import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { ProfileProjection } from "./types.js";

export interface ProfileSnapshotSummary {
  id: string;
  scope: string;
  subject_id: string;
  graph_revision: number;
  trust_revision: number;
  snapshot_hash: string;
  created_at: number;
}

/** Owns bounded, material-change profile snapshots; it never writes graph facts or selections. */
export class ProfileHistoryRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  record(profile: ProfileProjection): ProfileSnapshotSummary | undefined {
    if (profile.status !== "ok" || !profile.subject) return undefined;
    const material = { projection_version: profile.projection_version, status: profile.status, scope: profile.scope, subject: profile.subject, fields: profile.fields, ...(profile.stale_selections?.length ? { stale_selections: profile.stale_selections } : {}) };
    const snapshotHash = createHash("sha256").update(JSON.stringify(material)).digest("hex");
    const id = `profile-snapshot:${snapshotHash.slice(0, 40)}`;
    const now = this.now();
    this.db.prepare(`INSERT OR IGNORE INTO kg_profile_projection_snapshots(
      id,scope,subject_id,projection_version,graph_revision,trust_revision,snapshot_hash,snapshot,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(id, normalizeScope(profile.scope), profile.subject.id, profile.projection_version, profile.graph_revision, profile.trust_revision, snapshotHash, JSON.stringify(material), now);
    return this.get(id)?.summary;
  }

  list(input: { scope?: string; subject_id: string; limit?: number; before_id?: string }): ProfileSnapshotSummary[] {
    const scope = normalizeScope(input.scope), subjectId = boundedId(input.subject_id), limit = clamp(input.limit, 20, 1, 100), before = boundedId(input.before_id);
    if (!subjectId) return [];
    const rows = this.db.prepare(`SELECT id,scope,subject_id,graph_revision,trust_revision,snapshot_hash,created_at
      FROM kg_profile_projection_snapshots WHERE scope=? AND subject_id=? AND (? IS NULL OR id<?)
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(scope, subjectId, before ?? null, before ?? null, limit) as Array<Record<string, unknown>>;
    return rows.flatMap(summary);
  }

  get(id: string): { summary: ProfileSnapshotSummary; profile: ProfileProjection } | undefined {
    const row = this.db.prepare("SELECT id,scope,subject_id,graph_revision,trust_revision,snapshot_hash,snapshot,created_at FROM kg_profile_projection_snapshots WHERE id=?").get(boundedId(id)) as Record<string, unknown> | undefined;
    const current = row ? summary(row)[0] : undefined;
    if (!current || typeof row?.snapshot !== "string" || row.snapshot.length > 1_048_576) return undefined;
    try {
      const parsed = JSON.parse(row.snapshot) as ProfileProjection;
      return validSnapshot(parsed, current.subject_id, current.scope) ? { summary: current, profile: { ...parsed, graph_revision: current.graph_revision, trust_revision: current.trust_revision } } : undefined;
    } catch { return undefined; }
  }
}

function summary(row: Record<string, unknown>): ProfileSnapshotSummary[] {
  const id = boundedId(row.id), scope = safeScope(row.scope), subjectId = boundedId(row.subject_id), hash = typeof row.snapshot_hash === "string" && /^[a-f0-9]{64}$/.test(row.snapshot_hash) ? row.snapshot_hash : undefined;
  return id && scope && subjectId && hash ? [{ id, scope, subject_id: subjectId, graph_revision: integer(row.graph_revision), trust_revision: integer(row.trust_revision), snapshot_hash: hash, created_at: integer(row.created_at) }] : [];
}
function validSnapshot(value: unknown, subjectId: string, scope: string): value is ProfileProjection { return typeof value === "object" && value !== null && (value as ProfileProjection).projection_version === "profile-projection-v1" && (value as ProfileProjection).status === "ok" && (value as ProfileProjection).scope === scope && (value as ProfileProjection).subject?.id === subjectId && Array.isArray((value as ProfileProjection).fields); }
function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number { const number = Number(value); return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.trunc(number))) : fallback; }
function boundedId(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value) ? value : undefined; }
function safeScope(value: unknown): string | undefined { try { return normalizeScope(value); } catch { return undefined; } }
function integer(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0; }
