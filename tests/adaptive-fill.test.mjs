// Adaptive fill: at a recall budget of 1600 tokens or more, records held back
// only by the admission floor fill the room admitted records leave, once a
// well-matched record has opened the packet. The default budget is unchanged.
// Seeded ids and clock, so runs over the same data are comparable record by record.
import { enterDeterministic } from "../scripts/lib/deterministic.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createTempDir } from "./helpers/temp.mjs";
import { recallText } from "./helpers/recall.mjs";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";
import { Mnemora } from "../dist/tools.js";

const filler = "We also talked about the weather, groceries, a new podcast, my neighbour's dog, the commute, and what to cook for dinner on the weekend with friends.";
const sessions = [
  ["I went on a camping trip to Yosemite with my brother last month.", "That sounds great."],
  ["My camping trip to Big Sur was rainy but fun.", "Glad you enjoyed it."],
  ...Array.from({ length: 8 }, (_, index) => [`${filler} ${filler} By the way I need a new tent for camping someday, maybe. Item ${index}.`, "Noted."]),
  ...Array.from({ length: 10 }, (_, index) => [`Unrelated chat number ${index} about spreadsheets and quarterly budgets.`, "Sure."])
];

async function recall(prompt, unifiedRetrieval) {
  const directory = createTempDir("mnemora-adaptive-fill-");
  const config = normalizeConfig({ dbPath: join(directory, "m.db"), mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, unifiedRetrieval: { enabled: true, shadowMode: false, maxItems: 20, ...unifiedRetrieval } });
  const leave = enterDeterministic("adaptive-fill", Date.UTC(2024, 1, 1));
  const graph = new Mnemora({ config });
  const shared = new Proxy(graph, { get: (target, property) => property === "close" ? () => undefined : Reflect.get(target, property, target) });
  try {
    const engine = new MnemoraContextEngine(config, () => shared);
    let at = Date.UTC(2024, 0, 1);
    for (const [index, [user, assistant]] of sessions.entries()) await engine.ingestBatch({ sessionId: `s${index}`, messages: [{ role: "user", content: user, timestamp: at += 3_600_000 }, { role: "assistant", content: assistant, timestamp: at += 1000 }] });
    const text = recallText(await engine.assemble({ sessionId: "query", prompt, messages: [{ role: "user", content: prompt }], tokenBudget: 16000 })) ?? "";
    return [...text.matchAll(/^\[\d+\] ref=(\S+?);/gmu)].map(match => match[1]);
  } finally { graph.close(); leave(); }
}

test("a large budget fills an open packet with anchored below-floor records after the admitted ones", async () => {
  const prompt = "How many camping trips did I go on?";
  const admitted = await recall(prompt, { tokenBudget: 4000, adaptiveFill: false });
  const filled = await recall(prompt, { tokenBudget: 4000 });
  assert.ok(admitted.length >= 1);
  assert.ok(filled.length > admitted.length, `fill adds records (${admitted.length} -> ${filled.length})`);
  assert.deepEqual(filled.slice(0, admitted.length), admitted, "admitted records keep their place, fill comes after");
});

test("the default budget is unchanged by adaptive fill", async () => {
  const prompt = "How many camping trips did I go on?";
  assert.deepEqual(await recall(prompt, { tokenBudget: 800 }), await recall(prompt, { tokenBudget: 800, adaptiveFill: false }));
});

test("adaptive fill never opens a packet for an unrelated prompt", async () => {
  for (const prompt of ["hello", "Write a Python function that reverses a linked list."])
    assert.deepEqual(await recall(prompt, { tokenBudget: 4000 }), [], prompt);
});

test("adaptiveFill defaults on and can be turned off", () => {
  assert.equal(normalizeConfig({}).unifiedRetrieval.adaptiveFill, true);
  assert.equal(normalizeConfig({ unifiedRetrieval: { adaptiveFill: false } }).unifiedRetrieval.adaptiveFill, false);
});
