import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CognitionGraduationService, FormationService, GraphologyStore, ReflectionService } from "../dist/index.js";

test("C8 graduation verifies audit integrity, restart recovery, and proposal-only reflection", () => {
  const path = join(tmpdir(), `mnemora-graduation-${process.pid}-${Date.now()}.db`);
  let store;
  try {
    let now = 1_700_000_000_000;
    store = new GraphologyStore(path);
    const formation = new FormationService(store.db, () => ++now, { mode: "enforce", beliefs: { enabled: true, autoCorroborate: true } });
    formation.observe({ scope: "project:alpha", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user:1", content: "I prefer concise technical explanations." });
    formation.observe({ scope: "project:alpha", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user:2", content: "I prefer concise technical explanations." });
    const before = Number(store.db.prepare("SELECT COUNT(*) AS count FROM mnemora_beliefs").get().count);
    const reflections = new ReflectionService(store.db, () => ++now), preview = reflections.preview({ scope: "project:alpha", staleAfterDays: 3650 });
    reflections.runPreview({ scope: "project:alpha", previewHash: preview.preview_hash, staleAfterDays: 3650 });
    assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS count FROM mnemora_beliefs").get().count), before);
    const options = { enabled: true, formationShadow: true, admissionMode: "enforce", beliefsEnabled: true, contextCompilerEnabled: true, reflectionEnabled: true };
    const initial = new CognitionGraduationService(store.db, options).status("project:alpha");
    assert.equal(initial.ready, true);
    assert.deepEqual(initial.audit, { valid: true, checked: 2, issues: [] });
    store.close(); store = undefined;

    store = new GraphologyStore(path);
    const restarted = new CognitionGraduationService(store.db, options).status("project:alpha");
    assert.equal(restarted.ready, true);
    const audit = store.db.prepare("SELECT id FROM mnemora_cognition_audits WHERE scope=? ORDER BY created_at,id LIMIT 1").get("project:alpha");
    store.db.prepare("UPDATE mnemora_cognition_audits SET entry_hash=? WHERE id=?").run("0".repeat(64), audit.id);
    const corrupted = new CognitionGraduationService(store.db, options).status("project:alpha");
    assert.equal(corrupted.ready, false);
    assert.equal(corrupted.audit.issues.some(issue => issue.code === "entry_hash_mismatch"), true);
  } finally { try { store?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});
