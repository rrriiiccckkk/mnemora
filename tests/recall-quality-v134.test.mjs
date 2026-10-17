import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createTempDir } from "./helpers/temp.mjs";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";
import { Mnemora } from "../dist/tools.js";
import { contentTerms, ftsMatchExpression, joinHanSingles, lightStem, matchedTerms, weightedCoverage } from "../dist/retrieval/lexical.js";
import { selectInjectionCandidates } from "../dist/retrieval/injection-policy.js";

function engine(unifiedRetrieval = {}) {
  const directory = createTempDir("recall-v134-");
  const config = normalizeConfig({ dbPath: join(directory, "m.db"), mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, unifiedRetrieval: { enabled: true, shadowMode: false, tokenBudget: 800, maxItems: 8, ...unifiedRetrieval } });
  const graph = new Mnemora({ config });
  const shared = new Proxy(graph, { get: (target, property) => property === "close" ? () => undefined : Reflect.get(target, property, target) });
  return { engine: new MnemoraContextEngine(config, () => shared), close: () => graph.close() };
}
async function ask(target, prompt) {
  return (await target.assemble({ sessionId: "query-session", prompt, messages: [{ role: "user", content: prompt }], tokenBudget: 16000 })).systemPromptAddition ?? "";
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
