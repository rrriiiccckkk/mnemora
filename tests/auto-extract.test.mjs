import assert from "node:assert/strict";
import test from "node:test";
import { AutoExtractService, buildTurnKey, formatUserExtractionInput } from "../dist/auto-extract.js";
import { DeepSeekExtractor } from "../dist/extractor.js";

const turn = { sessionId: "s1", runId: "r1", userText: "  user secret  ", assistantText: " assistant secret " };

test("turn keys are stable, SHA-256 based, and session scoped", () => {
  assert.deepEqual(buildTurnKey(turn), buildTurnKey({ ...turn }));
  assert.notEqual(buildTurnKey(turn).turnKey, buildTurnKey({ ...turn, sessionId: "s2" }).turnKey);
  assert.match(buildTurnKey({ ...turn, runId: undefined }).turnKey, /^extract:s1:[a-f0-9]{24}$/);
});

test("automatic graph evidence contains only user-authored content", () => {
  assert.deepEqual(formatUserExtractionInput(turn, 1000), { text: "user secret", truncated: false });
  assert.deepEqual(formatUserExtractionInput({ ...turn, userText: "u".repeat(20) }, 5), { text: "uuuu…", truncated: true });
});

function harness(claim = { status: "claimed", attempt: 1 }, extract = async () => ({ entities: [], relations: [] }), loggerOverride) {
  const calls = { extract: [], ingest: [], memory: [], finish: [], close: 0, logs: [] };
  const openGraph = () => ({
    store: {
      claimAutoRun: (...args) => (calls.claim = args, claim),
      upsertMemoryDocument: (...args) => (calls.memory.push(args), {}),
      finishAutoRun: (...args) => (calls.finish.push(args), true)
    },
    extract: (...args) => (calls.extract.push(args), extract(...args)),
    ingestAutomaticExtraction: (...args) => (calls.ingest.push(args), { status: "succeeded" }),
    close: () => calls.close++
  });
  const config = { dbPath: "unused", extraction: { timeoutMs: 20, maxInputChars: 1000, minConfidenceToStore: 0 } };
  const logger = loggerOverride ?? { debug: (message, fields) => calls.logs.push([message, fields]), warn: (message, fields) => calls.logs.push([message, fields]) };
  return { calls, service: new AutoExtractService({ config, openGraph, logger, now: () => 100 }) };
}

for (const status of ["busy", "succeeded"]) test(`${status} claims skip extraction`, async () => {
  const { calls, service } = harness({ status });
  assert.deepEqual(await service.handle(turn), { status });
  assert.equal(calls.extract.length, 0);
});

test("empty extraction finishes successfully", async () => {
  const { calls, service } = harness();
  assert.deepEqual(await service.handle(turn), { status: "succeeded", extracted: 0 });
  assert.equal(calls.finish[0][1], 1);
  assert.equal(calls.finish[0][2], "succeeded");
});

test("extraction uses the canonical ingestion path with a stable user source", async () => {
  const extraction = { entities: [{ name: "X", type: "company", confidence: 1, evidence_span: "X" }], relations: [] };
  const { calls, service } = harness({ status: "claimed", attempt: 3 }, async () => extraction);
  await service.handle(turn);
  assert.equal(calls.ingest[0][0].source, "session:s1:turn:r1");
  assert.equal(calls.ingest[0][0].text, "user secret");
  assert.equal(calls.finish[0][1], 3);
});

test("automatic extraction never sends standalone credentials to local memory or an extraction provider", async () => {
  const { calls, service } = harness({ status: "claimed", attempt: 1 }, async () => ({ entities: [], relations: [] }));
  const secretTurn = { sessionId: "s1", runId: "secret", userText: "token ghp_abcdefghijklmnopqrstuvwxyz123456", assistantText: "provider sk-abcdefghijklmnopqrstuv" };
  await service.handle(secretTurn);
  assert.equal(calls.extract.length, 1);
  assert.match(calls.extract[0][0], /REDACTED_SECRET/);
  assert.doesNotMatch(JSON.stringify(calls), /ghp_|sk-abcdefghijkl/);
});

test("non-redactable secret policy skips automatic extraction before any persistent or provider work", async () => {
  let opened = 0;
  const service = new AutoExtractService({
    config: { dbPath: "unused", conversationJournal: { sensitiveContentPolicy: "drop" }, extraction: { timeoutMs: 20, maxInputChars: 1000, minConfidenceToStore: 0 } },
    openGraph: () => { opened++; throw new Error("must not open graph"); }, logger: {}, now: () => 100
  });
  assert.deepEqual(await service.handle({ ...turn, userText: "AWS AKIAABCDEFGHIJKLMNOP" }), { status: "succeeded", extracted: 0 });
  assert.equal(opened, 0);
});

test("enforced pre-admission skips exact low-information turns before graph, memory, or provider work", async () => {
  let opened = 0;
  const service = new AutoExtractService({
    config: { dbPath: "unused", cognition: { formationShadow: true, admission: { preAdmission: { mode: "enforce" } } }, extraction: { timeoutMs: 20, maxInputChars: 1000, minConfidenceToStore: 0 } },
    openGraph: () => { opened++; throw new Error("must not open graph"); }, logger: {}, now: () => 100
  });
  assert.deepEqual(await service.handle({ ...turn, userText: "谢谢！" }), { status: "succeeded", extracted: 0 });
  assert.equal(opened, 0);
});

test("enforced input quality skips generic refusal boilerplate before graph, memory, or provider work", async () => {
  let opened = 0;
  const service = new AutoExtractService({
    config: { dbPath: "unused", extraction: { timeoutMs: 20, maxInputChars: 1000, minConfidenceToStore: 0, autoInputQuality: { mode: "enforce", maxSegments: 16 } } },
    openGraph: () => { opened++; throw new Error("must not open graph"); }, logger: {}, now: () => 100
  });
  assert.deepEqual(await service.handle({ ...turn, userText: "As an AI, I cannot access that link." }), { status: "succeeded", extracted: 0 });
  assert.equal(opened, 0);
});

test("shadow input quality preserves the historical provider input and logs bounded diagnostics only", async () => {
  const { calls, service } = harness();
  const shadow = new AutoExtractService({
    config: { dbPath: "unused", extraction: { timeoutMs: 20, maxInputChars: 1000, minConfidenceToStore: 0, autoInputQuality: { mode: "shadow", maxSegments: 16 } } },
    openGraph: () => ({
      store: { claimAutoRun: () => ({ status: "claimed", attempt: 1 }), finishAutoRun: () => true },
      extract: (...args) => { calls.extract.push(args); return Promise.resolve({ entities: [], relations: [] }); },
      ingestAutomaticExtraction: () => ({ status: "succeeded" }), close() {}
    }),
    logger: { debug: (message, fields) => calls.logs.push([message, fields]), warn: (message, fields) => calls.logs.push([message, fields]) }, now: () => 100
  });
  const text = "Thanks!\n\nI decided to use SQLite.";
  assert.deepEqual(await shadow.handle({ ...turn, userText: text }), { status: "succeeded", extracted: 0 });
  assert.equal(calls.extract[0][0], text);
  const diagnostic = calls.logs.find(([message]) => message === "automatic extraction input quality observed");
  assert.ok(diagnostic);
  assert.equal(diagnostic[1].highSignalSegments, 1);
  assert.doesNotMatch(JSON.stringify(calls.logs), /SQLite|Thanks/);
});

test("enforced input quality passes its selected high-signal input to extraction and optional memory capture", async () => {
  const captured = [], extracted = [];
  const graph = () => ({
    store: { claimAutoRun: () => ({ status: "claimed", attempt: 1 }), upsertMemoryDocument: value => captured.push(value), finishAutoRun: () => true },
    extract: text => { extracted.push(text); return Promise.resolve({ entities: [], relations: [] }); }, ingestAutomaticExtraction: () => ({ status: "succeeded" }), close() {}
  });
  const service = new AutoExtractService({
    config: { dbPath: "unused", extraction: { timeoutMs: 20, maxInputChars: 30, minConfidenceToStore: 0, autoInputQuality: { mode: "enforce", maxSegments: 16 } }, memory: { captureOnAutoExtract: true, maxDocumentChars: 30 } },
    openGraph: graph, logger: {}, now: () => 100
  });
  await service.handle({ ...turn, userText: "Unrelated background context is long.\n\nCorrection: I prefer SQLite." });
  assert.match(extracted[0], /Correction: I prefer SQLite/u);
  assert.equal(extracted[0], captured[0].content);
  assert.equal(extracted[0].length <= 30, true);
});

test("complete turn capture is an explicit autoExtract opt-in", async () => {
  const { calls, service } = harness();
  await service.handle(turn);
  assert.equal(calls.memory.length, 0);

  const captured = [];
  const graph = () => ({
    store: {
      claimAutoRun: () => ({ status: "claimed", attempt: 1 }),
      upsertMemoryDocument: (value) => captured.push(value),
      finishAutoRun() { return true; }
    },
    extract: async () => ({ entities: [], relations: [] }), ingestAutomaticExtraction() { return { status: "succeeded" }; }, close() {}
  });
  const serviceWithCapture = new AutoExtractService({
    config: { dbPath: "unused", scope: { default: "project:alpha" }, extraction: { timeoutMs: 20, maxInputChars: 1000, minConfidenceToStore: 0 }, memory: { captureOnAutoExtract: true, maxDocumentChars: 40 } },
    openGraph: graph, logger: {}, now: () => 100
  });
  await serviceWithCapture.handle(turn);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].scope, "project:alpha");
  assert.equal(captured[0].metadata.kind, "conversation_turn");
  assert.equal(captured[0].content, "user secret");
  assert.equal(captured[0].content.length <= 40, true);
});

test("timeout aborts exact extraction signal, fails open, and logs no input", async () => {
  let signal;
  const { calls, service } = harness({ status: "claimed", attempt: 1 }, async (_text, _source, options) => {
    signal = options.signal;
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("user secret assistant secret")), { once: true }));
  });
  assert.deepEqual(await service.handle(turn), { status: "failed" });
  assert.equal(signal.aborted, true);
  assert.equal(calls.finish[0][2], "failed");
  assert.equal(calls.finish[0][4], "timeout");
  const serialized = JSON.stringify(calls.logs);
  assert.doesNotMatch(serialized, /user secret|assistant secret/);
  assert.match(serialized, /turnHash|inputChars/);
});

test("a success logger exception cannot alter the persisted successful outcome", async () => {
  let debugCalls = 0;
  const logger = {
    debug: () => {
      debugCalls++;
      if (debugCalls === 2) throw new Error("logger unavailable");
    },
    warn: () => { throw new Error("warn must not be reached"); }
  };
  const { calls, service } = harness(undefined, undefined, logger);
  assert.deepEqual(await service.handle(turn), { status: "succeeded", extracted: 0 });
  assert.deepEqual(calls.finish.map((args) => args[2]), ["succeeded"]);
});

test("a warning logger exception cannot escape a failed extraction", async () => {
  const logger = { debug: () => {}, warn: () => { throw new Error("logger unavailable"); } };
  const { calls, service } = harness(undefined, async () => { throw new Error("extract failed"); }, logger);
  assert.deepEqual(await service.handle(turn), { status: "failed" });
  assert.deepEqual(calls.finish.map((args) => args[2]), ["failed"]);
});

test("work admitted before shutdown records terminal success without admitting new work", async () => {
  let stopped = false;
  let release;
  const calls = { claims: 0, finishes: [] };
  const graph = () => ({
    store: {
      claimAutoRun() { calls.claims++; return { status: "claimed", attempt: 1 }; },
      ingestOnce() {},
      finishAutoRun(...args) { calls.finishes.push(args); return true; }
    },
    extract: async () => { await new Promise((resolve) => { release = resolve; }); return { entities: [], relations: [] }; },
    close() {}
  });
  const config = { dbPath: "unused", extraction: { timeoutMs: 1000, maxInputChars: 1000, minConfidenceToStore: 0 } };
  const service = new AutoExtractService({
    config,
    openGraph() { if (stopped) throw new Error("runtime stopped"); return graph(); },
    openGraphForAdmitted: graph,
    logger: {}
  });
  const inFlight = service.handle(turn);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  stopped = true;
  release();
  assert.deepEqual(await inFlight, { status: "succeeded", extracted: 0 });
  assert.equal(calls.finishes[0][2], "succeeded");
  assert.deepEqual(await service.handle({ ...turn, runId: "r2" }), { status: "failed" });
  assert.equal(calls.claims, 1);
});

for (const [name, error, expected] of [
  ["aborted", Object.assign(new Error("private"), { name: "AbortError" }), "aborted"],
  ["http", new Error("LLM extraction failed: 503 private body"), "http"],
  ["invalid response", new Error("LLM extraction returned invalid JSON private"), "invalid_response"],
  ["sqlite", Object.assign(new Error("private"), { code: "SQLITE_BUSY" }), "sqlite"],
  ["shutdown", Object.assign(new Error("private"), { name: "RuntimeStoppedError" }), "shutdown"],
  ["unknown", new Error("private"), "unknown"]
]) test(`${name} failures persist and log only a bounded category`, async () => {
  const { calls, service } = harness(undefined, async () => { throw error; });
  await service.handle(turn);
  assert.equal(calls.finish[0][4], expected);
  assert.equal(calls.logs.at(-1)[1].errorCategory, expected);
  assert.doesNotMatch(JSON.stringify(calls.logs), /private|503/);
});

test("malformed provider JSON persists and logs invalid_response without content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"private":"provider secret"' } }] })
  });
  try {
    const extractor = new DeepSeekExtractor({ apiKey: "secret", baseURL: "https://example.test", model: "test" });
    const { calls, service } = harness(undefined, (...args) => extractor.extract(...args));
    assert.deepEqual(await service.handle(turn), { status: "failed" });
    assert.equal(calls.finish[0][4], "invalid_response");
    assert.equal(calls.logs.at(-1)[1].errorCategory, "invalid_response");
    assert.doesNotMatch(JSON.stringify(calls.logs), /provider secret|user secret|assistant secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
