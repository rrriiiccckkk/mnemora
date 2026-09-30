import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { authorizeMnemoraContextRef, createMnemoraContextRef, parseMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";
import { RecallUsageRepository, type RecallUsageRecord } from "../recall-lifecycle/repository.js";
import { CognitionReferenceRepository } from "./reference-repository.js";
import type { RecallFeedbackKind } from "./reflection.js";

const EVENT_LIMIT = 200, TEXT_LIMIT = 16000, TEXT_BUDGET = 1_048_576;
const kinds = ["memory-document", "belief", "decision"] as const;
const feedbackKinds: RecallFeedbackKind[] = ["helpful", "unused", "irrelevant", "wrong", "outdated", "user_corrected", "context_mismatch"];
interface Mention { sourceRef: string; signal: "assistant_citation" | "user_mention_needs_review"; createdAt: number; }
export interface RecallUsefulnessReview {
  version: "recall-usefulness-review-v1";
  scope: string;
  targetRef: string;
  targetStatus: "active" | "unavailable";
  targetUpdatedAt: number | null;
  attachment: RecallUsageRecord | null;
  reviewedFeedback: Record<RecallFeedbackKind, number> | null;
  feedbackEvidence: "operator_asserted_unlinked";
  mentions: Mention[];
  corroboration: "unmeasured";
  turnAttribution: "unavailable";
  versionAttribution: "timestamp_window_only";
  coverage: { eventLimit: number; mentionLimit: number; scannedEvents: number; truncated: boolean; possiblyClippedTexts: number; ambiguousBoundaries: number; completeHistory: false; surface: "readable_user_chat_journal_only" };
  calibrationAction: "not_performed";
  mutation: "none";
}

/** An evidence worklist, not an implicit outcome classifier or efficacy score.
 * It rechecks live sources and never persists message text or inferred labels. */
export class RecallUsefulnessReviewService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  review(input: { scope: string; targetRef: string; limit?: number }): RecallUsefulnessReview {
    const scope = normalizeScope(input.scope), reference = authorizeMnemoraContextRef(input.targetRef, { scope, kinds });
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("invalid_usefulness_review");
    const report: RecallUsefulnessReview = {
      version: "recall-usefulness-review-v1", scope, targetRef: reference.canonical, targetStatus: "unavailable", targetUpdatedAt: null,
      attachment: null, reviewedFeedback: null, feedbackEvidence: "operator_asserted_unlinked", mentions: [],
      corroboration: "unmeasured", turnAttribution: "unavailable", versionAttribution: "timestamp_window_only",
      coverage: { eventLimit: EVENT_LIMIT, mentionLimit: limit, scannedEvents: 0, truncated: false, possiblyClippedTexts: 0, ambiguousBoundaries: 0, completeHistory: false, surface: "readable_user_chat_journal_only" },
      calibrationAction: "not_performed", mutation: "none"
    };
    // A savepoint gives one read snapshot and also works inside an existing
    // caller transaction. No data changes are made by this review.
    this.db.exec("SAVEPOINT mnemora_usefulness_review");
    try {
      try { new CognitionReferenceRepository(this.db).requireActive(reference); }
      catch (error) { if (error instanceof Error && error.message === "invalid_decision_evidence") return report; throw error; }
      const table = reference.kind === "memory-document" ? "kg_memory_documents" : reference.kind === "belief" ? "mnemora_beliefs" : "mnemora_decisions";
      const target = this.db.prepare(`SELECT updated_at FROM ${table} WHERE scope=? AND id=?`).get(scope, reference.id) as { updated_at: number };
      const now = this.now(), updatedAt = Number(target.updated_at);
      report.targetStatus = "active"; report.targetUpdatedAt = updatedAt;
      report.attachment = new RecallUsageRepository(this.db).usage(scope, reference.canonical) ?? null;
      report.reviewedFeedback = Object.fromEntries(feedbackKinds.map(kind => [kind, 0])) as Record<RecallFeedbackKind, number>;
      const feedback = this.db.prepare(`SELECT kind,COUNT(*) AS count FROM mnemora_recall_feedback
        WHERE scope=? AND target_ref=? AND created_at>=? AND created_at<=? GROUP BY kind`).all(scope, reference.canonical, updatedAt, now) as Array<{ kind: RecallFeedbackKind; count: number }>;
      for (const row of feedback) if (feedbackKinds.includes(row.kind)) report.reviewedFeedback[row.kind] = Number(row.count);
      const rows = this.db.prepare(`SELECT id,role,created_at,substr(normalized_text,1,?) AS text
        FROM mnemora_conversation_events WHERE scope=? AND deleted_at IS NULL AND normalized_text IS NOT NULL
        AND context_domain='user_chat' AND ((role='assistant' AND kind='assistant_message') OR (role='user' AND kind='user_message'))
        AND created_at>=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT ?`)
        .all(TEXT_LIMIT + 1, scope, updatedAt, now, EVENT_LIMIT + 1) as Array<{ id: string; role: string; created_at: number; text: string }>;
      report.coverage.truncated = rows.length > EVENT_LIMIT;
      let bytes = 0;
      for (const row of rows.slice(0, EVENT_LIMIT)) {
        bytes += Buffer.byteLength(row.text, "utf8");
        if (bytes > TEXT_BUDGET) { report.coverage.truncated = true; break; }
        report.coverage.scannedEvents++;
        const clipped = row.text.length >= TEXT_LIMIT;
        if (clipped) { report.coverage.possiblyClippedTexts++; report.coverage.truncated = true; }
        const mention = mentionsReference(row.text.slice(0, TEXT_LIMIT), reference.canonical);
        if (mention === "ambiguous") { report.coverage.ambiguousBoundaries++; report.coverage.truncated = true; continue; }
        if (!mention) continue;
        if (report.mentions.length >= limit) { report.coverage.truncated = true; break; }
        report.mentions.push({ sourceRef: createMnemoraContextRef({ scope, kind: "conversation-event", id: row.id }), signal: row.role === "assistant" ? "assistant_citation" : "user_mention_needs_review", createdAt: Number(row.created_at) });
      }
      return report;
    } finally { this.db.exec("RELEASE mnemora_usefulness_review"); }
  }
}

function mentionsReference(text: string, targetRef: string): boolean | "ambiguous" {
  let ambiguous = false;
  const delimiters = new Set(Array.from(" \t\f\v<>\"'`()[]{};,!，。！？、；："));
  for (const match of text.matchAll(/mnemora:\/\/[A-Za-z0-9._~%:/-]+/g)) {
    const start = match.index!, end = start + match[0].length;
    const previous = start > 0 ? previousCodePoint(text, start) : "";
    if (previous && !delimiters.has(previous) && previous !== "\r" && previous !== "\n") continue;
    const next = text[end] ?? "";
    if (next && !delimiters.has(next) && next !== "\r" && next !== "\n") continue;
    try {
      if (parseMnemoraContextRef(match[0]).canonical !== targetRef) continue;
      // Capture itself may have clipped a longer URI, even below this reader's
      // cap. Normalization joins captured parts with newlines; a line/part
      // ending also cannot certify that the original URI was complete.
      if (!next || next === "\r" || next === "\n") ambiguous = true;
      else return true;
    } catch { /* malformed or longer references are not mentions of this target */ }
  }
  return ambiguous ? "ambiguous" : false;
}

function previousCodePoint(text: string, index: number): string {
  const last = text.charCodeAt(index - 1), before = text.charCodeAt(index - 2);
  return index > 1 && last >= 0xDC00 && last <= 0xDFFF && before >= 0xD800 && before <= 0xDBFF ? text.slice(index - 2, index) : text[index - 1];
}
