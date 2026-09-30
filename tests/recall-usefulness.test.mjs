import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../dist/index.js";
import { createTempDir } from "./helpers/temp.mjs";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

function fixture(path = ":memory:") {
  const store = new api.GraphologyStore(path);
  const scope = "fixture:usefulness", document = store.upsertMemoryDocument({ scope, content: "PRIVATE_MEMORY_BODY", title: "PRIVATE_TITLE" });
  let now = document.updated_at + 1000;
  const targetRef = api.createMnemoraContextRef({ scope, kind: "memory-document", id: document.id });
  const journal = new api.ConversationEventRepository(store.db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" });
  const event = (id, role, text, extra = {}) => journal.append({ id, scope, sessionId: "PRIVATE_SESSION", kind: role === "assistant" ? "assistant_message" : "user_message", role, contextDomain: "user_chat", parts: [{ type: "text", text }], createdAt: now, ...extra });
  return { store, scope, targetRef, document, journal, event, clock: () => now, advance: delta => { now += delta; } };
}

test("usefulness review separates mentions from reviewed feedback without inventing outcomes", () => {
  assert.equal(typeof api.RecallUsefulnessReviewService, "function");
  const f = fixture();
  try {
    new api.RecallUsageRepository(f.store.db, f.clock).recordInjected({ scope: f.scope, targetRefs: [f.targetRef] });
    f.advance(10);
    f.event("assistant-1", "assistant", `PRIVATE_MESSAGE says [source](${f.targetRef}) twice ${f.targetRef}`);
    f.event("user-1", "user", `PRIVATE_CORRECTION quoted ${f.targetRef}, but this role alone proves nothing.`);
    new api.RecallFeedbackRepository(f.store.db, f.clock).record({ scope: f.scope, targetRef: f.targetRef, kind: "user_corrected" });
    const changes = f.store.db.prepare("SELECT total_changes() AS n").get().n;
    const report = new api.RecallUsefulnessReviewService(f.store.db, f.clock).review({ scope: f.scope, targetRef: f.targetRef });
    assert.equal(report.attachment.recallCount, 1);
    assert.deepEqual(report.mentions.map(item => item.signal).sort(), ["assistant_citation", "user_mention_needs_review"]);
    assert.equal(report.reviewedFeedback.user_corrected, 1);
    assert.equal(report.corroboration, "unmeasured");
    assert.equal(report.turnAttribution, "unavailable");
    assert.equal(report.calibrationAction, "not_performed");
    assert.equal(report.mutation, "none");
    assert.equal(f.store.db.prepare("SELECT total_changes() AS n").get().n, changes);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_MEMORY_BODY|PRIVATE_TITLE|PRIVATE_MESSAGE|PRIVATE_CORRECTION|PRIVATE_SESSION/);
  } finally { f.store.close(); }
});

test("only complete canonical references in readable user-chat messages count", () => {
  const f = fixture();
  try {
    f.event("exact", "assistant", `(${f.targetRef})`);
    for (const [id, text] of [["suffix", `${f.targetRef}-other`], ["plus", `${f.targetRef}+other)`], ["unicode-prefix", `𐐀${f.targetRef})`], ["path", `${f.targetRef}/extra`], ["query", `${f.targetRef}?x=1`], ["fragment", `${f.targetRef}#x`], ["embedded", `xmnemora${f.targetRef.slice(7)}`]]) f.event(id, "assistant", text);
    f.event("system", "assistant", f.targetRef, { contextDomain: "system" });
    f.event("tool", "assistant", f.targetRef, { role: "tool", kind: "tool_result", contextDomain: "tool" });
    const report = new api.RecallUsefulnessReviewService(f.store.db, f.clock).review({ scope: f.scope, targetRef: f.targetRef });
    assert.equal(report.mentions.length, 1);
    assert.equal(api.parseMnemoraContextRef(report.mentions[0].sourceRef).id, "exact");
    assert.equal(report.attachment, null, "absence of usage telemetry is unknown, not proof of zero delivery");
  } finally { f.store.close(); }
});

test("forgotten source messages and unavailable targets stop contributing to review", () => {
  const f = fixture();
  try {
    f.event("forgotten", "assistant", `(${f.targetRef})`);
    const service = new api.RecallUsefulnessReviewService(f.store.db, f.clock);
    assert.equal(service.review({ scope: f.scope, targetRef: f.targetRef }).mentions.length, 1);
    const impact = new api.MemoryImpactService(f.store.db), input = { scope: f.scope, kind: "event", id: "forgotten" }, preview = impact.preview(input);
    impact.forget({ ...input, previewHash: preview.previewHash, confirm: true });
    assert.equal(service.review({ scope: f.scope, targetRef: f.targetRef }).mentions.length, 0);
    const lifecycle = { action: "archive", document_id: f.document.id, scope: f.scope };
    f.store.confirmMemoryLifecycle({ ...lifecycle, preview_hash: f.store.previewMemoryLifecycle(lifecycle).preview_hash });
    const unavailable = service.review({ scope: f.scope, targetRef: f.targetRef });
    assert.equal(unavailable.targetStatus, "unavailable");
    assert.equal(unavailable.attachment, null);
    assert.equal(unavailable.reviewedFeedback, null);
    assert.deepEqual(unavailable.mentions, []);
  } finally { f.store.close(); }
});

test("old and future evidence is excluded and invalid scope or limits fail closed", () => {
  const f = fixture();
  try {
    f.event("old", "assistant", f.targetRef, { createdAt: f.document.updated_at - 1 });
    f.event("future", "assistant", f.targetRef, { createdAt: f.clock() + 1 });
    new api.RecallFeedbackRepository(f.store.db, () => f.document.updated_at - 1).record({ scope: f.scope, targetRef: f.targetRef, kind: "helpful" });
    const service = new api.RecallUsefulnessReviewService(f.store.db, f.clock);
    const report = service.review({ scope: f.scope, targetRef: f.targetRef });
    assert.deepEqual(report.mentions, []);
    assert.equal(report.reviewedFeedback.helpful, 0);
    assert.throws(() => service.review({ scope: "fixture:other", targetRef: f.targetRef }), /scope_mismatch/);
    for (const limit of [0, 51, NaN, 1.5]) assert.throws(() => service.review({ scope: f.scope, targetRef: f.targetRef, limit }), /invalid_usefulness_review/);
  } finally { f.store.close(); }
});

test("large histories and mention limits visibly report incomplete coverage", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 205; index++) f.event(`event-${String(index).padStart(3, "0")}`, "assistant", `(${f.targetRef})`);
    const report = new api.RecallUsefulnessReviewService(f.store.db, f.clock).review({ scope: f.scope, targetRef: f.targetRef, limit: 5 });
    assert.equal(report.mentions.length, 5);
    assert.equal(report.coverage.truncated, true);
    assert.equal(api.parseMnemoraContextRef(report.mentions[0].sourceRef).id, "event-204");
    assert.equal(report.coverage.eventLimit, 200);
    assert.equal(report.calibrationAction, "not_performed");
  } finally { f.store.close(); }
});

test("text clipping never turns a longer reference into a mention of its prefix", () => {
  const f = fixture();
  try {
    f.event("clipped", "assistant", `${"x".repeat(16000 - f.targetRef.length - 1)} ${f.targetRef}-suffix`);
    const report = new api.RecallUsefulnessReviewService(f.store.db, f.clock).review({ scope: f.scope, targetRef: f.targetRef });
    assert.equal(report.mentions.length, 0);
    assert.equal(report.coverage.truncated, true);
    assert.equal(report.coverage.possiblyClippedTexts, 1);
    assert.equal(report.coverage.ambiguousBoundaries, 1);
  } finally { f.store.close(); }
});

test("a multipart capture boundary cannot certify a clipped reference", () => {
  const f = fixture();
  try {
    const journal = new api.ConversationEventRepository(f.store.db, { maxInlineChars: 256, maxEventBytes: 262144, sensitiveContentPolicy: "redact" });
    journal.append({ id: "multipart", scope: f.scope, sessionId: "private", kind: "assistant_message", role: "assistant", parts: [
      { type: "text", text: `${"x".repeat(256 - f.targetRef.length - 1)} ${f.targetRef}-other` }, { type: "text", text: "following part" }
    ], createdAt: f.clock() });
    const report = new api.RecallUsefulnessReviewService(f.store.db, f.clock).review({ scope: f.scope, targetRef: f.targetRef });
    assert.deepEqual(report.mentions, []);
    assert.equal(report.coverage.truncated, true);
    assert.equal(report.coverage.ambiguousBoundaries, 1);
  } finally { f.store.close(); }
});

test("multibyte text obeys the read budget and hash-only sources stay unmeasured", () => {
  const f = fixture();
  try {
    const hidden = new api.ConversationEventRepository(f.store.db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "hash_only" });
    hidden.append({ id: "hash-only", scope: f.scope, sessionId: "private", kind: "user_message", role: "user", parts: [{ type: "text", text: `password=PRIVATE_SECRET (${f.targetRef})` }], createdAt: f.clock() });
    const service = new api.RecallUsefulnessReviewService(f.store.db, f.clock);
    assert.deepEqual(service.review({ scope: f.scope, targetRef: f.targetRef }).mentions, []);
    for (let index = 0; index < 50; index++) f.event(`large-${index}`, "assistant", `(${f.targetRef}) ${"中".repeat(14000)}`);
    const report = service.review({ scope: f.scope, targetRef: f.targetRef, limit: 50 });
    assert.ok(report.mentions.length > 0 && report.mentions.length <= 25);
    assert.equal(report.coverage.truncated, true);
    assert.equal(report.coverage.completeHistory, false);
    assert.equal(report.corroboration, "unmeasured");
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SECRET|中/);
  } finally { f.store.close(); }
});

test("belief and decision reviews resolve live records without changing their confidence", () => {
  const f = fixture();
  try {
    const formation = new api.FormationService(f.store.db, f.clock, { mode: "enforce", beliefs: { enabled: true } });
    const candidate = formation.observe({ scope: f.scope, origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user:first", content: "I prefer concise technical explanations." });
    const belief = f.store.db.prepare("SELECT id,epistemic_confidence FROM mnemora_beliefs WHERE scope=?").get(f.scope);
    const decisionService = new api.DecisionMemoryService(f.store.db, f.clock);
    const input = { scope: f.scope, objective: "Choose a concise explanation", decisionMaker: "user", confidence: .8, evidence: [{ sourceRef: api.createMnemoraContextRef({ scope: f.scope, kind: "memory-candidate", id: candidate.id }), relation: "rationale_source" }] };
    const decision = decisionService.confirm(input, decisionService.preview(input).preview_hash);
    const service = new api.RecallUsefulnessReviewService(f.store.db, f.clock);
    for (const [kind, id] of [["belief", belief.id], ["decision", decision.id]]) {
      const targetRef = api.createMnemoraContextRef({ scope: f.scope, kind, id });
      f.event(`mention-${kind}`, "assistant", `(${targetRef})`);
      const report = service.review({ scope: f.scope, targetRef });
      assert.equal(report.targetStatus, "active");
      assert.equal(report.mentions.length, 1);
      assert.equal(report.calibrationAction, "not_performed");
    }
    assert.equal(f.store.db.prepare("SELECT epistemic_confidence FROM mnemora_beliefs WHERE id=?").get(belief.id).epistemic_confidence, belief.epistemic_confidence);
    assert.equal(decisionService.get(decision.id, f.scope).confidence, .8);
    decisionService.changeStatus({ id: decision.id, scope: f.scope, action: "invalidate" });
    assert.equal(service.review({ scope: f.scope, targetRef: api.createMnemoraContextRef({ scope: f.scope, kind: "decision", id: decision.id }) }).targetStatus, "unavailable");
  } finally { f.store.close(); }
});

test("operator usefulness evidence opens only an explicit read-only snapshot", () => {
  const directory = createTempDir("usefulness-cli-"), path = join(directory, "snapshot.db"), f = fixture(path);
  f.advance(-1000);
  new api.RecallUsageRepository(f.store.db, f.clock).recordInjected({ scope: f.scope, targetRefs: [f.targetRef] });
  f.event("cli-citation", "assistant", `PRIVATE_CLI_MESSAGE (${f.targetRef})`);
  f.store.close();
  const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex"), before = hash();
  const args = ["dist/cli.js", "cognition", "feedback", "evidence", f.targetRef, "--scope", f.scope];
  const output = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, MNEMORA_DB: path } }));
  assert.equal(output.ok, true);
  assert.equal(output.result.database.readOnly, true);
  assert.equal(output.result.review.mentions.length, 1);
  assert.equal(output.result.review.attachment.recallCount, 1);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_CLI_MESSAGE|PRIVATE_MEMORY_BODY|PRIVATE_SESSION|snapshot\.db/);
  assert.equal(hash(), before);
  const missing = join(directory, "missing.db"), failed = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, MNEMORA_DB: missing } });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stderr).error.code, "explicit_existing_database_required");
  assert.equal(existsSync(missing), false);
  const prefixedMissing = join(directory, "missing-prefixed.db");
  const prefixedArgs = ["dist/cli.js", "cognition", "--scope", f.scope, "feedback", "evidence", f.targetRef];
  const prefixed = spawnSync(process.execPath, prefixedArgs, { encoding: "utf8", env: { ...process.env, MNEMORA_DB: prefixedMissing } });
  assert.equal(JSON.parse(prefixed.stderr).error.code, "explicit_existing_database_required");
  assert.equal(existsSync(prefixedMissing), false);
  const unspecifiedEnv = { ...process.env }; delete unspecifiedEnv.MNEMORA_DB;
  const unspecified = spawnSync(process.execPath, args, { encoding: "utf8", env: unspecifiedEnv });
  assert.equal(JSON.parse(unspecified.stderr).error.code, "explicit_existing_database_required");
  const mutableOption = spawnSync(process.execPath, [...args, "--confirm"], { encoding: "utf8", env: { ...process.env, MNEMORA_DB: path } });
  assert.equal(JSON.parse(mutableOption.stderr).error.code, "invalid_arguments");
  assert.equal(hash(), before);
});
