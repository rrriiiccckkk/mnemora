import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { SemanticPatternCandidate } from "../types.js";

const identifier = (scope: string, domain: string, sourceType: string, predicate: string, targetType: string) =>
  `semantic-pattern:${createHash("sha256").update([scope, domain, sourceType, predicate, targetType].join("\u0000")).digest("hex").slice(0, 40)}`;

export class SemanticPatternRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  record(input: { scope: string; domain: "investment" | "code" | "unknown"; sourceType: string; predicate: string; targetType: string; now?: number }): SemanticPatternCandidate {
    const scope = normalizeScope(input.scope), now = input.now ?? Date.now();
    const id = identifier(scope, input.domain, input.sourceType, input.predicate, input.targetType);
    this.db.prepare(`INSERT INTO kg_semantic_pattern_candidates(
      id,scope,domain,source_type,predicate,target_type,occurrence_count,status,first_seen_at,updated_at
    ) VALUES(?,?,?,?,?,?,1,'pending',?,?) ON CONFLICT(scope,domain,source_type,predicate,target_type) DO UPDATE SET
      occurrence_count=kg_semantic_pattern_candidates.occurrence_count+1,updated_at=excluded.updated_at`)
      .run(id, scope, input.domain, input.sourceType, input.predicate, input.targetType, now, now);
    return this.get(id, scope)!;
  }

  list(scope: string, limit = 20): SemanticPatternCandidate[] {
    const safe = normalizeScope(scope), take = Math.min(100, Math.max(1, Math.trunc(limit)));
    return (this.db.prepare("SELECT * FROM kg_semantic_pattern_candidates WHERE scope=? ORDER BY status='pending' DESC,occurrence_count DESC,updated_at DESC,id LIMIT ?").all(safe, take) as Array<Record<string, unknown>>).map(map);
  }

  get(id: string, scope: string): SemanticPatternCandidate | undefined {
    const row = this.db.prepare("SELECT * FROM kg_semantic_pattern_candidates WHERE id=? AND scope=?").get(id, normalizeScope(scope)) as Record<string, unknown> | undefined;
    return row ? map(row) : undefined;
  }

  review(id: string, scope: string): { decision: "accepted" | "rejected"; preview_hash: string; audit_id: string } | undefined {
    return this.db.prepare("SELECT decision,preview_hash,audit_id FROM kg_semantic_pattern_reviews WHERE candidate_id=? AND scope=?").get(id, normalizeScope(scope)) as { decision: "accepted" | "rejected"; preview_hash: string; audit_id: string } | undefined;
  }
}

function map(row: Record<string, unknown>): SemanticPatternCandidate {
  return {
    id: String(row.id), scope: String(row.scope), domain: row.domain === "investment" || row.domain === "code" ? row.domain : "unknown",
    source_type: String(row.source_type), predicate: String(row.predicate), target_type: String(row.target_type),
    occurrence_count: Number(row.occurrence_count), status: row.status === "accepted" || row.status === "rejected" ? row.status : "pending",
    first_seen_at: Number(row.first_seen_at), updated_at: Number(row.updated_at), reviewed_at: row.reviewed_at == null ? null : Number(row.reviewed_at)
  };
}
