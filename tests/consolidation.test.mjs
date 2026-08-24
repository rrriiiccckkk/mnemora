import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { EpisodeRepository } from "../dist/episodes/repository.js";
import { ConsolidationService } from "../dist/consolidation/service.js";
import { UnifiedRetrievalService } from "../dist/retrieval/service.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };

test("consolidation is scope-bound, proposal-only, idempotent, and absent from ordinary recall", () => {
  let now = 200 * 86400000;
  const store = new GraphologyStore(":memory:");
  try {
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 63);
    const events = new ConversationEventRepository(store.db, policy);
    const a = events.append({ scope: "a", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "same pattern" }], createdAt: now - 100 * 86400000 });
    const b = events.append({ scope: "a", sessionId: "s", kind: "assistant_message", role: "assistant", parts: [{ type: "text", text: "same pattern" }], createdAt: now - 99 * 86400000 });
    const other = events.append({ scope: "b", sessionId: "x", kind: "user_message", role: "user", parts: [{ type: "text", text: "same pattern" }], createdAt: now });
    const episodes = new EpisodeRepository(store.db);
    episodes.create({ scope: "a", kind: "experience", summary: "repeat preference", sourceEventIds: [a.id], importance: .7, confidence: .8, recordedAt: now - 100 * 86400000 });
    episodes.create({ scope: "a", kind: "experience", summary: "repeat preference", sourceEventIds: [b.id], importance: .7, confidence: .8, recordedAt: now - 99 * 86400000 });
    episodes.create({ scope: "b", kind: "experience", summary: "repeat preference", sourceEventIds: [other.id], importance: .7, confidence: .8, recordedAt: now });
    const service = new ConsolidationService(store.db, () => now);
    assert.deepEqual(service.schedule("a"), { scheduled: 4, existing: 0 }); assert.deepEqual(service.schedule("a"), { scheduled: 0, existing: 4 });
    const run = service.run({ scope: "a", maxJobs: 4, staleAfterDays: 30, proposalTtlDays: 1 });
    assert.equal(run.claimed, 4); assert.equal(run.proposed >= 3, true);
    const proposals = service.proposals("a");
    assert.equal(proposals.some(item => item.kind === "duplicate_episode"), true);
    assert.equal(proposals.some(item => item.kind === "staleness_review"), true);
    assert.equal(proposals.some(item => item.kind === "session_digest"), true);
    assert.equal(proposals.every(item => JSON.stringify(item).includes("repeat preference") === false), true);
    assert.equal(service.proposals("b").length, 0);
    assert.equal(new UnifiedRetrievalService(store.db, policy).find({ scope: "a", query: "repeat" }).candidates.length > 0, true);
    assert.equal(service.metrics("a").unsafe_promotions, 0);
    assert.equal(service.review("a", proposals[0].id, "rejected").status, "rejected");
    now += 2 * 86400000; assert.equal(service.expire("a") >= 1, true);
    store.db.prepare("UPDATE mnemora_consolidation_jobs SET status='running',lease_expires_at=? WHERE id=(SELECT id FROM mnemora_consolidation_jobs WHERE scope=? LIMIT 1)").run(now - 1, "a");
    assert.equal(service.reclaimStale("a"), 1);
  } finally { store.close(); }
});

test("consolidation adoption is preview-hash guarded, scope-bound, and archives only duplicate episode projections", () => {
  const now = 300 * 86400000;
  const store = new GraphologyStore(":memory:");
  try {
    const events = new ConversationEventRepository(store.db, policy);
    const firstEvent = events.append({ scope: "work", sessionId: "s", kind: "user_message", role: "user", parts: [{ type: "text", text: "keep implementation notes" }], createdAt: now - 2000 });
    const secondEvent = events.append({ scope: "work", sessionId: "s", kind: "assistant_message", role: "assistant", parts: [{ type: "text", text: "keep implementation notes" }], createdAt: now - 1000 });
    const episodes = new EpisodeRepository(store.db);
    const older = episodes.create({ scope: "work", kind: "experience", summary: "duplicate implementation note", sourceEventIds: [firstEvent.id], importance: .7, confidence: .8, recordedAt: now - 2000 });
    const newer = episodes.create({ scope: "work", kind: "experience", summary: "duplicate implementation note", sourceEventIds: [secondEvent.id], importance: .7, confidence: .8, recordedAt: now - 1000 });
    const service = new ConsolidationService(store.db, () => now);
    service.schedule("work");
    service.run({ scope: "work", maxJobs: 4, proposalTtlDays: 7 });
    const proposal = service.proposals("work").find(item => item.kind === "duplicate_episode");
    assert.ok(proposal);
    const preview = service.previewAdoption("work", proposal.id);
    assert.equal(preview.confirmationRequired, true);
    assert.equal(preview.action, "archive_duplicate_episodes");
    assert.equal(preview.retainedRefs.length, 1);
    assert.equal(preview.archivedRefs.length, 1);
    assert.throws(() => service.adopt({ scope: "work", id: proposal.id, previewHash: "not-the-preview" }), /stale_consolidation_preview/);
    assert.equal(store.db.prepare("SELECT status FROM mnemora_episodes WHERE id=?").get(older.id).status, "active");
    const receipt = service.adopt({ scope: "work", id: proposal.id, previewHash: preview.previewHash });
    assert.equal(receipt.previewHash, preview.previewHash);
    assert.equal(store.db.prepare("SELECT status FROM mnemora_episodes WHERE id=?").get(older.id).status, "archived");
    assert.equal(store.db.prepare("SELECT status FROM mnemora_episodes WHERE id=?").get(newer.id).status, "active");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events WHERE id IN (?,?)").get(firstEvent.id, secondEvent.id).value, 2);
    assert.equal(store.db.prepare("SELECT status FROM mnemora_consolidation_proposals WHERE id=?").get(proposal.id).status, "approved");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_consolidation_adoptions WHERE proposal_id=? AND scope='work'").get(proposal.id).value, 1);
    assert.throws(() => service.previewAdoption("other", proposal.id), /invalid_consolidation_adoption/);
  } finally { store.close(); }
});
