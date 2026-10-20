// Multi-session aggregation: "how many Xs" prompts match singular records,
// and recall the user's own turns rather than the assistant's long replies.
import { enterDeterministic } from "../scripts/lib/deterministic.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createTempDir } from "./helpers/temp.mjs";
import { recallText } from "./helpers/recall.mjs";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";
import { Mnemora } from "../dist/tools.js";
import { selectInjectionCandidates } from "../dist/retrieval/injection-policy.js";

const candidate = (id, excerpt) => ({ contextRef: `mnemora://v1/scope/default/conversation-event/${id}`, kind: "conversation-event", scope: "default", title: "message", excerpt, estimatedTokens: 12, bytes: excerpt.length, score: .6, sourceIds: [id], sourceRefs: [], authority: "user", confidence: 1, freshness: 0 });

test("a plural anchor matches its singular in a record", () => {
  for (const [query, excerpt] of [
    ["How many weddings did I attend this year?", "I just got back from my friend's wedding last weekend."],
    ["How many babies were born in my family?", "My cousin just had a baby girl."],
    ["How many fitness classes do I take?", "I go to a spin class on Tuesdays."],
    ["How many boxes did I ship?", "I shipped a box to my sister."]
  ]) assert.equal(selectInjectionCandidates({ query, candidates: [candidate("a", excerpt)], maxItems: 8, diversityLambda: 1 }).candidates.length, 1, query);
  // Words ending in -ss, -us or -is are not plurals.
  assert.equal(selectInjectionCandidates({ query: "Which bus did I take?", candidates: [candidate("b", "The bu stop was closed.")], maxItems: 8, diversityLambda: 1 }).candidates.length, 0);
});

async function recall(prompt, tokenBudget) {
  const directory = createTempDir("mnemora-aggregate-");
  const config = normalizeConfig({ dbPath: join(directory, "m.db"), mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, unifiedRetrieval: { enabled: true, shadowMode: false, tokenBudget, maxItems: 20 } });
  const leave = enterDeterministic("aggregate-recall", Date.UTC(2024, 1, 1));
  const graph = new Mnemora({ config });
  const shared = new Proxy(graph, { get: (target, property) => property === "close" ? () => undefined : Reflect.get(target, property, target) });
  try {
    const engine = new MnemoraContextEngine(config, () => shared);
    const advice = "Wedding guest etiquette: arrive early, bring a wedding gift from the registry, dress for the wedding venue, and congratulate the couple. ".repeat(4);
    const sessions = [
      ["I attended my cousin Rachel's wedding in March.", advice],
      ["I attended my college friend Emily's wedding at a vineyard.", advice],
      ["I attended Tom's wedding last month as a groomsman.", advice]
    ];
    let at = Date.UTC(2024, 0, 1);
    for (const [index, [user, assistant]] of sessions.entries()) await engine.ingestBatch({ sessionId: `s${index}`, messages: [{ role: "user", content: user, timestamp: at += 86_400_000 }, { role: "assistant", content: assistant, timestamp: at += 1000 }] });
    return recallText(await engine.assemble({ sessionId: "query", prompt, messages: [{ role: "user", content: prompt }], tokenBudget: 16000 })) ?? "";
  } finally { graph.close(); leave(); }
}

test("an aggregate prompt recalls the user's turns, not the assistant's replies", async () => {
  for (const budget of [800, 4000]) {
    const text = await recall("How many weddings have I attended this year?", budget);
    for (const fact of ["Rachel", "Emily", "Tom"]) assert.match(text, new RegExp(fact), `${fact} at ${budget}`);
    assert.doesNotMatch(text, /guest etiquette/u, `no assistant reply at ${budget}`);
  }
});

test("asking what the assistant said still recalls its replies", async () => {
  assert.match(await recall("What wedding etiquette tips did you give me?", 800), /guest etiquette/u);
});

test("an aggregate look-back (\"can you remind me … the average\") keeps the assistant's replies", async () => {
  assert.match(await recall("Can you remind me what the average wedding guest etiquette advice was?", 4000), /guest etiquette/u);
});
