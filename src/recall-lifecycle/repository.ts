import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createHash } from "node:crypto";
import { authorizeMnemoraContextRef, createMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";

type TrackableKind = "memory-document" | "belief" | "decision";

export interface RecallUsageRecord {
  scope: string;
  targetRef: string;
  targetKind: TrackableKind;
  firstRecalledAt: number;
  lastRecalledAt: number;
  recallCount: number;
}

export interface RecallDecayCandidate {
  documentId: string;
  contextRef: string;
  documentUpdatedAt: number;
  ageDays: number;
  recallCount: number;
  lastRecalledAt: number | null;
  reasonCode: "not_recalled_since_latest_write";
  nextAction: "kg_memory.lifecycle.archive_preview";
}

export interface RecallDecayReview {
  version: "recall-decay-review-v1";
  scope: string;
  minAgeDays: number;
  previewHash: string;
  candidates: RecallDecayCandidate[];
  usage: { trackedTargets: number; trackedRecalls: number };
  mutation: "none";
}

const trackableKinds: readonly TrackableKind[] = ["memory-document", "belief", "decision"];
const bounded = (value: unknown, fallback: number, min: number, max: number) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.trunc(Number(value)))) : fallback;

/**
 * Records only memories that were selected for an actual ContextEngine
 * attachment. Manual searches, speculative shadow retrieval, and provider
 * responses are intentionally not treated as recall evidence.
 */
export class RecallUsageRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  recordInjected(input: { scope: string; targetRefs: readonly string[] }): { recorded: number } {
    const scope = normalizeScope(input.scope), references = new Map<string, TrackableKind>();
    for (const value of input.targetRefs.slice(0, 20)) {
      try {
        const parsed = authorizeMnemoraContextRef(value, { scope, kinds: trackableKinds });
        references.set(parsed.canonical, parsed.kind as TrackableKind);
      } catch { /* non-trackable projections never become lifecycle evidence */ }
    }
    if (!references.size) return { recorded: 0 };
    const now = this.now(), statement = this.db.prepare(`INSERT INTO mnemora_recall_usage(scope,target_ref,target_kind,first_recalled_at,last_recalled_at,recall_count,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,target_ref) DO UPDATE SET
      target_kind=excluded.target_kind,last_recalled_at=excluded.last_recalled_at,
      recall_count=CASE WHEN mnemora_recall_usage.recall_count<2147483647 THEN mnemora_recall_usage.recall_count+1 ELSE mnemora_recall_usage.recall_count END,
      updated_at=excluded.updated_at`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [targetRef, targetKind] of references) statement.run(scope, targetRef, targetKind, now, now, 1, now);
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    return { recorded: references.size };
  }

  usage(scope: string, targetRef: string): RecallUsageRecord | undefined {
    const safeScope = normalizeScope(scope), row = this.db.prepare("SELECT scope,target_ref,target_kind,first_recalled_at,last_recalled_at,recall_count FROM mnemora_recall_usage WHERE scope=? AND target_ref=?").get(safeScope, targetRef) as { scope: string; target_ref: string; target_kind: TrackableKind; first_recalled_at: number; last_recalled_at: number; recall_count: number } | undefined;
    return row && { scope: row.scope, targetRef: row.target_ref, targetKind: row.target_kind, firstRecalledAt: Number(row.first_recalled_at), lastRecalledAt: Number(row.last_recalled_at), recallCount: Number(row.recall_count) };
  }

  summary(scope: string): { trackedTargets: number; trackedRecalls: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS targets,COALESCE(SUM(recall_count),0) AS recalls FROM mnemora_recall_usage WHERE scope=?").get(normalizeScope(scope)) as { targets: number; recalls: number };
    return { trackedTargets: Number(row.targets), trackedRecalls: Number(row.recalls) };
  }
}

/** Read-only recall-driven decay review. It never changes document state. */
export class RecallDecayReviewService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly usage: RecallUsageRepository, private readonly now: () => number = Date.now) {}

  preview(input: { scope: string; minAgeDays?: number; limit?: number }): RecallDecayReview {
    const scope = normalizeScope(input.scope), minAgeDays = bounded(input.minAgeDays, 90, 1, 36500), limit = bounded(input.limit, 20, 1, 100), now = this.now(), before = now - minAgeDays * 86_400_000;
    const rows = this.db.prepare("SELECT id,updated_at FROM kg_memory_documents WHERE scope=? AND lifecycle_state='active' AND updated_at<=? ORDER BY updated_at,id LIMIT ?").all(scope, before, Math.min(500, limit * 5)) as Array<{ id: string; updated_at: number }>;
    const candidates: RecallDecayCandidate[] = [];
    for (const row of rows) {
      const contextRef = createMnemoraContextRef({ scope, kind: "memory-document", id: row.id }), usage = this.usage.usage(scope, contextRef);
      // A recall predating the newest edit says nothing about the current
      // version. This is a relevance-review signal, never truth decay.
      if (usage?.lastRecalledAt != null && usage.lastRecalledAt >= Number(row.updated_at)) continue;
      candidates.push({ documentId: row.id, contextRef, documentUpdatedAt: Number(row.updated_at), ageDays: Math.floor(Math.max(0, now - Number(row.updated_at)) / 86_400_000), recallCount: usage?.recallCount ?? 0, lastRecalledAt: usage?.lastRecalledAt ?? null, reasonCode: "not_recalled_since_latest_write", nextAction: "kg_memory.lifecycle.archive_preview" });
      if (candidates.length >= limit) break;
    }
    const summary = this.usage.summary(scope), previewHash = digest({ version: "recall-decay-review-v1", scope, minAgeDays, candidates });
    return { version: "recall-decay-review-v1", scope, minAgeDays, previewHash, candidates, usage: summary, mutation: "none" };
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
