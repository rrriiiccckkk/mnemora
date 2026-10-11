import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore, ConversationEventRepository, UnifiedRetrievalService } from "../dist/index.js";
import { DecisionMemoryService } from "../dist/cognition/decisions.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };

test("current decisions respect inclusive validity windows without erasing plans or history", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const service = new DecisionMemoryService(store.db, () => 100);
    const input = { scope: "a", objective: "WINDOW_CUTOVER", chosenAction: "Scheduled cutover", decisionMaker: "user", validFrom: 200, validUntil: 300 };
    service.confirm(input, service.preview(input).preview_hash);
    for (const [now, expected] of [[199, 0], [200, 1], [300, 1], [301, 0]]) {
      const retrieval = new UnifiedRetrievalService(store.db, policy, () => now);
      const result = retrieval.find({ scope: "a", query: "WINDOW_CUTOVER" });
      assert.equal(result.candidates.length, expected);
      if (expected) assert.match(retrieval.compilePrompt(result), /valid_from=200; valid_to=300/);
    }
    assert.equal(store.db.prepare("SELECT status FROM mnemora_decisions").get().status, "active");
  } finally { store.close(); }
});

test("claim validity is applied before confidence and LIMIT, including late old facts", () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,created_at,updated_at) VALUES('n','concept','Cutover',1,1)").run();
    const insert = store.db.prepare("INSERT INTO kg_observations(id,source_entity_id,source,scope,quote,confidence,valid_from,valid_to,created_at) VALUES(?,'n','fixture',?,?,?,?,?,?)");
    insert.run("current", "a", "CHECK_42 current", .8, 200, 300, 200);
    // Imported later, but its validity ended before the current fact began.
    for (let i = 0; i < 12; i++) insert.run(`old-${i}`, "a", "CHECK_42 old", 1, 100, 199, 400 + i);
    insert.run("future", "a", "CHECK_42 future", 1, 301, null, 500);
    insert.run("foreign", "b", "CHECK_42 secret", 1, null, null, 200);
    const retrieval = new UnifiedRetrievalService(store.db, policy, () => 250);
    const result = retrieval.find({ scope: "a", query: "CHECK_42", limit: 1 });
    assert.deepEqual(result.candidates.map(item => item.excerpt), ["CHECK_42 current"]);
    assert.match(retrieval.compilePrompt(result), /valid_from=200; valid_to=300/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_observations").get().n, 15);
  } finally { store.close(); }
});

test("historical source cutoff precedes collection limits and preserves separate checks", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const journal = new ConversationEventRepository(store.db, policy);
    const append = (time, text, scope = "a") => journal.append({ scope, sessionId: `${scope}-${time}`, role: "user", kind: "user_message", createdAt: time, parts: [{ type: "text", text }] });
    append(100, "RELEASE_CHECK_42 guard pending; installation pending.");
    append(200, "RELEASE_CHECK_42 guard passed; published; installation pending.");
    for (let i = 0; i < 20; i++) append(300 + i, "RELEASE_CHECK_42 installed.");
    append(150, "RELEASE_CHECK_42 foreign secret.", "b");
    const service = new UnifiedRetrievalService(store.db, policy, () => 400);
    const result = service.find({ scope: "a", query: "RELEASE_CHECK_42", intent: "exact_history", recordedBefore: 200, limit: 2, tokenBudget: 1000 });
    const prompt = service.compilePrompt(result);
    assert.match(prompt, /guard pending/);
    assert.match(prompt, /guard passed; published; installation pending/);
    assert.doesNotMatch(prompt, /installed\.|foreign/);
    assert.equal(journal.search("a", "RELEASE_CHECK_42", 1, 100)[0].createdAt, 100);
    assert.throws(() => service.find({ scope: "a", query: "RELEASE_CHECK_42", recordedBefore: 200 }), /invalid_history_cutoff/);
    assert.throws(() => service.find({ scope: "a", query: "RELEASE_CHECK_42", intent: "exact_history", recordedBefore: NaN }), /invalid_history_cutoff/);
  } finally { store.close(); }
});
