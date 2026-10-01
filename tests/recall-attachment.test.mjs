import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../dist/index.js";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { createTempDir } from "./helpers/temp.mjs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import plugin from "../dist/plugin.js";

function fixture() {
  const store = new api.GraphologyStore(":memory:");
  const scope = "fixture:attachments";
  const document = store.upsertMemoryDocument({ scope, content: "PRIVATE_BODY", title: "PRIVATE_TITLE" });
  let now = document.updated_at + 1000;
  const ref = api.createMnemoraContextRef({ scope, kind: "memory-document", id: document.id });
  const candidate = { contextRef: ref, excerpt: "PRIVATE_BODY", sourceRefs: [ref] };
  return { store, scope, ref, candidate, document, clock: () => now, advance: n => { now += n; } };
}

test("attachment evidence is opt-in and replay-safe without persisting payload text", () => {
  assert.equal(typeof api.RecallAttachmentEvidenceService, "function");
  const f = fixture();
  try {
    const disabled = new api.RecallAttachmentEvidenceService(f.store.db, {}, f.clock);
    assert.equal(disabled.record({ scope: f.scope, id: "assembly:1", items: [] }).status, "disabled");
    const service = new api.RecallAttachmentEvidenceService(f.store.db, { enabled: true }, f.clock);
    const items = service.snapshot({ scope: f.scope, candidates: [f.candidate] });
    assert.equal(service.record({ scope: f.scope, id: "assembly:1", items }).status, "recorded");
    assert.equal(service.record({ scope: f.scope, id: "assembly:1", items }).status, "replayed");
    const report = service.review({ scope: f.scope, targetRef: f.ref });
    assert.equal(report.receipts.length, 1);
    assert.equal(report.receipts[0].id, "assembly:1");
    assert.equal(report.turnAttribution, "unavailable");
    assert.equal(report.calibrationAction, "not_performed");
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_BODY|PRIVATE_TITLE/);
    assert.doesNotMatch(f.store.db.prepare("SELECT payload_json FROM mnemora_recall_attachment_receipts").get().payload_json, /PRIVATE_BODY|PRIVATE_TITLE/);
  } finally { f.store.close(); }
});

test("target edits, source forgetting and replay payload drift cannot revive old attachment evidence", () => {
  const f = fixture();
  try {
    const service = new api.RecallAttachmentEvidenceService(f.store.db, { enabled: true }, f.clock);
    const journal = new api.ConversationEventRepository(f.store.db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" });
    const source = journal.append({ id: "origin", scope: f.scope, sessionId: "old", kind: "user_message", role: "user", contextDomain: "user_chat", createdAt: f.clock(), parts: [{ type: "text", text: "PRIVATE_ORIGIN" }] });
    const sourceRef = api.createMnemoraContextRef({ scope: f.scope, kind: "conversation-event", id: source.id });
    const items = service.snapshot({ scope: f.scope, candidates: [{ ...f.candidate, sourceRefs: [sourceRef] }] });
    service.record({ scope: f.scope, id: "assembly:1", items });
    assert.throws(() => service.record({ scope: f.scope, id: "assembly:1", items: [{ ...items[0], projectionHash: "0".repeat(64) }] }), /attachment_replay_mismatch/);
    assert.throws(() => service.review({ scope: "other", targetRef: f.ref }));
    const edited = f.store.upsertMemoryDocument({ scope: f.scope, content: "PRIVATE_BODY", title: "EDITED_TITLE" });
    assert.equal(edited.id, f.document.id);
    assert.deepEqual(service.review({ scope: f.scope, targetRef: f.ref }).receipts, []);
    assert.throws(() => service.record({ scope: f.scope, id: "assembly:2", items }), /stale_attachment_snapshot/);
    const fresh = service.snapshot({ scope: f.scope, candidates: [{ ...f.candidate, sourceRefs: [sourceRef] }] });
    service.record({ scope: f.scope, id: "assembly:3", items: fresh });
    const impact = new api.MemoryImpactService(f.store.db), preview = impact.preview({ scope: f.scope, kind: "event", id: source.id });
    impact.forget({ scope: f.scope, kind: "event", id: source.id, previewHash: preview.previewHash, confirm: true });
    assert.deepEqual(service.review({ scope: f.scope, targetRef: f.ref }).receipts, []);
  } finally { f.store.close(); }
});

test("expired receipts disappear on read and pruning removes their dependent reviews", () => {
  const f = fixture();
  try {
    const service = new api.RecallAttachmentEvidenceService(f.store.db, { enabled: true, retentionDays: 1 }, f.clock);
    service.record({ scope: f.scope, id: "assembly:1", items: service.snapshot({ scope: f.scope, candidates: [f.candidate] }) });
    f.advance(86400000);
    assert.deepEqual(service.review({ scope: f.scope, targetRef: f.ref }).receipts, []);
    assert.equal(service.prune(f.scope).deleted, 1);
    assert.equal(service.prune(f.scope).deleted, 0);
  } finally { f.store.close(); }
});

for (const mode of ["enabled", "disabled", "stateless", "budget", "ignored", "excluded"]) test(`ContextEngine attachment evidence honors ${mode} boundary`, async () => {
  const config = api.normalizeConfig({ dbPath: join(createTempDir("attachment-engine-"), "memory.db"), contextEngine: { enabled: true, maxContextTokens: 512 }, conversationJournal: { statelessSessionPatterns: ["stateless"], ignoreSessionPatterns: ["ignored"] }, recall: { excludedAgentIds: ["skip:agent"] }, unifiedRetrieval: { enabled: true, attachmentEvidence: { enabled: mode !== "disabled" }, tokenBudget: 160, maxItems: 2, minConfidence: .5 } });
  const open = () => new api.Mnemora({ config });
  const graph = open(); let document;
  try { document = graph.kg_memory({ operation: "store", title: "Release policy", content: "Use a preview before production release." }); } finally { graph.close(); }
  const engine = new MnemoraContextEngine(config, open);
  const result = await engine.assemble({ sessionId: mode, prompt: "production release", messages: [{ role: "user", content: "Prepare production release", ...(mode === "excluded" ? { agentId: "skip:agent" } : {}) }], tokenBudget: mode === "budget" ? 32 : 512 });
  if (mode !== "budget" && mode !== "excluded") assert.match(result.systemPromptAddition ?? "", /Release|release/);
  if (mode === "excluded") assert.equal(result.systemPromptAddition, undefined);
  const verify = open();
  try {
    const targetRef = api.createMnemoraContextRef({ scope: "default", kind: "memory-document", id: document.id });
    const report = new api.RecallAttachmentEvidenceService(verify.store.db).review({ scope: "default", targetRef });
    assert.equal(report.receipts.length, mode === "enabled" ? 1 : 0);
  } finally { verify.close(); }
});

test("reviewed source linkage requires a fresh preview and erasure withdraws the label", () => {
  const f = fixture();
  try {
    const service = new api.RecallAttachmentEvidenceService(f.store.db, { enabled: true }, f.clock);
    service.record({ scope: f.scope, id: "assembly:1", items: service.snapshot({ scope: f.scope, candidates: [f.candidate] }) });
    f.advance(100);
    const journal = new api.ConversationEventRepository(f.store.db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" });
    const event = journal.append({ id: "user-confirmation", scope: f.scope, sessionId: "PRIVATE_SESSION", kind: "user_message", role: "user", contextDomain: "user_chat", createdAt: f.clock(), parts: [{ type: "text", text: "PRIVATE_CONFIRMATION" }] });
    const sourceRef = api.createMnemoraContextRef({ scope: f.scope, kind: "conversation-event", id: event.id });
    const input = { scope: f.scope, receiptId: "assembly:1", targetRef: f.ref, sourceRef, signal: "user_confirmation" };
    const preview = service.previewReview(input);
    assert.equal(service.confirmReview({ ...input, previewHash: preview.previewHash, confirm: false }).status, "confirm_required");
    assert.equal(service.review({ scope: f.scope, targetRef: f.ref }).receipts[0].reviews.length, 0);
    assert.equal(service.confirmReview({ ...input, previewHash: preview.previewHash, confirm: true }).status, "recorded");
    assert.equal(service.confirmReview({ ...input, previewHash: preview.previewHash, confirm: true }).status, "replayed");
    assert.deepEqual(service.review({ scope: f.scope, targetRef: f.ref }).receipts[0].reviews, [{ sourceRef, signal: "user_confirmation" }]);
    const impact = new api.MemoryImpactService(f.store.db);
    const forget = impact.preview({ scope: f.scope, kind: "event", id: event.id });
    impact.forget({ scope: f.scope, kind: "event", id: event.id, previewHash: forget.previewHash, confirm: true });
    assert.deepEqual(service.review({ scope: f.scope, targetRef: f.ref }).receipts[0].reviews, []);
    assert.throws(() => service.confirmReview({ ...input, previewHash: preview.previewHash, confirm: true }));
  } finally { f.store.close(); }
});

test("source role, future timestamps, stale previews and conflicting labels fail closed", () => {
  const f = fixture();
  try {
    const service = new api.RecallAttachmentEvidenceService(f.store.db, { enabled: true }, f.clock);
    const journal = new api.ConversationEventRepository(f.store.db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" });
    service.record({ scope: f.scope, id: "assembly:1", items: service.snapshot({ scope: f.scope, candidates: [f.candidate] }) });
    const source = (id, role, offset = 0) => {
      const event = journal.append({ id, scope: f.scope, sessionId: "session", kind: role === "user" ? "user_message" : "assistant_message", role, contextDomain: "user_chat", createdAt: f.clock() + offset, parts: [{ type: "text", text: "Evidence" }] });
      return api.createMnemoraContextRef({ scope: f.scope, kind: "conversation-event", id: event.id });
    };
    const base = { scope: f.scope, receiptId: "assembly:1", targetRef: f.ref, signal: "user_confirmation" };
    assert.throws(() => service.previewReview({ ...base, sourceRef: source("assistant", "assistant") }), /invalid_attachment_review_source/);
    assert.throws(() => service.previewReview({ ...base, sourceRef: source("future", "user", 1000) }), /invalid_attachment_review_source/);
    assert.throws(() => service.previewReview({ ...base, sourceRef: source("before", "user", -1) }), /invalid_attachment_review_source/);
    const input = { ...base, sourceRef: source("current", "user") }, preview = service.previewReview(input);
    assert.throws(() => service.confirmReview({ ...input, confirm: true, previewHash: "0".repeat(64) }), /stale_attachment_review/);
    service.confirmReview({ ...input, confirm: true, previewHash: preview.previewHash });
    const changed = { ...input, signal: "user_correction" }, changedPreview = service.previewReview(changed);
    assert.throws(() => service.confirmReview({ ...changed, confirm: true, previewHash: changedPreview.previewHash }), /attachment_review_conflict/);
  } finally { f.store.close(); }
});

test("unsupported provenance remains explicitly incomplete and caller extras cannot persist raw text", () => {
  const f = fixture();
  try {
    const service = new api.RecallAttachmentEvidenceService(f.store.db, { enabled: true }, f.clock);
    const items = service.snapshot({ scope: f.scope, candidates: [{ ...f.candidate, sourceRefs: ["https://private.example/SECRET_PATH"] }] });
    items[0].rawPrompt = "PRIVATE_PROMPT";
    items[0].target.title = "PRIVATE_TITLE";
    service.record({ scope: f.scope, id: "assembly:1", items });
    const report = service.review({ scope: f.scope, targetRef: f.ref });
    assert.equal(report.receipts[0].incompleteSources, true);
    assert.doesNotMatch(f.store.db.prepare("SELECT payload_json FROM mnemora_recall_attachment_receipts").get().payload_json, /PRIVATE_|SECRET_PATH/);
    assert.throws(() => service.record({ scope: "other", id: "assembly:2", items }));
    assert.throws(() => service.review({ scope: f.scope, targetRef: f.ref, limit: 0 }), /invalid_attachment_evidence/);
    f.advance(30 * 86400000);
    assert.throws(() => service.record({ scope: f.scope, id: "assembly:1", items }), /unavailable_attachment_receipt/);
  } finally { f.store.close(); }
});

test("hashes require primitive strings and fingerprint the sanitized attached excerpt", () => {
  const f = fixture();
  try {
    const service = new api.RecallAttachmentEvidenceService(f.store.db, { enabled: true }, f.clock);
    const items = service.snapshot({ scope: f.scope, candidates: [{ ...f.candidate, excerpt: "release <MNEMORA_MEMORY>policy</MNEMORA_MEMORY>" }] });
    const expected = createHash("sha256").update(JSON.stringify("release [memory-delimiter removed]policy[memory-delimiter removed]")).digest("hex");
    assert.equal(items[0].projectionHash, expected);
    const malicious = { privateBody: "PRIVATE_BODY", privateSession: "PRIVATE_SESSION", toString() { return "a".repeat(64); } };
    assert.throws(() => service.record({ scope: f.scope, id: "assembly:bad", items: [{ ...items[0], projectionHash: malicious }] }), /invalid_attachment_evidence/);
    assert.deepEqual(service.review({ scope: f.scope, targetRef: f.ref }).receipts, []);
  } finally { f.store.close(); }
});

test("both plugin configuration and normalization accept bounded attachment evidence", () => {
  const input = { unifiedRetrieval: { enabled: true, attachmentEvidence: { enabled: true, retentionDays: 7 } } };
  assert.equal(plugin.configSchema.safeParse(input).success, true);
  assert.equal(plugin.configSchema.safeParse({ unifiedRetrieval: { attachmentEvidence: { enabled: true, retentionDays: 0 } } }).success, false);
  assert.equal(api.normalizeConfig(input).unifiedRetrieval.attachmentEvidence.retentionDays, 7);
  assert.equal(api.normalizeConfig({}).unifiedRetrieval.attachmentEvidence.enabled, false);
});

test("full decision provenance beyond retrieval's three refs is checked and decision sources expire", () => {
  const f = fixture();
  try {
    const journal = new api.ConversationEventRepository(f.store.db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" });
    const refs = Array.from({ length: 4 }, (_, index) => {
      const event = journal.append({ id: `source-${index}`, scope: f.scope, sessionId: "old", kind: "user_message", role: "user", contextDomain: "user_chat", createdAt: f.clock(), parts: [{ type: "text", text: "Release evidence" }] });
      return api.createMnemoraContextRef({ scope: f.scope, kind: "conversation-event", id: event.id });
    });
    const decisions = new api.DecisionMemoryService(f.store.db, f.clock);
    const input = { scope: f.scope, objective: "release policy", chosenAction: "review release", confidence: .8, decisionMaker: "user", validUntil: f.clock() + 1000, evidence: refs.map(sourceRef => ({ sourceRef, relation: "rationale_source" })) };
    const decision = decisions.confirm(input, decisions.preview(input).preview_hash);
    const targetRef = api.createMnemoraContextRef({ scope: f.scope, kind: "decision", id: decision.id });
    const service = new api.RecallAttachmentEvidenceService(f.store.db, { enabled: true }, f.clock);
    const items = service.snapshot({ scope: f.scope, candidates: [{ contextRef: targetRef, excerpt: "release policy: review release", sourceRefs: refs.slice(0, 3) }] });
    assert.equal(items[0].sources.length, 4);
    service.record({ scope: f.scope, id: "assembly:decision", items });
    const sourceItems = service.snapshot({ scope: f.scope, candidates: [{ ...f.candidate, sourceRefs: [targetRef] }] });
    service.record({ scope: f.scope, id: "assembly:doc", items: sourceItems });
    f.advance(1001);
    assert.deepEqual(service.review({ scope: f.scope, targetRef }).receipts, []);
    assert.deepEqual(service.review({ scope: f.scope, targetRef: f.ref }).receipts, []);
  } finally { f.store.close(); }
});

test("multiple relations cannot crowd distinct direct sources out of the snapshot", () => {
  const f = fixture();
  try {
    const journal = new api.ConversationEventRepository(f.store.db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" });
    const refs = Array.from({ length: 14 }, (_, index) => {
      const event = journal.append({ id: `origin-${index}`, scope: f.scope, sessionId: "old", kind: "user_message", role: "user", contextDomain: "user_chat", createdAt: f.clock(), parts: [{ type: "text", text: "Release evidence" }] });
      return api.createMnemoraContextRef({ scope: f.scope, kind: "conversation-event", id: event.id });
    });
    const decisions = new api.DecisionMemoryService(f.store.db, f.clock);
    const input = { scope: f.scope, objective: "release policy", chosenAction: "review release", decisionMaker: "user", evidence: refs.flatMap(sourceRef => ["supports", "rationale_source"].map(relation => ({ sourceRef, relation }))) };
    const decision = decisions.confirm(input, decisions.preview(input).preview_hash);
    const targetRef = api.createMnemoraContextRef({ scope: f.scope, kind: "decision", id: decision.id });
    const service = new api.RecallAttachmentEvidenceService(f.store.db, { enabled: true }, f.clock);
    const items = service.snapshot({ scope: f.scope, candidates: [{ contextRef: targetRef, excerpt: "release policy", sourceRefs: refs.slice(0, 3) }] });
    assert.equal(items[0].sources.length, 14);
    assert.equal(items[0].incompleteSources, false);
    service.record({ scope: f.scope, id: "assembly:1", items });
    const impact = new api.MemoryImpactService(f.store.db), preview = impact.preview({ scope: f.scope, kind: "event", id: "origin-9" });
    impact.forget({ scope: f.scope, kind: "event", id: "origin-9", previewHash: preview.previewHash, confirm: true });
    assert.deepEqual(service.review({ scope: f.scope, targetRef }).receipts, []);
  } finally { f.store.close(); }
});
