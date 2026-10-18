// End-to-end LongMemEval_S evaluation: a reading model answers each question
// with (a) no memory, (b) a same-budget bm25 baseline, (c) Mnemora's automatic
// recall, and a judge model grades each answer with the official LongMemEval
// prompts (evaluate_qa.py).
//
// Two phases, so the slow local part and the paid API part are separable and
// the API part is resumable:
//
//   node --expose-gc scripts/evaluate-longmemeval-qa.mjs contexts <data.json> <start:end> <contexts.jsonl>
//   MNEMORA_QA_BASE_URL=https://api.example.com/v1 MNEMORA_QA_MODEL=<model> [MNEMORA_QA_API_KEY=…] \
//     node scripts/evaluate-longmemeval-qa.mjs answer <contexts.jsonl> <answers.jsonl> [maxSeconds]
//   node scripts/evaluate-longmemeval-qa.mjs report <answers.jsonl>
//
// Haystack sessions are ingested with their dataset timestamps, and each
// question runs with the clock set to its question date. The API key is
// read from MNEMORA_QA_API_KEY only (or injected by an HTTPS proxy) and is
// never written to any output. Outputs contain model answers and verdicts.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTempDir } from "../tests/helpers/temp.mjs";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";
import { Mnemora } from "../dist/tools.js";

const BUDGET = 800, MAX_ITEMS = 8;
const [mode, ...args] = process.argv.slice(2);
const estimate = value => Math.ceil(value.length / 4);
const lines = path => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

/** "2023/05/20 (Sat) 02:21" → epoch ms (UTC; the dataset has no zone). */
function datasetTime(value) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \(\w+\) (\d{2}):(\d{2})$/u.exec(String(value));
  if (!match) throw new Error(`bad dataset date: ${value}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
}
const isoMinute = ms => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

const STOP = new Set("a an the and or but if of to in on at for with from by about as is are was were be been being do does did have has had i me my mine you your we our they them their it its this that these those what which who whom when where why how can could would should will shall may might must not no yes so than then there here just also very much many more most some any all each every other such only own same too s t don now".split(" "));
function bm25Context(question) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE t USING fts5(content, sid UNINDEXED, turn UNINDEXED, at UNINDEXED, role UNINDEXED, tokenize='porter')");
  const insert = db.prepare("INSERT INTO t(content,sid,turn,at,role) VALUES(?,?,?,?,?)");
  question.haystack_sessions.forEach((session, index) => session.forEach((message, turn) => insert.run(message.content, question.haystack_session_ids[index], turn, datasetTime(question.haystack_dates[index]) + turn * 1000, message.role)));
  const terms = [...new Set((question.question.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(word => word.length > 1 && !STOP.has(word)))];
  const blocks = []; let used = 0;
  if (terms.length) for (const row of db.prepare("SELECT sid, turn, at, role, content FROM t WHERE t MATCH ? ORDER BY bm25(t) LIMIT 200").all(terms.map(term => `"${term}"`).join(" OR "))) {
    const block = `[${blocks.length + 1}] ${isoMinute(Number(row.at))} ${row.role}: ${row.content}`;
    const cost = estimate(block);
    if (blocks.length >= MAX_ITEMS) break;
    if (used + cost > BUDGET) continue;
    blocks.push(block); used += cost;
  }
  db.close();
  return blocks.join("\n\n");
}

async function contexts([datasetPath, range, outPath]) {
  const all = JSON.parse(readFileSync(datasetPath, "utf8"));
  const [start, end] = String(range ?? `0:${all.length}`).split(":").map(Number);
  const done = new Set(lines(outPath).map(row => row.qid));
  for (const question of all.slice(start, end)) {
    if (done.has(question.question_id)) continue;
    // Run each question on its own clock: "now" is the question date, so record
    // age (freshness) is what it would have been when the user asked.
    const realNow = Date.now, started = realNow(), asked = datasetTime(question.question_date);
    Date.now = () => asked + (realNow() - started);
    const directory = createTempDir("mnemora-lme-qa-");
    const config = normalizeConfig({ dbPath: join(directory, "m.db"), mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, unifiedRetrieval: { enabled: true, shadowMode: false, tokenBudget: BUDGET, maxItems: MAX_ITEMS, diversityLambda: .75 } });
    const graph = new Mnemora({ config });
    const shared = new Proxy(graph, { get: (target, property) => property === "close" ? () => undefined : Reflect.get(target, property, target) });
    try {
      const engine = new MnemoraContextEngine(config, () => shared);
      for (let index = 0; index < question.haystack_sessions.length; index++) {
        const at = datasetTime(question.haystack_dates[index]);
        await engine.ingestBatch({ sessionId: question.haystack_session_ids[index], messages: question.haystack_sessions[index].map((message, turn) => ({ role: message.role, content: message.content, timestamp: at + turn * 1000 })) });
      }
      const mnemora = (await engine.assemble({ sessionId: "query-session", prompt: question.question, messages: [{ role: "user", content: question.question }], tokenBudget: 16000 })).systemPromptAddition ?? "";
      appendFileSync(outPath, `${JSON.stringify({ qid: question.question_id, type: question.question_type, abstention: question.question_id.endsWith("_abs"), question: question.question, question_date: question.question_date, answer: String(question.answer), contexts: { none: "", bm25: bm25Context(question), mnemora } })}\n`);
    } finally {
      graph.close(); globalThis.gc?.(); await new Promise(resolve => setTimeout(resolve, 10));
      rmSync(directory, { recursive: true, force: true });
      Date.now = realNow;
    }
  }
}

// Reader prompt follows LongMemEval's generation template; the memory block is
// the only difference between arms.
function readerPrompt(row, arm) {
  const memory = row.contexts[arm];
  const history = arm === "none" ? "(no chat history available)" : memory || "(nothing relevant was retrieved)";
  return `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer concisely. If the history does not contain the information needed, say so.\n\n\nHistory Chats:\n\n${history}\n\nCurrent Date: ${row.question_date}\nQuestion: ${row.question}\nAnswer:`;
}
function judgePrompt(row, response) {
  const base = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.";
  if (row.abstention) return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${row.question}\n\nExplanation: ${row.answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  if (row.type === "temporal-reasoning") return `${base} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${row.question}\n\nCorrect Answer: ${row.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (row.type === "knowledge-update") return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${row.question}\n\nCorrect Answer: ${row.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (row.type === "single-session-preference") return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${row.question}\n\nRubric: ${row.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  return `${base} \n\nQuestion: ${row.question}\n\nCorrect Answer: ${row.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
}

const PROVIDER_REFUSAL = /^the request was rejected because it was considered high risk/iu;
const BASE_URL = (process.env.MNEMORA_QA_BASE_URL ?? "").replace(/\/+$/u, "");
const MODEL = process.env.MNEMORA_QA_MODEL ?? "", JUDGE = process.env.MNEMORA_QA_JUDGE_MODEL ?? MODEL;
const usage = { prompt: 0, completion: 0, calls: 0 };
async function chat(model, content, maxTokens) {
  const headers = { "content-type": "application/json", ...(process.env.MNEMORA_QA_API_KEY ? { authorization: `Bearer ${process.env.MNEMORA_QA_API_KEY}` } : {}) };
  const body = JSON.stringify({ model, messages: [{ role: "user", content }], max_completion_tokens: maxTokens, temperature: 0, ...(process.env.MNEMORA_QA_THINKING === "enabled" ? {} : { thinking: { type: "disabled" } }) });
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    try {
      const response = await fetch(`${BASE_URL}/chat/completions`, { method: "POST", headers, body, signal: AbortSignal.timeout(120_000) });
      status = response.status;
      if (response.ok) {
        const json = await response.json();
        usage.prompt += json.usage?.prompt_tokens ?? 0; usage.completion += json.usage?.completion_tokens ?? 0; usage.calls++;
        return String(json.choices?.[0]?.message?.content ?? "").trim();
      }
      if (status !== 429 && status < 500) throw new Error(`http_${status}`);
    } catch (error) { if (String(error?.message).startsWith("http_") || attempt >= 4) throw error; }
    if (attempt >= 4) throw new Error(`http_${status}`);
    await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** attempt));
  }
}

async function answer([contextsPath, outPath, maxSeconds]) {
  if (!BASE_URL || !MODEL) throw new Error("set MNEMORA_QA_BASE_URL and MNEMORA_QA_MODEL");
  const arms = (process.env.MNEMORA_QA_ARMS ?? "none,bm25,mnemora").split(",");
  const deadline = Date.now() + 1000 * Number(maxSeconds ?? 3600);
  const done = new Set(lines(outPath).map(row => `${row.qid}|${row.arm}`));
  const jobs = lines(contextsPath).flatMap(row => arms.filter(arm => !done.has(`${row.qid}|${arm}`)).map(arm => ({ row, arm })));
  const concurrency = Math.max(1, Math.min(16, Number(process.env.MNEMORA_QA_CONCURRENCY ?? 4)));
  let next = 0, failed = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length && Date.now() < deadline) {
      const { row, arm } = jobs[next++];
      try {
        const response = await chat(MODEL, readerPrompt(row, arm), 300);
        // A provider safety refusal is not an answer; leave the job for a rerun.
        if (PROVIDER_REFUSAL.test(response)) throw new Error("provider_refusal");
        const verdict = await chat(JUDGE, judgePrompt(row, response), 8);
        appendFileSync(outPath, `${JSON.stringify({ qid: row.qid, type: row.type, abstention: row.abstention, arm, contextTokens: estimate(row.contexts[arm]), response, correct: /^\W*yes/iu.test(verdict) })}\n`);
      } catch (error) { failed++; if (failed > 20) throw new Error(`too many API failures: ${error.message}`); }
    }
  }));
  console.log(JSON.stringify({ remaining: Math.max(0, jobs.length - next), failed, usage }));
}

function report([answersPath]) {
  const rows = lines(answersPath);
  const result = {};
  for (const row of rows) {
    for (const group of ["ALL", row.abstention ? "abstention" : row.type]) {
      const cell = ((result[group] ??= {})[row.arm] ??= { n: 0, correct: 0, tokens: 0 });
      cell.n++; cell.correct += Number(row.correct); cell.tokens += row.contextTokens;
    }
  }
  for (const group of Object.values(result)) for (const [arm, cell] of Object.entries(group)) group[arm] = { n: cell.n, accuracyPct: Math.round(1000 * cell.correct / cell.n) / 10, meanContextTokens: Math.round(cell.tokens / cell.n) };
  console.log(JSON.stringify({ benchmark: "longmemeval-s-qa-v1", reader: MODEL || undefined, budgetTokens: BUDGET, maxItems: MAX_ITEMS, result }, null, 2));
}

if (mode === "contexts") await contexts(args);
else if (mode === "answer") await answer(args);
else if (mode === "report") report(args);
else throw new Error("usage: evaluate-longmemeval-qa.mjs <contexts|answer|report> …");
