import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore, ConversationEventRepository, EpisodeRepository, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";
import { automaticEpisodeImportance, automaticEpisodeProposal } from "../dist/journal/service.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
test("episodes are source-idempotent, scope isolated, searchable, and lifecycle-safe", () => {
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(SUPPORTED_SCHEMA_VERSION, 75);
    const events = new ConversationEventRepository(store.db, policy), repo = new EpisodeRepository(store.db);
    const first = events.append({ scope: "work", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "plan the launch" }] });
    const episode = repo.create({ scope: "work", kind: "task", title: "Launch", summary: "Plan the product launch", sourceEventIds: [first.id], importance: .8, confidence: .9 });
    assert.equal(repo.create({ scope: "work", kind: "task", title: "Launch", summary: "Plan the product launch", sourceEventIds: [first.id], importance: .8, confidence: .9 }).id, episode.id);
    assert.deepEqual(repo.search("work", "launch").map(item => item.id), [episode.id]);
    assert.deepEqual(repo.search("other", "launch"), []);
    assert.equal(repo.transition(episode.id, "work", "archived").status, "archived");
    assert.deepEqual(repo.search("work", "launch"), []);
    assert.throws(() => repo.create({ scope: "work", kind: "task", summary: "bad", sourceEventIds: ["missing"], importance: .5, confidence: .5 }), /invalid_episode_source/);
  } finally { store.close(); }
});

test("automatic episode importance is a real signal that minImportance can filter", () => {
  const short = automaticEpisodeImportance([{ role: "user", normalizedText: "ok" }, { role: "assistant", normalizedText: "done" }]);
  const detailed = automaticEpisodeImportance([{ role: "user", normalizedText: "Please compare the supplier risks across the semiconductor packaging market." }, { role: "assistant", normalizedText: "I will compare concentration, qualification risk, capacity, and the evidence for each supplier before making a recommendation." }]);
  assert.ok(short < .5);
  assert.ok(detailed >= .5 && detailed > short);
});

test("signal episode extraction classifies only explicit task language and never creates a personal fact", () => {
  const incident = automaticEpisodeProposal([
    { role: "user", normalizedText: "The deployment failed after the migration; roll it back." },
    { role: "assistant", normalizedText: "I will inspect the failure and prepare a rollback plan." }
  ]);
  assert.deepEqual(incident, { kind: "incident", title: "explicit incident signal", importance: incident.importance, signals: ["incident"] });
  assert.ok(incident.importance > automaticEpisodeImportance([{ role: "user", normalizedText: "The deployment failed after the migration; roll it back." }, { role: "assistant", normalizedText: "I will inspect the failure and prepare a rollback plan." }]));
  const ordinary = automaticEpisodeProposal([{ role: "user", normalizedText: "please explain this" }, { role: "assistant", normalizedText: "Here is an explanation." }]);
  assert.equal(ordinary.kind, "interaction");
  assert.deepEqual(ordinary.signals, []);
});
