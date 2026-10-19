import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createTempDir } from "./helpers/temp.mjs";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";
import { Mnemora } from "../dist/tools.js";
import { contentTerms, ftsMatchExpression, joinHanSingles, lightStem, matchedTerms, weightedCoverage } from "../dist/retrieval/lexical.js";
import { selectInjectionCandidates } from "../dist/retrieval/injection-policy.js";
import { recallText, withoutRecall } from "./helpers/recall.mjs";

function engine(unifiedRetrieval = {}) {
  const directory = createTempDir("recall-v134-");
  const config = normalizeConfig({ dbPath: join(directory, "m.db"), mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, unifiedRetrieval: { enabled: true, shadowMode: false, tokenBudget: 800, maxItems: 8, ...unifiedRetrieval } });
  const graph = new Mnemora({ config });
  const shared = new Proxy(graph, { get: (target, property) => property === "close" ? () => undefined : Reflect.get(target, property, target) });
  return { engine: new MnemoraContextEngine(config, () => shared), graph, close: () => graph.close() };
}
async function ask(target, prompt) {
  return recallText(await target.assemble({ sessionId: "query-session", prompt, messages: [{ role: "user", content: prompt }], tokenBudget: 16000 })) ?? "";
}
const candidate = (id, excerpt, queryMatch, score = 1) => ({ contextRef: `mnemora://v1/scope/default/conversation-event/${id}`, kind: "conversation-event", scope: "default", title: "user_message", excerpt, estimatedTokens: 10, bytes: excerpt.length, score, sourceIds: [id], sourceRefs: [], authority: "user_explicit", confidence: 1, freshness: 1, selectionReason: "lexical_match", queryMatch });

test("relevance floor is unset by default (0.15 with semantic recall, 0 without) and is clamped", () => {
  assert.equal(normalizeConfig({}).unifiedRetrieval.minQueryMatch, undefined);
  assert.equal(normalizeConfig({ unifiedRetrieval: { minQueryMatch: .15 } }).unifiedRetrieval.minQueryMatch, .15);
  assert.equal(normalizeConfig({ unifiedRetrieval: { minQueryMatch: 0 } }).unifiedRetrieval.minQueryMatch, 0);
  assert.equal(normalizeConfig({ unifiedRetrieval: { minQueryMatch: 7 } }).unifiedRetrieval.minQueryMatch, 1);
});

test("light stemming matches inflected forms the porter index already finds", () => {
  assert.equal(lightStem("graduated"), lightStem("graduate"));
  assert.equal(lightStem("lives"), lightStem("live"));
  assert.equal(lightStem("races"), lightStem("race"));
  assert.equal(lightStem("ios17"), "ios17");
  assert.deepEqual(matchedTerms("I graduated in 2019 and started running races.", ["graduate", "race", "swim"], true), ["graduate", "race"]);
  assert.deepEqual(matchedTerms("I graduated in 2019 and started running races.", ["graduate", "race", "swim"]), []);
  assert.deepEqual(matchedTerms("我对花生严重过敏", ["花生", "过敏", "海鲜"]), ["花生", "过敏"]);
});

test("rarity weighting: sharing only a common word scores below sharing the rare one", () => {
  const weights = new Map([["time", .2], ["hamster", 6]]);
  const common = weightedCoverage("We spent a lot of time on the project.", ["time", "hamster"], weights);
  const rare = weightedCoverage("My hamster is called Biscuit.", ["time", "hamster"], weights);
  assert.ok(common < .15, `common=${common}`);
  assert.ok(rare > .9, `rare=${rare}`);
});

test("adjacent single Han characters join into a searchable bigram phrase", () => {
  assert.deepEqual(joinHanSingles(["帮", "我", "订", "餐", "要注意"]), ["帮", "我", "订餐", "要注意"]);
  assert.ok(contentTerms("帮我订餐要注意什么？").includes("订餐"));
  assert.equal(ftsMatchExpression(["订餐"]), "\"订 餐\"");
});

test("a Chinese compound missing from the ICU dictionary is still recalled", async () => {
  const { engine: target, close } = engine();
  try {
    for (let index = 0; index < 30; index++) await target.ingestBatch({ sessionId: `n${index}`, messages: [{ role: "user", content: `第${index}次聊天：帮我看看这段代码有什么问题。` }] });
    await target.ingestBatch({ sessionId: "fact", messages: [{ role: "user", content: "顺便说一下，我对花生严重过敏，订餐时千万别点含花生的。" }] });
    assert.match(await ask(target, "帮我订餐要注意什么？"), /花生/u);
  } finally { close(); }
});

test("selection drops candidates below the floor but keeps exact identifiers", () => {
  const strong = candidate("a", "My hamster Biscuit eats carrots.", .8);
  const weak = candidate("b", "Biscuit recipes for the holidays.", .05);
  const selected = selectInjectionCandidates({ query: "What does my hamster Biscuit eat?", candidates: [strong, weak], maxItems: 8, diversityLambda: 1, minQueryMatch: .15 });
  assert.deepEqual(selected.candidates.map(item => item.sourceIds[0]), ["a"]);
  const none = selectInjectionCandidates({ query: "What does my hamster Biscuit eat?", candidates: [weak], maxItems: 8, diversityLambda: 1, minQueryMatch: .15 });
  assert.equal(none.candidates.length, 0);
  assert.equal(none.reason, "below_relevance_floor");
  const disabled = selectInjectionCandidates({ query: "What does my hamster Biscuit eat?", candidates: [weak], maxItems: 8, diversityLambda: 1, minQueryMatch: 0 });
  assert.equal(disabled.candidates.length, 1);
  const identifier = candidate("c", "Deploy TASK_4821 finished on staging.", .05);
  const exact = selectInjectionCandidates({ query: "Status of TASK_4821 deploy?", candidates: [identifier], maxItems: 8, diversityLambda: 1, minQueryMatch: .15 });
  assert.equal(exact.candidates.length, 1);
});

test("with the lexical floor set, an unrelated prompt over a long history attaches nothing", async () => {
  const { engine: target, close } = engine({ minQueryMatch: .15 });
  const topics = ["the quarterly budget review took most of the time today", "my bike needs new brake pads before the weekend", "we watched a documentary about deep sea fish", "the printer at the office keeps jamming on long jobs", "I am learning to bake sourdough bread at home", "our team switched the standup to a later time"];
  try {
    for (let index = 0; index < 36; index++) await target.ingestBatch({ sessionId: `s${index}`, messages: [{ role: "user", content: `Note ${index}: ${topics[index % topics.length]}.` }] });
    await target.ingestBatch({ sessionId: "garden", messages: [{ role: "user", content: "For the garden I bought tomato seedlings, basil and a new hose." }] });
    assert.equal(await ask(target, "How much time does a flight from Tokyo to Lima take with a layover?"), "");
    assert.match(await ask(target, "Which seedlings did I buy for the garden?"), /tomato seedlings/u);
  } finally { close(); }
});

test("knowledge updates: the earlier record names the later record on the same topic", async () => {
  const { engine: target, close } = engine();
  try {
    await target.ingestBatch({ sessionId: "s1", messages: [{ role: "user", content: "I live in Berlin now." }] });
    await new Promise(resolve => setTimeout(resolve, 15));
    await target.ingestBatch({ sessionId: "s2", messages: [{ role: "user", content: "Update: I moved from Berlin to Singapore last month, so I live in Singapore now." }] });
    const rendered = await ask(target, "Where do I live?");
    assert.match(rendered, /when they conflict, the most recent statement is current/u);
    const berlin = rendered.split("\n\n").find(block => block.includes("I live in Berlin now."));
    assert.match(berlin, /newer_related=\d/u);
    const singapore = rendered.split("\n\n").find(block => block.includes("Singapore now"));
    assert.doesNotMatch(singapore, /newer_related=/u);
  } finally { close(); }
});

test("unrelated records are not linked as updates", async () => {
  const { engine: target, close } = engine();
  try {
    await target.ingestBatch({ sessionId: "s1", messages: [{ role: "user", content: "My sister lives in Berlin and works as a nurse." }] });
    await new Promise(resolve => setTimeout(resolve, 15));
    await target.ingestBatch({ sessionId: "s2", messages: [{ role: "user", content: "My brother is a chef in Lisbon." }] });
    const rendered = await ask(target, "What does my sister do in Berlin and where is my brother a chef?");
    assert.doesNotMatch(rendered, /newer_related=/u);
  } finally { close(); }
});

test("host message timestamps become record time and render as ISO", async () => {
  const { engine: target, close } = engine();
  try {
    const at = Date.parse("2023-05-20T10:00:00Z");
    await target.ingestBatch({ sessionId: "old", messages: [{ role: "user", content: "I bought new trail running shoes.", timestamp: at }] });
    await target.ingestBatch({ sessionId: "secs", messages: [{ role: "user", content: "I repaired the trail bike chain.", timestamp: at / 1000 }] });
    await target.ingestBatch({ sessionId: "future", messages: [{ role: "user", content: "I washed the trail jacket.", timestamp: Date.now() + 86_400_000 }] });
    const rendered = await ask(target, "What trail gear did I deal with?");
    assert.match(rendered, /recorded_at=2023-05-20T10:00:00\.000Z\nI bought new trail running shoes\./u);
    assert.match(rendered, /recorded_at=2023-05-20T10:00:00\.000Z\nI repaired the trail bike chain\./u);
    const future = rendered.match(/recorded_at=(\S+)\nI washed the trail jacket\./u);
    assert.ok(future && Date.parse(future[1]) <= Date.now());
  } finally { close(); }
});

test("freshness ranks but does not gate: an old record keeps its admission score", async () => {
  const { UnifiedRetrievalService } = await import("../dist/retrieval/service.js");
  for (const age of [0, 3 * 365 * 86_400_000]) {
    const { engine: target, graph, close } = engine();
    try {
      await target.ingestBatch({ sessionId: "s", messages: [{ role: "user", content: "The play I attended was The Glass Menagerie at the community theater.", timestamp: Date.now() - age }] });
      const service = new UnifiedRetrievalService(graph.store.db, target.policy(), Date.now, graph.memoryLifecycle);
      // A fresh copy scores about 0.98; at the 0.1 freshness floor the same
      // record scores about 0.85. A 0.9 floor must treat both alike.
      const found = service.find({ scope: "default", query: "play attended Glass Menagerie community theater", limit: 8, tokenBudget: 800, hardMinScore: .9 });
      assert.equal(found.candidates.length, 1, `age ${age}`);
    } finally { close(); }
  }
});

test("recalled conversation turns name their speaker and cite their ref once", async () => {
  const { engine: target, close } = engine();
  try {
    await target.ingestBatch({ sessionId: "rome", messages: [
      { role: "user", content: "Which Rome restaurant is best for a romantic dinner?" },
      { role: "assistant", content: "For a romantic dinner in Rome, I would recommend Roscioli." }
    ] });
    const prompt = await ask(target, "Remind me which romantic Rome restaurant you recommended?");
    assert.match(prompt, /conversation-event\/[^;\s]+; role=assistant[;\n]/u);
    assert.match(prompt, /conversation-event\/[^;\s]+; role=user[;\n]/u);
    assert.doesNotMatch(prompt, /kind=conversation-event|authority=user_explicit/u);
    const refs = [...prompt.matchAll(/mnemora:\/\/[^\s;,]+/gu)].map(match => match[0]);
    assert.equal(refs.length, new Set(refs).size, "each record is cited once");
  } finally { close(); }
});

test("prompts about what the assistant said are recognised in English and Chinese", async () => {
  const { asksAboutAssistant } = await import("../dist/retrieval/service.js");
  for (const prompt of ["Can you remind me which restaurant you recommended?", "Going back to our previous conversation about dinosaurs, what colour was the Plesiosaur?", "你之前推荐的那家餐厅叫什么？"]) assert.equal(asksAboutAssistant(prompt), true, prompt);
  for (const prompt of ["What degree did I graduate with?", "我上周买了什么？", "Where do you think I should travel?"]) assert.equal(asksAboutAssistant(prompt), false, prompt);
});

test("assistant-recall prompts attach the reply that followed the matching user turn", async () => {
  const { engine: target, close } = engine();
  try {
    await target.ingestBatch({ sessionId: "bandung", messages: [
      { role: "user", content: "I'm visiting Cihampelas Walk in Bandung. Where should I eat Nasi Goreng there?" },
      { role: "assistant", content: `Head to Miss Bee Providore: its signature fried rice is the local favourite. ${"Plenty of other options line the street. ".repeat(40)}` },
      { role: "user", content: "Thanks, what about shopping for denim?" },
      { role: "assistant", content: "The denim street has many small boutiques." }
    ] });
    const prompt = await ask(target, "Can you remind me of the restaurant you recommended at Cihampelas Walk for Nasi Goreng?");
    assert.match(prompt, /role=assistant[^\n]*\n[^\n]*Miss Bee Providore/u);
    // A new request is not a look-back: the user's own turns keep their weight.
    const { asksAboutAssistant } = await import("../dist/retrieval/service.js");
    assert.equal(asksAboutAssistant("Can you recommend a restaurant in Bandung?"), false);
  } finally { close(); }
});

test("find charges the packet wrapper so final packing keeps every admitted record", async () => {
  const { UnifiedRetrievalService } = await import("../dist/retrieval/service.js");
  const { engine: target, graph, close } = engine();
  try {
    await target.ingestBatch({ sessionId: "s", messages: Array.from({ length: 6 }, (_, index) => ({ role: "user", content: `Catalonia literature note ${index}: ${"political climate and music themes ".repeat(12)}` })) });
    const service = new UnifiedRetrievalService(graph.store.db, target.policy(), Date.now, graph.memoryLifecycle);
    for (const budget of [200, 320, 500]) {
      const found = service.find({ scope: "default", query: "Catalonia literature political climate music", limit: 8, tokenBudget: budget });
      const packed = service.packPrompt(found, 8, undefined, budget);
      assert.equal(packed.candidates.length, found.candidates.length, `budget ${budget}`);
      assert.ok(packed.estimatedTokens <= budget);
    }
  } finally { close(); }
});

test("aggregate prompts are recognised and admit weaker single-fact matches", async () => {
  const { asksForAggregate, defaultAdmissionFloor } = await import("../dist/retrieval/service.js");
  for (const prompt of ["How many plants did I acquire last month?", "What is the total amount I spent on gifts?", "Which grocery store did I spend the most money at?", "我一共买了几本书？", "上个月总共花了多少钱？"]) {
    assert.equal(asksForAggregate(prompt), true, prompt);
    assert.equal(defaultAdmissionFloor(prompt), .25, prompt);
  }
  for (const prompt of ["What degree did I graduate with?", "我上周买了什么？", "Can you suggest a hotel in Miami?"]) {
    assert.equal(asksForAggregate(prompt), false, prompt);
    assert.equal(defaultAdmissionFloor(prompt), .35, prompt);
  }
  // A look-back at the assistant keeps the default floor: its handling attaches replies instead.
  assert.equal(defaultAdmissionFloor("How many songs did you recommend in our previous conversation?"), .35);
});

test("the semantic neighbourhood gates the packet, not each record", () => {
  const query = "How many doctors did I visit this year?";
  const close = { ...candidate("a", "I saw a doctor about my knee in March.", .4), semanticSimilarity: .6 };
  const distant = { ...candidate("b", "The doctor I visited, a dermatologist, prescribed a cream.", .3), semanticallyDistant: true };
  const weak = candidate("c", "My visit to the doctor in June was quick.", .1);
  const options = { query, maxItems: 8, diversityLambda: 1, minSemanticSimilarity: .45, gateQueryMatch: .15 };
  const opened = selectInjectionCandidates({ ...options, candidates: [close, distant, weak] });
  assert.deepEqual(opened.candidates.map(item => item.sourceIds[0]).sort(), ["a", "b", "c"]);
  // Every word match lies outside the neighbourhood: the prompt is about something else.
  const closed = selectInjectionCandidates({ ...options, candidates: [distant, { ...weak, semanticallyDistant: true }] });
  assert.equal(closed.candidates.length, 0);
  assert.equal(closed.reason, "below_relevance_floor");
  // Only weak matches: the gate floor keeps the packet closed.
  assert.equal(selectInjectionCandidates({ ...options, candidates: [weak] }).candidates.length, 0);
  // A floor the operator sets still applies to each record.
  assert.deepEqual(selectInjectionCandidates({ ...options, minQueryMatch: .15, candidates: [close, distant, weak] }).candidates.map(item => item.sourceIds[0]).sort(), ["a", "b"]);
});
