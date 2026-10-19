import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";
import { ConversationEventRepository } from "../dist/journal/repository.js";
import { UnifiedRetrievalService } from "../dist/retrieval/service.js";

const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" };
const DAY = 86_400_000;
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2023, 3, 25);

function fixture(distractor) {
  const store = new GraphologyStore(":memory:");
  const events = new ConversationEventRepository(store.db, policy);
  const say = (text, createdAt) => events.append({ scope: "s", sessionId: `x${createdAt}`, kind: "user_message", role: "user", parts: [{ type: "text", text }], createdAt });
  say(distractor, NOW - 3 * DAY);
  say("I bought a kitchen smoker for the patio and tried brisket.", NOW - 10 * DAY);
  return store;
}

const first = (result) => result.candidates.find(candidate => candidate.kind === "conversation-event")?.excerpt ?? "";
const QUESTION = "What kitchen item did I buy 10 days ago?";

test("a time phrase settles a near tie in favour of the record from that window", () => {
  // The distractor is newer and shorter, so it wins without the time phrase.
  const store = fixture("I bought a kitchen scale for coffee.");
  try {
    const service = new UnifiedRetrievalService(store.db, policy, () => NOW);
    assert.match(first(service.find({ scope: "s", query: QUESTION })), /smoker/u);
    assert.doesNotMatch(first(service.find({ scope: "s", query: QUESTION, timeAnchors: false })), /smoker/u);
  } finally { store.close(); }
});

test("a much closer match from another day still ranks first", () => {
  // Deliberate: a busy day holds many unrelated records, so the window is a
  // tie-breaker, not a filter.
  const store = fixture("I bought a new kitchen item: a stand mixer for the kitchen.");
  try {
    const service = new UnifiedRetrievalService(store.db, policy, () => NOW);
    const result = service.find({ scope: "s", query: QUESTION });
    assert.match(first(result), /stand mixer/u);
    assert.ok(result.candidates.some(candidate => /smoker/u.test(candidate.excerpt)));
  } finally { store.close(); }
});

test("the time phrase's words do not count as topic", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const events = new ConversationEventRepository(store.db, policy);
    events.append({ scope: "s", sessionId: "a", kind: "user_message", role: "user", parts: [{ type: "text", text: "Ten days ago, many days ago, the days were long." }], createdAt: NOW - 200 * DAY });
    const service = new UnifiedRetrievalService(store.db, policy, () => NOW);
    // Without the anchor, "days" and "ago" match this unrelated record.
    assert.equal(service.find({ scope: "s", query: "What gadget did I buy 10 days ago?", timeAnchors: false }).candidates.length > 0, true);
    assert.equal(service.find({ scope: "s", query: "What gadget did I buy 10 days ago?" }).candidates.length, 0);
  } finally { store.close(); }
});

test("recalled records carry resolved relative dates as metadata, and timeAnchors false turns both aids off", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const events = new ConversationEventRepository(store.db, policy);
    events.append({ scope: "s", sessionId: "a", kind: "user_message", role: "user", parts: [{ type: "text", text: "I started the pottery class three weeks ago and finished a bowl yesterday." }], createdAt: at(2023, 5, 25) });
    const service = new UnifiedRetrievalService(store.db, policy, () => at(2023, 6, 1));
    const on = service.compilePrompt(service.find({ scope: "s", query: "pottery class bowl" }));
    assert.match(on, /; dates=three weeks ago≈2023-05-04, yesterday≈2023-05-24/u);
    assert.match(on, /I started the pottery class three weeks ago and finished a bowl yesterday\./u);
    const off = service.compilePrompt(service.find({ scope: "s", query: "pottery class bowl", timeAnchors: false }));
    assert.doesNotMatch(off, /; dates=/u);
  } finally { store.close(); }
});
