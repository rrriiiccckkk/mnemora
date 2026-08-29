import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GraphologyStore, FormationService, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

test("formation shadow is idempotent, scope-isolated, hash-chained, and creates no belief rows", () => {
  let now = 2_000_000_000_000;
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(SUPPORTED_SCHEMA_VERSION, 70);
    const service = new FormationService(store.db, () => now);
    const first = service.observe({ scope: "a", origin: "explicit_ingest", authority: "manual_operator", kind: "graph_extraction", source: "manual", entities: 1, relations: 1, content: "private text" });
    assert.equal(first.status, "accepted_shadow");
    service.observe({ scope: "a", origin: "explicit_ingest", authority: "manual_operator", kind: "graph_extraction", source: "manual", entities: 1, relations: 1, content: "private text" });
    now += 1;
    const second = service.observe({ scope: "a", origin: "automatic_extract", authority: "assistant_inference", kind: "graph_extraction", source: "auto", entities: 1, relations: 0, content: "another private text" });
    assert.equal(second.reason, "assistant_inference");
    assert.deepEqual(service.status("b"), { scope: "b", candidates: {}, admissions: {}, enforcement: {}, beliefs: {}, belief_transitions: {}, shadow_only: true });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_cognition_candidates WHERE scope='a'").get().value, 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_cognition_change_sets WHERE scope='a'").get().value, 2);
    assert.equal(store.db.prepare("SELECT authority_detail FROM mnemora_cognition_candidates WHERE id=?").get(second.id).authority_detail, "assistant_inference");
    const audits = store.db.prepare("SELECT previous_hash,entry_hash FROM mnemora_cognition_audits WHERE scope='a' ORDER BY created_at,id").all();
    assert.equal(audits.length, 2); assert.equal(audits[1].previous_hash, audits[0].entry_hash);
    assert.equal(JSON.stringify(store.db.prepare("SELECT * FROM mnemora_cognition_candidates").all()).includes("private text"), false);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_beliefs").get().value, 0);
  } finally { store.close(); }
});

test("deterministic admission enforces conservative durable and transient outcomes without beliefs by default", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const service = new FormationService(store.db, () => 1, { mode: "enforce" });
    assert.equal(service.observe({ scope: "personal", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user", content: "For technical explanations, I prefer concise answers." }).status, "accept");
    assert.equal(service.observe({ scope: "personal", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user", content: "I am eating hotpot tonight." }).status, "episodic_only");
    assert.equal(service.observe({ scope: "personal", origin: "automatic_extract", authority: "assistant_inference", kind: "memory_document", source: "assistant", content: "The user loves Apple products." }).reason, "assistant_inference");
    assert.equal(service.observe({ scope: "personal", origin: "explicit_ingest", authority: "tool_observation", kind: "graph_extraction", source: "tool", entities: 1 }).status, "episodic_only");
    assert.deepEqual(service.status("personal").enforcement, { accept: 1, episodic_only: 2, reject: 1 });
  } finally { store.close(); }
});

test("belief lifecycle creates, corroborates, refines, and corrects only explicit scoped user candidates", () => {
  let now = 1;
  const store = new GraphologyStore(":memory:");
  try {
    const service = new FormationService(store.db, () => ++now, { mode: "enforce", beliefs: { enabled: true, autoCorroborate: true } });
    const first = service.observe({ scope: "personal", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user:1", content: "I prefer concise technical explanations." });
    assert.equal(first.lifecycle, "CREATE");
    assert.equal(service.observe({ scope: "personal", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user:2", content: "I prefer concise technical explanations." }).lifecycle, "CORROBORATE");
    const original = store.db.prepare("SELECT id,state,support_count FROM mnemora_beliefs WHERE scope='personal'").get();
    assert.deepEqual({ state: original.state, support_count: original.support_count }, { state: "strong", support_count: 2 });
    assert.equal(service.observe({ scope: "personal", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user:3", content: "I prefer concise technical explanations with examples.", priorBeliefId: original.id }).lifecycle, "REFINE");
    const refined = store.db.prepare("SELECT id FROM mnemora_beliefs WHERE scope='personal' AND state='supported'").get();
    assert.equal(service.observe({ scope: "personal", origin: "memory_store", authority: "user_correction", kind: "memory_document", source: "user:4", content: "I no longer prefer concise answers; include necessary detail.", priorBeliefId: refined.id }).lifecycle, "CORRECT");
    assert.equal(service.observe({ scope: "work", origin: "memory_store", authority: "user_correction", kind: "memory_document", source: "user:5", content: "This must not cross scopes.", priorBeliefId: original.id }).lifecycle, "NO_CHANGE");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_beliefs WHERE scope='work'").get().value, 0);
  } finally { store.close(); }
});

test("later additive cognition migrations preserve a v34 formation database", () => {
  const path = join(tmpdir(), `mnemora-cognition-${process.pid}-${Date.now()}.db`); let legacy;
  try {
    legacy = new GraphologyStore(path);
    legacy.db.exec("DROP TABLE mnemora_belief_evidence; DROP TABLE mnemora_belief_transitions; DROP TABLE mnemora_beliefs; PRAGMA user_version=34");
    legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path);
    try {
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 70);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mnemora_beliefs'").get().n, 1);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mnemora_cognition_change_sets'").get().n, 1);
    } finally { migrated.close(); }
  } finally { try { legacy?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});
