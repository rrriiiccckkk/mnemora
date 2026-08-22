import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore, ConversationEventRepository, EpisodeRepository, MemoryImpactService } from "../dist/index.js";
import { DecisionMemoryService } from "../dist/cognition/decisions.js";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
const policy={maxInlineChars:16000,maxEventBytes:262144,sensitiveContentPolicy:"redact"};
test("memory impact is scope-bound, preview-bound, and forget removes active episode recall", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const event = new ConversationEventRepository(store.db, policy).append({ scope: "a", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "remember" }] });
    const episodes = new EpisodeRepository(store.db);
    const episode = episodes.create({ scope: "a", kind: "experience", summary: "remember", sourceEventIds: [event.id], importance: .8, confidence: .8 });
    const decisions = new DecisionMemoryService(store.db);
    const decision = { scope: "a", objective: "Use the remembered plan", evidence: [{ sourceRef: createMnemoraContextRef({ scope: "a", kind: "episode", id: episode.id }) }] };
    const storedDecision = decisions.confirm(decision, decisions.preview(decision).preview_hash);
    const impact = new MemoryImpactService(store.db), preview = impact.preview({ scope: "a", kind: "event", id: event.id });
    assert.deepEqual(preview.affected.episodes, [episode.id]);
    assert.deepEqual(preview.affected.decisions, [storedDecision.id]);
    assert.equal(impact.forget({ scope: "a", kind: "event", id: event.id, previewHash: preview.previewHash, confirm: false }).status, "confirm_required");
    assert.throws(() => impact.forget({ scope: "a", kind: "event", id: event.id, previewHash: "old", confirm: true }), /stale_memory_preview/);
    assert.equal(impact.forget({ scope: "a", kind: "event", id: event.id, previewHash: preview.previewHash, confirm: true }).status, "forgotten");
    assert.deepEqual(episodes.search("a", "remember"), []);
    assert.equal(decisions.get(storedDecision.id, "a").status, "needs_review");
    assert.deepEqual(decisions.find("a", "remember"), []);
  } finally { store.close(); }
});
