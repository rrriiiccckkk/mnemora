import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";
import { Mnemora } from "../dist/tools.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { SummaryRepository } from "../dist/context-engine/summary-repository.js";
import { ContextCompactionService } from "../dist/context-engine/compaction-service.js";
import { CompactionRunRepository } from "../dist/context-engine/compaction-run-repository.js";
import { estimateCompactionTokens } from "../dist/context-engine/token-estimate.js";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { createMnemoraContextRef, resolveMnemoraContextRef } from "../dist/context/context-ref.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { normalizeConfig } from "../dist/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
const event = (repo, input) => repo.append({ scope: "project-a", sessionId: "session-a", role: "user", kind: "user_message", parts: [{ type: "text", text: input }] });

test("v29 summary DAG preserves recoverable source events and rejects cycles or incomplete tool pairs", () => {
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 66);
    const journal = new ConversationEventRepository(store.db, policy), summaries = new SummaryRepository(store.db, policy);
    const first = event(journal, "first durable fact"), second = event(journal, "second durable fact");
    const summary = summaries.create({ scope: "project-a", sessionId: "session-a", eventIds: [first.id, second.id], content: "first and second", maxChars: 100 });
    const expanded = summaries.expand(summary.id, "project-a");
    assert.deepEqual(expanded.events.map(value => value.id), [first.id, second.id]);
    const parent = summaries.create({ scope: "project-a", sessionId: "session-a", childSummaryIds: [summary.id], content: "higher-level summary", maxChars: 100 });
    assert.equal(parent.level, summary.level + 1);
    const tool = journal.append({ scope: "project-a", sessionId: "session-a", role: "assistant", kind: "tool_call", parts: [{ type: "tool_call", callId: "call-1", name: "fetch" }] });
    assert.throws(() => summaries.create({ scope: "project-a", sessionId: "session-a", eventIds: [tool.id], content: "unsafe", maxChars: 100 }), /incomplete_tool_pair/);
  } finally { store.close(); }
});

test("compaction anchors remain resolvable after retention without restoring retained content", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const journal = new ConversationEventRepository(store.db, policy), summaries = new SummaryRepository(store.db, policy);
    const source = journal.append({ scope: "project-a", sessionId: "session-a", role: "user", kind: "user_message", parts: [{ type: "text", text: "sensitive durable source" }], createdAt: 1 });
    const summary = summaries.create({ scope: "project-a", sessionId: "session-a", eventIds: [source.id], content: "source-linked projection", maxChars: 100 });
    assert.equal(journal.enforceRetention(1, 86_400_002, "project-a"), 1);
    assert.equal(journal.get(source.id, "project-a"), undefined);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events WHERE id=? AND deleted_at IS NOT NULL").get(source.id).value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_parts WHERE event_id=?").get(source.id).value, 0);
    const expanded = summaries.expand(summary.id, "project-a");
    assert.deepEqual(expanded.events.map(item => ({ id: item.id, tombstoned: item.tombstoned, parts: item.parts })), [{ id: source.id, tombstoned: true, parts: [] }]);
    assert.deepEqual(summaries.get(summary.id, "project-a").sourceEventIds, [source.id]);
  } finally { store.close(); }
});

test("v6.15 compaction preserves source-linked and durable evidence references through retention", async () => {
  const store = new GraphologyStore(":memory:");
  try {
    const journal = new ConversationEventRepository(store.db, policy);
    const receipt = journal.captureTurn({
      scope: "default", sessionId: "compaction-evidence", hostCorrelation: "seed", events: Array.from({ length: 6 }, (_value, index) => ({
        scope: "default", sessionId: "compaction-evidence", kind: index % 2 ? "assistant_message" : "user_message", role: index % 2 ? "assistant" : "user", contextDomain: "user_chat",
        hostEntryId: `e${index + 1}`, parts: [{ type: "text", text: `durable evidence event ${index + 1}` }]
      }))
    });
    const compactedEventIds = receipt.events.slice(0, 4).map(item => item.id);
    const sourceRef = createMnemoraContextRef({ scope: "default", kind: "conversation-event", id: compactedEventIds[0] });
    const task = new EpisodeRepository(store.db).create({ scope: "default", kind: "task", summary: "Preserve compaction evidence", sourceEventIds: [compactedEventIds[0]], importance: .8, confidence: .9 });
    const outcomes = new TaskOutcomeService(store.db);
    const outcomeInput = { scope: "default", taskRef: createMnemoraContextRef({ scope: "default", kind: "episode", id: task.id }), verdict: "success", impact: "helpful", evidenceRefs: [sourceRef] };
    const outcome = outcomes.confirm(outcomeInput, outcomes.preview(outcomeInput).preview_hash);
    const service = new ContextCompactionService(store.db, policy, { async summarize() { return "source-linked compaction summary"; } });
    const result = await service.compact({
      scope: "default", sessionId: "compaction-evidence", protectedRecentEvents: 2, currentTokenCount: 200,
      options: { minEvents: 4, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000 },
      runtimeContext: { async rewriteTranscriptEntries() { return { changed: true, rewrittenEntries: 4 }; } }
    });
    assert.equal(result.compacted, true, JSON.stringify(result));
    const summaryId = String(result.details.summaryId), summaries = new SummaryRepository(store.db, policy);
    assert.deepEqual(summaries.get(summaryId, "default")?.sourceEventIds, compactedEventIds);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events WHERE id IN (?,?,?,?) AND deleted_at IS NULL").get(...compactedEventIds).n, 4);
    assert.throws(() => store.db.prepare("DELETE FROM mnemora_conversation_events WHERE id=? AND scope=?").run(compactedEventIds[0], "default"), /FOREIGN KEY/i);

    assert.equal(journal.enforceRetention(1, Date.now() + 2 * 86_400_000, "default"), 6);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events WHERE id IN (?,?,?,?) AND deleted_at IS NOT NULL").get(...compactedEventIds).n, 4);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_parts WHERE event_id IN (?,?,?,?)").get(...compactedEventIds).n, 0);
    const expanded = summaries.expand(summaryId, "default");
    assert.deepEqual(expanded?.events.map(item => ({ id: item.id, tombstoned: item.tombstoned, parts: item.parts })), compactedEventIds.map(id => ({ id, tombstoned: true, parts: [] })));
    assert.deepEqual(outcomes.get(outcome.id, "default")?.evidenceRefs, [sourceRef]);
    const anchor = await resolveMnemoraContextRef(sourceRef, { scope: "default", kinds: ["conversation-event"] }, reference => journal.getEvidenceAnchor(reference.id, reference.scope) ?? (() => { throw new Error("missing_evidence_anchor"); })());
    assert.deepEqual({ id: anchor.id, tombstoned: anchor.tombstoned, parts: anchor.parts }, { id: compactedEventIds[0], tombstoned: true, parts: [] });
  } finally { store.close(); }
});

test("v6.3 schema migration is additive and preserves existing journal evidence", () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-v63-migration-")), dbPath = join(directory, "memory.db");
  let store;
  try {
    store = new GraphologyStore(dbPath);
    new ConversationEventRepository(store.db, policy).append({ scope: "default", sessionId: "s", kind: "user_message", role: "user", contextDomain: "user_chat", parts: [{ type: "text", text: "existing evidence" }] });
    store.db.exec("DROP TABLE mnemora_compaction_runs");
    store.db.exec("PRAGMA user_version=48");
    store.close(); store = new GraphologyStore(dbPath);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 66);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_compaction_runs").get().n, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events").get().n, 1);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("v6.7 replay-flood migration is additive and preserves journal evidence", () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-v67-migration-")), dbPath = join(directory, "memory.db"); let store;
  try {
    store = new GraphologyStore(dbPath);
    new ConversationEventRepository(store.db, policy).append({ scope: "default", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "existing evidence" }] });
    store.db.exec("DROP TABLE mnemora_replay_flood_guards; PRAGMA user_version=49"); store.close(); store = new GraphologyStore(dbPath);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 66);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_replay_flood_guards").get().n, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events").get().n, 1);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("v6.11 replay cleanup migration is additive and preserves existing journal evidence", () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-v611-migration-")), dbPath = join(directory, "memory.db"); let store;
  try {
    store = new GraphologyStore(dbPath);
    new ConversationEventRepository(store.db, policy).append({ scope: "default", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "existing evidence" }] });
    store.db.exec("DROP INDEX idx_mnemora_replay_flood_guards_scope_seen; PRAGMA user_version=50"); store.close(); store = new GraphologyStore(dbPath);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 66);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_mnemora_replay_flood_guards_scope_seen'").get().n, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events").get().n, 1);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("v6.16 local compaction is source-linked, bounded, and never rewrites the fresh tail", async () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy);
  try {
    journal.captureTurn({ scope: "default", sessionId: "compact", hostCorrelation: "seed", events: Array.from({ length: 6 }, (_value, index) => ({
      scope: "default", sessionId: "compact", kind: index % 2 ? "assistant_message" : "user_message", role: index % 2 ? "assistant" : "user", contextDomain: "user_chat",
      hostEntryId: `m${index + 1}`, parts: [{ type: "text", text: `event ${index + 1} durable detail` }]
    })) });
    let calls = 0, rewritten;
    const service = new ContextCompactionService(store.db, policy, { async summarize({ source, signal }) { calls++; assert.equal(signal?.aborted ?? false, false); assert.match(source, /event 1/); assert.doesNotMatch(source, /event 5/); return "User chose <safe> bounded summary"; } });
    const result = await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, currentTokenCount: 200, options: { minEvents: 4, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000 }, runtimeContext: { async rewriteTranscriptEntries(value) { rewritten = value; return { changed: true, bytesFreed: 100, rewrittenEntries: value.replacements.length }; } } });
    assert.equal(result.compacted, true, JSON.stringify(result)); assert.equal(result.reason, "source_linked_incremental_compaction"); assert.equal(result.firstKeptEntryId, "m5"); assert.equal(calls, 1);
    assert.equal(rewritten.replacements.length, 4); assert.equal(rewritten.replacements[0].entryId, "m1"); assert.equal(rewritten.replacements.at(-1).entryId, "m4");
    const summary = new SummaryRepository(store.db, policy).list("default", "compact")[0];
    assert.match(summary.content, /&lt;safe&gt;/); assert.deepEqual(new SummaryRepository(store.db, policy).expand(summary.id, "default").events.map(row => row.id).length, 4);
    assert.deepEqual({ ...store.db.prepare("SELECT status,selected_event_count FROM mnemora_compaction_runs").get() }, { status: "succeeded", selected_event_count: 4 });
    const repeated = await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, options: { minEvents: 4, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000 }, runtimeContext: { async rewriteTranscriptEntries() { throw new Error("must_not_rewrite"); } } });
    assert.notEqual(repeated.compacted, true); assert.equal(calls, 1);
  } finally { store.close(); }
});

test("v6.16 chunks bounded leaves into an expandable root and preserves every source anchor", async () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy);
  try {
    journal.captureTurn({ scope: "default", sessionId: "chunked", hostCorrelation: "chunked", events: Array.from({ length: 10 }, (_value, index) => ({
      scope: "default", sessionId: "chunked", kind: index % 2 ? "assistant_message" : "user_message", role: index % 2 ? "assistant" : "user", contextDomain: "user_chat", hostEntryId: `m${index + 1}`, parts: [{ type: "text", text: `source ${index + 1} ${"x".repeat(480)}` }]
    })) });
    let calls = 0, rewrite;
    const result = await new ContextCompactionService(store.db, policy, { async summarize({ source }) { calls++; assert.ok(source.length <= 1000); return `leaf ${calls}`; } }).compact({
      scope: "default", sessionId: "chunked", protectedRecentEvents: 2, currentTokenCount: 5000, targetTokens: 0,
      options: { minEvents: 2, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000, leafChunkTokens: 256, maxChunksPerRun: 4, condensedMinFanout: 4, deadlineMs: 5000 },
      runtimeContext: { async rewriteTranscriptEntries(value) { rewrite = value; return { changed: true, rewrittenEntries: value.replacements.length }; } }
    });
    assert.equal(result.compacted, true, JSON.stringify(result)); assert.equal(result.details.chunks, 4); assert.equal(calls, 4); assert.equal(rewrite.replacements.length, 8);
    assert.deepEqual(rewrite.replacements.map(item => item.entryId), ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
    const summaries = new SummaryRepository(store.db, policy), root = summaries.roots("default", "chunked")[0];
    assert.equal(root.level, 1); assert.equal(root.childSummaryIds.length, 4); assert.equal(root.injectionEligible, true);
    assert.equal(summaries.expand(root.id, "default").events.length, 8);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events WHERE id IN (SELECT event_id FROM mnemora_summary_event_edges) AND deleted_at IS NULL").get().n, 8);
  } finally { store.close(); }
});

test("v6.16 assembles one summary root with a strict fresh tail and proactively compacts afterTurn", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-v616-")), dbPath = join(directory, "memory.db");
  const config = normalizeConfig({ dbPath, contextEngine: { enabled: true, maxContextTokens: 256, protectedRecentEvents: 2, compaction: { enabled: true, minEvents: 2, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000, contextThreshold: .75, freshTailCount: 2, leafChunkTokens: 300, maxChunksPerRun: 4, condensedMinFanout: 2, deadlineMs: 5000 } } });
  const open = () => { const store = new GraphologyStore(dbPath); return { store, close() { store.close(); } }; };
  const engine = new MnemoraContextEngine(config, open), messages = Array.from({ length: 6 }, (_value, index) => ({ id: `m${index + 1}`, role: index % 2 ? "assistant" : "user", content: `turn ${index + 1} ${"x".repeat(220)}` }));
  let rewrites = 0;
  try {
    await engine.afterTurn({ sessionId: "projected", prePromptMessageCount: 0, tokenBudget: 256, messages, runtimeContext: {
      llm: { async complete() { return { text: "bounded leaf" }; } },
      async rewriteTranscriptEntries(value) { rewrites++; return { changed: true, rewrittenEntries: value.replacements.length }; }
    } });
    assert.equal(rewrites, 1);
    const assembled = await engine.assemble({ sessionId: "projected", messages, tokenBudget: 256 });
    assert.equal(assembled.estimatedTokens <= 256, true);
    assert.equal(assembled.messages.length, 3);
    assert.equal(assembled.messages[0].role, "system"); assert.match(String(assembled.messages[0].content), /MNEMORA_COMPACTION/);
    assert.deepEqual(assembled.messages.slice(1).map(item => item.id), ["m5", "m6"]);
    assert.equal(assembled.promptAuthority, "assembled");
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("v6.25.1 proactive compaction uses durable Journal volume when afterTurn exposes only a delta", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-v6251-threshold-")), dbPath = join(directory, "memory.db");
  const config = normalizeConfig({ dbPath, contextEngine: { enabled: true, maxContextTokens: 256, protectedRecentEvents: 2, compaction: { enabled: true, minEvents: 2, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000, contextThreshold: .75, freshTailCount: 2, leafChunkTokens: 300, maxChunksPerRun: 4, condensedMinFanout: 2, deadlineMs: 5000 } } });
  const open = () => { const store = new GraphologyStore(dbPath); return { store, close() { store.close(); } }; };
  const engine = new MnemoraContextEngine(config, open);
  try {
    await engine.ingestBatch({ sessionId: "delta-only", messages: Array.from({ length: 4 }, (_value, index) => ({ id: `old-${index + 1}`, role: index % 2 ? "assistant" : "user", content: `durable prior event ${index + 1}: ${"x".repeat(420)}` })) });
    let rewrites = 0;
    await engine.afterTurn({ sessionId: "delta-only", prePromptMessageCount: 0, tokenBudget: 256, messages: [{ id: "delta", role: "user", content: "ok" }], runtimeContext: {
      llm: { async complete() { return { text: "bounded durable summary" }; } },
      async rewriteTranscriptEntries(value) { rewrites++; assert.equal(value.replacements.length >= 2, true); return { changed: true, rewrittenEntries: value.replacements.length }; }
    } });
    assert.equal(rewrites, 1, "a one-message afterTurn delta must not hide the already-durable session volume");
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("explicit compact and maintain ignore host delta counts in favor of durable Journal volume", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-host-delta-")), dbPath = join(directory, "memory.db");
  const config = normalizeConfig({ dbPath, contextEngine: { enabled: true, maxContextTokens: 256, protectedRecentEvents: 2, compaction: { enabled: true, minEvents: 2, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000, contextThreshold: .75, freshTailCount: 2, leafChunkTokens: 300, maxChunksPerRun: 4, condensedMinFanout: 2, deadlineMs: 5000 } } });
  const open = () => { const store = new GraphologyStore(dbPath); return { store, close() { store.close(); } }; };
  const engine = new MnemoraContextEngine(config, open);
  const messages = (prefix) => Array.from({ length: 4 }, (_value, index) => ({ id: `${prefix}-${index + 1}`, role: index % 2 ? "assistant" : "user", content: `durable event ${index + 1}: ${"x".repeat(420)}` }));
  const runtime = { tokenBudget: 256, currentTokenCount: 1, llm: { async complete() { return { text: "durable bounded summary" }; } }, async rewriteTranscriptEntries(value) { return { changed: true, rewrittenEntries: value.replacements.length }; } };
  try {
    await engine.ingestBatch({ sessionId: "explicit-host-delta", messages: messages("explicit") });
    const explicit = await engine.compact({ sessionId: "explicit-host-delta", sessionFile: "unused", currentTokenCount: 1, runtimeContext: runtime });
    assert.equal(explicit.compacted, true, JSON.stringify(explicit));
    assert.equal(explicit.result.tokensBefore > 192, true, "the durable Journal, not the host delta, determines compaction volume");

    await engine.ingestBatch({ sessionId: "maintain-host-delta", messages: messages("maintain") });
    const maintained = await engine.maintain({ sessionId: "maintain-host-delta", runtimeContext: runtime });
    assert.equal(maintained.changed, true, JSON.stringify(maintained));
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("v6.17 compaction projects individually oversized source events without exposing or repeatedly retrying them", async () => {
  const store = new GraphologyStore(":memory:"), dropped = { ...policy, sensitiveContentPolicy: "drop" }, journal = new ConversationEventRepository(store.db, dropped);
  try {
    const content = ["event one", "api_key=SECRET_VALUE", "x".repeat(2000), "event four", "event five", "event six", "fresh seven", "fresh eight"];
    journal.captureTurn({ scope: "default", sessionId: "compact", hostCorrelation: "v610-skips", events: content.map((text, index) => ({ scope: "default", sessionId: "compact", kind: index % 2 ? "assistant_message" : "user_message", role: index % 2 ? "assistant" : "user", contextDomain: "user_chat", hostEntryId: `m${index + 1}`, parts: [{ type: "text", text }] })) });
    const sources = [], replacements = [];
    const service = new ContextCompactionService(store.db, dropped, { async summarize(input) { sources.push(input.source); return "safe summary"; } });
    const options = { minEvents: 4, maxInputChars: 1024, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000 };
    const result = await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, options, runtimeContext: { async rewriteTranscriptEntries(input) { replacements.push(...input.replacements); return { changed: true }; } } });
    assert.equal(result.compacted, true, JSON.stringify(result));
    assert.equal(result.details.selectedEvents, 5); assert.equal(result.details.skippedEvents, 1);
    assert.equal(Number(result.details.selectedSourceTokens) > Number(result.details.estimatedModelInputTokens), true, "oversized fallback accounting distinguishes source reduction from bounded model input");
    assert.match(sources.join("\n"), /event one/); assert.match(sources.join("\n"), /event six/); assert.doesNotMatch(sources.join("\n"), /SECRET_VALUE|x{100}/);
    assert.deepEqual(replacements.map(item => item.entryId), ["m1", "m3", "m4", "m5", "m6"]);
    assert.match(String(result.summary), /exceeded the compaction input bound/);
    const second = await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, options, runtimeContext: { async rewriteTranscriptEntries() { throw new Error("must not rewrite a succeeded source"); } } });
    assert.equal(second.compacted, false);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_compaction_runs WHERE failure_category='fallback_oversized_source_event' AND status='succeeded'").get().n, 1);
  } finally { store.close(); }
});

test("v6.11 compaction charges failed work and retires a stale non-injectable summary", () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy), runs = new CompactionRunRepository(store.db), summaries = new SummaryRepository(store.db, policy), now = 5_000_000;
  try {
    const firstEvent = journal.append({ scope: "default", sessionId: "compact", kind: "user_message", role: "user", contextDomain: "user_chat", parts: [{ type: "text", text: "first source" }], createdAt: now });
    const secondEvent = journal.append({ scope: "default", sessionId: "compact", kind: "assistant_message", role: "assistant", contextDomain: "user_chat", parts: [{ type: "text", text: "second source" }], createdAt: now });
    store.db.prepare("INSERT INTO mnemora_compaction_runs(id,scope,session_id,source_fingerprint,status,summary_id,selected_event_count,input_chars,estimated_input_tokens,estimated_output_tokens,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("failed-budget", "default", "other", "failed-budget", "failed", null, 0, 0, 80, 0, now, now, now);
    assert.equal(runs.limits({ scope: "default", sessionId: "compact", now, maxRunsPerHour: 10, maxDailyTokens: 80, circuitCooldownMs: 60_000, summaryMaxCallsPerWindow: 10, summaryCallWindowMs: 60_000, summarySpendBackoffMs: 60_000 }), "daily_budget_exhausted");
    assert.equal(estimateCompactionTokens("中文摘要"), 4);
    const initial = runs.reserve({ scope: "default", sessionId: "compact", fingerprint: "stale-summary", selectedEventCount: 2, inputChars: 8, estimatedInputTokens: 8, now, staleRunningMs: 60_000 });
    assert.ok(initial.run); runs.update(initial.run.id, "running", now);
    const orphan = summaries.create({ id: initial.run.summaryId, scope: "default", sessionId: "compact", eventIds: [firstEvent.id, secondEvent.id], content: "中文摘要", maxChars: 100, injectionEligible: false, now });
    assert.equal(orphan.estimatedTokens, 4);
    const replacement = runs.reserve({ scope: "default", sessionId: "compact", fingerprint: "stale-summary", selectedEventCount: 2, inputChars: 8, estimatedInputTokens: 8, now: now + 60_001, staleRunningMs: 60_000 });
    assert.ok(replacement.run); assert.notEqual(replacement.run.summaryId, orphan.id);
    assert.deepEqual({ ...store.db.prepare("SELECT injection_eligible,deleted_at FROM mnemora_summary_nodes WHERE id=?").get(orphan.id) }, { injection_eligible: 0, deleted_at: now + 60_001 });
  } finally { store.close(); }
});

test("v6.16 compaction degrades model failures safely and still fails closed on declined rewrites", async () => {
  const seed = () => {
    const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy);
    journal.captureTurn({ scope: "default", sessionId: "compact", hostCorrelation: `seed-${Math.random()}`, events: Array.from({ length: 6 }, (_value, index) => ({ scope: "default", sessionId: "compact", kind: index % 2 ? "assistant_message" : "user_message", role: index % 2 ? "assistant" : "user", contextDomain: "user_chat", hostEntryId: `m${index + 1}`, parts: [{ type: "text", text: `event ${index + 1}` }] })) });
    return store;
  };
  const options = { minEvents: 4, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000 };
  const failed = seed();
  try {
    let rewrites = 0;
    const result = await new ContextCompactionService(failed.db, policy, { async summarize() { throw new Error("provider response must not escape"); } }).compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, options, runtimeContext: { async rewriteTranscriptEntries() { rewrites++; return { changed: true }; } } });
    assert.deepEqual({ compacted: result.compacted, reason: result.reason }, { compacted: true, reason: "source_linked_fallback_compaction" }); assert.equal(rewrites, 1);
    assert.deepEqual({ ...failed.db.prepare("SELECT status,failure_category FROM mnemora_compaction_runs").get() }, { status: "succeeded", failure_category: "fallback_model_failed" });
    assert.equal(failed.db.prepare("SELECT COUNT(*) AS n FROM mnemora_summary_nodes WHERE deleted_at IS NULL AND injection_eligible=1").get().n, 1);
    assert.match(result.summary, /Durable, source-linked Journal evidence/);
  } finally { failed.close(); }
  const declined = seed();
  try {
    const result = await new ContextCompactionService(declined.db, policy, { async summarize() { return "safe summary"; } }).compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, options, runtimeContext: { async rewriteTranscriptEntries() { return { changed: false, reason: "host_declined" }; } } });
    assert.equal(result.reason, "runtime_rewrite_declined");
    assert.equal(declined.db.prepare("SELECT COUNT(*) AS n FROM mnemora_summary_nodes WHERE deleted_at IS NULL").get().n, 0);
    assert.deepEqual({ ...declined.db.prepare("SELECT status,failure_category FROM mnemora_compaction_runs").get() }, { status: "failed", failure_category: "runtime_rewrite_declined" });
  } finally { declined.close(); }
  const ambiguous = seed();
  try {
    let calls = 0;
    const service = new ContextCompactionService(ambiguous.db, policy, { async summarize() { calls++; return "safe summary"; } });
    const result = await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, options, runtimeContext: { async rewriteTranscriptEntries() { throw new Error("host outcome unknown"); } } });
    assert.equal(result.reason, "runtime_rewrite_unknown");
    assert.deepEqual({ ...ambiguous.db.prepare("SELECT status FROM mnemora_compaction_runs").get() }, { status: "prepared" });
    assert.deepEqual({ ...ambiguous.db.prepare("SELECT injection_eligible,deleted_at FROM mnemora_summary_nodes").get() }, { injection_eligible: 0, deleted_at: null });
    assert.equal((await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, options, runtimeContext: { async rewriteTranscriptEntries() { throw new Error("must_not_retry"); } } })).reason, "replay_pending");
    assert.equal(calls, 1);
    const reconciled = new CompactionRunRepository(ambiguous.db).reconcilePrepared({ scope: "default", id: ambiguous.db.prepare("SELECT id FROM mnemora_compaction_runs").get().id, outcome: "rewrite_not_applied" });
    assert.equal(reconciled?.status, "failed");
    assert.deepEqual({ ...ambiguous.db.prepare("SELECT injection_eligible,deleted_at FROM mnemora_summary_nodes").get() }, { injection_eligible: 0, deleted_at: reconciled?.completedAt });
    const retried = await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, options, runtimeContext: { async rewriteTranscriptEntries() { return { changed: true }; } } });
    assert.equal(retried.compacted, true); assert.equal(calls, 2);
  } finally { ambiguous.close(); }
});

test("v6.16 total deadline aborts model work then commits one evidence-preserving fallback", async () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy);
  try {
    journal.captureTurn({ scope: "default", sessionId: "deadline", hostCorrelation: "deadline", events: Array.from({ length: 6 }, (_value, index) => ({ scope: "default", sessionId: "deadline", kind: index % 2 ? "assistant_message" : "user_message", role: index % 2 ? "assistant" : "user", contextDomain: "user_chat", hostEntryId: `m${index + 1}`, parts: [{ type: "text", text: `deadline source ${index + 1}` }] })) });
    let rewrites = 0;
    const result = await new ContextCompactionService(store.db, policy, { async summarize({ signal }) { return await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })); } }).compact({
      scope: "default", sessionId: "deadline", protectedRecentEvents: 2,
      options: { minEvents: 4, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 5000, maxRunsPerHour: 4, maxDailyTokens: 10000, deadlineMs: 1000 },
      runtimeContext: { async rewriteTranscriptEntries() { rewrites++; return { changed: true }; } }
    });
    assert.equal(result.reason, "source_linked_fallback_compaction"); assert.equal(rewrites, 1);
    assert.deepEqual({ ...store.db.prepare("SELECT status,failure_category FROM mnemora_compaction_runs").get() }, { status: "succeeded", failure_category: "fallback_deadline_exceeded" });
  } finally { store.close(); }
});

test("v6.3 compaction gates model work on host rewrite, rate, budget, failure cooldown, and abort safety", async () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy);
  try {
    journal.captureTurn({ scope: "default", sessionId: "compact", hostCorrelation: "seed", events: Array.from({ length: 6 }, (_value, index) => ({ scope: "default", sessionId: "compact", kind: index % 2 ? "assistant_message" : "user_message", role: index % 2 ? "assistant" : "user", contextDomain: "user_chat", hostEntryId: `m${index + 1}`, parts: [{ type: "text", text: `event ${index + 1}` }] })) });
    let calls = 0;
    const service = new ContextCompactionService(store.db, policy, { async summarize() { calls++; return "safe"; } });
    const options = { minEvents: 4, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 1, maxDailyTokens: 10000 };
    assert.equal((await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, options, runtimeContext: undefined })).reason, "runtime_rewrite_unavailable");
    assert.equal(calls, 0);
    store.db.prepare("INSERT INTO mnemora_compaction_runs(id,scope,session_id,source_fingerprint,status,summary_id,selected_event_count,input_chars,estimated_input_tokens,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("prior", "default", "other", "prior", "succeeded", null, 0, 0, 1000, Date.now(), Date.now());
    assert.equal((await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, options, runtimeContext: { async rewriteTranscriptEntries() { return { changed: true }; } } })).reason, "rate_limited");
    assert.equal(calls, 0);
    assert.equal((await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, options: { ...options, maxRunsPerHour: 4, maxDailyTokens: 1000 }, runtimeContext: { async rewriteTranscriptEntries() { return { changed: true }; } } })).reason, "daily_budget_exhausted");
    for (const id of ["failed-a", "failed-b", "failed-c"]) store.db.prepare("INSERT INTO mnemora_compaction_runs(id,scope,session_id,source_fingerprint,status,summary_id,selected_event_count,input_chars,estimated_input_tokens,failure_category,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, "default", "other", id, "failed", null, 0, 0, 0, "model_transport", Date.now(), Date.now(), Date.now());
    const failureTime = Date.now();
    assert.equal((await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, now: failureTime, options: { ...options, maxRunsPerHour: 8, maxDailyTokens: 10000, circuitCooldownMs: 60000 }, runtimeContext: { async rewriteTranscriptEntries() { return { changed: true }; } } })).reason, "circuit_open");
    const recovered = await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, now: failureTime + 60000, options: { ...options, maxRunsPerHour: 8, maxDailyTokens: 10000, circuitCooldownMs: 60000 }, runtimeContext: { async rewriteTranscriptEntries() { return { changed: true }; } } });
    assert.notEqual(recovered.reason, "circuit_open");
    const controller = new AbortController(); controller.abort(new Error("stop"));
    await assert.rejects(() => service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, options: { ...options, maxRunsPerHour: 4 }, runtimeContext: { async rewriteTranscriptEntries() { return { changed: true }; } }, signal: controller.signal }), /stop/);
  } finally { store.close(); }
});

test("v6.7 compaction applies per-session summary spend backoff before any model call", async () => {
  const store = new GraphologyStore(":memory:"), journal = new ConversationEventRepository(store.db, policy), now = 1_000_000;
  try {
    journal.captureTurn({ scope: "default", sessionId: "compact", hostCorrelation: "seed", createdAt: now, events: Array.from({ length: 6 }, (_value, index) => ({ scope: "default", sessionId: "compact", kind: index % 2 ? "assistant_message" : "user_message", role: index % 2 ? "assistant" : "user", contextDomain: "user_chat", hostEntryId: `m${index + 1}`, parts: [{ type: "text", text: `event ${index + 1}` }] })) });
    for (const id of ["spent-a", "spent-b"]) store.db.prepare("INSERT INTO mnemora_compaction_runs(id,scope,session_id,source_fingerprint,status,summary_id,selected_event_count,input_chars,estimated_input_tokens,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, "default", "compact", id, "succeeded", null, 0, 0, 0, now, now);
    let calls = 0; const service = new ContextCompactionService(store.db, policy, { async summarize() { calls++; return "safe"; } });
    const options = { minEvents: 4, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 24, maxDailyTokens: 10000, summaryMaxCallsPerWindow: 2, summaryCallWindowMs: 60000, summarySpendBackoffMs: 60000 };
    const runtimeContext = { async rewriteTranscriptEntries() { return { changed: true }; } };
    assert.equal((await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, now, options, runtimeContext })).reason, "summary_spend_backoff");
    assert.equal((await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, now: now + 60000, options, runtimeContext })).reason, "summary_call_window_exhausted");
    assert.equal((await service.compact({ scope: "default", sessionId: "compact", protectedRecentEvents: 2, now: now + 60001, options, runtimeContext })).compacted, true);
    assert.equal(calls, 1);
  } finally { store.close(); }
});

test("v6.3 ContextEngine uses the public host LLM and owns compaction only when explicitly enabled", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-v63-")), dbPath = join(directory, "memory.db");
  const config = normalizeConfig({ dbPath, mode: "standalone", contextEngine: { enabled: true, protectedRecentEvents: 2, compaction: { enabled: true, minEvents: 4, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000 } } });
  const open = () => { const store = new GraphologyStore(dbPath); return { store, close() { store.close(); } }; };
  const engine = new MnemoraContextEngine(config, open);
  try {
    await engine.afterTurn({ sessionId: "compact", prePromptMessageCount: 0, messages: Array.from({ length: 6 }, (_value, index) => ({ id: `m${index + 1}`, role: index % 2 ? "assistant" : "user", content: `event ${index + 1}` })) });
    let completions = 0, rewrites = 0;
    const result = await engine.compact({ sessionId: "compact", sessionFile: "session.jsonl", currentTokenCount: 100, runtimeContext: {
      llm: { async complete(value) { completions++; assert.match(value.systemPrompt, /non-authoritative/); return { text: "host model summary" }; } },
      async rewriteTranscriptEntries(value) { rewrites++; assert.equal(value.replacements.length, 4); return { changed: true, bytesFreed: 10, rewrittenEntries: 4 }; }
    } });
    assert.equal(engine.info.ownsCompaction, true); assert.deepEqual({ ok: result.ok, compacted: result.compacted, reason: result.reason }, { ok: true, compacted: true, reason: "source_linked_incremental_compaction" }); assert.equal(completions, 1); assert.equal(rewrites, 1);
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("v6.3 ContextEngine aborts a public host model at its local compaction timeout", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-v63-timeout-")), dbPath = join(directory, "memory.db");
  const config = normalizeConfig({ dbPath, contextEngine: { enabled: true, protectedRecentEvents: 2, compaction: { enabled: true, minEvents: 4, maxInputChars: 1000, maxOutputChars: 300, timeoutMs: 1000, maxRunsPerHour: 4, maxDailyTokens: 10000 } } });
  const open = () => { const store = new GraphologyStore(dbPath); return { store, close() { store.close(); } }; };
  const engine = new MnemoraContextEngine(config, open);
  try {
    await engine.afterTurn({ sessionId: "compact", prePromptMessageCount: 0, messages: Array.from({ length: 6 }, (_value, index) => ({ id: `m${index + 1}`, role: index % 2 ? "assistant" : "user", content: `event ${index + 1}` })) });
    let rewrites = 0;
    const result = await engine.compact({ sessionId: "compact", sessionFile: "session.jsonl", runtimeContext: {
      llm: { async complete(value) { return await new Promise((_resolve, reject) => value.signal.addEventListener("abort", () => reject(value.signal.reason), { once: true })); } },
      async rewriteTranscriptEntries() { rewrites++; return { changed: true }; }
    } });
    assert.deepEqual({ compacted: result.compacted, reason: result.reason }, { compacted: true, reason: "source_linked_fallback_compaction" }); assert.equal(rewrites, 1);
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("ContextEngine applies its budget and delegates compaction without suppressing host safety", async () => {
  const config = normalizeConfig({ dbPath: ":memory:", contextEngine: { enabled: true, maxContextTokens: 256, maxSummaryChars: 500, protectedRecentEvents: 2 } });
  let delegated = 0;
  const engine = new MnemoraContextEngine(config, () => { const store = new GraphologyStore(":memory:"); return { store, close() { store.close(); } }; }, async () => ({ delegated: ++delegated }));
  const assembled = await engine.assemble({ sessionId: "s", messages: [{ role: "user", content: "x".repeat(3000) }, { role: "user", content: "recent" }], tokenBudget: 256 });
  assert.deepEqual(assembled.messages, [{ role: "user", content: "recent" }]);
  assert.equal(assembled.estimatedTokens <= 256, true);
  assert.equal(assembled.promptAuthority, "assembled");
  assert.equal(engine.info.ownsCompaction, false);
  assert.deepEqual(await engine.compact({ sessionId: "s", sessionFile: "session.jsonl" }), { delegated: 1 });
  const controller = new AbortController(); controller.abort(new Error("stop"));
  await assert.rejects(() => engine.compact({ sessionId: "s", sessionFile: "session.jsonl", abortSignal: controller.signal }), /stop/);
});

test("ContextEngine exposes unavoidable active-user overflow without dropping or truncating it", async () => {
  const config = normalizeConfig({ dbPath: ":memory:", contextEngine: { enabled: true, maxContextTokens: 256 } });
  const engine = new MnemoraContextEngine(config, () => { const store = new GraphologyStore(":memory:"); return { store, close() { store.close(); } }; });
  const current = { role: "user", content: "x".repeat(100000) };
  const assembled = await engine.assemble({ sessionId: "s", messages: [{ role: "assistant", content: "old" }, current], tokenBudget: 256 });
  assert.deepEqual(assembled.messages, [current]);
  assert.equal(assembled.estimatedTokens, 25000);
  assert.equal(assembled.promptAuthority, "preassembly_may_overflow");
});

test("ContextEngine preserves the current user message verbatim and never emits a summary prompt", async () => {
  const config = normalizeConfig({ dbPath: ":memory:", contextEngine: { enabled: true, maxContextTokens: 256 } });
  const engine = new MnemoraContextEngine(config, () => { const store = new GraphologyStore(":memory:"); return { store, close() { store.close(); } }; });
  const quoted = { role: "user", id: "current", content: [{ type: "text", text: "Explain this code" }, { type: "quote", body: "daily report", reference: "message-1" }] };
  const assembled = await engine.assemble({ sessionId: "s", messages: [{ role: "system", content: "safety" }, { role: "user", content: "old".repeat(2000) }, quoted], tokenBudget: 256 });
  assert.equal(assembled.messages.includes(quoted), true);
  assert.deepEqual(assembled.messages.find(message => message.id === "current"), quoted);
  assert.equal("systemPromptAddition" in assembled, false);
});

test("standalone ContextEngine is the single opt-in unified-memory prompt producer", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-retrieval-"));
  const config = normalizeConfig({ dbPath: join(directory, "memory.db"), mode: "standalone", contextEngine: { enabled: true, maxContextTokens: 512 }, unifiedRetrieval: { enabled: true, tokenBudget: 160, maxItems: 2, minConfidence: .5 } });
  const open = () => { const store = new GraphologyStore(config.dbPath); return { store, close() { store.close(); } }; };
  const graph = open();
  try { new ConversationEventRepository(graph.store.db, policy).append({ scope: "default", sessionId: "old", kind: "user_message", role: "user", parts: [{ type: "text", text: "The user prefers TypeScript for coding projects" }] }); } finally { graph.close(); }
  const engine = new MnemoraContextEngine(config, open), current = { id: "current", role: "user", content: "Help me with TypeScript coding" };
  const assembled = await engine.assemble({ sessionId: "new", prompt: "TypeScript coding", messages: [{ role: "system", content: "host policy" }, current], tokenBudget: 512 });
  assert.equal(assembled.messages.at(-1), current); assert.match(assembled.systemPromptAddition ?? "", /MNEMORA_MEMORY/); assert.match(assembled.systemPromptAddition ?? "", /non_authoritative/);
});

test("ContextEngine records lifecycle use only after a bounded memory attachment and renders its provenance", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-recall-usage-"));
  const config = normalizeConfig({ dbPath: join(directory, "memory.db"), contextEngine: { enabled: true, maxContextTokens: 512 }, unifiedRetrieval: { enabled: true, tokenBudget: 160, maxItems: 2, minConfidence: .5 } });
  const open = () => new Mnemora({ config });
  const graph = open(); let document;
  try { document = graph.kg_memory({ operation: "store", title: "Release policy", content: "Use a preview before production release." }); }
  finally { graph.close(); }
  const engine = new MnemoraContextEngine(config, open);
  try {
    const assembled = await engine.assemble({ sessionId: "usage", prompt: "production release", messages: [{ role: "user", content: "Prepare a production release" }], tokenBudget: 512 });
    assert.match(assembled.systemPromptAddition ?? "", /ref=mnemora:\/\/v1\/scope\/default\/memory-document\//);
    const verify = open();
    try {
      const ref = createMnemoraContextRef({ scope: "default", kind: "memory-document", id: document.id });
      assert.equal(verify.recallUsage.usage("default", ref)?.recallCount, 1);
      assert.deepEqual(verify.kg_memory({ operation: "recall_decay_review", min_age_days: 1 }).candidates, []);
    } finally { verify.close(); }
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("ContextEngine excludes only an explicit public agent identity from automatic assembly", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-agent-id-"));
  const config = normalizeConfig({ dbPath: join(directory, "memory.db"), contextEngine: { enabled: true, maxContextTokens: 512 }, unifiedRetrieval: { enabled: true, tokenBudget: 160, maxItems: 2, minConfidence: .5 }, recall: { excludedAgentIds: ["background:worker"] } });
  const open = () => { const store = new GraphologyStore(config.dbPath); return { store, close() { store.close(); } }; };
  const graph = open();
  try { new ConversationEventRepository(graph.store.db, policy).append({ scope: "default", sessionId: "old", kind: "user_message", role: "user", parts: [{ type: "text", text: "The user prefers TypeScript for coding projects" }] }); } finally { graph.close(); }
  const engine = new MnemoraContextEngine(config, open);
  try {
    const excluded = await engine.assemble({ sessionId: "excluded", prompt: "TypeScript coding", messages: [{ role: "user", agentId: "Background:Worker", content: "Help me with TypeScript coding" }], tokenBudget: 512 });
    const ordinary = await engine.assemble({ sessionId: "ordinary", prompt: "TypeScript coding", messages: [{ role: "user", content: "Help me with TypeScript coding" }], tokenBudget: 512 });
    assert.equal(excluded.systemPromptAddition, undefined);
    assert.match(ordinary.systemPromptAddition ?? "", /MNEMORA_MEMORY/);
    await engine.afterTurn({ sessionId: "excluded", prePromptMessageCount: 0, messages: [{ id: "excluded-user", role: "user", agentId: "Background:Worker", content: "Do not persist this" }, { id: "excluded-assistant", role: "assistant", content: "This response must not be captured" }] });
    const verify = open(); try { assert.equal(verify.store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events WHERE session_id='excluded'").get().value, 0); } finally { verify.close(); }
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("ContextEngine honors tag routing in unified retrieval and fails open on hostile capture input", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-v610-routing-"));
  const config = normalizeConfig({ dbPath: join(directory, "memory.db"), contextEngine: { enabled: true, maxContextTokens: 800 }, unifiedRetrieval: { enabled: true, tokenBudget: 240, maxItems: 3, minConfidence: .5 }, recall: { queryRouting: { enabled: true } } });
  const open = () => new Mnemora({ config });
  const graph = open();
  try {
    graph.kg_memory({ operation: "store", title: "Research note", content: "tagged retrieval must retain this research note", metadata: { tags: "research" } });
    graph.kg_memory({ operation: "store", title: "Personal note", content: "personal result must stay out of research tag recall", metadata: { tags: "personal" } });
  } finally { graph.close(); }
  const engine = new MnemoraContextEngine(config, open);
  try {
    const assembled = await engine.assemble({ sessionId: "tags", prompt: "tag:research", messages: [{ role: "user", content: "Find the research notes" }], tokenBudget: 800 });
    assert.match(assembled.systemPromptAddition ?? "", /tagged retrieval/); assert.doesNotMatch(assembled.systemPromptAddition ?? "", /personal result/);
    await assert.doesNotReject(() => engine.afterTurn({ sessionId: "hostile", prePromptMessageCount: 0, messages: Array.from({ length: 513 }, (_value, index) => ({ id: `m${index}`, role: "user", content: "host input" })) }));
    await assert.doesNotReject(() => engine.ingest({ sessionId: "s".repeat(513), message: { role: "user", content: "host input" } }));
    const verify = open(); try { assert.equal(verify.store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events WHERE session_id='hostile'").get().value, 0); } finally { verify.close(); }
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("ContextEngine forwards exact prefix constraints and never supplements a constrained route with graph recall", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-v622-routing-"));
  const config = normalizeConfig({ dbPath: join(directory, "memory.db"), contextEngine: { enabled: true, maxContextTokens: 800 }, unifiedRetrieval: { enabled: true, tokenBudget: 240, maxItems: 3, minConfidence: .5 }, recall: { queryRouting: { enabled: true } } });
  const open = () => new Mnemora({ config });
  const graph = open();
  try {
    graph.kg_memory({ operation: "store", title: "AIF deployment", content: "bounded AIF deployment runbook", metadata: { project: "AIF", environment: "prod" } });
    graph.kg_memory({ operation: "store", title: "Other deployment", content: "unrelated deployment note", metadata: { project: "other", environment: "prod" } });
  } finally { graph.close(); }
  const engine = new MnemoraContextEngine(config, open);
  try {
    const constrained = await engine.assemble({ sessionId: "prefix", prompt: "proj:AIF env:prod deployment", messages: [{ role: "user", content: "Find the deployment runbook" }], tokenBudget: 800 });
    assert.match(constrained.systemPromptAddition ?? "", /bounded AIF deployment runbook/);
    assert.doesNotMatch(constrained.systemPromptAddition ?? "", /unrelated deployment note|Graph evidence expansion/);
    const mismatch = await engine.assemble({ sessionId: "scope", prompt: "scope:project:other deployment", messages: [{ role: "user", content: "Find deployment" }], tokenBudget: 800 });
    assert.equal(mismatch.systemPromptAddition, undefined);
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("standalone ContextEngine adds bounded semantic recall inside its one attachment when embeddings are enabled", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-semantic-"));
  const config = normalizeConfig({ dbPath: join(directory, "memory.db"), mode: "standalone", contextEngine: { enabled: true, maxContextTokens: 800 }, unifiedRetrieval: { enabled: true, tokenBudget: 320, maxItems: 3, minConfidence: .5 }, embeddings: { enabled: true, model: "fixture-engine" } });
  const embedder = { async embed(inputs) { return { identity: { provider: "ollama", model: "fixture-engine", dimensions: 2 }, vectors: inputs.map(() => [1, 0]) }; } };
  const open = () => new Mnemora({ config, embedder });
  const graph = open();
  try {
    graph.kg_memory({ operation: "store", scope: "default", title: "Packaging constraint", content: "HBM packaging capacity is a bottleneck." });
    await graph.kg_memory({ operation: "embed_backfill", scope: "default", limit: 10 });
  } finally { graph.close(); }
  const engine = new MnemoraContextEngine(config, open);
  const assembled = await engine.assemble({ sessionId: "semantic", prompt: "semiconductor supply chain", messages: [{ role: "user", content: "Help with the semiconductor supply chain" }], tokenBudget: 800 });
  assert.match(assembled.systemPromptAddition ?? "", /Graph evidence expansion/);
  assert.match(assembled.systemPromptAddition ?? "", /Packaging constraint/);
  assert.equal((assembled.systemPromptAddition?.match(/<MNEMORA_MEMORY/g) ?? []).length, 1);
});

test("ContextEngine preserves ordinary history while excluding unknown and background envelopes", async () => {
  const config = normalizeConfig({ dbPath: ":memory:", contextEngine: { enabled: true, maxContextTokens: 512 } });
  const engine = new MnemoraContextEngine(config, () => { const store = new GraphologyStore(":memory:"); return { store, close() { store.close(); } }; });
  const current = { role: "user", id: "current", content: "Explain the latest deployment" };
  const assembled = await engine.assemble({ sessionId: "s", messages: [
    { role: "system", content: "host policy" },
    { role: "system", kind: "scheduler", content: "DO NOT LEAK BACKGROUND" },
    { role: "user", content: "old user history" },
    { role: "assistant", content: "old assistant history" },
    { role: "tool", content: "safe tool result" },
    { role: "tool", kind: "heartbeat", content: "background tool result" },
    { role: "user", type: "background", content: "background disguised as user" },
    { role: "observer", content: "unknown envelope" },
    current
  ], tokenBudget: 512 });
  assert.deepEqual(assembled.messages, [
    { role: "system", content: "host policy" },
    { role: "user", content: "old user history" },
    { role: "assistant", content: "old assistant history" },
    { role: "tool", content: "safe tool result" },
    current
  ]);
  assert.equal(JSON.stringify(assembled.messages).includes("BACKGROUND"), false);
  assert.equal(assembled.messages.includes(current), true);
});

test("ContextEngine never journals unknown host envelopes as user", async () => {
  const config = normalizeConfig({ dbPath: ":memory:", contextEngine: { enabled: true } });
  let store;
  const engine = new MnemoraContextEngine(config, () => { store = new GraphologyStore(":memory:"); return { store, close() { /* inspect below */ } }; });
  await engine.ingest({ sessionId: "s", message: { role: "observer", content: "background text" } });
  const row = store.db.prepare("SELECT kind,role,context_domain FROM mnemora_conversation_events").get();
  assert.equal(row.kind, "system_marker");
  assert.equal(row.role, null);
  assert.equal(row.context_domain, "unknown");
  store.close();
});

test("ContextEngine marks heartbeat afterTurn output as background rather than user chat", async () => {
  const config = normalizeConfig({ dbPath: ":memory:", contextEngine: { enabled: true } });
  let store;
  const engine = new MnemoraContextEngine(config, () => { store = new GraphologyStore(":memory:"); return { store, close() { /* inspect below */ } }; });
  await engine.afterTurn({
    sessionId: "heartbeat-session",
    messages: [{ role: "user", content: "scheduled maintenance completed" }],
    prePromptMessageCount: 0,
    isHeartbeat: true
  });
  const row = store.db.prepare("SELECT kind,role,context_domain FROM mnemora_conversation_events").get();
  assert.deepEqual({ ...row }, { kind: "system_marker", role: null, context_domain: "background" });
  store.close();
});

test("ContextEngine afterTurn captures the real OpenClaw lifecycle exactly once", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-lifecycle-"));
  const config = normalizeConfig({ dbPath: join(directory, "memory.db"), mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true } });
  const open = () => { const store = new GraphologyStore(config.dbPath); return { store, close() { store.close(); } }; };
  const engine = new MnemoraContextEngine(config, open);
  const lifecycle = await import("openclaw/plugin-sdk/agent-harness-runtime");
  const params = {
    contextEngine: engine,
    promptError: false,
    aborted: false,
    yieldAborted: false,
    sessionIdUsed: "session-a",
    sessionFile: "session.jsonl",
    messagesSnapshot: [{ role: "user", content: "remember this", timestamp: 101 }, { role: "assistant", content: "captured", timestamp: 102 }],
    prePromptMessageCount: 0,
    warn() {}
  };
  assert.equal((await lifecycle.finalizeHarnessContextEngineTurn(params)).postTurnFinalizationSucceeded, true);
  assert.equal((await lifecycle.finalizeHarnessContextEngineTurn(params)).postTurnFinalizationSucceeded, true);
  const graph = open();
  try {
    const rows = (graph.store.db.prepare("SELECT role,context_domain FROM mnemora_conversation_events ORDER BY sequence").all()).map(row => ({ ...row }));
    assert.deepEqual(rows, [{ role: "user", context_domain: "user_chat" }, { role: "assistant", context_domain: "user_chat" }]);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_commits").get().value, 1);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_turn_receipt_events").get().value, 2);
  } finally { graph.close(); }
});

test("public OpenClaw lifecycle bootstraps, assembles, restarts, and delegates standalone compaction", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-graduation-"));
  const config = normalizeConfig({ dbPath: join(directory, "memory.db"), mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true, maxSummaryChars: 500, protectedRecentEvents: 2 }, episodicMemory: { enabled: true }, unifiedRetrieval: { enabled: true, tokenBudget: 180, maxItems: 3, minConfidence: .5 } });
  const open = () => { const store = new GraphologyStore(config.dbPath); return { store, close() { store.close(); } }; };
  let delegated = 0;
  const engine = new MnemoraContextEngine(config, open, async () => ({ ok: true, compacted: true, delegated: ++delegated })), lifecycle = await import("openclaw/plugin-sdk/agent-harness-runtime");
  const messages = [
    { id: "graduation-1", role: "user", content: "For coding work, the user prefers TypeScript.", timestamp: 1 },
    { id: "graduation-2", role: "assistant", content: "I will use TypeScript for the implementation.", timestamp: 2 },
    { id: "graduation-3", role: "user", content: "Keep source references before compaction.", timestamp: 3 },
    { id: "graduation-4", role: "assistant", content: "Source references will be retained.", timestamp: 4 }
  ];
  const finalization = { contextEngine: engine, promptError: false, aborted: false, yieldAborted: false, sessionIdUsed: "graduation-session", sessionFile: "session.jsonl", messagesSnapshot: messages, prePromptMessageCount: 0, warn() {} };
  await lifecycle.bootstrapHarnessContextEngine({ contextEngine: engine, hadSessionFile: false, sessionId: "graduation-session", sessionFile: "session.jsonl", warn() {} });
  assert.equal((await lifecycle.finalizeHarnessContextEngineTurn(finalization)).postTurnFinalizationSucceeded, true);
  assert.equal((await lifecycle.finalizeHarnessContextEngineTurn(finalization)).postTurnFinalizationSucceeded, true);
  const assembled = await lifecycle.assembleHarnessContextEngine({ contextEngine: engine, sessionId: "graduation-session", messages: [{ id: "current", role: "user", content: "Help me write TypeScript", timestamp: 5 }], prompt: "TypeScript coding", tokenBudget: 512, modelId: "fixture" });
  assert.match(assembled?.systemPromptAddition ?? "", /MNEMORA_MEMORY/);
  assert.match(assembled?.systemPromptAddition ?? "", /source=mnemora:\/\//);
  const compacted = await lifecycle.compactContextEngineWithSafetyTimeout(engine, { sessionId: "graduation-session", sessionFile: "session.jsonl", currentTokenCount: 100 }, 1_000);
  assert.equal(compacted.ok, true); assert.equal(compacted.compacted, true); assert.equal(delegated, 1);
  const restarted = new MnemoraContextEngine(config, open);
  assert.equal((await lifecycle.bootstrapHarnessContextEngine({ contextEngine: restarted, hadSessionFile: true, sessionId: "graduation-session", sessionFile: "session.jsonl", warn() {} })), undefined);
  const graph = open();
  try {
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events WHERE session_id='graduation-session'").get().n, 4);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_commits").get().n, 1);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_summary_event_edges").get().n, 0);
  } finally { graph.close(); }
});

test("ContextEngine batch capture is atomic and never silently truncates", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-batch-"));
  const config = normalizeConfig({ dbPath: join(directory, "memory.db"), contextEngine: { enabled: true } });
  const open = () => { const store = new GraphologyStore(config.dbPath); return { store, close() { store.close(); } }; };
  const engine = new MnemoraContextEngine(config, open);
  const messages = Array.from({ length: 65 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `event ${index}`, timestamp: index + 1 }));
  assert.deepEqual(await engine.ingestBatch({ sessionId: "session-b", messages }), { ingestedCount: 65 });
  assert.deepEqual(await engine.ingestBatch({ sessionId: "session-b", messages }), { ingestedCount: 0 });
  const graph = open();
  try { assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events").get().value, 65); } finally { graph.close(); }
});

test("v6.25 archives only bounded public tool strings and projects an opaque source-linked reference", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-tool-payload-")), dbPath = join(directory, "memory.db");
  const config = normalizeConfig({ dbPath, contextEngine: { enabled: true, maxContextTokens: 8192 }, artifacts: { enabled: true, inlineThresholdChars: 1024, maxArtifactBytes: 32768, toolPayloads: { enabled: true } } });
  const open = () => { const store = new GraphologyStore(config.dbPath); return { store, close() { store.close(); } }; };
  const engine = new MnemoraContextEngine(config, open), payload = `tool output: ${"x".repeat(20000)}`;
  const messages = [{ id: "tool-user", role: "user", content: "Inspect the generated report" }, { id: "tool-call", role: "assistant", content: "I will inspect it." }, { id: "tool-result", role: "tool", content: payload }];
  try {
    await engine.afterTurn({ sessionId: "tool-session", prePromptMessageCount: 0, messages });
    const graph = open(); let artifact;
    try {
      const row = graph.store.db.prepare("SELECT id,source_event_id,byte_length FROM mnemora_artifacts WHERE scope='default' AND kind='tool_result'").get();
      assert.ok(row?.id); assert.equal(row.byte_length, Buffer.byteLength(payload)); assert.ok(row.source_event_id);
      artifact = row.id;
      assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_host_message_links WHERE entry_id='tool-result'").get().n, 1);
    } finally { graph.close(); }
    const reader = new Mnemora({ config });
    try {
      const recovered = reader.kg_memory({ operation: "artifact_read", artifact_id: artifact, max_bytes: 128 });
      assert.equal(recovered.status, "ok"); assert.equal(recovered.content, payload.slice(0, 128)); assert.equal(recovered.truncated, true);
      assert.deepEqual(reader.kg_memory({ operation: "artifact_read", artifact_id: artifact, scope: "other" }), { status: "not_found" });
    } finally { reader.close(); }
    const assembled = await engine.assemble({ sessionId: "tool-session", messages: [...messages, { id: "tool-current", role: "user", content: "What did the report contain?" }], tokenBudget: 8192 });
    const projected = assembled.messages.find(message => message.id === "tool-result");
    assert.match(projected.content, new RegExp(`artifact_id="${artifact}"`)); assert.match(projected.content, /untrusted_tool_output/); assert.doesNotMatch(projected.content, /x{100}/);
    const otherSession = await engine.assemble({ sessionId: "other-session", messages: [...messages, { id: "other-current", role: "user", content: "What did the report contain?" }], tokenBudget: 8192 });
    assert.equal(otherSession.messages.find(message => message.id === "tool-result").content, payload, "artifact links never cross sessions");

    const secret = "api_key=SECRET_VALUE\n" + "z".repeat(2400), secretMessages = [{ id: "secret-user", role: "user", content: "Inspect the private report" }, { id: "secret-tool", role: "tool", content: secret }];
    await engine.afterTurn({ sessionId: "secret-session", prePromptMessageCount: 0, messages: secretMessages });
    const secretAssembled = await engine.assemble({ sessionId: "secret-session", messages: [...secretMessages, { id: "secret-current", role: "user", content: "Summarize it" }], tokenBudget: 8192 });
    assert.equal(secretAssembled.messages.find(message => message.id === "secret-tool").content, secret, "a redacted artifact must never be advertised as a complete replacement");
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("ContextEngine leaves ignored and stateless sessions readable but never persists their turns", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-session-policy-"));
  const config = normalizeConfig({ dbPath: join(directory, "memory.db"), contextEngine: { enabled: true }, conversationJournal: { ignoreSessionPatterns: ["agent:*:cron:**"], statelessSessionPatterns: ["agent:*:readonly:**"] } });
  const open = () => { const store = new GraphologyStore(config.dbPath); return { store, close() { store.close(); } }; };
  const engine = new MnemoraContextEngine(config, open);
  try {
    assert.deepEqual(await engine.ingest({ sessionId: "agent:alpha:cron:daily", message: { role: "user", content: "ignore this" } }), { ingested: false });
    assert.deepEqual(await engine.ingestBatch({ sessionId: "agent:alpha:readonly:preview", messages: [{ role: "user", content: "do not write" }] }), { ingestedCount: 0 });
    const graph = open();
    try { assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_conversation_events").get().n, 0); } finally { graph.close(); }
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("ContextEngine leaves source-linked compaction to the future bounded compactor and delegates today", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-compact-"));
  const config = normalizeConfig({ dbPath: join(directory, "memory.db"), mode: "standalone", contextEngine: { enabled: true, maxSummaryChars: 500, protectedRecentEvents: 2 } });
  const open = () => { const store = new GraphologyStore(config.dbPath); return { store, close() { store.close(); } }; };
  let delegated;
  const engine = new MnemoraContextEngine(config, open, async value => (delegated = value, { ok: true, compacted: true }));
  const messages = [
    { id: "m1", role: "user", content: "old preference alpha", timestamp: 1 },
    { id: "m2", role: "assistant", content: "old response alpha", timestamp: 2 },
    { id: "m3", role: "user", content: "current task beta", timestamp: 3 },
    { id: "m4", role: "assistant", content: "current response beta", timestamp: 4 }
  ];
  await engine.afterTurn({ sessionId: "compact-session", messages, prePromptMessageCount: 0 });
  const params = { sessionId: "compact-session", sessionFile: "session.jsonl", currentTokenCount: 200 };
  const result = await engine.compact(params);
  assert.equal(result.ok, true); assert.equal(result.compacted, true); assert.deepEqual(delegated, params);
  const graph = open();
  try { assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_summary_nodes WHERE injection_eligible=1").get().n, 0); } finally { graph.close(); }
});

test("ContextEngine completes one safe derived lifecycle after its durable afterTurn capture", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-engine-lifecycle-")), dbPath = join(directory, "memory.db");
  const config = normalizeConfig({ dbPath, contextEngine: { enabled: true } });
  const turns = [];
  const open = () => { const store = new GraphologyStore(dbPath); return { store, close() { store.close(); } }; };
  const engine = new MnemoraContextEngine(config, open, undefined, {
    derivedTaskKinds: () => ["auto_extract"],
    onCompletedTurn: async (turn, receipt) => { turns.push({ turn, receipt }); }
  });
  try {
    await engine.afterTurn({ sessionId: "lifecycle", prePromptMessageCount: 0, messages: [
      { id: "user", role: "user", content: "Keep this bounded." },
      { id: "assistant", role: "assistant", content: "Acknowledged." }
    ] });
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0].turn, { sessionId: "lifecycle", userText: "Keep this bounded.", assistantText: "Acknowledged." });
    assert.deepEqual(turns[0].receipt.tasks.map(task => task.kind), ["auto_extract"]);
  } finally { try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("journal batch rollback cannot commit a partial completed turn", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const repository = new ConversationEventRepository(store.db, policy);
    assert.throws(() => repository.appendBatch([
      { scope: "project-a", sessionId: "session-a", kind: "user_message", role: "user", parts: [{ type: "text", text: "first" }], hostCorrelation: "turn:user" },
      { scope: "project-a", sessionId: "session-a", kind: "assistant_message", role: "assistant", parts: Array.from({ length: 65 }, () => ({ type: "text", text: "too many" })) }
    ]), /invalid_journal_event/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events").get().value, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_commits").get().value, 0);
  } finally { store.close(); }
});
