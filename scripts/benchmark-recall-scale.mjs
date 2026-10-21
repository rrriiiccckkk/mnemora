// Automatic-recall latency and memory at scale: one scope with N conversation
// turns (synthetic, deterministic: a Zipf vocabulary with recurring topics,
// names and numbers), then assemble() for a fixed set of prompts at the
// default budget (800 tokens, 8 records) and a fill budget (4000, 20).
// Reports ingestion rate, recall p50/p95/max, heap and RSS, database size.
//
// Usage:
//   npm run build
//   node --expose-gc scripts/benchmark-recall-scale.mjs [turns...]   # default 10000 50000 100000
// Not part of CI: wall-clock numbers depend on the machine.
import { statSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../tests/helpers/temp.mjs";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";
import { Mnemora } from "../dist/tools.js";

const sizes = process.argv.slice(2).map(Number).filter(Number.isFinite);
const SIZES = sizes.length ? sizes : [10_000, 50_000, 100_000];

let seed = 42;
const random = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = values => values[Math.floor(random() * values.length)];
const common = "the a to and of I my it is in for that was on with this have just so but at be we can about some like really get when out what up think time".split(" ");
const topics = ["camping trip", "mortgage", "guitar lessons", "wedding", "marathon training", "sourdough bread", "Instagram followers", "coin collection", "kitchen renovation", "job interview", "piano recital", "road trip", "yoga class", "book club", "car repair", "vegetable garden", "photography lens", "museum visit", "flight to Tokyo", "dentist appointment"];
const names = ["Emily", "Tom", "Rachel", "Alex", "Priya", "Marco", "Sofia", "Daniel", "Mei", "Lucas"];
const zipf = Array.from({ length: 4000 }, (_, i) => `w${i.toString(36)}`);
const word = () => random() < .55 ? pick(common) : zipf[Math.floor(zipf.length * random() ** 3)];
function userTurn() {
  const topic = pick(topics), filler = Array.from({ length: 12 + Math.floor(random() * 30) }, word).join(" ");
  return `${filler}. By the way, about my ${topic}: ${pick(names)} said it cost $${Math.floor(random() * 900) + 10} and took ${Math.floor(random() * 12) + 1} hours. ${Array.from({ length: 8 }, word).join(" ")}.`;
}
const assistantTurn = () => `${Array.from({ length: 60 + Math.floor(random() * 120) }, word).join(" ")}.`;
const PROMPTS = ["How much did my camping trip cost?", "What did Emily say about the wedding?", "How many hours did the kitchen renovation take?", "When is my dentist appointment?", "How many guitar lessons have I had in total?", "hello", "Write a Python function that reverses a linked list.", "What did Rachel tell me about the flight to Tokyo?", "How many Instagram followers do I have now?", "What lens did I buy for photography?"];

const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; };
const mb = bytes => Math.round(bytes / 1048576);

for (const turns of SIZES) {
  seed = 42;
  const directory = createTempDir("mnemora-recall-scale-"), dbPath = join(directory, "m.db");
  const config = normalizeConfig({ dbPath, mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, unifiedRetrieval: { enabled: true, shadowMode: false } });
  const graph = new Mnemora({ config });
  const shared = new Proxy(graph, { get: (target, property) => property === "close" ? () => undefined : Reflect.get(target, property, target) });
  try {
    const engine = new MnemoraContextEngine(config, () => shared);
    const start = performance.now();
    let at = Date.UTC(2024, 0, 1);
    for (let done = 0, session = 0; done < turns; session++) {
      const messages = [];
      for (let k = 0; k < 10 && done < turns; k++, done++) messages.push({ role: k % 2 ? "assistant" : "user", content: k % 2 ? assistantTurn() : userTurn(), timestamp: at += 30_000 });
      await engine.ingestBatch({ sessionId: `s${session}`, messages });
      at += 6 * 3_600_000;
    }
    const ingestMs = performance.now() - start;
    const result = { turns, ingest_turns_per_second: Math.round(turns / (ingestMs / 1000)), db_mb: mb(statSync(dbPath).size + (statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0)) };
    for (const [budget, maxItems] of [[800, 8], [4000, 20]]) {
      config.unifiedRetrieval.tokenBudget = budget; config.unifiedRetrieval.maxItems = maxItems;
      const times = [];
      for (let round = 0; round < 3; round++) for (const prompt of PROMPTS) {
        const t0 = performance.now();
        await engine.assemble({ sessionId: "bench-query", prompt, messages: [{ role: "user", content: prompt }], tokenBudget: 16000 });
        if (round > 0) times.push(performance.now() - t0); // round 0 warms caches
      }
      result[`recall_${budget}`] = { p50_ms: Math.round(percentile(times, .5)), p95_ms: Math.round(percentile(times, .95)), max_ms: Math.round(Math.max(...times)) };
    }
    globalThis.gc?.();
    const memory = process.memoryUsage();
    result.heap_mb = mb(memory.heapUsed); result.rss_mb = mb(memory.rss);
    console.log(JSON.stringify(result));
  } finally { graph.close(); }
}
