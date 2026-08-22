import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { DecisionMemoryService } from "../dist/cognition/decisions.js";
import { FormationService } from "../dist/cognition/service.js";
import { SUPPORTED_SCHEMA_VERSION } from "../dist/schema.js";
import { GraphologyStore } from "../dist/store.js";

test("explicit decision memory is previewed, source-linked, idempotent, and lifecycle-bound", () => {
  let now = 1_000;
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(SUPPORTED_SCHEMA_VERSION, 61);
    const candidate = new FormationService(store.db, () => ++now, { mode: "enforce" }).observe({ scope: "project:alpha", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "user:decision", content: "Use SQLite for this local-first project." });
    const sourceRef = createMnemoraContextRef({ scope: "project:alpha", kind: "memory-candidate", id: candidate.id });
    const service = new DecisionMemoryService(store.db, () => ++now);
    const input = { scope: "project:alpha", objective: "Choose the local persistence layer", alternatives: ["SQLite", "Postgres"], chosenAction: "Use SQLite", rationale: "Keep deployment local-first.", confidence: .9, decisionMaker: "user", evidence: [{ sourceRef, relation: "rationale_source" }] };
    const preview = service.preview(input);
    assert.equal(preview.status, "preview");
    assert.throws(() => service.confirm(input, "wrong"), /invalid_decision_preview/);
    const first = service.confirm(input, preview.preview_hash);
    assert.equal(first.status, "active");
    assert.equal(first.evidence[0].sourceRef, sourceRef);
    assert.deepEqual(service.confirm(input, preview.preview_hash), first);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_decisions").get().n, 1);
    assert.equal(service.find("project:alpha", "persistence")[0].id, first.id);

    const successorInput = { ...input, objective: "Keep SQLite as the local persistence layer", previousDecisionId: first.id };
    const successor = service.confirm(successorInput, service.preview(successorInput).preview_hash);
    assert.equal(service.get(first.id, "project:alpha").status, "superseded");
    assert.equal(successor.previousVersionId, first.id);
    assert.equal(service.changeStatus({ id: successor.id, scope: "project:alpha", action: "invalidate" }).status, "invalidated");
    assert.deepEqual(service.status("project:alpha").decisions, { invalidated: 1, superseded: 1 });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_decision_transitions WHERE scope='project:alpha'").get().n, 4);
  } finally { store.close(); }
});

test("decision memory rejects cross-scope evidence and remains readable after later additive migrations", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const service = new DecisionMemoryService(store.db);
    const foreign = createMnemoraContextRef({ scope: "project:other", kind: "claim", id: "claim:foreign" });
    assert.throws(() => service.preview({ scope: "project:alpha", objective: "Never cross scope", evidence: [{ sourceRef: foreign }] }), /scope_mismatch/);
    const phantom = createMnemoraContextRef({ scope: "project:alpha", kind: "memory-candidate", id: "cognition-candidate:missing" });
    assert.throws(() => service.preview({ scope: "project:alpha", objective: "Never accept phantom evidence", evidence: [{ sourceRef: phantom }] }), /invalid_decision_evidence/);
  } finally { store.close(); }

  const path = join(tmpdir(), `mnemora-decisions-${process.pid}-${Date.now()}.db`);
  let legacy;
  try {
    legacy = new GraphologyStore(path);
    legacy.db.exec("DROP TABLE mnemora_decision_transitions; DROP TABLE mnemora_decision_episodes; DROP TABLE mnemora_decision_evidence; DROP TABLE mnemora_decisions; PRAGMA user_version=36");
    legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path);
    try {
    assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 61);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mnemora_decisions'").get().n, 1);
    } finally { migrated.close(); }
  } finally { try { legacy?.close(); } catch {} try { rmSync(path, { force: true }); } catch {} }
});
