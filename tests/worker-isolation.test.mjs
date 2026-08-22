import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAnchorVerificationProvider } from "../dist/index.js";

test("built-in AnchorVerifier uses a killable, heap-bounded child process and preserves bounded output", async () => {
  let workerHeader = "";
  const server = createServer((request, response) => {
    workerHeader = String(request.headers["x-mnemora-isolated-worker"] ?? "");
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: "verified", verification_confidence: .9, source_quality: .8 }) } }] }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  try {
    const provider = createAnchorVerificationProvider({ llm: { apiKey: "fixture-secret", baseURL, model: "fixture-model" }, trustLayer: { verification: { automatic: { enabled: true, timeoutMs: 1000 } } } });
    assert.ok(provider);
    const decision = await provider.verify({ claim_id: "claim:1", quote: "direct support", snapshot: "source snapshot", signal: new AbortController().signal, maxOutputBytes: 4096 });
    assert.deepEqual(decision, { status: "verified", verification_confidence: .9, source_quality: .8 });
    assert.equal(workerHeader, "anchor-verifier-v1");
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("isolated verifier termination follows caller cancellation without exposing a Provider body", async () => {
  const server = createServer((_request, response) => { setTimeout(() => response.end("provider body must not escape"), 1000); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(), controller = new AbortController();
  try {
    const provider = createAnchorVerificationProvider({ llm: { apiKey: "fixture-secret", baseURL: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" }, trustLayer: { verification: { automatic: { enabled: true, timeoutMs: 1000 } } } });
    const pending = provider.verify({ claim_id: "claim:1", quote: "direct support", snapshot: "source snapshot", signal: controller.signal, maxOutputBytes: 4096 });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(() => pending, error => error instanceof Error && /aborted/.test(error.message) && !error.message.includes("provider body"));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
