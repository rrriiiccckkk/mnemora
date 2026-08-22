import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora, UnifiedRetrievalService } from "../dist/index.js";
import { memoryMatchesMetadataFilters, planRecallQuery, safeIdentifierHints } from "../dist/retrieval/query-routing.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };

test("query routing stays inert until explicitly enabled and then exposes bounded, deterministic intent, tags, and alternates", () => {
  assert.deepEqual(planRecallQuery("tag:research AI document"), { query: "tag:research AI document", alternates: [], tags: [], intent: "general" });
  const plan = planRecallQuery("tag:research AI document", { enabled: true });
  assert.deepEqual(plan, { query: "AI document", alternates: ["人工智能 document"], tags: ["research"], intent: "artifact" });
  assert.equal(planRecallQuery("之前说过什么", { enabled: true }).intent, "exact_history");
});

test("identifier hints preserve exact technical identifiers and never search secret labels", () => {
  assert.deepEqual(safeIdentifierHints("Investigate FOO_BAR and DATABASE_URL, not API_KEY, ACCESS_TOKEN, DEPLOYMENT_KEY, PRIVATE_SIGNING_KEY, SIGNING_KEY, or ENCRYPTION_KEY."), ["FOO_BAR", "DATABASE_URL"]);
  assert.deepEqual(planRecallQuery("Where is FOO_BAR configured?", { enabled: true }).alternates, ["FOO_BAR"]);
  assert.deepEqual(planRecallQuery("Where is FOO_BAR configured?", { enabled: true, identifierHints: false }).alternates, []);
});

test("identifier hints retain their documented four-item bound through query planning", () => {
  const plan = planRecallQuery("Compare ONE_FLAG TWO_FLAG THREE_FLAG FOUR_FLAG", { enabled: true, queryExpansion: false });
  assert.deepEqual(plan.alternates, ["ONE_FLAG", "TWO_FLAG", "THREE_FLAG", "FOUR_FLAG"]);
});

test("supported metadata prefixes are bounded lexical anchors and scope is fail-closed", () => {
  const plan = planRecallQuery("proj:AIF env:prod deploy checklist", { enabled: true });
  assert.deepEqual(plan.query, "deploy checklist");
  assert.deepEqual(plan.metadataFilters, [{ prefix: "proj", value: "aif" }, { prefix: "env", value: "prod" }]);
  assert.deepEqual(plan.mustContain, ["aif", "prod"]);
  assert.equal(plan.lexicalOnly, true);
  assert.deepEqual(planRecallQuery("scope:project:alpha rollback", { enabled: true }).scopeConstraint, "project:alpha");
  assert.equal(memoryMatchesMetadataFilters({ project: "AIF", environment: "prod" }, plan.metadataFilters), true);
  assert.equal(memoryMatchesMetadataFilters({ project: "other", environment: "prod" }, plan.metadataFilters), false);
});

test("query expansion remains local, bilingual, and bounded for operational vocabulary", () => {
  const plan = planRecallQuery("挂了 deploy", { enabled: true });
  assert.equal(plan.alternates.length <= 4, true);
  assert.equal(plan.alternates.some(value => value.includes("down")), true);
  assert.equal(plan.alternates.every(value => value.length <= 512), true);
});

test("tag-prefix filtering and query expansion remain local, scope-bound, and opt-in", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:", recall: { queryRouting: { enabled: true } } } });
  try {
    graph.kg_memory({ operation: "store", scope: "work", title: "AI research", content: "人工智能 platform notes", metadata: { tags: "research,ai" } });
    graph.kg_memory({ operation: "store", scope: "work", title: "Personal", content: "人工智能 private notes", metadata: { tags: "personal" } });
    graph.kg_memory({ operation: "store", scope: "private", title: "Hidden", content: "人工智能 hidden", metadata: { tags: "research" } });
    assert.deepEqual(graph.kg_memory({ operation: "search", scope: "work", query: "tag:research AI" }).map(item => item.title), ["AI research"]);
    assert.deepEqual(graph.kg_memory({ operation: "search", scope: "work", query: "tag:research" }).map(item => item.title), ["AI research"]);
  } finally { graph.close(); }
});

test("unified retrieval uses supplied bounded alternates without broadening the scope", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    new ConversationEventRepository(graph.store.db, policy).append({ scope: "work", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "人工智能 project plan" }] });
    const service = new UnifiedRetrievalService(graph.store.db, policy);
    assert.equal(service.find({ scope: "work", query: "AI" }).empty, true);
    const result = service.find({ scope: "work", query: "AI", alternates: ["人工智能"], intent: "structured_fact" });
    assert.equal(result.intent, "structured_fact");
    assert.equal(result.candidates.length, 1);
    assert.equal(service.find({ scope: "private", query: "AI", alternates: ["人工智能"] }).empty, true);
  } finally { graph.close(); }
});
