import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createHash } from "node:crypto";
import { authorizeMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";
import { CognitionReferenceRepository } from "./reference-repository.js";
import { sanitizeMemoryForContext } from "../retrieval/context-safety.js";

const targetKinds = ["memory-document", "belief", "decision"] as const;
const tables = { "memory-document": "kg_memory_documents", belief: "mnemora_beliefs", decision: "mnemora_decisions", "conversation-event": "mnemora_conversation_events" } as const;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Version { ref: string; hash: string; }
export interface AttachmentItem { target: Version; projectionHash: string; sources: Version[]; incompleteSources: boolean; }
type ReviewSignal = "assistant_citation" | "user_confirmation" | "user_correction";
interface ReviewInput { scope: string; receiptId: string; targetRef: string; sourceRef: string; signal: ReviewSignal; }

/** Exact assembly evidence, not causal turn attribution or automatic labels.
 * Call record only after successful attachment; snapshot before async work. */
export class RecallAttachmentEvidenceService {
  private readonly enabled: boolean;
  private readonly days: number;
  constructor(private readonly db: DatabaseSyncInstance, options: { enabled?: boolean; retentionDays?: number } = {}, private readonly now: () => number = Date.now) {
    this.enabled = options.enabled === true;
    this.days = Number.isInteger(options.retentionDays) ? Math.min(365, Math.max(1, options.retentionDays!)) : 30;
  }

  snapshot(input: { scope: string; candidates: readonly { contextRef: string; excerpt: string; sourceRefs: readonly string[] }[] }): AttachmentItem[] {
    if (!this.enabled) return [];
    const scope = normalizeScope(input.scope), items: AttachmentItem[] = [];
    for (const candidate of input.candidates.slice(0, 20)) {
      try {
        authorizeMnemoraContextRef(candidate.contextRef, { scope, kinds: targetKinds });
        const target = this.version(scope, candidate.contextRef), sources: Version[] = [];
        const reference = authorizeMnemoraContextRef(candidate.contextRef, { scope, kinds: targetKinds });
        const evidence = reference.kind === "belief" ? this.db.prepare("SELECT DISTINCT source_ref FROM mnemora_belief_evidence WHERE belief_id=? ORDER BY source_ref LIMIT 21").all(reference.id) as Array<{ source_ref: string }> : reference.kind === "decision" ? this.db.prepare("SELECT DISTINCT source_ref FROM mnemora_decision_evidence WHERE decision_id=? ORDER BY source_ref LIMIT 21").all(reference.id) as Array<{ source_ref: string }> : [];
        const sourceRefs = [...new Set([...candidate.sourceRefs, ...evidence.map(row => row.source_ref)])].filter(ref => ref !== target.ref);
        let incompleteSources = sourceRefs.length > 20;
        for (const ref of sourceRefs.slice(0, 20)) {
          if (ref === target.ref) continue;
          try {
            sources.push(this.version(scope, ref));
            // A direct record ref is not a closed proof of its own provenance.
            if (authorizeMnemoraContextRef(ref, { scope, kinds: [...targetKinds, "conversation-event"] }).kind !== "conversation-event") incompleteSources = true;
          } catch { incompleteSources = true; }
        }
        items.push({ target, projectionHash: digest(sanitizeMemoryForContext(candidate.excerpt)), sources, incompleteSources });
      } catch { /* Unsupported/invalid targets never become attachment evidence. */ }
    }
    return items;
  }

  record(input: { scope: string; id: string; items: readonly AttachmentItem[] }): { status: "disabled" | "recorded" | "replayed" | "empty" } {
    if (!this.enabled) return { status: "disabled" };
    const scope = normalizeScope(input.scope);
    this.identity(input.id);
    if (input.items.length > 20) throw new Error("invalid_attachment_evidence");
    const items = input.items.map(item => ({ target: { ref: item.target.ref, hash: item.target.hash }, projectionHash: item.projectionHash, sources: item.sources.map(source => ({ ref: source.ref, hash: source.hash })), incompleteSources: item.incompleteSources }));
    for (const item of items) {
      authorizeMnemoraContextRef(item.target.ref, { scope, kinds: targetKinds });
      if (typeof item.projectionHash !== "string" || !/^[a-f0-9]{64}$/.test(item.projectionHash) || typeof item.target.hash !== "string" || !/^[a-f0-9]{64}$/.test(item.target.hash) || item.sources.some(source => typeof source.hash !== "string" || !/^[a-f0-9]{64}$/.test(source.hash)) || typeof item.incompleteSources !== "boolean" || item.sources.length > 20) throw new Error("invalid_attachment_evidence");
    }
    const payload = JSON.stringify(items);
    if (payload.length > 131072 || new Set(items.map(item => item.target.ref)).size !== items.length) throw new Error("invalid_attachment_evidence");
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT payload_json,expires_at,created_at FROM mnemora_recall_attachment_receipts WHERE scope=? AND id=?").get(scope, input.id) as { payload_json: string; expires_at: number; created_at: number } | undefined;
      if (existing) {
        if (existing.expires_at <= this.now() || existing.created_at > this.now()) throw new Error("unavailable_attachment_receipt");
        if (existing.payload_json !== payload) throw new Error("attachment_replay_mismatch");
        return { status: "replayed" as const };
      }
      if (!items.length) return { status: "empty" as const };
      // Recheck exact record versions: an edit during graph/provider work must
      // not make the newer record masquerade as the attached older projection.
      for (const item of items) for (const version of [item.target, ...item.sources]) if (this.version(scope, version.ref).hash !== version.hash) throw new Error("stale_attachment_snapshot");
      const now = this.now();
      this.db.prepare("DELETE FROM mnemora_recall_attachment_receipts WHERE scope=? AND expires_at<=?").run(scope, now);
      this.db.prepare("INSERT INTO mnemora_recall_attachment_receipts(scope,id,payload_json,created_at,expires_at) VALUES(?,?,?,?,?)").run(scope, input.id, payload, now, now + this.days * 86400000);
      this.db.prepare("DELETE FROM mnemora_recall_attachment_receipts WHERE scope=? AND id NOT IN (SELECT id FROM mnemora_recall_attachment_receipts WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT 1000)").run(scope, scope);
      return { status: "recorded" as const };
    });
  }

  review(input: { scope: string; targetRef: string; limit?: number }) {
    const scope = normalizeScope(input.scope), ref = authorizeMnemoraContextRef(input.targetRef, { scope, kinds: targetKinds }).canonical;
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("invalid_attachment_evidence");
    return this.transaction(() => {
      const receipts: Array<{ id: string; createdAt: number; expiresAt: number; targetVersion: string; projectionHash: string; incompleteSources: boolean; reviews: Array<{ sourceRef: string; signal: ReviewSignal }> }> = [];
      const now = this.now();
      const rows = this.db.prepare("SELECT id,payload_json,created_at,expires_at FROM mnemora_recall_attachment_receipts WHERE scope=? AND created_at<=? AND expires_at>? ORDER BY created_at DESC,id DESC LIMIT 201").all(scope, now, now) as Array<{ id: string; payload_json: string; created_at: number; expires_at: number }>;
      for (const row of rows.slice(0, 200)) {
        const item = (JSON.parse(row.payload_json) as AttachmentItem[]).find(item => item.target.ref === ref);
        if (!item || !this.current(scope, item)) continue;
        const reviews = (this.db.prepare("SELECT source_ref,source_version,signal FROM mnemora_recall_attachment_reviews WHERE scope=? AND receipt_id=? AND target_ref=? AND created_at<=?").all(scope, row.id, ref, now) as Array<{ source_ref: string; source_version: string; signal: ReviewSignal }>).flatMap(review => {
          try { return this.version(scope, review.source_ref).hash === review.source_version ? [{ sourceRef: review.source_ref, signal: review.signal }] : []; } catch { return []; }
        });
        receipts.push({ id: row.id, createdAt: row.created_at, expiresAt: row.expires_at, targetVersion: item.target.hash, projectionHash: item.projectionHash, incompleteSources: item.incompleteSources, reviews });
      }
      return { version: "recall-attachment-evidence-v1" as const, scope, targetRef: ref, receipts: receipts.slice(0, limit), truncated: rows.length > 200 || receipts.length > limit, completeHistory: false as const, turnAttribution: "unavailable" as const, calibrationAction: "not_performed" as const, mutation: "none" as const };
    });
  }

  prune(scopeInput: string): { deleted: number } {
    if (!this.enabled) return { deleted: 0 };
    const scope = normalizeScope(scopeInput);
    const result = this.db.prepare("DELETE FROM mnemora_recall_attachment_receipts WHERE scope=? AND expires_at<=?").run(scope, this.now()) as { changes: number };
    return { deleted: Number(result.changes) };
  }

  previewReview(input: ReviewInput) {
    return this.transaction(() => {
      const scope = normalizeScope(input.scope);
      this.identity(input.receiptId);
      const target = authorizeMnemoraContextRef(input.targetRef, { scope, kinds: targetKinds });
      const source = authorizeMnemoraContextRef(input.sourceRef, { scope, kinds: ["conversation-event"] });
      if (!["assistant_citation", "user_confirmation", "user_correction"].includes(input.signal)) throw new Error("invalid_attachment_review");
      const row = this.db.prepare("SELECT payload_json,created_at,expires_at FROM mnemora_recall_attachment_receipts WHERE scope=? AND id=?").get(scope, input.receiptId) as { payload_json: string; created_at: number; expires_at: number } | undefined;
      const now = this.now();
      if (!row || row.expires_at <= now || row.created_at > now) throw new Error("unavailable_attachment_receipt");
      const item = (JSON.parse(row.payload_json) as AttachmentItem[]).find(item => item.target.ref === target.canonical);
      if (!item || !this.current(scope, item)) throw new Error("stale_attachment_snapshot");
      const version = this.version(scope, source.canonical);
      const event = this.db.prepare("SELECT role,created_at FROM mnemora_conversation_events WHERE scope=? AND id=?").get(scope, source.id) as { role: string; created_at: number };
      if (event.created_at < row.created_at || event.created_at > now || event.role !== (input.signal === "assistant_citation" ? "assistant" : "user")) throw new Error("invalid_attachment_review_source");
      const review = { scope, receiptId: input.receiptId, targetRef: target.canonical, sourceRef: source.canonical, sourceVersion: version.hash, signal: input.signal, targetVersion: item.target.hash, projectionHash: item.projectionHash };
      return { ...review, previewHash: digest(review), labelEvidence: "operator_reviewed_source_link" as const, causalAttribution: "unavailable" as const, mutation: "none" as const };
    });
  }

  confirmReview(input: ReviewInput & { previewHash: string; confirm: boolean }) {
    if (!this.enabled) return { status: "disabled" as const };
    return this.transaction(() => {
      const preview = this.previewReview(input);
      if (input.confirm !== true) return { status: "confirm_required" as const };
      if (preview.previewHash !== input.previewHash) throw new Error("stale_attachment_review");
      const existing = this.db.prepare("SELECT review_hash FROM mnemora_recall_attachment_reviews WHERE scope=? AND receipt_id=? AND target_ref=? AND source_ref=?").all(preview.scope, preview.receiptId, preview.targetRef, preview.sourceRef) as Array<{ review_hash: string }>;
      if (existing.length) {
        if (existing.length !== 1 || existing[0].review_hash !== preview.previewHash) throw new Error("attachment_review_conflict");
        return { status: "replayed" as const };
      }
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM mnemora_recall_attachment_reviews WHERE scope=? AND receipt_id=?").get(preview.scope, preview.receiptId) as { n: number };
      if (count.n >= 100) throw new Error("attachment_review_limit");
      this.db.prepare("INSERT INTO mnemora_recall_attachment_reviews(scope,receipt_id,target_ref,source_ref,source_version,signal,review_hash,created_at) VALUES(?,?,?,?,?,?,?,?)").run(preview.scope, preview.receiptId, preview.targetRef, preview.sourceRef, preview.sourceVersion, preview.signal, preview.previewHash, this.now());
      return { status: "recorded" as const };
    });
  }

  private current(scope: string, item: AttachmentItem): boolean {
    try { return [item.target, ...item.sources].every(version => this.version(scope, version.ref).hash === version.hash); } catch { return false; }
  }
  private version(scope: string, value: string): Version {
    const reference = authorizeMnemoraContextRef(value, { scope, kinds: [...targetKinds, "conversation-event"] });
    new CognitionReferenceRepository(this.db).requireActive(reference);
    const row = this.db.prepare(`SELECT * FROM ${tables[reference.kind as keyof typeof tables]} WHERE scope=? AND id=?`).get(scope, reference.id) as Record<string, unknown>;
    if (reference.kind === "decision" && ((row.valid_until != null && Number(row.valid_until) < this.now()) || (row.valid_from != null && Number(row.valid_from) > this.now()))) throw new Error("expired_attachment_source");
    if (reference.kind === "memory-document") {
      const lifecycle = this.db.prepare("SELECT expires_at FROM mnemora_memory_document_lifecycle WHERE scope=? AND document_id=?").get(scope, reference.id) as { expires_at: number | null } | undefined;
      if (lifecycle?.expires_at != null && lifecycle.expires_at < this.now()) throw new Error("expired_attachment_source");
    }
    if (reference.kind === "conversation-event" && (row.normalized_text == null || row.context_domain !== "user_chat" || !((row.role === "assistant" && row.kind === "assistant_message") || (row.role === "user" && row.kind === "user_message")))) throw new Error("unreadable_attachment_source");
    return { ref: reference.canonical, hash: digest(row) };
  }
  private identity(value: string): void { if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,79}$/.test(value)) throw new Error("invalid_attachment_evidence"); }
  private transaction<T>(read: () => T): T {
    this.db.exec("SAVEPOINT mnemora_attachment_evidence");
    try { const result = read(); this.db.exec("RELEASE mnemora_attachment_evidence"); return result; }
    catch (error) { this.db.exec("ROLLBACK TO mnemora_attachment_evidence"); this.db.exec("RELEASE mnemora_attachment_evidence"); throw error; }
  }
}
