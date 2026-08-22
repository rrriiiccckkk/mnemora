import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { SourceAnchorStatus, VerificationStatus } from "./types.js";

export interface SourceLifecycleReport {
  lifecycle_version: "source-lifecycle-v1";
  scope: string;
  generated_at: number;
  freshness_after_days: number;
  summary: { total: number; fresh: number; aging: number; overdue: number; unavailable: number; revalidation_required: number };
  items: SourceLifecycleItem[];
  truncated: boolean;
}
export interface SourceLifecycleItem {
  source_anchor_id: string;
  provider: string;
  source_status: SourceAnchorStatus;
  verification_status: VerificationStatus;
  captured_at: number;
  last_checked_at: number | null;
  freshness: "fresh" | "aging" | "overdue" | "unavailable";
  claim_count: number;
  revalidation_required: boolean;
}

/**
 * Read-only lifecycle view over Mnemora-owned source anchors. It does not invoke a
 * Provider, resolve an external ID, or expose source labels, IDs, snapshots,
 * credentials, evidence text, or provider payloads.
 */
export class SourceLifecycleService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  status(input: { scope?: string; limit?: number; freshnessAfterDays?: number } = {}): SourceLifecycleReport {
    const scope = normalizeScope(input.scope);
    const limit = clamp(input.limit, 20, 1, 100);
    const freshnessAfterDays = clamp(input.freshnessAfterDays, 30, 1, 3650);
    const generatedAt = this.now();
    const rows = this.db.prepare(`SELECT a.id,a.provider,a.status AS source_status,a.captured_at,a.last_checked_at,
        CASE WHEN SUM(CASE WHEN v.status='contradicted' THEN 1 ELSE 0 END)>0 THEN 'contradicted'
             WHEN SUM(CASE WHEN v.status='rejected' THEN 1 ELSE 0 END)>0 THEN 'rejected'
             WHEN SUM(CASE WHEN v.status='stale' THEN 1 ELSE 0 END)>0 THEN 'stale'
             WHEN SUM(CASE WHEN v.status='flagged' THEN 1 ELSE 0 END)>0 THEN 'flagged'
             WHEN SUM(CASE WHEN v.status='unverifiable' THEN 1 ELSE 0 END)>0 THEN 'unverifiable'
             WHEN SUM(CASE WHEN v.status='pending' THEN 1 ELSE 0 END)>0 THEN 'pending'
             WHEN SUM(CASE WHEN v.status='verified' THEN 1 ELSE 0 END)>0 THEN 'verified'
             WHEN SUM(CASE WHEN v.status='superseded' THEN 1 ELSE 0 END)>0 THEN 'superseded'
             ELSE 'pending' END AS verification_status,
        COUNT(v.id) AS claim_count,
        MAX(CASE WHEN v.status IN ('stale','contradicted','flagged') THEN 1 ELSE 0 END) AS revalidation_required
      FROM kg_source_anchors a LEFT JOIN kg_claim_verifications v ON v.source_anchor_id=a.id
      WHERE a.scope=? GROUP BY a.id
      ORDER BY a.captured_at DESC,a.id ASC LIMIT ?`).all(scope, limit + 1) as Array<Record<string, unknown>>;
    const decoded = rows.flatMap(row => item(row, generatedAt, freshnessAfterDays));
    const truncated = decoded.length > limit;
    const items = decoded.slice(0, limit);
    const cutoff = generatedAt - freshnessAfterDays * 86_400_000;
    const agingCutoff = generatedAt - freshnessAfterDays * 43_200_000;
    const aggregate = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status!='available' THEN 1 ELSE 0 END) AS unavailable,
      SUM(CASE WHEN status='available' AND COALESCE(last_checked_at,captured_at)<? THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN status='available' AND COALESCE(last_checked_at,captured_at)>=? AND COALESCE(last_checked_at,captured_at)<? THEN 1 ELSE 0 END) AS aging,
      SUM(CASE WHEN status='available' AND COALESCE(last_checked_at,captured_at)>=? THEN 1 ELSE 0 END) AS fresh,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM kg_claim_verifications v WHERE v.source_anchor_id=kg_source_anchors.id AND v.status IN ('stale','contradicted','flagged')) THEN 1 ELSE 0 END) AS revalidation_required
      FROM kg_source_anchors WHERE scope=?`).get(cutoff, agingCutoff, cutoff, agingCutoff, scope) as Record<string, unknown>;
    const summary = { total: integer(aggregate.total), fresh: integer(aggregate.fresh), aging: integer(aggregate.aging), overdue: integer(aggregate.overdue), unavailable: integer(aggregate.unavailable), revalidation_required: integer(aggregate.revalidation_required) };
    return { lifecycle_version: "source-lifecycle-v1", scope, generated_at: generatedAt, freshness_after_days: freshnessAfterDays, summary, items, truncated };
  }
}

function item(row: Record<string, unknown>, now: number, freshnessAfterDays: number): SourceLifecycleItem[] {
  const sourceAnchorId = text(row.id, 200), provider = providerId(row.provider), sourceStatus = sourceAnchorStatus(row.source_status), claimVerificationStatus = claimStatus(row.verification_status);
  const capturedAt = integer(row.captured_at), lastCheckedAt = row.last_checked_at == null ? null : integer(row.last_checked_at);
  if (!sourceAnchorId || !provider || !sourceStatus || !claimVerificationStatus || !capturedAt) return [];
  const reference = lastCheckedAt ?? capturedAt;
  const age = Math.max(0, now - reference);
  const freshness = sourceStatus !== "available" ? "unavailable" : age > freshnessAfterDays * 86_400_000 ? "overdue" : age > freshnessAfterDays * 43_200_000 ? "aging" : "fresh";
  return [{ source_anchor_id: sourceAnchorId, provider, source_status: sourceStatus, verification_status: claimVerificationStatus, captured_at: capturedAt, last_checked_at: lastCheckedAt, freshness, claim_count: integer(row.claim_count), revalidation_required: row.revalidation_required === 1 }];
}
function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number { const number = Number(value); return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.trunc(number))) : fallback; }
function text(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value) ? value : undefined; }
function providerId(value: unknown): string | undefined { return typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(value) ? value : undefined; }
function sourceAnchorStatus(value: unknown): SourceAnchorStatus | undefined { return ["available", "missing", "deleted", "changed", "legacy"].includes(value as string) ? value as SourceAnchorStatus : undefined; }
function claimStatus(value: unknown): VerificationStatus | undefined { return ["pending", "verified", "flagged", "rejected", "unverifiable", "contradicted", "stale", "superseded"].includes(value as string) ? value as VerificationStatus : undefined; }
function integer(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0; }
