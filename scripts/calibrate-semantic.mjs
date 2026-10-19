import { rmSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { createTempDir } from "../tests/helpers/temp.mjs";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";
import { Mnemora } from "../dist/tools.js";
import { searchJournalSemantic } from "../dist/journal/search-index.js";

// Semantic threshold calibration for an embedding model on a LongMemEval-format
// dataset (English or Chinese). For every question it embeds the history the
// way Mnemora does (journal chunks), then records the best cosine of three
// prompts against it: the question against its own evidence turns, a borrowed
// foreign question, and an off-topic prompt. `minSimilarity` should admit
// evidence and keep foreign and off-topic prompts out; `gateSimilarity` is
// checked against the attachment rates of `npm run eval:longmemeval`.
//
// Usage:
//   MNEMORA_CAL_EMBED_MODEL=<ollama model> [MNEMORA_CAL_EMBED_URL=http://127.0.0.1:11434] \
//     node scripts/calibrate-semantic.mjs run <dataset.json[.gz]> <start:end> <out.jsonl>
//   node scripts/calibrate-semantic.mjs report <out.jsonl> [more.jsonl...]
// Filters: MNEMORA_CAL_TYPES=<type,...>, MNEMORA_CAL_QIDS=<file of question ids>.
// `run` resumes: questions already in <out.jsonl> are skipped. Output holds
// similarities only, no dataset text.

const OFF_TOPIC_EN = ["Write a Python function that reverses a linked list.", "What's the capital of Australia?", "Fix the failing unit test in the payment service.", "hello", "Translate this paragraph into French for me.", "Explain how TCP congestion control works.", "Draft a polite email declining a meeting invitation.", "What is 17 times 23?", "Summarize the main ideas of stoicism.", "Generate a regular expression that matches email addresses."];
const OFF_TOPIC_ZH = ["写一个反转链表的 Python 函数。", "澳大利亚的首都是哪里？", "修复支付服务里失败的单元测试。", "你好", "把这段话翻译成法语。", "解释一下 TCP 拥塞控制是怎么工作的。", "帮我写一封礼貌拒绝会议邀请的邮件。", "17 乘以 23 等于多少？", "总结一下斯多葛主义的主要思想。", "写一个匹配邮箱地址的正则表达式。"];
const HAN = /\p{Script=Han}/u;

const [mode, ...rest] = process.argv.slice(2);
if (mode === "report") report(rest);
else if (mode === "run") await run(...rest);
else throw new Error("usage: calibrate-semantic.mjs run <dataset> <start:end> <out.jsonl> | report <out.jsonl>...");

async function run(datasetPath, range = "0:500", outPath) {
  const model = process.env.MNEMORA_CAL_EMBED_MODEL;
  if (!datasetPath || !outPath || !model) throw new Error("run needs <dataset> <start:end> <out.jsonl> and MNEMORA_CAL_EMBED_MODEL");
  const raw = readFileSync(datasetPath);
  const all = JSON.parse((datasetPath.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"));
  const [start, end] = range.split(":").map(Number);
  const done = new Set(existsSync(outPath) ? readFileSync(outPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line).qid) : []);
  const types = process.env.MNEMORA_CAL_TYPES ? new Set(process.env.MNEMORA_CAL_TYPES.split(",")) : undefined;
  const ids = process.env.MNEMORA_CAL_QIDS ? new Set(readFileSync(process.env.MNEMORA_CAL_QIDS, "utf8").split(/\s+/u).filter(Boolean)) : undefined;
  for (let index = start; index < Math.min(end, all.length); index++) {
    const question = all[index];
    if (done.has(question.question_id) || types && !types.has(question.question_type) || ids && !ids.has(question.question_id)) continue;
    const directory = createTempDir("mnemora-cal-");
    const config = normalizeConfig({ dbPath: join(directory, "m.db"), mode: "standalone", embeddings: { enabled: true, provider: "ollama", baseURL: process.env.MNEMORA_CAL_EMBED_URL ?? "http://127.0.0.1:11434", model, timeoutMs: 300000, batchSize: 32 }, conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, unifiedRetrieval: { enabled: true, shadowMode: false } });
    const graph = new Mnemora({ config });
    const shared = new Proxy(graph, { get: (target, property) => property === "close" ? () => undefined : Reflect.get(target, property, target) });
    try {
      const engine = new MnemoraContextEngine(config, () => shared);
      for (let session = 0; session < question.haystack_sessions.length; session++) await engine.ingestBatch({ sessionId: question.haystack_session_ids[session], messages: question.haystack_sessions[session].map(message => ({ role: message.role, content: message.content })) });
      for (let round = 0; round < 50; round++) if (!(await graph.embedJournalChunks({ scope: "default", limit: 2000 }))?.embedded) break;
      const db = graph.store.db;
      // Mnemora fails open when the provider is down; a calibration must not.
      if (!db.prepare("SELECT 1 FROM mnemora_conversation_event_chunks_embeddings LIMIT 1").get()) throw new Error(`no vectors for ${question.question_id}: is the embedding provider for ${model} reachable?`);
      // Evidence turns: the n-th message of a session is its n-th event.
      const gold = new Set(), skipped = { sessions: 0 };
      for (let session = 0; session < question.haystack_sessions.length; session++) {
        const turns = question.haystack_sessions[session];
        if (!turns.some(turn => turn.has_answer)) continue;
        const events = db.prepare("SELECT id, role FROM mnemora_conversation_events WHERE scope='default' AND session_id=? ORDER BY sequence").all(question.haystack_session_ids[session]);
        if (events.length !== turns.length || events.some((event, turn) => event.role !== turns[turn].role)) { skipped.sessions++; continue; }
        turns.forEach((turn, position) => { if (turn.has_answer) gold.add(events[position].id); });
      }
      const best = async prompt => {
        const query = await graph.journalQueryVector(prompt);
        if (!query) return undefined;
        const hits = searchJournalSemantic(db, { scope: "default", identity: query.identity, vector: query.vector, limit: 100000, maxScan: 100000, minSimilarity: -1 });
        return hits;
      };
      const own = await best(question.question);
      const goldHits = own?.filter(hit => gold.has(hit.eventId)) ?? [];
      const zh = HAN.test(question.question);
      const offTopic = (zh ? OFF_TOPIC_ZH : OFF_TOPIC_EN)[index % OFF_TOPIC_EN.length];
      const foreign = all[(index + 167) % all.length].question;
      const top = hits => hits?.[0]?.similarity ?? null;
      const at = (hits, rank) => hits?.[rank - 1]?.similarity ?? null;
      const ownHits = own ?? [];
      const row = {
        qid: question.question_id, type: question.question_type, abstention: question.question_id.endsWith("_abs"), language: zh ? "zh" : "en",
        events: ownHits.length, goldEvents: gold.size, goldSkippedSessions: skipped.sessions,
        evidenceBest: goldHits[0]?.similarity ?? null, evidenceRank: goldHits.length ? ownHits.findIndex(hit => hit.eventId === goldHits[0].eventId) + 1 : null,
        ownTop: top(own), own48: at(own, 48), foreignTop: top(await best(foreign)), offTopicTop: top(await best(offTopic)),
      };
      appendFileSync(outPath, `${JSON.stringify(row)}\n`);
      process.stderr.write(`${index} ${row.qid} evidence=${row.evidenceBest?.toFixed(3)} foreign=${row.foreignTop?.toFixed(3)} offtopic=${row.offTopicTop?.toFixed(3)}\n`);
    } finally { graph.close(); rmSync(directory, { recursive: true, force: true }); globalThis.gc?.(); }
  }
}

function report(paths) {
  const rows = paths.flatMap(path => readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)));
  const quantiles = values => { const sorted = values.filter(value => value !== null).sort((a, b) => a - b); const q = p => sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + .5))].toFixed(3)) : null; return { n: sorted.length, p10: q(.1), p25: q(.25), p50: q(.5), p75: q(.75), p90: q(.9) }; };
  const answerable = rows.filter(row => !row.abstention && row.evidenceBest !== null);
  const share = (values, threshold) => values.length ? Number((100 * values.filter(value => value >= threshold).length / values.length).toFixed(1)) : null;
  const evidence = answerable.map(row => row.evidenceBest), foreign = rows.map(row => row.foreignTop).filter(value => value !== null), offTopic = rows.map(row => row.offTopicTop).filter(value => value !== null);
  const grid = [];
  for (let threshold = .2; threshold <= .9001; threshold += .05) grid.push({ threshold: Number(threshold.toFixed(2)), evidencePct: share(evidence, threshold), foreignPct: share(foreign, threshold), offTopicPct: share(offTopic, threshold) });
  const byType = {};
  for (const row of answerable) (byType[row.type] ??= []).push(row.evidenceBest);
  console.log(JSON.stringify({
    questions: rows.length, answerable: answerable.length, goldSkippedSessions: rows.reduce((sum, row) => sum + row.goldSkippedSessions, 0),
    evidenceBest: quantiles(evidence), evidenceRank: quantiles(answerable.map(row => row.evidenceRank)), ownTop: quantiles(rows.map(row => row.ownTop)), own48: quantiles(rows.map(row => row.own48)),
    foreignTop: quantiles(foreign), offTopicTop: quantiles(offTopic),
    evidenceBestByType: Object.fromEntries(Object.entries(byType).map(([type, values]) => [type, quantiles(values)])),
    thresholds: grid,
  }, null, 2));
}
