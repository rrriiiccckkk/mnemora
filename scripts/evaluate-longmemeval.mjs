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
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createTempDir } from "../tests/helpers/temp.mjs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";
import { Mnemora } from "../dist/tools.js";
import { recallText } from "../tests/helpers/recall.mjs";

const [datasetPath, rangeArgument, outPath] = process.argv.slice(2);
if (!datasetPath) throw new Error("usage: evaluate-longmemeval.mjs <longmemeval_s_cleaned.json> [limit|start:end] [out.jsonl]");
const raw = readFileSync(datasetPath);
// Plain or gzip-compressed JSON (the Chinese LongMemEval translations ship as .json.gz).
const all = JSON.parse((datasetPath.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"));
const [rangeStart, rangeEnd] = String(rangeArgument ?? "").includes(":") ? String(rangeArgument).split(":").map(Number) : [0, Number(rangeArgument ?? Infinity) || all.length];
const data = all.slice(rangeStart, rangeEnd);
// Negative probes measure false attachment: a question taken from another
// item (its evidence is absent from this haystack) and an unrelated task.
// Optional semantic recall: MNEMORA_EVAL_EMBED_MODEL=<ollama model> [MNEMORA_EVAL_EMBED_URL=http://127.0.0.1:11434]
const EMBEDDINGS = process.env.MNEMORA_EVAL_EMBED_MODEL ? { embeddings: { enabled: true, provider: "ollama", baseURL: process.env.MNEMORA_EVAL_EMBED_URL ?? "http://127.0.0.1:11434", model: process.env.MNEMORA_EVAL_EMBED_MODEL, timeoutMs: 120000, batchSize: 32 } } : {};
// Threshold overrides for calibration: MNEMORA_EVAL_MIN_SIMILARITY, MNEMORA_EVAL_GATE_SIMILARITY.
const SEMANTIC_THRESHOLDS = { ...(process.env.MNEMORA_EVAL_MIN_SIMILARITY ? { minSimilarity: Number(process.env.MNEMORA_EVAL_MIN_SIMILARITY) } : {}), ...(process.env.MNEMORA_EVAL_GATE_SIMILARITY ? { gateSimilarity: Number(process.env.MNEMORA_EVAL_GATE_SIMILARITY) } : {}) };
const OFF_TOPIC = ["Write a Python function that reverses a linked list.", "What's the capital of Australia?", "Fix the failing unit test in the payment service.", "hello", "Translate this paragraph into French for me.", "Explain how TCP congestion control works.", "Draft a polite email declining a meeting invitation.", "What is 17 times 23?", "Summarize the main ideas of stoicism.", "Generate a regex that matches IPv4 addresses.", "Can you refactor this function to be async?", "Give me three name ideas for a coffee shop.", "How do I center a div in CSS?", "Write a haiku about autumn."];
// Off-topic prompts in the dataset's language: Chinese when the question has Han characters.
const OFF_TOPIC_ZH = ["写一个反转链表的 Python 函数。", "澳大利亚的首都是哪里？", "修复支付服务里失败的单元测试。", "你好", "把这段话翻译成法语。", "解释一下 TCP 拥塞控制是怎么工作的。", "帮我写一封礼貌拒绝会议邀请的邮件。", "17 乘以 23 等于多少？", "总结一下斯多葛主义的主要思想。", "写一个匹配邮箱地址的正则表达式。"];
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

const totals = { questions: 0, answerable: 0, abstention: 0, mnemora: { sessionHit: 0, turnHit: 0, empty: 0, abstentionInjected: 0, tokens: 0, foreignQuestionInjected: 0, offTopicInjected: 0 }, bm25: { sessionHit: 0, turnHit: 0 } };
for (const [offset, question] of data.entries()) {
  const index = rangeStart + offset;
  const directory = createTempDir("mnemora-lme-");
  const config = normalizeConfig({ dbPath: join(directory, "m.db"), mode: "standalone", ...EMBEDDINGS, conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, unifiedRetrieval: { enabled: true, shadowMode: false, tokenBudget: BUDGET, maxItems: MAX_ITEMS, diversityLambda: .75, ...(EMBEDDINGS.embeddings ? { semantic: { embedPerTurn: 1000, ...SEMANTIC_THRESHOLDS } } : {}) } });
  const graph = new Mnemora({ config });
  const shared = new Proxy(graph, { get: (target, property) => property === "close" ? () => undefined : Reflect.get(target, property, target) });
  try {
    const engine = new MnemoraContextEngine(config, () => shared);
    for (let index = 0; index < question.haystack_sessions.length; index++) await engine.ingestBatch({ sessionId: question.haystack_session_ids[index], messages: question.haystack_sessions[index].map(message => ({ role: message.role, content: message.content })) });
    const ask = async prompt => recallText(await engine.assemble({ sessionId: "query-session", prompt, messages: [{ role: "user", content: prompt }], tokenBudget: 16000 })) ?? "";
    const rendered = await ask(question.question);
    const foreignInjected = Boolean(await ask(all[(index + 167) % all.length].question));
    const offTopics = /\p{Script=Han}/u.test(question.question) ? OFF_TOPIC_ZH : OFF_TOPIC;
    const offTopicInjected = Boolean(await ask(offTopics[index % offTopics.length]));
    totals.mnemora.foreignQuestionInjected += Number(foreignInjected);
    totals.mnemora.offTopicInjected += Number(offTopicInjected);
    const rows = graph.store.db.prepare("SELECT id, session_id FROM mnemora_conversation_events ORDER BY session_id, sequence").all();
    const position = new Map(); const counters = new Map();
    for (const row of rows) { const turn = counters.get(row.session_id) ?? 0; counters.set(row.session_id, turn + 1); position.set(row.id, `${row.session_id}#${turn}`); }
    const ids = [...rendered.matchAll(/(?:^\[\d+\] ref=|^provenance_refs=)([^\s;]+)/gmu)].flatMap(match => match[1].split(",")).map(value => value.replace(/[;,]+$/u, "").split("/").pop());
    const items = [...new Set(ids)].map(id => position.get(id)).filter(Boolean);
    const gold = new Set(question.answer_session_ids);
    const goldTurns = new Set(question.haystack_sessions.flatMap((session, index) => session.map((message, turn) => message.has_answer ? `${question.haystack_session_ids[index]}#${turn}` : null)).filter(Boolean));
    const baseline = bm25Baseline(question);
    const abstention = question.question_id.endsWith("_abs");
    const record = { qid: question.question_id, type: question.question_type, abstention, mnemora: items, bm25: baseline, tokens: estimate(rendered), foreignInjected, offTopicInjected };
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
  benchmark: "longmemeval-s-retrieval-v2", questions: totals.questions, answerable: totals.answerable, budgetTokens: BUDGET, maxItems: MAX_ITEMS,
  mnemora: { sessionHitPct: pct(totals.mnemora.sessionHit), turnHitPct: pct(totals.mnemora.turnHit), emptyPct: pct(totals.mnemora.empty), meanTokens: totals.answerable ? Math.round(totals.mnemora.tokens / totals.answerable) : 0, abstentionInjectedPct: totals.abstention ? Math.round(1000 * totals.mnemora.abstentionInjected / totals.abstention) / 10 : 0, foreignQuestionInjectedPct: totals.questions ? Math.round(1000 * totals.mnemora.foreignQuestionInjected / totals.questions) / 10 : 0, offTopicInjectedPct: totals.questions ? Math.round(1000 * totals.mnemora.offTopicInjected / totals.questions) / 10 : 0 },
  bm25Baseline: { sessionHitPct: pct(totals.bm25.sessionHit), turnHitPct: pct(totals.bm25.turnHit) }
}, null, 2));
