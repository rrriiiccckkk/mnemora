import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { Mnemora, createOpenClawToolDefinitions } from "../dist/index.js";

const entity = (name, type) => ({ name, type, confidence: .9, evidence_span: `${name} evidence` });
const worksAt = (source, target) => ({ source, target, type: "works_at", confidence: .9, evidence_span: `${source} works at ${target}` });

test("profile projection deterministically rebuilds scoped evidence with bounded provenance and conflicts", async () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", scope: { default: "project:work" }, quality: { singleValuedEdgeTypes: ["works_at"] } } });
  try {
    await graph.kg_ingest("Alice works at Acme", "fixture:acme", { entities: [entity("Alice", "person"), entity("Acme", "company")], relations: [worksAt("Alice", "Acme")] }, "project:work");
    await graph.kg_ingest("Alice works at Globex", "fixture:globex", { entities: [entity("Alice", "person"), entity("Globex", "company")], relations: [worksAt("Alice", "Globex")] }, "project:work");
    await graph.kg_ingest("Alice works at PrivateCo", "fixture:private", { entities: [entity("Alice", "person"), entity("PrivateCo", "company")], relations: [worksAt("Alice", "PrivateCo")] }, "project:private");

    const beforeRevision = graph.store.graphRevision();
    const first = graph.kg_profile("Alice");
    const second = graph.kg_profile("Alice");
    assert.deepEqual(second, first);
    assert.equal(graph.store.graphRevision(), beforeRevision);
    assert.equal(first.projection_version, "profile-projection-v1");
    assert.equal(first.status, "ok");
    assert.equal(first.scope, "project:work");
    assert.equal(first.subject?.id, "person:alice");
    const work = first.fields.find(field => field.key === "works_at");
    assert.deepEqual(work?.values.map(value => value.entity.name).sort(), ["Acme", "Globex"]);
    assert.equal(work?.values.some(value => value.entity.name === "PrivateCo"), false);
    assert.equal(work?.conflict, true);
    assert.equal(work?.values.every(value => value.provenance.length > 0 && value.provenance.every(claim => claim.verification === "not_anchored" && !Object.hasOwn(claim, "quote"))), true);
    assert.equal(work?.values.every(value => value.conflict_candidate_ids.length > 0), true);
    assert.deepEqual(graph.kg_profile("Alice", "project:private").fields.find(field => field.key === "works_at")?.values.map(value => value.entity.name), ["PrivateCo"]);
    assert.equal(graph.kg_profile("Missing entity").status, "not_found");
  } finally { graph.close(); }
});

test("kg_profile publishes a closed read-only scoped tool contract", async () => {
  let received;
  const graph = { kg_profile(subject, scope, limit) { received = { subject, scope, limit }; return { projection_version: "profile-projection-v1", status: "not_found", scope: scope ?? "default", graph_revision: 0, trust_revision: 0, fields: [] }; }, close() {} };
  const tool = createOpenClawToolDefinitions(() => graph).find(item => item.name === "kg_profile");
  assert.match(tool.description, /read-only entity profile/i);
  assert.match(tool.description, /scope\.default/i);
  assert.equal(Check(tool.parameters, { subject: "person:alice", scope: "project:work", limit: 20 }), true);
  assert.equal(Check(tool.parameters, { subject: "person:alice", limit: 21 }), false);
  assert.equal(Check(tool.parameters, { subject: "person:alice", extra: true }), false);
  const output = JSON.parse((await tool.execute("profile", { subject: "person:alice", scope: "project:work", limit: 3 })).content[0].text);
  assert.deepEqual(received, { subject: "person:alice", scope: "project:work", limit: 3 });
  assert.deepEqual(output, { projection_version: "profile-projection-v1", status: "not_found", scope: "project:work", graph_revision: 0, trust_revision: 0, fields: [] });
});

test("profile locks are preview-first, scope-bound, and never overwrite sourced conflicting values", async () => {
  let now = 100;
  const graph = new Mnemora({ config: { dbPath: ":memory:", scope: { default: "project:work" }, quality: { singleValuedEdgeTypes: ["works_at"] } }, now: () => ++now });
  try {
    await graph.kg_ingest("Alice works at Acme", "fixture:acme", { entities: [entity("Alice", "person"), entity("Acme", "company")], relations: [worksAt("Alice", "Acme")] }, "project:work");
    await graph.kg_ingest("Alice works at Globex", "fixture:globex", { entities: [entity("Alice", "person"), entity("Globex", "company")], relations: [worksAt("Alice", "Globex")] }, "project:work");
    await graph.kg_ingest("Alice works at PrivateCo", "fixture:private", { entities: [entity("Alice", "person"), entity("PrivateCo", "company")], relations: [worksAt("Alice", "PrivateCo")] }, "project:private");
    const before = graph.store.graphRevision();
    const globex = graph.kg_profile("Alice").fields.find(field => field.key === "works_at").values.find(value => value.entity.name === "Globex").entity.id;
    const preview = graph.kg_profile_lock({ action: "set", subject: "Alice", field_key: "works_at", target_id: globex });
    assert.equal(preview.status, "ready");
    assert.equal(graph.kg_profile("Alice").fields.find(field => field.key === "works_at").selection, undefined);
    const confirmed = graph.kg_profile_lock({ action: "set", subject: "Alice", field_key: "works_at", target_id: globex, preview_hash: preview.preview_hash, confirm: true });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(graph.store.graphRevision(), before);
    const field = graph.kg_profile("Alice").fields.find(item => item.key === "works_at");
    assert.equal(field.selection?.entity.name, "Globex");
    assert.equal(field.selection?.locked, true);
    assert.deepEqual(field.values.map(value => value.entity.name).sort(), ["Acme", "Globex"]);
    assert.equal(graph.kg_profile_lock({ action: "set", subject: "Alice", field_key: "works_at", target_id: "company:privateco" }).status, "invalid_target");
    const clearPreview = graph.kg_profile_lock({ action: "clear", subject: "Alice", field_key: "works_at" });
    assert.equal(graph.kg_profile_lock({ action: "clear", subject: "Alice", field_key: "works_at", preview_hash: clearPreview.preview_hash, confirm: true }).status, "confirmed");
    assert.equal(graph.kg_profile("Alice").fields.find(item => item.key === "works_at").selection, undefined);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_profile_selection_audits").get().n, 2);
  } finally { graph.close(); }
});

test("stale profile locks are never projected as empty selected fields and remain explicitly clearable", async () => {
  let now = 500;
  const graph = new Mnemora({ config: { dbPath: ":memory:", quality: { singleValuedEdgeTypes: ["works_at"] } }, now: () => ++now });
  try {
    await graph.kg_ingest("Alice works at Acme", "fixture:acme", { entities: [entity("Alice", "person"), entity("Acme", "company")], relations: [worksAt("Alice", "Acme")] });
    const targetId = graph.kg_profile("Alice").fields.find(item => item.key === "works_at")?.values[0]?.entity.id;
    assert.ok(targetId);
    const set = graph.kg_profile_lock({ action: "set", subject: "Alice", field_key: "works_at", target_id: targetId });
    assert.equal(graph.kg_profile_lock({ action: "set", subject: "Alice", field_key: "works_at", target_id: targetId, preview_hash: set.preview_hash, confirm: true }).status, "confirmed");
    graph.store.db.prepare("UPDATE kg_edges SET deleted_at=? WHERE source_id='person:alice' AND target_id=? AND type='works_at'").run(now, targetId);
    const profile = graph.kg_profile("Alice");
    assert.equal(profile.fields.some(field => field.key === "works_at" && field.values.length === 0 && field.selection), false);
    assert.deepEqual(profile.stale_selections?.map(item => ({ key: item.key, entity: item.entity.name, reason: item.reason })), [{ key: "works_at", entity: "Acme", reason: "missing_evidence" }]);
    const clear = graph.kg_profile_lock({ action: "clear", subject: "Alice", field_key: "works_at" });
    assert.equal(clear.current_selection?.entity.name, "Acme");
    assert.equal(graph.kg_profile_lock({ action: "clear", subject: "Alice", field_key: "works_at", preview_hash: clear.preview_hash, confirm: true }).status, "confirmed");
    assert.equal(graph.kg_profile("Alice").stale_selections, undefined);
  } finally { graph.close(); }
});

test("kg_profile_lock exposes a closed preview-confirm contract", async () => {
  let received;
  const graph = { kg_profile_lock(input) { received = input; return { status: "ready", preview_hash: "a".repeat(64) }; }, close() {} };
  const tool = createOpenClawToolDefinitions(() => graph).find(item => item.name === "kg_profile_lock");
  const input = { action: "set", subject: "Alice", field_key: "works_at", target_id: "company:acme", scope: "project:work" };
  assert.equal(Check(tool.parameters, input), true);
  assert.equal(Check(tool.parameters, { action: "set", subject: "Alice", field_key: "works_at" }), false);
  assert.equal(Check(tool.parameters, { action: "clear", subject: "Alice", field_key: "works_at", target_id: "company:acme" }), false);
  assert.deepEqual(JSON.parse((await tool.execute("profile-lock", input)).content[0].text), { status: "ready", preview_hash: "a".repeat(64) });
  assert.deepEqual(received, input);
});
