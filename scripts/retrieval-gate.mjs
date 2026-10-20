// Retrieval regression gate: a fixed LongMemEval_S subset through the
// automatic recall path, lexical only, no model calls, deterministic.
//
// Each question gets a fresh database fed its haystack sessions at their
// dataset dates, with the clock at the question date (as in
// evaluate-longmemeval-qa.mjs). Three prompts are assembled: the question,
// a question from another item (its evidence is not in this haystack) and an
// unrelated task. Evidence recall counts questions whose packet holds all (or
// any) evidence sessions; wrong attachment counts the records attached to the
// other two prompts and to unanswerable questions. Lexical recall attaches
// something to most such prompts on this dataset (generic chat matches
// "hello"), so records are counted rather than packets. The gate fails when
// evidence recall drops or wrong attachment rises beyond the tolerance.
//
// Usage:
//   npm run build
//   node --expose-gc scripts/retrieval-gate.mjs <longmemeval_s_cleaned.json>            # check
//   node --expose-gc scripts/retrieval-gate.mjs <longmemeval_s_cleaned.json> --update   # rewrite baseline
//   ... --baseline eval/retrieval-gate/baseline-4000.json   # another budget (adaptive fill)
//   ... --no-adaptive-fill                                  # A/B: turn adaptive fill off
//
// The dataset (MIT, xiaowu0162/longmemeval-cleaned) is not in the repository;
// the baseline pins its revision and sha256, and the script refuses others.
process.env.TZ = "UTC"; // relative-date notes use local calendar days
import { enterDeterministic } from "./lib/deterministic.mjs";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { createTempDir } = await import("../tests/helpers/temp.mjs");
const { recallText } = await import("../tests/helpers/recall.mjs");
const { MnemoraContextEngine } = await import("../dist/context-engine/engine.js");
const { normalizeConfig } = await import("../dist/config.js");
const { Mnemora } = await import("../dist/tools.js");

const [datasetPath, ...flags] = process.argv.slice(2);
if (!datasetPath) throw new Error("usage: retrieval-gate.mjs <longmemeval_s_cleaned.json> [--update] [--baseline <file>] [--no-adaptive-fill]");
const update = flags.includes("--update"), adaptiveFill = !flags.includes("--no-adaptive-fill");
const baselineFlag = flags.indexOf("--baseline");
const BASELINE = baselineFlag >= 0 && flags[baselineFlag + 1] ? new URL(flags[baselineFlag + 1], `file://${process.cwd()}/`) : new URL("../eval/retrieval-gate/baseline.json", import.meta.url);
const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

const digest = await new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(datasetPath).on("data", chunk => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
});
if (digest !== baseline.dataset.sha256) throw new Error(`dataset sha256 ${digest} does not match the pinned ${baseline.dataset.sha256} (${baseline.dataset.url})`);

const all = JSON.parse(readFileSync(datasetPath, "utf8"));
const byId = new Map(all.map((question, index) => [question.question_id, { question, index }]));
const OFF_TOPIC = ["Write a Python function that reverses a linked list.", "What's the capital of Australia?", "Fix the failing unit test in the payment service.", "hello", "Translate this paragraph into French for me.", "Explain how TCP congestion control works."];

/** "2023/05/20 (Sat) 02:21" → epoch ms (UTC; the dataset has no zone). */
function datasetTime(value) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \(\w+\) (\d{2}):(\d{2})$/u.exec(String(value));
  if (!match) throw new Error(`bad dataset date: ${value}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
}

async function evaluate(question, index) {
  const leave = enterDeterministic(question.question_id, datasetTime(question.question_date));
  const directory = createTempDir("mnemora-gate-");
  const config = normalizeConfig({ dbPath: join(directory, "m.db"), mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, unifiedRetrieval: { enabled: true, shadowMode: false, tokenBudget: baseline.budgetTokens, maxItems: baseline.maxItems, diversityLambda: .75, adaptiveFill } });
  const graph = new Mnemora({ config });
  const shared = new Proxy(graph, { get: (target, property) => property === "close" ? () => undefined : Reflect.get(target, property, target) });
  try {
    const engine = new MnemoraContextEngine(config, () => shared);
    for (let session = 0; session < question.haystack_sessions.length; session++) {
      const at = datasetTime(question.haystack_dates[session]);
      await engine.ingestBatch({ sessionId: question.haystack_session_ids[session], messages: question.haystack_sessions[session].map((message, turn) => ({ role: message.role, content: message.content, timestamp: at + turn * 1000 })) });
    }
    const sessionOf = new Map(graph.store.db.prepare("SELECT id, session_id FROM mnemora_conversation_events").all().map(row => [row.id, row.session_id]));
    const ask = async prompt => recallText(await engine.assemble({ sessionId: "query-session", prompt, messages: [{ role: "user", content: prompt }], tokenBudget: 16000 })) ?? "";
    const sessions = packet => [...new Set([...packet.matchAll(/(?:^\[\d+\] ref=|^provenance_refs=)([^\s;]+)/gmu)].flatMap(match => match[1].split(",")).map(value => sessionOf.get(value.replace(/[;,]+$/u, "").split("/").pop())).filter(Boolean))];
    const items = packet => [...packet.matchAll(/^\[\d+\] ref=/gmu)].length;
    const packet = await ask(question.question), found = sessions(packet);
    const gold = question.answer_session_ids;
    return {
      ...(question.question_id.endsWith("_abs")
        ? { abstentionItems: items(packet) }
        : { allEvidence: gold.every(id => found.includes(id)), anyEvidence: gold.some(id => found.includes(id)) }),
      foreignItems: items(await ask(all[(index + 167) % all.length].question)),
      offTopicItems: items(await ask(OFF_TOPIC[index % OFF_TOPIC.length])),
    };
  } finally {
    graph.close(); leave(); globalThis.gc?.();
    rmSync(directory, { recursive: true, force: true });
  }
}

const METRICS = { allEvidence: "higher", anyEvidence: "higher", abstentionItems: "lower", foreignItems: "lower", offTopicItems: "lower" };
const totals = results => Object.fromEntries(Object.keys(METRICS).map(metric => [metric, Object.values(results).reduce((sum, result) => sum + Number(result[metric] ?? 0), 0)]));

const started = Date.now();
const results = {};
for (const qid of baseline.questions) {
  const entry = byId.get(qid);
  if (!entry) throw new Error(`question ${qid} is not in the dataset`);
  results[qid] = await evaluate(entry.question, entry.index);
}
const now = totals(results), before = totals(baseline.results ?? {});
const seconds = Math.round((Date.now() - started) / 1000);

if (update) {
  writeFileSync(BASELINE, `${JSON.stringify({ ...baseline, totals: now, results }, null, 2)}\n`);
  console.log(JSON.stringify({ updated: true, questions: baseline.questions.length, totals: now, seconds }, null, 2));
  process.exit(0);
}

const failures = [], changes = [];
for (const [metric, direction] of Object.entries(METRICS)) {
  const worse = direction === "higher" ? before[metric] - now[metric] : now[metric] - before[metric];
  if (worse > baseline.tolerance[metric]) failures.push(`${metric}: ${before[metric]} -> ${now[metric]} (tolerance ${baseline.tolerance[metric]})`);
}
for (const qid of baseline.questions) for (const metric of Object.keys(METRICS)) {
  const was = baseline.results?.[qid]?.[metric], is = results[qid][metric];
  if (was !== undefined && was !== is) changes.push(`${qid} ${metric}: ${was} -> ${is}`);
}
console.log(JSON.stringify({ questions: baseline.questions.length, baseline: before, current: now, changed: changes, seconds }, null, 2));
if (failures.length) {
  console.error(`retrieval gate failed:\n  ${failures.join("\n  ")}\nIf the change is intended, rerun with --update and commit the baseline file.`);
  process.exit(1);
}
console.log("retrieval gate ok");
