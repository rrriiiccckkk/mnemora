// Builds the Chinese retrieval-gate dataset: a reduced LongMemEval_S subset
// machine-translated to Simplified Chinese, so CI measures recall on Chinese
// conversations too. LongMemEval (xiaowu0162/longmemeval-cleaned) is MIT; the
// output keeps its question and session ids, dates and evidence labels.
//
// Reduction (per question of the gate subset): every evidence session, plus
// 8 other sessions of its haystack chosen with a seed from the question id.
// Assistant turns that are not evidence are cut to 800 characters at a
// sentence end. The same reduction of the English source is written too, so
// the two languages compare on the same structure.
//
// Usage:
//   node scripts/build-zh-gate-dataset.mjs reduce <longmemeval_s_cleaned.json> <reduced_en.json>
//   MNEMORA_QA_BASE_URL=… MNEMORA_QA_MODEL=… [MNEMORA_QA_API_KEY=…] \
//     node scripts/build-zh-gate-dataset.mjs translate <reduced_en.json> <cache.jsonl> [maxSeconds]
//   … build-zh-gate-dataset.mjs align <reduced_en.json> <cache.jsonl> <align.jsonl> [maxSeconds]
//   node scripts/build-zh-gate-dataset.mjs assemble <reduced_en.json> <cache.jsonl> <zh.json> [align.jsonl]
//
// align retranslates each question and answer with the question's translated
// evidence turns as reference, so a thing is worded as in the evidence
// ("fence" is 栅栏 in both, not 围栏 in one): translated separately, the two
// differ where the English did not, and lexical recall would pay for it.
//
// translate is resumable: finished pieces are appended to the cache and
// skipped on the next run. Names of people, brands, products and works stay
// in their original script, so one name reads the same in every session.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const DISTRACTORS = 8, ASSISTANT_CHARS = 800, CHUNK_CHARS = 6000;
const GATE = new URL("../eval/retrieval-gate/baseline.json", import.meta.url);

/** Deterministic shuffle (mulberry32 seeded from sha256 of the question id). */
function shuffled(values, seedText) {
  let seed = createHash("sha256").update(seedText).digest().readUInt32LE(0);
  const random = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

function cut(text) {
  if (text.length <= ASSISTANT_CHARS) return text;
  const head = text.slice(0, ASSISTANT_CHARS), end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("\n"), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return `${end > ASSISTANT_CHARS / 2 ? head.slice(0, end + 1) : head}…`;
}

function reduce([sourcePath, outPath]) {
  const ids = new Set(JSON.parse(readFileSync(GATE, "utf8")).questions);
  const out = JSON.parse(readFileSync(sourcePath, "utf8")).filter(question => ids.has(question.question_id)).map(question => {
    const evidence = new Set(question.answer_session_ids);
    const others = shuffled(question.haystack_session_ids.map((id, index) => ({ id, index })).filter(({ id }) => !evidence.has(id)), question.question_id).slice(0, DISTRACTORS).map(({ index }) => index);
    const keep = question.haystack_session_ids.map((id, index) => index).filter(index => evidence.has(question.haystack_session_ids[index]) || others.includes(index));
    return {
      question_id: question.question_id, question_type: question.question_type, question: question.question, answer: String(question.answer), question_date: question.question_date,
      haystack_session_ids: keep.map(index => question.haystack_session_ids[index]), haystack_dates: keep.map(index => question.haystack_dates[index]),
      haystack_sessions: keep.map(index => question.haystack_sessions[index].map(turn => ({ role: turn.role, content: turn.role === "assistant" && !turn.has_answer ? cut(turn.content) : turn.content, ...(turn.has_answer ? { has_answer: true } : {}) }))),
      answer_session_ids: question.answer_session_ids
    };
  });
  writeFileSync(outPath, `${JSON.stringify(out)}\n`);
  console.log(JSON.stringify({ questions: out.length, sessions: out.reduce((n, q) => n + q.haystack_sessions.length, 0), chars: out.reduce((n, q) => n + q.haystack_sessions.flat().reduce((m, t) => m + t.content.length, 0), 0) }));
}

/** Translation pieces: question texts, and sessions split into chunks of whole turns. */
function pieces(dataset) {
  const out = new Map();
  const add = texts => { const key = createHash("sha256").update(JSON.stringify(texts)).digest("hex").slice(0, 24); out.set(key, texts); return key; };
  for (const question of dataset) {
    add([question.question, question.answer]);
    for (const session of question.haystack_sessions) {
      let chunk = [], size = 0;
      for (const turn of session) {
        if (chunk.length && size + turn.content.length > CHUNK_CHARS) { add(chunk); chunk = []; size = 0; }
        chunk.push(`${turn.role}: ${turn.content}`); size += turn.content.length;
      }
      if (chunk.length) add(chunk);
    }
  }
  return { out, add };
}
const keyOf = texts => createHash("sha256").update(JSON.stringify(texts)).digest("hex").slice(0, 24);

const INSTRUCTION = `把下面 JSON 数组里的每一项翻译成简体中文，输出一个长度完全相同的 JSON 数组，只输出数组本身。
规则：
- 每项开头的 "user: " 或 "assistant: " 原样保留，不翻译。user 的话用自然的中文口语，像中国用户在聊天里打字；assistant 的话用自然的书面中文。
- 外国人名、品牌、产品、店名、书名、影视和游戏名、软件和网站名保留原文（例如 Emily、Sephora、iPhone、The Great Gatsby），不要音译。
- 数字、金额、日期、时间、度量单位、百分比保持原值，可以写成阿拉伯数字；不要换算单位或货币。
- 代码、命令、URL、邮箱保持原样；Markdown 结构（列表、标题、加粗）保留。
- 不增删信息，不合并或拆分数组项，不加解释。`;

const SINGLE = `把下面这段话翻译成简体中文，只输出译文。开头的 "user: " 或 "assistant: " 原样保留。外国人名、品牌、产品、作品和软件名保留原文；数字、金额、日期、单位保持原值；代码、命令、URL 原样保留；不增删信息。`;

async function chat(texts, single = false, system = SINGLE) {
  const base = process.env.MNEMORA_QA_BASE_URL, model = process.env.MNEMORA_QA_MODEL;
  if (!base || !model) throw new Error("set MNEMORA_QA_BASE_URL and MNEMORA_QA_MODEL");
  const headers = { "content-type": "application/json", ...(process.env.MNEMORA_QA_API_KEY ? { authorization: `Bearer ${process.env.MNEMORA_QA_API_KEY}` } : {}) };
  const body = JSON.stringify({ model, messages: single ? [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: texts[0] }] : [{ role: "system", content: INSTRUCTION }, { role: "user", content: JSON.stringify(texts) }], max_completion_tokens: 16000, temperature: 0, thinking: { type: "disabled" } });
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${base}/chat/completions`, { method: "POST", headers, body, signal: AbortSignal.timeout(300_000) }).catch(error => ({ ok: false, status: 0, error }));
    if (response.ok) { const json = await response.json(); return { text: String(json.choices?.[0]?.message?.content ?? ""), usage: json.usage }; }
    if (attempt >= 4 || (response.status && response.status !== 429 && response.status < 500)) throw new Error(`http_${response.status}`);
    await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** attempt));
  }
}

/** A translated array is accepted when it has the same length, roles and Chinese in every long item. */
function parse(texts, raw) {
  const match = /\[[\s\S]*\]/u.exec(raw.replace(/^```(?:json)?\s*|\s*```$/gu, ""));
  if (!match) throw new Error("no array");
  const value = JSON.parse(match[0]);
  if (!Array.isArray(value) || value.length !== texts.length) throw new Error(`length ${value?.length} != ${texts.length}`);
  value.forEach((item, index) => {
    if (typeof item !== "string") throw new Error("non-string");
    const role = /^(user|assistant): /u.exec(texts[index])?.[1];
    if (role && !item.startsWith(`${role}: `)) throw new Error(`role prefix lost at ${index}`);
    const body = role ? texts[index].slice(role.length + 2) : texts[index];
    if (body.length > 40 && /[a-z]{3}/iu.test(body) && !/\p{Script=Han}/u.test(item)) throw new Error(`untranslated item ${index}`);
  });
  return value;
}

async function translate([reducedPath, cachePath, maxSeconds]) {
  const dataset = JSON.parse(readFileSync(reducedPath, "utf8")), deadline = Date.now() + 1000 * Number(maxSeconds ?? 3600);
  const done = new Set(existsSync(cachePath) ? readFileSync(cachePath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line).key) : []);
  const todo = [...pieces(dataset).out].filter(([key]) => !done.has(key));
  const usage = { prompt: 0, completion: 0, calls: 0 }; let failed = 0, next = 0;
  const worker = async () => {
    while (next < todo.length && Date.now() < deadline) {
      const [key, texts] = todo[next++];
      let value;
      for (let attempt = 0; attempt < 3 && !value; attempt++) {
        try { const result = await chat(texts); usage.calls++; usage.prompt += result.usage?.prompt_tokens ?? 0; usage.completion += result.usage?.completion_tokens ?? 0; value = parse(texts, result.text); } catch (error) { if (attempt === 2) { failed++; console.error(key, String(error?.message ?? error)); } }
      }
      // Fallback: one item per call, plain text (JSON escaping and long code
      // blocks are what the array form fails on). Code-only items may stay as is.
      if (!value) try {
        value = [];
        for (const text of texts) {
          const result = await chat([text], true); usage.calls++; usage.prompt += result.usage?.prompt_tokens ?? 0; usage.completion += result.usage?.completion_tokens ?? 0;
          const role = /^(user|assistant): /u.exec(text)?.[1], item = result.text.trim();
          value.push(role && !item.startsWith(`${role}: `) ? `${role}: ${item.replace(/^(?:user|assistant)[:：]\s*/u, "")}` : item);
        }
        failed--;
      } catch (error) { value = undefined; console.error(key, "single", String(error?.message ?? error)); }
      if (value) appendFileSync(cachePath, `${JSON.stringify({ key, value })}\n`);
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.MNEMORA_QA_CONCURRENCY ?? 8) }, worker));
  console.log(JSON.stringify({ remaining: todo.length - next + failed, failed, usage }));
}

const ALIGN = `把英文的问题和答案翻译成简体中文。问题是用户在问自己过去的对话。下面给出这些对话里相关片段的中文译文：问题或答案提到片段里出现过的人、事、物时，用片段里的同一个说法。外国人名、品牌、作品名保留原文；数字、金额、日期、单位保持原值。只输出 JSON：{"question": "…", "answer": "…"}。`;

function translatedTurns(dataset, cachePath) {
  const cache = new Map(readFileSync(cachePath, "utf8").split("\n").filter(Boolean).map(line => { const row = JSON.parse(line); return [row.key, row.value]; }));
  const get = texts => { const value = cache.get(keyOf(texts)); if (!value) throw new Error(`missing translation ${keyOf(texts)}`); return value; };
  return { get, sessions: question => question.haystack_sessions.map(session => {
    const turns = [];
    let chunk = [], size = 0;
    const flush = () => { if (!chunk.length) return; get(chunk.map(turn => `${turn.role}: ${turn.content}`)).forEach((text, index) => turns.push({ ...chunk[index], content: text.replace(/^(?:user|assistant)[:：]\s?/u, "") })); chunk = []; size = 0; };
    for (const turn of session) { if (chunk.length && size + turn.content.length > CHUNK_CHARS) flush(); chunk.push(turn); size += turn.content.length; }
    flush();
    return turns;
  }) };
}

async function align([reducedPath, cachePath, alignPath, maxSeconds]) {
  const dataset = JSON.parse(readFileSync(reducedPath, "utf8")), deadline = Date.now() + 1000 * Number(maxSeconds ?? 3600), { sessions } = translatedTurns(dataset, cachePath);
  const done = new Set(existsSync(alignPath) ? readFileSync(alignPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line).id) : []);
  const todo = dataset.filter(question => !done.has(question.question_id));
  let next = 0, failed = 0;
  const worker = async () => {
    while (next < todo.length && Date.now() < deadline) {
      const question = todo[next++];
      const evidence = sessions(question).flat().filter(turn => turn.has_answer).map(turn => turn.content.slice(0, 1500)).join("\n---\n").slice(0, 6000);
      try {
        const result = await chat([`${ALIGN}\n\n片段：\n${evidence || "（无）"}\n\n问题：${question.question}\n答案：${question.answer}`], true, "");
        const value = JSON.parse(/\{[\s\S]*\}/u.exec(result.text)?.[0] ?? "");
        if (typeof value.question !== "string" || typeof value.answer !== "string" || !/\p{Script=Han}/u.test(value.question)) throw new Error("bad shape");
        appendFileSync(alignPath, `${JSON.stringify({ id: question.question_id, question: value.question.trim(), answer: value.answer.trim() })}\n`);
      } catch (error) { failed++; console.error(question.question_id, String(error?.message ?? error)); }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.MNEMORA_QA_CONCURRENCY ?? 8) }, worker));
  console.log(JSON.stringify({ remaining: todo.length - next + failed, failed }));
}

function assemble([reducedPath, cachePath, outPath, alignPath]) {
  const aligned = new Map(alignPath && existsSync(alignPath) ? readFileSync(alignPath, "utf8").split("\n").filter(Boolean).map(line => { const row = JSON.parse(line); return [row.id, row]; }) : []);
  const dataset = JSON.parse(readFileSync(reducedPath, "utf8")), { get, sessions } = translatedTurns(dataset, cachePath);
  const strip = text => text.replace(/^(?:user|assistant)[:：]\s?/u, "").trim();
  const out = dataset.map(question => {
    const [questionZh, answerZh] = get([question.question, question.answer]), fixed = aligned.get(question.question_id);
    return { ...question, question: strip(fixed?.question ?? questionZh), answer: strip(fixed?.answer ?? answerZh), haystack_sessions: sessions(question) };
  });
  writeFileSync(outPath, `${JSON.stringify(out)}\n`);
  console.log(JSON.stringify({ questions: out.length, chars: out.reduce((n, q) => n + q.haystack_sessions.flat().reduce((m, t) => m + t.content.length, 0), 0) }));
}

const [phase, ...args] = process.argv.slice(2);
if (phase === "reduce") reduce(args);
else if (phase === "translate") await translate(args);
else if (phase === "align") await align(args);
else if (phase === "assemble") assemble(args);
else throw new Error("usage: build-zh-gate-dataset.mjs reduce|translate|assemble …");
