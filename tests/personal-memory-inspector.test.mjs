import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { ArtifactRepository } from "../dist/artifacts/repository.js";
import { SummaryRepository } from "../dist/context-engine/summary-repository.js";
import { PersonalMemoryInspectorService, PERSONAL_MEMORY_SECTIONS } from "../dist/personal-memory/index.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
test("personal memory inspector is bounded, read-only, scope-isolated, and redacts source identity", () => {
  let now = 2000000000000;
  const store = new GraphologyStore(":memory:");
  try {
    const events = new ConversationEventRepository(store.db, policy), artifacts = new ArtifactRepository(store.db, policy), episodes = new EpisodeRepository(store.db), summaries = new SummaryRepository(store.db, policy);
    const event = events.append({ scope: "alpha", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "secret preference: concise answers" }], createdAt: now });
    events.append({ scope: "beta", sessionId: "other", kind: "user_message", role: "user", parts: [{ type: "text", text: "other scope" }], createdAt: now });
    const artifact = artifacts.put({ scope: "alpha", sourceEventId: event.id, kind: "tool_output", content: "safe preview", now });
    episodes.create({ scope: "alpha", kind: "experience", summary: "User likes concise answers", sourceEventIds: [event.id], sourceArtifactIds: [artifact.id], importance: .8, confidence: .9, recordedAt: now });
    summaries.create({ scope: "alpha", sessionId: "s", eventIds: [event.id], content: "A bounded summary", maxChars: 200, now });
    store.db.prepare("INSERT INTO kg_source_anchors(id,scope,provider,source_label,content_hash,captured_at,status) VALUES(?,?,?,?,?,?,?)").run("anchor-a", "alpha", "local", "DO_NOT_SHOW_THIS_LABEL", "a".repeat(64), now, "available");
    store.db.prepare("INSERT INTO kg_claim_verifications(id,claim_id,source_anchor_id,scope,status,verifier_kind,created_at) VALUES(?,?,?,?,?,?,?)").run("verification-a", "claim-a", "anchor-a", "alpha", "verified", "human", now);
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("person:alice", "person", "Alice", "", "[]", .5, now, now);
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("company:mnemora", "company", "Mnemora", "", "[]", .5, now, now);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("edge-a", "person:alice", "company:mnemora", "works_at", "{}", .8, now, now);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run("observation-a", "edge-a", null, "{}", "local", "alpha", "private quote", .8, now);
    store.db.prepare("INSERT INTO kg_recall_shadow_runs(id,scope,policy_version,candidate_count,fixed_count,adaptive_count,overlap_count,empty,top_scores,absolute_floor,relative_floor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("shadow-a", "alpha", "adaptive-relative-v1", 2, 2, 1, 1, 0, "[]", 0, 0, now);
    const view = new PersonalMemoryInspectorService(store.db, () => now);
    for (const section of PERSONAL_MEMORY_SECTIONS) {
      const result = view.read({ scope: "alpha", section, limit: 1 });
      assert.equal(result.kind, "personal_memory"); assert.equal(result.scope, "alpha"); assert.equal(result.section, section); assert.equal(result.items.length <= 1, true);
    }
    assert.equal(view.read({ scope: "alpha", section: "today" }).items[0].text.includes("concise answers"), true);
    assert.deepEqual(view.read({ scope: "beta", section: "episodes" }).items, []);
    assert.deepEqual(view.read({ scope: "alpha", section: "profile", subject: "Alice" }).items.map(item => item.related_entity), ["Mnemora"]);
    const sources = JSON.stringify(view.read({ scope: "alpha", section: "sources" }));
    assert.equal(sources.includes("DO_NOT_SHOW_THIS_LABEL"), false);
    const before = JSON.stringify(view.read({ scope: "alpha", section: "episodes" }));
    assert.equal(before.includes("User likes concise answers"), true);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events WHERE scope='alpha'").get().value, 1);
  } finally { store.close(); }
});
