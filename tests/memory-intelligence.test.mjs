import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { MemoryIntelligenceService } from "../dist/intelligence/service.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
test("memory intelligence provenance and changes are scope-isolated, bounded, redacted, and read-only", () => {
  const now = 2000000000000, store = new GraphologyStore(":memory:");
  try {
    const events = new ConversationEventRepository(store.db, policy), event = events.append({ scope: "alpha", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "private source body" }], createdAt: now });
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("person:a", "person", "A", "", "[]", .5, now, now);
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("company:b", "company", "B", "", "[]", .5, now, now);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("edge:a", "person:a", "company:b", "works_at", "{}", .8, now, now);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run("claim:a", "edge:a", null, "{}", "SENSITIVE_SOURCE_LABEL", "alpha", "PRIVATE_QUOTE", .8, now);
    store.db.prepare("INSERT INTO kg_source_anchors(id,scope,provider,message_id,source_label,content_hash,captured_at,status) VALUES(?,?,?,?,?,?,?,?)").run("anchor:a", "alpha", "local", event.id, "SENSITIVE_ANCHOR_LABEL", "a".repeat(64), now, "available");
    store.db.prepare("INSERT INTO kg_claim_verifications(id,claim_id,source_anchor_id,scope,status,verifier_kind,created_at) VALUES(?,?,?,?,?,?,?)").run("verification:a", "claim:a", "anchor:a", "alpha", "pending", "rule", now);
    store.db.prepare("INSERT INTO kg_verification_transitions(id,verification_id,from_status,to_status,verifier_kind,support_type,reason_code,created_at) VALUES(?,?,?,?,?,?,?,?)").run("transition:a", "verification:a", "pending", "verified", "human", "direct", "manual_review", now + 1);
    store.db.prepare("INSERT INTO kg_profile_selection_audits(id,scope,subject_id,field_key,action,graph_revision,trust_revision,created_at) VALUES(?,?,?,?,?,?,?,?)").run("audit:a", "alpha", "person:a", "works_at", "set", 1, 1, now + 2);
    const intelligence = new MemoryIntelligenceService(store.db), provenance = intelligence.read({ view: "provenance", scope: "alpha", claim_id: "claim:a", limit: 10 });
    assert.equal(provenance.items.some(item => item.kind === "observation"), true);
    assert.equal(provenance.items.some(item => item.kind === "verification" && item.journal_event_id === event.id), true);
    assert.equal(JSON.stringify(provenance).includes("SENSITIVE_ANCHOR_LABEL"), false);
    assert.equal(JSON.stringify(provenance).includes("SENSITIVE_SOURCE_LABEL"), false);
    assert.equal(JSON.stringify(provenance).includes("PRIVATE_QUOTE"), false);
    assert.deepEqual(intelligence.read({ view: "provenance", scope: "beta", claim_id: "claim:a" }).items, []);
    const changes = intelligence.read({ view: "changes", scope: "alpha", limit: 1 });
    assert.equal(changes.items.length, 1); assert.equal(changes.truncated, true);
    assert.equal(intelligence.read({ view: "changes", scope: "beta" }).items.length, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM kg_claim_verifications WHERE scope='alpha'").get().value, 1);
  } finally { store.close(); }
});
