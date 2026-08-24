import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { PersonalContextCompiler } from "../dist/cognition/context-compiler.js";
import { RecallFeedbackRepository, ReflectionService } from "../dist/cognition/reflection.js";
import { FormationService } from "../dist/cognition/service.js";
import { SUPPORTED_SCHEMA_VERSION } from "../dist/schema.js";
import { GraphologyStore } from "../dist/store.js";

test("reflection proposes scoped patterns and review work without promoting beliefs", () => {
  let now = 100 * 86_400_000;
  const store = new GraphologyStore(":memory:");
  try {
    const formation = new FormationService(store.db, () => ++now, { mode: "enforce", beliefs: { enabled: true, autoCorroborate: true } });
    formation.observe({ scope: "project:alpha", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user:1", content: "I prefer concise technical explanations." });
    formation.observe({ scope: "project:alpha", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user:2", content: "I prefer concise technical explanations." });
    now += 100 * 86_400_000;
    const belief = store.db.prepare("SELECT id,epistemic_confidence FROM mnemora_beliefs WHERE scope=?").get("project:alpha");
    const beforeBeliefs = store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_beliefs").get().n;
    const reflections = new ReflectionService(store.db, () => now);
    const preview = reflections.preview({ scope: "project:alpha", staleAfterDays: 30 });
    assert.equal(preview.candidates.some(item => item.kind === "pattern_candidate"), true);
    assert.equal(preview.candidates.some(item => item.kind === "staleness_review"), true);
    assert.throws(() => reflections.runPreview({ scope: "project:alpha", previewHash: "wrong" }), /invalid_reflection_preview/);
    assert.deepEqual(reflections.runPreview({ scope: "project:alpha", previewHash: preview.preview_hash, staleAfterDays: 30 }), { queued: 1, proposed: 2, reclaimed: 0 });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_beliefs").get().n, beforeBeliefs);
    assert.equal(reflections.candidates("project:alpha").every(item => item.sourceRefs.every(ref => ref.includes("project%3Aalpha"))), true);
    assert.deepEqual(reflections.metrics("project:alpha").unsafe_promotions, 0);

    const ref = createMnemoraContextRef({ scope: "project:alpha", kind: "belief", id: belief.id });
    const feedback = new RecallFeedbackRepository(store.db, () => now);
    assert.equal(feedback.record({ scope: "project:alpha", targetRef: ref, kind: "helpful" }).created, true);
    assert.equal(feedback.record({ scope: "project:alpha", targetRef: ref, kind: "wrong" }).created, true);
    assert.equal(feedback.record({ scope: "project:alpha", targetRef: ref, kind: "wrong" }).created, false);
    assert.throws(() => feedback.record({ scope: "project:beta", targetRef: ref, kind: "wrong" }), /scope_mismatch/);
    assert.equal(reflections.preview({ scope: "project:alpha", staleAfterDays: 3650 }).candidates.some(item => item.reasonCode === "feedback_staleness"), true);
    const compiled = new PersonalContextCompiler(store.db, () => now, { staleAfterDays: 30 }).compile({ scope: "project:alpha", tokenBudget: 128 });
    const item = compiled.items.find(value => value.kind === "belief");
    assert.equal(item.confidence, belief.epistemic_confidence);
    assert.equal(item.stalenessRisk, "review");
    assert.ok(item.salience < .5, "negative feedback affects retrieval salience only");
  } finally { store.close(); }
});

test("schema v39 adds reflection and feedback tables without changing historical cognition rows", () => {
  const path = join(tmpdir(), `mnemora-reflection-${process.pid}-${Date.now()}.db`);
  let legacy;
  try {
    legacy = new GraphologyStore(path);
    legacy.db.exec("DROP TABLE mnemora_recall_feedback; DROP TABLE mnemora_reflection_candidates; DROP TABLE mnemora_reflection_jobs; PRAGMA user_version=38");
    legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path);
    try {
      assert.equal(SUPPORTED_SCHEMA_VERSION, 62);
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 62);
      for (const table of ["mnemora_reflection_jobs", "mnemora_reflection_candidates", "mnemora_recall_feedback"]) assert.equal(migrated.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(table).n, 1);
    } finally { migrated.close(); }
  } finally { try { legacy?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});
