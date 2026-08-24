import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { KgMemorySearchResult } from "../types.js";
import { normalizeScope } from "../scope.js";

export type MemoryTier = "core" | "working" | "peripheral";
export type MemoryLifecycleOptions = {
  enabled: boolean;
  accessReinforcement: boolean;
  corePromotionAccesses: number;
  temporalInference: boolean;
};

type LifecycleRow = {
  document_id: string;
  scope: string;
  tier: MemoryTier;
  access_count: number;
  last_accessed_at: number | null;
  expires_at: number | null;
  expiry_reason: string | null;
  updated_at: number;
};

const day = 86_400_000;
const tiers = new Set<MemoryTier>(["core", "working", "peripheral"]);
const bounded = (value: unknown, fallback: number, min: number, max: number) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : fallback;

/**
 * A local, evidence-preserving retrieval overlay for canonical memory
 * documents. It never archives, deletes, edits content, or changes truth
 * confidence. Automatic promotion is deliberately limited to manual memory
 * documents; automatic captures stay at their current tier until an operator
 * explicitly changes them.
 */
export class MemoryDocumentLifecycleService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly options: MemoryLifecycleOptions, private readonly now: () => number = Date.now) {}

  decorate(items: readonly KgMemorySearchResult[]): KgMemorySearchResult[] {
    if (!this.options.enabled || !items.length) return [...items];
    const rows = this.rows(items.map(item => ({ id: item.id, scope: item.scope })));
    const now = this.now();
    return items.map(item => {
      const row = rows.get(`${normalizeScope(item.scope)}\0${item.id}`);
      if (!row) return item;
      const tierFactor = row.tier === "core" ? 1.04 : row.tier === "peripheral" ? .88 : 1;
      // An inferred date is a review signal, not a destructive lifecycle
      // action. Keep expired material visible for explicit search, but ensure
      // current evidence wins ties in automatic ranking.
      const expiryFactor = row.expires_at != null && row.expires_at < now ? .5 : 1;
      const score = Math.round(Math.max(0, Math.min(1, item.score * tierFactor * expiryFactor)) * 1_000_000) / 1_000_000;
      return {
        ...item,
        score,
        memory_tier: row.tier,
        memory_access_count: row.access_count,
        ...(row.expires_at != null ? { memory_expires_at: row.expires_at } : {}),
        ...(row.expiry_reason ? { memory_expiry_reason: row.expiry_reason } : {})
      };
    });
  }

  recordAccess(items: readonly KgMemorySearchResult[]): void {
    this.recordAccessRefs(items.map(item => ({ id: item.id, scope: item.scope })));
  }

  recordAccessRefs(items: readonly { id: string; scope: string }[]): void {
    if (!(this.options.enabled && this.options.accessReinforcement) || !items.length) return;
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const read = this.db.prepare("SELECT d.source,l.tier,l.access_count FROM kg_memory_documents d JOIN mnemora_memory_document_lifecycle l ON l.document_id=d.id WHERE d.id=? AND d.scope=? AND d.lifecycle_state='active'");
      const update = this.db.prepare("UPDATE mnemora_memory_document_lifecycle SET access_count=?,last_accessed_at=?,tier=?,updated_at=? WHERE document_id=? AND scope=?");
      for (const item of items.slice(0, 20)) {
        const row = read.get(item.id, normalizeScope(item.scope)) as { source?: unknown; tier?: unknown; access_count?: unknown } | undefined;
        if (!row || !tiers.has(row.tier as MemoryTier)) continue;
        const source = typeof row.source === "string" ? row.source : "";
        const count = Math.max(0, Number(row.access_count) || 0) + 1;
        // Only an explicitly manual source may be promoted by repeated use.
        const tier: MemoryTier = source === "memory:manual" && row.tier === "working" && count >= this.options.corePromotionAccesses ? "core" : row.tier as MemoryTier;
        update.run(count, now, tier, now, item.id, normalizeScope(item.scope));
      }
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ } throw error; }
  }

  /** Score-only lifecycle overlay used by unified ContextEngine retrieval. */
  overlay(documentId: string, scope: string): { factor: number } | undefined {
    if (!this.options.enabled) return undefined;
    const row = this.one(documentId, scope);
    if (!row) return undefined;
    const tierFactor = row.tier === "core" ? 1.04 : row.tier === "peripheral" ? .88 : 1;
    const expiryFactor = row.expires_at != null && row.expires_at < this.now() ? .5 : 1;
    return { factor: tierFactor * expiryFactor };
  }

  review(scope: string, limit?: number): { scope: string; items: Array<{ document_id: string; title: string; tier: MemoryTier; access_count: number; expires_at: number | null; expiry_reason: string | null; expired: boolean }>; truncated: boolean } {
    const safe = normalizeScope(scope), maximum = bounded(limit, 20, 1, 100), now = this.now();
    const rows = this.db.prepare(`SELECT l.document_id,d.title,l.tier,l.access_count,l.expires_at,l.expiry_reason
      FROM mnemora_memory_document_lifecycle l JOIN kg_memory_documents d ON d.id=l.document_id
      WHERE l.scope=? AND d.lifecycle_state='active'
      ORDER BY CASE l.tier WHEN 'core' THEN 0 WHEN 'working' THEN 1 ELSE 2 END,l.updated_at DESC,l.document_id
      LIMIT ?`).all(safe, maximum + 1) as Array<LifecycleRow & { title: string }>;
    return {
      scope: safe,
      items: rows.slice(0, maximum).map(row => ({ document_id: row.document_id, title: row.title.slice(0, 200), tier: row.tier, access_count: row.access_count, expires_at: row.expires_at, expiry_reason: row.expiry_reason, expired: row.expires_at != null && row.expires_at < now })),
      truncated: rows.length > maximum
    };
  }

  previewTier(input: { documentId: string; scope: string; tier: MemoryTier }): { confirmed: false; preview_hash: string; document_id: string; scope: string; from_tier: MemoryTier; to_tier: MemoryTier } {
    const current = this.one(input.documentId, input.scope);
    if (!current || !tiers.has(input.tier)) throw new Error("memory_lifecycle_not_found");
    const value = { version: 1, document_id: current.document_id, scope: current.scope, from_tier: current.tier, to_tier: input.tier, updated_at: current.updated_at };
    return { confirmed: false, preview_hash: createHash("sha256").update(JSON.stringify(value)).digest("hex"), document_id: current.document_id, scope: current.scope, from_tier: current.tier, to_tier: input.tier };
  }

  confirmTier(input: { documentId: string; scope: string; tier: MemoryTier; previewHash: string }): { confirmed: true; document_id: string; scope: string; tier: MemoryTier } {
    const current = this.one(input.documentId, input.scope);
    if (!current || !tiers.has(input.tier)) throw new Error("memory_lifecycle_not_found");
    const value = { version: 1, document_id: current.document_id, scope: current.scope, from_tier: current.tier, to_tier: input.tier, updated_at: current.updated_at };
    const previewHash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    if (previewHash !== input.previewHash) throw new Error("stale_memory_lifecycle_preview");
    const now = this.now();
    const result = this.db.prepare("UPDATE mnemora_memory_document_lifecycle SET tier=?,updated_at=? WHERE document_id=? AND scope=? AND updated_at=?").run(input.tier, now, current.document_id, current.scope, current.updated_at) as { changes?: unknown };
    if (Number(result.changes) !== 1) throw new Error("stale_memory_lifecycle_preview");
    return { confirmed: true, document_id: current.document_id, scope: current.scope, tier: input.tier };
  }

  inferForDocument(input: { documentId: string; scope: string }): { inferred: boolean; expiresAt?: number; reason?: string } {
    if (!(this.options.enabled && this.options.temporalInference)) return { inferred: false };
    const safe = normalizeScope(input.scope);
    const row = this.db.prepare("SELECT title,content FROM kg_memory_documents WHERE id=? AND scope=? AND lifecycle_state='active'").get(input.documentId, safe) as { title?: unknown; content?: unknown } | undefined;
    if (!row) return { inferred: false };
    const inferred = inferExpiry(`${typeof row.title === "string" ? row.title : ""}\n${typeof row.content === "string" ? row.content : ""}`, this.now());
    if (!inferred) return { inferred: false };
    const now = this.now();
    this.db.prepare("UPDATE mnemora_memory_document_lifecycle SET expires_at=?,expiry_reason=?,expiry_inferred_at=?,updated_at=? WHERE document_id=? AND scope=?").run(inferred.expiresAt, inferred.reason, now, now, input.documentId, safe);
    return { inferred: true, expiresAt: inferred.expiresAt, reason: inferred.reason };
  }

  private rows(items: Array<{ id: string; scope: string }>): Map<string, LifecycleRow> {
    const found = new Map<string, LifecycleRow>();
    const query = this.db.prepare("SELECT document_id,scope,tier,access_count,last_accessed_at,expires_at,expiry_reason,updated_at FROM mnemora_memory_document_lifecycle WHERE document_id=? AND scope=?");
    for (const item of items.slice(0, 50)) {
      const row = query.get(item.id, normalizeScope(item.scope)) as LifecycleRow | undefined;
      if (row && tiers.has(row.tier)) found.set(`${row.scope}\0${row.document_id}`, row);
    }
    return found;
  }

  private one(documentId: string, scope: string): LifecycleRow | undefined {
    return this.db.prepare("SELECT l.document_id,l.scope,l.tier,l.access_count,l.last_accessed_at,l.expires_at,l.expiry_reason,l.updated_at FROM mnemora_memory_document_lifecycle l JOIN kg_memory_documents d ON d.id=l.document_id WHERE l.document_id=? AND l.scope=? AND d.lifecycle_state='active'").get(documentId, normalizeScope(scope)) as LifecycleRow | undefined;
  }
}

/** Eight bounded local expiry signals. They make a dated/temporary document
 * easier to review; no signal can archive or delete a document. */
export function inferExpiry(input: string, now = Date.now()): { expiresAt: number; reason: string } | undefined {
  const text = input.slice(0, 20_000);
  const date = text.match(/(?:expires?|valid\s*(?:until|to)|有效期至|截至|到期(?:日)?)[^\d]{0,16}([1-9]\d{3})[-/.年](0?[1-9]|1[0-2])[-/.月](3[01]|[12]\d|0?[1-9])(?:日)?(?!\d)/iu);
  if (date) {
    const year = Number(date[1]), month = Number(date[2]), dayOfMonth = Number(date[3]);
    const value = Date.UTC(year, month - 1, dayOfMonth, 23, 59, 59, 999), actual = new Date(value);
    if (Number.isFinite(value) && actual.getUTCFullYear() === year && actual.getUTCMonth() === month - 1 && actual.getUTCDate() === dayOfMonth) return { expiresAt: value, reason: "explicit_date" };
  }
  const rules: Array<[RegExp, number, string]> = [
    [/\b(?:temporary|temp|short[- ]lived|trial)\b|临时|试用|短期/u, 30, "temporary"],
    [/\b(?:today|eod)\b|今天|当日/u, 1, "today"],
    [/\b(?:this week|本周)\b/u, 7, "this_week"],
    [/\b(?:next week|下周)\b/u, 14, "next_week"],
    [/\b(?:this month|本月)\b/u, 31, "this_month"],
    [/\b(?:next month|下个月)\b/u, 62, "next_month"],
    [/\b(?:quarterly|this quarter|本季度)\b/u, 92, "quarter"],
    [/\b(?:annual|yearly|本年度)\b/u, 366, "annual"]
  ];
  for (const [pattern, days, reason] of rules) if (pattern.test(text)) return { expiresAt: now + days * day, reason };
  return undefined;
}
