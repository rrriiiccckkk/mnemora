import test from "node:test";
import assert from "node:assert/strict";
import { QueryPlanner } from "../dist/index.js";

const provider = content => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
const plan = { version: 1, steps: [{ op: "lookup", query: "Apple", mode: "lexical" }], order_by: "relevance", limit: 10 };

test("planner sends bounded closed-schema instructions and accepts one normalized lexical plan", async () => {
  let request;
  const planner = new QueryPlanner({ llm: { apiKey: "key" }, query: { maxResults: 7 } }, async (_url, init) => { request = init; return provider(plan); });
  const result = await planner.plan("Who supplies Apple?");
  assert.equal(result.limit, 7);
  const body = JSON.parse(request.body);
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.match(body.messages[0].content, /mode.*lexical/is);
  assert.match(body.messages[0].content, /additional|extra|closed/is);
  assert.match(body.messages[0].content, /"additionalProperties":false/);
  assert.match(body.messages[0].content, /"oneOf"/);
  assert.match(body.messages[0].content, /"enum":\["lexical"\]/);
  assert.doesNotMatch(body.messages[0].content, /person\|company|out\|in\|both/);
  assert.equal(body.messages[1].content, "Who supplies Apple?");
  assert.doesNotMatch(request.body, /API_KEY|absolute path/i);
});

test("question ceiling counts Unicode code points in planner", async () => {
  const planner = new QueryPlanner({ llm: { apiKey: "key" } }, async () => provider(plan));
  await planner.plan("😀".repeat(4000));
  await assert.rejects(planner.plan("😀".repeat(4001)), /^Error: invalid_plan$/);
  await planner.plan("e\u0301".repeat(2000));
  await assert.rejects(planner.plan("e\u0301".repeat(2000) + "x"), /^Error: invalid_plan$/);
});

test("planner trims credentials, prefers config, and falls back only to a trimmed nonblank environment key", async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = "  env-key  ";
    for (const [configured, expected] of [["  config-key  ", "Bearer config-key"], ["   ", "Bearer env-key"]]) {
      let authorization;
      const planner = new QueryPlanner({ llm: { apiKey: configured } }, async (_url, init) => { authorization = init.headers.authorization; return provider(plan); });
      await planner.plan("x");
      assert.equal(authorization, expected);
    }
    process.env.DEEPSEEK_API_KEY = "   ";
    await assert.rejects(new QueryPlanner({}, async () => provider(plan)).plan("x"), /^Error: unavailable$/);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("planner rejects SQL, extra keys, non-lexical modes, and oversized questions as invalid_plan", async () => {
  for (const value of [
    { version: 1, steps: [{ op: "sql", text: "SELECT" }] },
    { ...plan, extra: true },
    { ...plan, steps: [{ op: "lookup", query: "x", mode: "hybrid" }] }
  ]) await assert.rejects(new QueryPlanner({ llm: { apiKey: "key" } }, async () => provider(value)).plan("x"), /^Error: invalid_plan$/);
  await assert.rejects(new QueryPlanner({ llm: { apiKey: "key" } }, async () => provider(plan)).plan("x".repeat(4001)), /^Error: invalid_plan$/);
});

test("planner errors expose only bounded categories and never provider bodies", async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    await assert.rejects(new QueryPlanner({}, async () => { throw new Error("unused"); }).plan("x"), /^Error: unavailable$/);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous;
  }
  await assert.rejects(new QueryPlanner({ llm: { apiKey: "key" } }, async () => ({ ok: false, status: 429, json: async () => ({ secret: "SECRET_PROVIDER_BODY" }) })).plan("x"), error => error.message === "provider" && !String(error).includes("SECRET_PROVIDER_BODY"));
  await assert.rejects(new QueryPlanner({ llm: { apiKey: "key" } }, async () => ({ ok: true, status: 200, json: async () => ({ secret: "SECRET_PROVIDER_BODY" }) })).plan("x"), /^Error: invalid_plan$/);
});

test("planner distinguishes caller abort and timeout", async () => {
  const pending = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  const caller = new AbortController();
  const aborted = new QueryPlanner({ llm: { apiKey: "key" }, query: { timeoutMs: 1000 } }, pending).plan("x", { signal: caller.signal });
  caller.abort();
  await assert.rejects(aborted, /^Error: aborted$/);
  await assert.rejects(new QueryPlanner({ llm: { apiKey: "key" }, query: { timeoutMs: 1 } }, pending).plan("x"), /^Error: timeout$/);
});
