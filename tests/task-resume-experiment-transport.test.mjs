import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { callExperimentModel } from "../dist/task-resume/experiment-transport.js";

const request = { model: "fixture-model", temperature: .2, max_tokens: 256, messages: [{ role: "system", content: "Evaluate." }, { role: "user", content: "Private fixture prompt." }] };
const options = { endpoint: "https://experiment.invalid/v1/chat/completions", apiKey: "PRIVATE_TEST_KEY", timeoutMs: 1000 };
const limit = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const rejectsSafely = operation => assert.rejects(operation, error => {
  assert.equal(error.message, "experiment_model_call_failed");
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error.stack), /PRIVATE_TEST_KEY|Private fixture prompt|PRIVATE_ERROR_BODY/);
  return true;
});

test("transport sends exactly one authorized JSON POST and returns unmodified provider JSON", async () => {
  let calls = 0;
  const payload = { model: "actual-model", usage: { total_tokens: 42 }, choices: [{ finish_reason: "length" }], extra: { untouched: true } };
  const result = await callExperimentModel({ ...request, stream: true, tools: [{ secret: "not sent" }], messages: request.messages.map(message => ({ ...message, extra: "not sent" })) }, { ...options, fetch: async (url, init) => {
    calls++;
    assert.equal(url, options.endpoint);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${options.apiKey}`);
    assert.equal(new Headers(init.headers).get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(init.body), request);
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(payload);
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, payload);
});

test("non-explicit HTTPS and endpoint credentials/query/fragment are rejected before fetch", async () => {
  let calls = 0;
  for (const endpoint of ["", "/relative", "http://experiment.invalid", "https:experiment.invalid", "https://user:pass@experiment.invalid", "https://@experiment.invalid", "https://experiment.invalid?secret=x", "https://experiment.invalid?", "https://experiment.invalid#secret", "https://experiment.invalid#", " https://experiment.invalid", "https://experi\nment.invalid"]) {
    await rejectsSafely(() => callExperimentModel(request, { ...options, endpoint, fetch: async () => { calls++; return Response.json({}); } }));
  }
  assert.equal(calls, 0);
});

test("empty or CRLF API keys and invalid deadlines fail before fetch", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return Response.json({}); };
  for (const apiKey of ["", "   ", " PRIVATE_TEST_KEY", "PRIVATE_TEST_KEY ", "PRIVATE_TEST_KEY\t", "PRIVATE_TEST_KEY\rInjected: value", "PRIVATE_TEST_KEY\nInjected: value"]) await rejectsSafely(() => callExperimentModel(request, { ...options, apiKey, fetch }));
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5]) await rejectsSafely(() => callExperimentModel(request, { ...options, timeoutMs, fetch }));
  assert.equal(calls, 0);
});

test("streamed JSON at exactly 4 MiB accepts multibyte characters split across chunks", async () => {
  const content = "中".repeat(Math.floor((limit - 2) / 3)) + "a".repeat((limit - 2) % 3);
  const bytes = encoder.encode(JSON.stringify(content));
  assert.equal(bytes.byteLength, limit);
  let offset = 0;
  const body = new ReadableStream({ pull(controller) { if (offset === bytes.length) return controller.close(); const end = Math.min(bytes.length, offset + 65537); controller.enqueue(bytes.subarray(offset, end)); offset = end; } });
  assert.equal(await callExperimentModel(request, { ...options, fetch: async () => new Response(body) }), content);
});

test("long and multibyte-overflow streams stop at the byte limit and are cancelled", async () => {
  for (const bytes of [encoder.encode(JSON.stringify("x".repeat(limit))), encoder.encode('"' + "x".repeat(limit - 2) + '中"')]) {
    let offset = 0, cancelled = false;
    const body = new ReadableStream({ pull(controller) { const end = Math.min(bytes.length, offset + 65536); controller.enqueue(bytes.subarray(offset, end)); offset = end; if (offset === bytes.length) controller.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    await rejectsSafely(() => callExperimentModel(request, { ...options, fetch: async () => new Response(body) }));
    assert.ok(cancelled || offset === bytes.length);
    assert.ok(offset <= limit + 65536);
  }
});

test("non-2xx, missing body, invalid JSON and incomplete UTF-8 reject without exposing response bodies", async () => {
  for (const response of [new Response("PRIVATE_ERROR_BODY", { status: 401 }), new Response(null), new Response('PRIVATE_ERROR_BODY {invalid'), new Response(new Uint8Array([34, 0xe4, 0xb8, 34]))]) {
    let calls = 0;
    await rejectsSafely(() => callExperimentModel(request, { ...options, fetch: async () => { calls++; return response; } }));
    assert.equal(calls, 1);
  }
});

test("redirect and network/stream errors are generic with no fallback or retry", async () => {
  for (const fetch of [
    async () => new Response("PRIVATE_ERROR_BODY", { status: 302, headers: { location: "https://other.invalid" } }),
    async () => { throw new Error("PRIVATE_TEST_KEY PRIVATE_ERROR_BODY Private fixture prompt"); },
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("PRIVATE_ERROR_BODY")); } })),
    async () => { const response = Response.json({}); Object.defineProperty(response, "redirected", { value: true }); return response; }
  ]) {
    let calls = 0;
    await rejectsSafely(() => callExperimentModel(request, { ...options, fetch: async (...args) => { calls++; assert.equal(args[1].redirect, "error"); return fetch(...args); } }));
    assert.equal(calls, 1);
  }
});

test("timeout uses an aborting signal and bounds even a fetch that ignores it", { timeout: 500 }, async () => {
  let signal, calls = 0;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await rejectsSafely(() => callExperimentModel(request, { ...options, timeoutMs: 15, fetch: async (_url, init) => { calls++; signal = init.signal; return new Promise(() => {}); } }));
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason.name, "TimeoutError");
  } finally { clearTimeout(keepAlive); }
});

test("deadline also covers stalled response streaming and cancels the body", { timeout: 500 }, async () => {
  let cancelled = false, signal;
  const body = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('{"pending":')); }, cancel() { cancelled = true; } });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await rejectsSafely(() => callExperimentModel(request, { ...options, timeoutMs: 15, fetch: async (_url, init) => { signal = init.signal; return new Response(body); } }));
    await delay(0);
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test("successful secret echoes are rejected even when JSON escapes hide the key in the wire body", async () => {
  for (const wire of [JSON.stringify({ output: `echo ${options.apiKey}` }), JSON.stringify({ output: options.apiKey }).replaceAll("P", "\\u0050"), JSON.stringify({ [options.apiKey]: "echo" })]) {
    let calls = 0;
    await rejectsSafely(() => callExperimentModel(request, { ...options, fetch: async () => { calls++; return new Response(wire); } }));
    assert.equal(calls, 1);
  }
});
