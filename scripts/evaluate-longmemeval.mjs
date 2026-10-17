// Retrieval-level LongMemEval evaluation of the automatic recall path.
//
// For every question a fresh database receives the haystack sessions through
// MnemoraContextEngine.ingestBatch(); assemble() is then called with the
// question and the rendered provenance refs are mapped back to sessions and
// turns. A same-budget SQLite FTS5 bm25 baseline runs on identical messages.
//
// Usage:
//   curl -L -o /tmp/longmemeval_s_cleaned.json \
//     https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
//   npm run build
//   node --expose-gc scripts/evaluate-longmemeval.mjs /tmp/longmemeval_s_cleaned.json [limit] [out.jsonl]
//
// The process prints one JSON summary. No model calls are made.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";
import { Mnemora } from "../dist/tools.js";

const [datasetPath, limitArgument, outPath] = process.argv.slice(2);
if (!datasetPath) throw new Error("usage: evaluate-longmemeval.mjs <longmemeval_s_cleaned.json> [limit] [out.jsonl]");
const data = JSON.parse(readFileSync(datasetPath, "utf8")).slice(0, Number(limitArgument ?? Infinity) || undefined);
if (outPath) writeFileSync(outPath, "");
const BUDGET = 800, MAX_ITEMS = 8;
const STOP = new Set("a an the and or but if of to in on at for with from by about as is are was were be been being do does did have has had i me my mine you your we our they them their it its this that these those what which who whom when where why how can could would should will shall may might must there here so than too very just also any some all not no yes up down out over under again then once into onto".split(" "));
const estimate = value => Math.ceil(value.length / 4);

function bm25Baseline(question) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(content, sid UNINDEXED, turn UNINDEXED, tokenize='porter')");
  const insert = db.prepare("INSERT INTO t(content,sid,turn) VALUES(?,?,?)");
  question.haystack_sessions.forEach((session, index) => session.forEach((message, turn) => insert.run(message.content, question.haystack_session_ids[index], turn)));
  const terms = [...new Set((question.question.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(word => word.length > 1 && !STOP.has(word)))];
  const items = []; let used = 0;
  if (terms.length) for (const row of db.prepare("SELECT sid, turn, content FROM t WHERE t MATCH ? ORDER BY bm25(t) LIMIT 200").all(terms.map(term => `"${term}"`).join(" OR "))) {
    const cost = estimate(row.content) + 20;
    if (items.length >= MAX_ITEMS) break;
    if (used + cost > BUDGET) continue;
    items.push(`${row.sid}#${row.turn}`); used += cost;
  }
  db.close();
  return items;
}

const totals = { questions: 0, answerable: 0, abstention: 0, mnemora: { sessionHit: 0, turnHit: 0, empty: 0, abstentionInjected: 0, tokens: 0 }, bm25: { sessionHit: 0, turnHit: 0 } };
for (const question of data) {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-lme-"));
  const config = normalizeConfig({ dbPath: join(directory, "m.db"), mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, unifiedRetrieval: { enabled: true, shadowMode: false, tokenBudget: BUDGET, maxItems: MAX_ITEMS, diversityLambda: .75 } });
  const graph = new Mnemora({ config });
  const shared = new Proxy(graph, { get: (target, property) => property === "close" ? () => undefined : Reflect.get(target, property, target) });
  try {
    const engine = new MnemoraContextEngine(config, () => shared);
    for (let index = 0; index < question.haystack_sessions.length; index++) await engine.ingestBatch({ sessionId: question.haystack_session_ids[index], messages: question.haystack_sessions[index].map(message => ({ role: message.role, content: message.content })) });
    const rendered = (await engine.assemble({ sessionId: "query-session", prompt: question.question, messages: [{ role: "user", content: question.question }], tokenBudget: 16000 })).systemPromptAddition ?? "";
    const rows = graph.store.db.prepare("SELECT id, session_id FROM mnemora_conversation_events ORDER BY session_id, sequence").all();
    const position = new Map(); const counters = new Map();
    for (const row of rows) { const turn = counters.get(row.session_id) ?? 0; counters.set(row.session_id, turn + 1); position.set(row.id, `${row.session_id}#${turn}`); }
    const ids = [...rendered.matchAll(/provenance_refs=(\S+)/gu)].flatMap(match => match[1].replace(/;$/u, "").split(",")).map(value => value.replace(/[;,]+$/u, "").split("/").pop());
    const items = [...new Set(ids)].map(id => position.get(id)).filter(Boolean);
    const gold = new Set(question.answer_session_ids);
    const goldTurns = new Set(question.haystack_sessions.flatMap((session, index) => session.map((message, turn) => message.has_answer ? `${question.haystack_session_ids[index]}#${turn}` : null)).filter(Boolean));
    const baseline = bm25Baseline(question);
    const abstention = question.question_id.endsWith("_abs");
    const record = { qid: question.question_id, type: question.question_type, abstention, mnemora: items, bm25: baseline, tokens: estimate(rendered) };
    totals.questions++;
    if (abstention) { totals.abstention++; if (items.length) totals.mnemora.abstentionInjected++; }
    else {
      totals.answerable++;
      if (items.some(item => gold.has(item.split("#")[0]))) totals.mnemora.sessionHit++;
      if (items.some(item => goldTurns.has(item))) totals.mnemora.turnHit++;
      if (!items.length) totals.mnemora.empty++;
      if (baseline.some(item => gold.has(item.split("#")[0]))) totals.bm25.sessionHit++;
      if (baseline.some(item => goldTurns.has(item))) totals.bm25.turnHit++;
      totals.mnemora.tokens += record.tokens;
    }
    if (outPath) appendFileSync(outPath, `${JSON.stringify(record)}\n`);
  } finally {
    graph.close(); globalThis.gc?.(); await new Promise(resolve => setTimeout(resolve, 10));
    rmSync(directory, { recursive: true, force: true });
  }
}
const pct = value => totals.answerable ? Math.round(1000 * value / totals.answerable) / 10 : 0;
console.log(JSON.stringify({
  benchmark: "longmemeval-s-retrieval-v1", questions: totals.questions, answerable: totals.answerable, budgetTokens: BUDGET, maxItems: MAX_ITEMS,
  mnemora: { sessionHitPct: pct(totals.mnemora.sessionHit), turnHitPct: pct(totals.mnemora.turnHit), emptyPct: pct(totals.mnemora.empty), meanTokens: totals.answerable ? Math.round(totals.mnemora.tokens / totals.answerable) : 0, abstentionInjected: totals.abstention ? Math.round(1000 * totals.mnemora.abstentionInjected / totals.abstention) / 10 : 0 },
  bm25Baseline: { sessionHitPct: pct(totals.bm25.sessionHit), turnHitPct: pct(totals.bm25.turnHit) }
}, null, 2));
