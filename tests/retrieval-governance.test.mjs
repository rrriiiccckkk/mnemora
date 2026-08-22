import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora, UnifiedRetrievalService } from "../dist/index.js";
import { RecallFeedbackRepository } from "../dist/cognition/reflection.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };

test("tag recall filters metadata before recency limits so old tagged documents remain discoverable", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const tagged = graph.kg_memory({ operation: "store", scope: "work", title: "Old research", content: "archived research note", metadata: { tags: "research" } });
    for (let index = 0; index < 120; index++) graph.kg_memory({ operation: "store", scope: "work", title: `New note ${index}`, content: `unrelated note ${index}`, metadata: { tags: "personal" } });
    graph.store.db.prepare("UPDATE kg_memory_documents SET updated_at=? WHERE id=?").run(1, tagged.id);
    const result = new UnifiedRetrievalService(graph.store.db, policy).find({ scope: "work", query: "", tags: ["research"], limit: 1 });
    assert.equal(result.candidates.length, 1);
    assert.equal(decodeURIComponent(result.candidates[0].contextRef).endsWith(tagged.id), true);
  } finally { graph.close(); }
});

test("unified retrieval considers bounded document terms when a natural-language query is not one literal substring", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const document = graph.kg_memory({ operation: "store", scope: "work", title: "Production release", content: "Keep a verified rollback checklist before deployment." });
    const result = new UnifiedRetrievalService(graph.store.db, policy).find({ scope: "work", query: "production release checklist", limit: 4 });
    assert.equal(result.candidates.some(candidate => decodeURIComponent(candidate.contextRef).endsWith(document.id)), true);
  } finally { graph.close(); }
});

test("unified retrieval keeps distinct memory documents that share one ordinary source label", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const first = graph.kg_memory({ operation: "store", scope: "work", source: "manual", title: "Release checklist", content: "production release checklist" });
    const second = graph.kg_memory({ operation: "store", scope: "work", source: "manual", title: "Deployment checklist", content: "deployment checklist" });
    const refs = new UnifiedRetrievalService(graph.store.db, policy).find({ scope: "work", query: "checklist", limit: 4 }).candidates.map(candidate => candidate.contextRef);
    assert.equal(refs.some(value => value.endsWith(encodeURIComponent(first.id))), true);
    assert.equal(refs.some(value => value.endsWith(encodeURIComponent(second.id))), true);
  } finally { graph.close(); }
});

test("prefix retrieval enforces metadata, must-contain, exact scope, and lexical-only routing", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const match = graph.kg_memory({ operation: "store", scope: "project:alpha", title: "AIF deployment", content: "AIF deployment checklist", metadata: { project: "AIF", environment: "prod" } });
    graph.kg_memory({ operation: "store", scope: "project:alpha", title: "Other deployment", content: "Other deployment checklist", metadata: { project: "other", environment: "prod" } });
    graph.kg_memory({ operation: "store", scope: "project:beta", title: "AIF deployment", content: "AIF deployment checklist", metadata: { project: "AIF", environment: "prod" } });
    const service = new UnifiedRetrievalService(graph.store.db, policy);
    const result = service.find({ scope: "project:alpha", query: "deploy", metadataFilters: [{ prefix: "proj", value: "aif" }, { prefix: "env", value: "prod" }], mustContain: ["aif"], lexicalOnly: true, limit: 4 });
    assert.deepEqual(result.candidates.map(item => decodeURIComponent(item.contextRef).endsWith(match.id)), [true]);
    assert.equal(service.find({ scope: "project:alpha", query: "deploy", scopeConstraint: "project:beta", lexicalOnly: true }).empty, true);
  } finally { graph.close(); }
});

test("unified retrieval applies a bounded hard score floor while explicit zero preserves compatibility", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const event = new ConversationEventRepository(graph.store.db, policy).append({ scope: "work", sessionId: "s", kind: "assistant_message", role: "assistant", parts: [{ type: "text", text: "low score marker" }] });
    const service = new UnifiedRetrievalService(graph.store.db, policy);
    assert.equal(service.find({ scope: "work", query: "low score", hardMinScore: .99 }).empty, true);
    assert.equal(service.find({ scope: "work", query: "low score", hardMinScore: 0 }).candidates.length, 1);
    assert.equal(typeof event.id, "string");
  } finally { graph.close(); }
});

test("explicit negative feedback adaptively demotes unified memory recall without changing truth or lifecycle", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const outdated = graph.kg_memory({ operation: "store", scope: "work", title: "Outdated release", content: "release deployment checklist old route" });
    const current = graph.kg_memory({ operation: "store", scope: "work", title: "Current release", content: "release deployment checklist current route" });
    const service = new UnifiedRetrievalService(graph.store.db, policy);
    const before = service.find({ scope: "work", query: "release deployment checklist", limit: 2 }).candidates;
    const ref = `mnemora://v1/scope/work/memory-document/${encodeURIComponent(outdated.id)}`;
    new RecallFeedbackRepository(graph.store.db).record({ scope: "work", targetRef: ref, kind: "outdated" });
    const after = service.find({ scope: "work", query: "release deployment checklist", limit: 2 }).candidates;
    const beforeOutdated = before.find(candidate => candidate.contextRef.endsWith(encodeURIComponent(outdated.id)));
    const afterOutdated = after.find(candidate => candidate.contextRef.endsWith(encodeURIComponent(outdated.id)));
    assert.equal(beforeOutdated != null, true);
    assert.equal(afterOutdated != null, true);
    assert.equal(afterOutdated.score < beforeOutdated.score, true);
    assert.equal(after.some(candidate => candidate.contextRef.endsWith(encodeURIComponent(current.id))), true);
    assert.equal(graph.store.db.prepare("SELECT lifecycle_state FROM kg_memory_documents WHERE id=?").get(outdated.id).lifecycle_state, "active");
  } finally { graph.close(); }
});

test("public memory search preserves older tag-only matches across its lexical candidate limit", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const tagged = graph.kg_memory({ operation: "store", scope: "work", title: "Old research", content: "archived research note", metadata: { tags: "research" } });
    for (let index = 0; index < 120; index++) graph.kg_memory({ operation: "store", scope: "work", title: `New note ${index}`, content: `unrelated note ${index}`, metadata: { tags: "personal" } });
    graph.store.db.prepare("UPDATE kg_memory_documents SET updated_at=? WHERE id=?").run(1, tagged.id);
    const result = graph.kg_memory({ operation: "search", scope: "work", query: "tag:research", limit: 1 });
    assert.deepEqual(result.map(item => item.id), [tagged.id]);
  } finally { graph.close(); }
});

test("memory ranking reads feedback salience once per candidate even when aging comparisons rerun ranking", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", memory: { retrieval: { aging: { enabled: true } } } } });
  const original = RecallFeedbackRepository.prototype.salience;
  let calls = 0;
  RecallFeedbackRepository.prototype.salience = function (...args) { calls++; return original.apply(this, args); };
  try {
    graph.kg_memory({ operation: "store", scope: "work", title: "HBM one", content: "HBM capacity outlook one" });
    graph.kg_memory({ operation: "store", scope: "work", title: "HBM two", content: "HBM capacity outlook two" });
    const result = graph.kg_memory({ operation: "search", scope: "work", query: "HBM capacity", limit: 2 });
    assert.equal(result.length, 2);
    assert.equal(calls, 2);
  } finally {
    RecallFeedbackRepository.prototype.salience = original;
    graph.close();
  }
});
