import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createHash } from "node:crypto";
import { normalizeScope } from "../scope.js";
import type { CreateSourceAnchorsInput, ExternalSourceRef, InspectorSourceAnchorRow, SourceAnchorPage, SourceAnchorWriteResult, VerificationStatus } from "./types.js";

const MAX_SOURCE_LABEL_LENGTH = 256;

/** Owns trust-layer rows; graph mutation and recall policy remain elsewhere. */
export class SourceAnchorRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  createPendingAnchors(input: CreateSourceAnchorsInput): SourceAnchorWriteResult {
    const scope = normalizeScope(input.scope);
    const source = boundedSource(input.source);
    const text = typeof input.text === "string" ? input.text : "";
    const contentHash = sha256(text);
    const externalRef = validExternalRef(input.externalRef);
    const claims = input.claims.filter(claim => validClaim(claim));
    if (!claims.length) return { anchors: 0, verifications: 0, externalRefs: 0 };
    const anchor = this.db.prepare(`INSERT OR IGNORE INTO kg_source_anchors(
      id,scope,provider,external_id,external_version,conversation_id,message_id,summary_id,source_label,content_hash,snapshot_text,snapshot_truncated,span_start,span_end,span_encoding,source_created_at,captured_at,last_checked_at,status
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const verification = this.db.prepare(`INSERT OR IGNORE INTO kg_claim_verifications(
      id,claim_id,source_anchor_id,scope,status,support_type,extraction_confidence,verification_confidence,source_quality,verifier_kind,verifier_model,verifier_prompt_version,note,created_at,verified_at
    ) VALUES(?,?,?,?,'pending',NULL,?,NULL,NULL,'rule',NULL,NULL,NULL,?,NULL)`);
    const external = this.db.prepare(`INSERT OR IGNORE INTO kg_external_refs(
      id,scope,provider,external_id,external_version,object_type,claim_id,source_anchor_id,content_hash,status,first_seen_at,last_seen_at
    ) VALUES(?,?,?,?,?,'source',NULL,?,?,'active',?,?)`);
    let anchors = 0, verifications = 0, externalRefs = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const claim of claims) {
        const id = `source:${sha256(`${scope}\0${source}\0${contentHash}\0${claim.id}`).slice(0, 40)}`;
        const span = findSpan(text, claim.quote);
        const snapshot = evidenceSnapshot(text, span, input.snapshotMaxBytes);
        const insertedAnchor = anchor.run(
          id, scope, externalRef?.provider ?? "mnemora-local", externalRef?.externalId ?? null, externalRef?.externalVersion ?? null,
          externalRef?.conversationId ?? null, externalRef?.messageId ?? null, externalRef?.summaryId ?? null,
          source, contentHash, snapshot.text, snapshot.truncated ? 1 : 0,
          span?.start ?? null, span?.end ?? null, span ? "utf16-code-unit" : null,
          null, input.capturedAt, null, "available"
        );
        anchors += Number(insertedAnchor.changes ?? 0);
        const verificationId = `verification:${sha256(`${claim.id}\0${id}`).slice(0, 40)}`;
        const insertedVerification = verification.run(verificationId, claim.id, id, scope, claim.extractionConfidence, input.capturedAt);
        verifications += Number(insertedVerification.changes ?? 0);
        if (externalRef) {
          const externalId = `external:${sha256(`${scope}\0${externalRef.provider}\0${externalRef.externalId}\0${id}`).slice(0, 40)}`;
          const insertedExternal = external.run(externalId, scope, externalRef.provider, externalRef.externalId, externalRef.externalVersion ?? null, id, contentHash, input.capturedAt, input.capturedAt);
          externalRefs += Number(insertedExternal.changes ?? 0);
        }
      }
      if (anchors || verifications || externalRefs) this.db.prepare("UPDATE kg_trust_state SET revision=revision+1,updated_at=? WHERE id=1").run(input.capturedAt);
      this.db.exec("COMMIT");
      return { anchors, verifications, externalRefs };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  revision(): string {
    const row = this.db.prepare("SELECT revision FROM kg_trust_state WHERE id=1").get() as { revision?: unknown } | undefined;
    return `trust:${safeInteger(row?.revision)}`;
  }

  listForInspector(input: { scope: string; after: { sort: number; id: string } | null; limit: number; check?: () => void }): SourceAnchorPage {
    const scope = normalizeScope(input.scope);
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    input.check?.();
    const rows = this.db.prepare(`SELECT a.id,a.source_label,a.status AS source_status,a.snapshot_truncated,a.captured_at,
      CASE WHEN SUM(CASE WHEN v.status='contradicted' THEN 1 ELSE 0 END)>0 THEN 'contradicted'
           WHEN SUM(CASE WHEN v.status='rejected' THEN 1 ELSE 0 END)>0 THEN 'rejected'
           WHEN SUM(CASE WHEN v.status='stale' THEN 1 ELSE 0 END)>0 THEN 'stale'
           WHEN SUM(CASE WHEN v.status='flagged' THEN 1 ELSE 0 END)>0 THEN 'flagged'
           WHEN SUM(CASE WHEN v.status='unverifiable' THEN 1 ELSE 0 END)>0 THEN 'unverifiable'
           WHEN SUM(CASE WHEN v.status='pending' THEN 1 ELSE 0 END)>0 THEN 'pending'
           WHEN SUM(CASE WHEN v.status='verified' THEN 1 ELSE 0 END)>0 THEN 'verified'
           WHEN SUM(CASE WHEN v.status='superseded' THEN 1 ELSE 0 END)>0 THEN 'superseded'
           ELSE 'pending' END AS verification_status,
      COUNT(v.id) AS claim_count
      FROM kg_source_anchors a LEFT JOIN kg_claim_verifications v ON v.source_anchor_id=a.id
      WHERE a.scope=? AND (? IS NULL OR a.captured_at<? OR (a.captured_at=? AND a.id>?))
      GROUP BY a.id
      ORDER BY a.captured_at DESC,a.id ASC
      LIMIT ?`).all(scope, input.after?.sort ?? null, input.after?.sort ?? 0, input.after?.sort ?? 0, input.after?.id ?? "", limit + 1) as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit + 1);
    const hasNext = page.length > limit;
    const emitted = page.slice(0, limit).flatMap(row => {
      input.check?.();
      return inspectorRow(row);
    });
    const last = emitted.at(-1);
    return { items: emitted, next: hasNext && last ? { sort: last.captured_at, id: last.id } : null, truncated: emitted.length !== Math.min(limit, page.length) };
  }
}

function boundedSource(value: unknown): string {
  const source = typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim() : "manual";
  return (source || "manual").slice(0, MAX_SOURCE_LABEL_LENGTH);
}
function validClaim(value: { id: string; quote: string; extractionConfidence: number }): boolean {
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200 && typeof value.quote === "string" && Number.isFinite(value.extractionConfidence) && value.extractionConfidence >= 0 && value.extractionConfidence <= 1;
}
function validExternalRef(value: ExternalSourceRef | undefined): ExternalSourceRef | undefined {
  if (!value || !boundedIdentifier(value.provider, 80) || !boundedIdentifier(value.externalId, 512)) return undefined;
  return {
    provider: value.provider.trim(), externalId: value.externalId.trim(),
    ...(boundedIdentifier(value.externalVersion, 200) ? { externalVersion: value.externalVersion!.trim() } : {}),
    ...(boundedIdentifier(value.conversationId, 200) ? { conversationId: value.conversationId!.trim() } : {}),
    ...(boundedIdentifier(value.messageId, 200) ? { messageId: value.messageId!.trim() } : {}),
    ...(boundedIdentifier(value.summaryId, 200) ? { summaryId: value.summaryId!.trim() } : {})
  };
}
function boundedIdentifier(value: unknown, maximum: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum && !/[\u0000-\u001f]/.test(value); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function findSpan(text: string, quote: string): { start: number; end: number } | undefined {
  if (!quote) return undefined;
  const start = text.indexOf(quote);
  return start < 0 ? undefined : { start, end: start + quote.length };
}
function evidenceSnapshot(text: string, span: { start: number; end: number } | undefined, maximum: number): { text: string | null; truncated: boolean } {
  const cap = Math.max(256, Math.min(32768, Math.trunc(maximum)));
  if (Buffer.byteLength(text, "utf8") <= cap) return { text, truncated: false };
  const start = span?.start ?? 0;
  return { text: truncateUtf8(text.slice(start), cap), truncated: true };
}

/** UTF-8 safe, hard byte cap for persistent evidence snapshots. */
export function truncateUtf8(text: string, maximum: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maximum) return text;
  let end = Math.max(0, Math.min(bytes.length, Math.trunc(maximum)));
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
function safeInteger(value: unknown): number { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0; }
function inspectorRow(value: Record<string, unknown>): InspectorSourceAnchorRow[] {
  const id = typeof value.id === "string" && /^source:[A-Za-z0-9_-]{1,160}$/.test(value.id) ? value.id : undefined;
  const source = typeof value.source_label === "string" && value.source_label.length <= MAX_SOURCE_LABEL_LENGTH ? value.source_label : undefined;
  const sourceStatus = ["available", "missing", "deleted", "changed", "legacy"].includes(value.source_status as string) ? value.source_status as InspectorSourceAnchorRow["source_status"] : undefined;
  const verificationStatus = ["pending", "verified", "flagged", "rejected", "unverifiable", "contradicted", "stale", "superseded"].includes(value.verification_status as string) ? value.verification_status as VerificationStatus : undefined;
  const capturedAt = safeInteger(value.captured_at), claimCount = safeInteger(value.claim_count);
  return id && source && sourceStatus && verificationStatus && capturedAt ? [{ id, source, source_status: sourceStatus, verification_status: verificationStatus, snapshot_truncated: value.snapshot_truncated === 1, claim_count: claimCount, captured_at: capturedAt }] : [];
}
