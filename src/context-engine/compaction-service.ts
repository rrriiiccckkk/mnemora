import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { JournalCapturePolicy } from "../journal/types.js";
import { CompactionModelError, type CompactionSummarizer } from "./compaction-model.js";
import { CompactionRunRepository, type CompactionRun } from "./compaction-run-repository.js";
import { SummaryRepository, type SummaryNode } from "./summary-repository.js";
import { estimateCompactionTokens } from "./token-estimate.js";

type RewriteRuntime = { rewriteTranscriptEntries?(request: { replacements: Array<{ entryId: string; message: unknown }>; allowedRewriteSuffixEntryIds?: string[] }): Promise<{ changed: boolean; bytesFreed?: number; rewrittenEntries?: number; reason?: string }> };
type Row = { id: string; role: string | null; normalized_text: string | null; entry_id: string; sequence: number };
export type CompactionOptions = {
  minEvents: number; maxInputChars: number; maxOutputChars: number; timeoutMs: number; maxRunsPerHour: number; maxDailyTokens: number;
  circuitCooldownMs: number; summaryMaxCallsPerWindow: number; summaryCallWindowMs: number; summarySpendBackoffMs: number;
  contextThreshold?: number; freshTailCount?: number; leafChunkTokens?: number; maxChunksPerRun?: number; condensedMinFanout?: number; deadlineMs?: number;
};
type Result = { compacted: boolean; reason: string; summary?: string; firstKeptEntryId?: string; tokensBefore: number; tokensAfter: number; details: Record<string, unknown> };
/** `modelInputTokens` is what can reach a model; `sourceReductionTokens` is
 * the durable Journal volume that a successful rewrite removes. Oversized
 * source events intentionally have different values: their model input is a
 * small deterministic fallback while their source reduction remains large. */
type Chunk = { rows: Row[]; source: string; modelInputTokens: number; sourceReductionTokens: number; fallbackCategory?: "oversized_source_event" };
type PreparedChunk = { chunk: Chunk; run: CompactionRun; summary: SummaryNode; fallbackCategory?: string };
const tokens = estimateCompactionTokens;
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason ?? new Error("aborted"); };
const category = (error: unknown) => error instanceof CompactionModelError ? error.category : "model_failed";
const safeSummary = (value: string, maxChars: number) => value.replace(/[<&>]/g, char => char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&amp;").trim().slice(0, maxChars);
const fallbackSummary = "Earlier conversation was compacted without a model summary after a bounded summarization failure. Durable, source-linked Journal evidence remains available for inspection.";
const oversizedSourceFallback = "A source-linked Journal event exceeded the compaction input bound. Its durable evidence remains available for inspection, but its original content is not repeated in this transcript projection.";

function journalRows(db: DatabaseSyncInstance, scope: string, sessionId: string): Row[] {
  return db.prepare(`SELECT e.id,e.role,e.normalized_text,l.entry_id,e.sequence
    FROM mnemora_conversation_events e JOIN mnemora_host_message_links l ON l.event_id=e.id AND l.scope=e.scope
    WHERE e.scope=? AND e.session_id=? AND e.deleted_at IS NULL AND e.context_domain='user_chat'
    ORDER BY e.sequence ASC,e.id ASC`).all(scope, sessionId) as Row[];
}

/** Canonical active volume for one durable Journal session. Host lifecycle
 * callbacks may expose only the current delta, so they are never a source of
 * truth for proactive compaction thresholds. */
export function activeJournalTokenEstimate(db: DatabaseSyncInstance, scope: string, sessionId: string): number {
  const runs = new CompactionRunRepository(db);
  return journalRows(db, scope, sessionId).filter(row => !runs.hasSucceededSourceEvent(scope, row.id)).reduce((total, row) => total + tokens(row.normalized_text ?? ""), 0);
}

/**
 * Bounded source-linked compaction. Every source event remains durable; host
 * transcript rewrites only replace a bounded prefix with an expandable Summary
 * projection. The service never reads a host transcript directly.
 */
export class ContextCompactionService {
  private readonly summaries: SummaryRepository;
  private readonly runs: CompactionRunRepository;

  constructor(private readonly db: DatabaseSyncInstance, policy: JournalCapturePolicy, private readonly summarizer: CompactionSummarizer) {
    this.summaries = new SummaryRepository(db, policy);
    this.runs = new CompactionRunRepository(db);
  }

  activeTokenEstimate(scope: string, sessionId: string): number {
    return activeJournalTokenEstimate(this.db, scope, sessionId);
  }

  async compact(input: { scope: string; sessionId: string; protectedRecentEvents: number; runtimeContext?: RewriteRuntime; signal?: AbortSignal; currentTokenCount?: number; targetTokens?: number; now?: number; options: CompactionOptions }): Promise<Result> {
    abort(input.signal);
    const runtime = input.runtimeContext;
    const before = input.currentTokenCount ?? this.activeTokenEstimate(input.scope, input.sessionId);
    if (!runtime?.rewriteTranscriptEntries) return this.result(false, "runtime_rewrite_unavailable", before, before, {});
    const now = input.now ?? Date.now(), options = normalizeOptions(input.options);
    const deadline = new AbortController(), onAbort = () => deadline.abort(input.signal?.reason ?? new Error("aborted"));
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => deadline.abort(new Error("compaction_deadline")), options.deadlineMs);
    try {
      const rows = this.rows(input.scope, input.sessionId);
      const totalBefore = input.currentTokenCount ?? rows.filter(row => !this.runs.hasSucceededSourceEvent(input.scope, row.id)).reduce((sum, row) => sum + tokens(row.normalized_text ?? ""), 0);
      const protectedCount = Math.min(50, Math.max(2, Math.floor(input.protectedRecentEvents)));
      if (rows.length <= protectedCount) return this.result(false, "protected_recent_events", totalBefore, totalBefore, { protectedRecentEvents: protectedCount });
      const candidates = rows.slice(0, rows.length - protectedCount).filter(row => !this.runs.hasSucceededSourceEvent(input.scope, row.id));
      const desiredReduction = Math.max(0, totalBefore - Math.max(0, input.targetTokens ?? 0));
      const selection = selectChunks(candidates, options, desiredReduction);
      if (selection.selectedEvents < options.minEvents) return this.result(false, selection.selectedEvents ? "minimum_events_not_reached" : "input_budget_exhausted", totalBefore, totalBefore, { selectedEvents: selection.selectedEvents, skippedEvents: selection.skipped, minEvents: options.minEvents });

      const prepared: PreparedChunk[] = [];
      let stoppedReason: string | undefined;
      for (const chunk of selection.chunks) {
        abort(deadline.signal);
        const limited = this.runs.limits({ scope: input.scope, sessionId: input.sessionId, now, maxRunsPerHour: options.maxRunsPerHour, maxDailyTokens: options.maxDailyTokens, circuitCooldownMs: options.circuitCooldownMs, summaryMaxCallsPerWindow: options.summaryMaxCallsPerWindow, summaryCallWindowMs: options.summaryCallWindowMs, summarySpendBackoffMs: options.summarySpendBackoffMs });
        if (limited) { stoppedReason = limited; break; }
        const fingerprint = this.runs.fingerprint(chunk.rows.map(row => row.id), chunk.rows.map(row => row.normalized_text ?? ""));
        const reserved = this.runs.reserve({ scope: input.scope, sessionId: input.sessionId, fingerprint, selectedEventCount: chunk.rows.length, inputChars: chunk.source.length, estimatedInputTokens: chunk.modelInputTokens, now, staleRunningMs: Math.max(60000, options.timeoutMs * 2) });
        if (!reserved.run) { stoppedReason = reserved.reason ?? "replay_pending"; continue; }
        const run = reserved.run;
        this.runs.update(run.id, "running", now);
        let content: string, fallbackCategory: string | undefined;
        if (chunk.fallbackCategory) { fallbackCategory = chunk.fallbackCategory; content = oversizedSourceFallback; }
        else try {
          content = safeSummary(await this.summarizer.summarize({ source: chunk.source, maxOutputChars: options.maxOutputChars, signal: deadline.signal }), options.maxOutputChars);
          if (!content) throw new CompactionModelError("invalid_model_response");
        } catch (error) {
          if (input.signal?.aborted) { this.runs.update(run.id, "cancelled", now, { failureCategory: "aborted" }); throw error; }
          fallbackCategory = deadline.signal.aborted ? "deadline_exceeded" : category(error);
          content = fallbackSummary;
        }
        try {
          // A global deadline stops further model work, but a deterministic
          // fallback already selected for this chunk must still be persisted
          // and rewritten atomically. Only the caller's cancellation may abort
          // that evidence-preserving finalization.
          const summary = this.summaries.create({ id: run.summaryId, scope: input.scope, sessionId: input.sessionId, eventIds: chunk.rows.map(row => row.id), content, maxChars: options.maxOutputChars, injectionEligible: false, signal: input.signal, now });
          this.runs.update(run.id, "prepared", now, { outputChars: summary.content.length, estimatedOutputTokens: summary.estimatedTokens, ...(fallbackCategory ? { failureCategory: `fallback_${fallbackCategory}` } : {}) });
          prepared.push({ chunk, run, summary, fallbackCategory });
        } catch (error) {
          if (input.signal?.aborted) { this.runs.update(run.id, "cancelled", now, { failureCategory: "aborted" }); throw error; }
          this.runs.update(run.id, "failed", now, { failureCategory: "summary_persist_failed" });
          stoppedReason = "summary_persist_failed";
          break;
        }
        if (deadline.signal.aborted) { stoppedReason = "deadline_reached"; break; }
      }

      if (!prepared.length) return this.result(false, stoppedReason ?? "no_compaction_candidate", totalBefore, totalBefore, { selectedEvents: selection.selectedEvents, selectedSourceTokens: selection.selectedSourceTokens, skippedEvents: selection.skipped });
      const root = this.rootFor(prepared, input.scope, input.sessionId, options, now);
      const sourceRows = prepared.flatMap(item => item.chunk.rows);
      const preparedSourceTokens = prepared.reduce((total, item) => total + item.chunk.sourceReductionTokens, 0);
      const preparedModelInputTokens = prepared.reduce((total, item) => total + item.chunk.modelInputTokens, 0);
      const entryIds = sourceRows.map(row => row.entry_id);
      const summaryMessage = this.summaryMessage(root);
      const replacements = sourceRows.map((row, index) => ({ entryId: row.entry_id, message: index === 0 ? { role: "system", content: summaryMessage } : { role: "system", content: `<MNEMORA_COMPACTED summary_id="${root.id}" source_event="${row.id}" />` } }));
      try {
        abort(input.signal);
        const rewritten = await runtime.rewriteTranscriptEntries({ replacements, allowedRewriteSuffixEntryIds: entryIds });
        if (!rewritten.changed) {
          this.archivePrepared(prepared, root, input.scope, now);
          return this.result(false, "runtime_rewrite_declined", totalBefore, totalBefore, { selectedEvents: sourceRows.length, selectedSourceTokens: preparedSourceTokens, estimatedModelInputTokens: preparedModelInputTokens, runIds: prepared.map(item => item.run.id), ...(stoppedReason ? { stoppedReason } : {}) });
        }
        this.summaries.activate(root.id, input.scope);
        for (const item of prepared) this.runs.update(item.run.id, "succeeded", now, item.fallbackCategory ? { failureCategory: `fallback_${item.fallbackCategory}` } : {});
        const removed = sourceRows.reduce((sum, row) => sum + tokens(row.normalized_text ?? ""), 0);
        const after = Math.max(0, totalBefore - removed + tokens(summaryMessage) + Math.max(0, sourceRows.length - 1) * 4);
        const fallbackChunks = prepared.filter(item => item.fallbackCategory).map(item => item.fallbackCategory);
        return { ...this.result(true, fallbackChunks.length ? "source_linked_fallback_compaction" : "source_linked_incremental_compaction", totalBefore, after, {
          summaryId: root.id, leafSummaryIds: prepared.map(item => item.summary.id), runIds: prepared.map(item => item.run.id), selectedEvents: sourceRows.length, selectedSourceTokens: preparedSourceTokens, estimatedModelInputTokens: preparedModelInputTokens, chunks: prepared.length, skippedEvents: selection.skipped,
          ...(fallbackChunks.length ? { fallbackCategories: fallbackChunks } : {}), ...(stoppedReason ? { stoppedReason } : {}), rewrittenEntries: rewritten.rewrittenEntries ?? sourceRows.length, bytesFreed: rewritten.bytesFreed ?? 0
        }), summary: root.content, firstKeptEntryId: rows[rows.length - protectedCount]?.entry_id };
      } catch (error) {
        if (input.signal?.aborted) throw error;
        // A host error after a rewrite request remains ambiguous. Preserve each
        // prepared claim as non-injectable and require explicit reconciliation.
        return this.result(false, "runtime_rewrite_unknown", totalBefore, totalBefore, { selectedEvents: sourceRows.length, selectedSourceTokens: preparedSourceTokens, estimatedModelInputTokens: preparedModelInputTokens, runIds: prepared.map(item => item.run.id) });
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  private rootFor(prepared: PreparedChunk[], scope: string, sessionId: string, options: Required<CompactionOptions>, now: number): SummaryNode {
    if (prepared.length === 1) return prepared[0].summary;
    const label = prepared.length >= options.condensedMinFanout ? "Consolidated bounded conversation segments:" : "Bounded conversation segments:";
    const content = deterministicCondense(label, prepared.map(item => item.summary.content), options.maxOutputChars);
    return this.summaries.create({ scope, sessionId, childSummaryIds: prepared.map(item => item.summary.id), content, maxChars: options.maxOutputChars, injectionEligible: false, now });
  }

  private archivePrepared(prepared: PreparedChunk[], root: SummaryNode, scope: string, now: number): void {
    const ids = new Set([...prepared.map(item => item.summary.id), root.id]);
    for (const id of ids) this.summaries.archive(id, scope, now);
    for (const item of prepared) this.runs.update(item.run.id, "failed", now, { failureCategory: "runtime_rewrite_declined" });
  }

  private summaryMessage(summary: SummaryNode): string {
    return `<MNEMORA_COMPACTION summary_id="${summary.id}" source_linked="true" authority="non_authoritative" priority="reference">\n${summary.content}\n</MNEMORA_COMPACTION>`;
  }

  private rows(scope: string, sessionId: string): Row[] {
    return journalRows(this.db, scope, sessionId);
  }

  private result(compacted: boolean, reason: string, tokensBefore: number, tokensAfter: number, details: Record<string, unknown>): Result { return { compacted, reason, tokensBefore, tokensAfter, details }; }
}

function normalizeOptions(input: CompactionOptions): Required<CompactionOptions> {
  const clamp = (value: unknown, fallback: number, min: number, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : fallback;
  const unit = (value: unknown, fallback: number, min: number, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, Number(value))) : fallback;
  return {
    minEvents: clamp(input.minEvents, 4, 2, 50), maxInputChars: clamp(input.maxInputChars, 12000, 1024, 100000), maxOutputChars: clamp(input.maxOutputChars, 4000, 256, 16000), timeoutMs: clamp(input.timeoutMs, 15000, 1000, 120000), maxRunsPerHour: clamp(input.maxRunsPerHour, 4, 1, 24), maxDailyTokens: clamp(input.maxDailyTokens, 32000, 1000, 1000000), circuitCooldownMs: clamp(input.circuitCooldownMs, 3600000, 60000, 86400000), summaryMaxCallsPerWindow: clamp(input.summaryMaxCallsPerWindow, 24, 1, 100), summaryCallWindowMs: clamp(input.summaryCallWindowMs, 600000, 60000, 86400000), summarySpendBackoffMs: clamp(input.summarySpendBackoffMs, 1800000, 60000, 86400000), contextThreshold: unit(input.contextThreshold, .75, .5, .95), freshTailCount: clamp(input.freshTailCount, 8, 2, 50), leafChunkTokens: clamp(input.leafChunkTokens, 3000, 256, 24000), maxChunksPerRun: clamp(input.maxChunksPerRun, 4, 1, 12), condensedMinFanout: clamp(input.condensedMinFanout, 4, 2, 12), deadlineMs: clamp(input.deadlineMs, 45000, 1000, 300000)
  };
}

function selectChunks(rows: Row[], options: Required<CompactionOptions>, desiredReduction: number): { chunks: Chunk[]; selectedEvents: number; selectedSourceTokens: number; skipped: number } {
  const chunks: Chunk[] = [], current: Row[] = [];
  let currentSource: string[] = [], currentTokens = 0, currentChars = 0, selectedEvents = 0, selectedSourceTokens = 0, skipped = 0;
  const flush = () => {
    if (!current.length) return;
    chunks.push({ rows: current.splice(0), source: currentSource.join("\n"), modelInputTokens: currentTokens, sourceReductionTokens: currentTokens });
    currentSource = []; currentTokens = 0; currentChars = 0;
  };
  for (const row of rows) {
    const value = (row.normalized_text ?? "").trim();
    if (!value) { skipped++; continue; }
    const line = `${row.role ?? "message"}: ${value}`, size = line.length, lineTokens = tokens(line);
    if (size > options.maxInputChars || lineTokens > options.leafChunkTokens) {
      flush();
      if (chunks.length >= options.maxChunksPerRun || (desiredReduction > 0 && selectedSourceTokens >= desiredReduction)) break;
      // Do not pass an unbounded event to a model, and do not leave it as a
      // permanent candidate on every later compaction attempt.  A generic,
      // source-linked projection has no source payload yet lets a successful
      // host rewrite durably mark this exact event as handled.
      chunks.push({ rows: [row], source: "", modelInputTokens: tokens(oversizedSourceFallback), sourceReductionTokens: lineTokens, fallbackCategory: "oversized_source_event" });
      selectedEvents++; selectedSourceTokens += lineTokens;
      continue;
    }
    const over = current.length && (currentChars + size + 1 > options.maxInputChars || currentTokens + lineTokens > options.leafChunkTokens);
    if (over) {
      flush();
      if (chunks.length >= options.maxChunksPerRun || (desiredReduction > 0 && selectedSourceTokens >= desiredReduction)) break;
    }
    current.push(row); currentSource.push(line); currentChars += size + (currentSource.length > 1 ? 1 : 0); currentTokens += lineTokens; selectedEvents++; selectedSourceTokens += lineTokens;
  }
  // A partially built leaf already contains selected source events.  Flush it
  // even when the target reduction was reached exactly; otherwise those rows
  // are neither rewritten nor marked succeeded and would be selected again.
  if (chunks.length < options.maxChunksPerRun) flush();
  return { chunks, selectedEvents, selectedSourceTokens, skipped };
}

function deterministicCondense(label: string, values: string[], maxChars: number): string {
  const bounded = Math.max(64, maxChars), lines: string[] = [label];
  for (const value of values) {
    const remaining = bounded - lines.join("\n").length - 2;
    if (remaining <= 0) break;
    lines.push(`- ${value.slice(0, Math.max(0, remaining - 2))}`);
  }
  return lines.join("\n").slice(0, bounded);
}
