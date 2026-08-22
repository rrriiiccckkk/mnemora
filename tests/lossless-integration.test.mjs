import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Mnemora, BoundedCommandError, LosslessClawAdapter, SpawnCommandRunner } from "../dist/index.js";

const sourceText = "Lossless source says Acme supplies advanced packaging.";
const extracted = { entities: [{ name: "Acme", type: "company", confidence: .9, evidence_span: "Acme supplies advanced packaging." }], relations: [] };

class FakeRunner {
  calls = [];
  constructor(respond) { this.respond = respond; }
  async run(command, args, options) { this.calls.push({ command, args: [...args], options }); return this.respond(command, args, options); }
}

test("Lossless adapter probes its public CLI and resolves bounded tail content without retaining CLI metadata", async () => {
  const runner = new FakeRunner(async (_command, args) => {
    if (args[0] === "status") return { stdout: JSON.stringify({ ok: true, data: { version: "0.11.3", databasePath: "C:\\private\\lcm.db" } }), stderr: "", exitCode: 0 };
    return { stdout: JSON.stringify({ ok: true, data: { messages: [{ id: "m1", content: "old" }, { id: "m2", content: sourceText, createdAt: "2026-07-30T00:00:00.000Z" }] } }), stderr: "", exitCode: 0 };
  });
  const adapter = new LosslessClawAdapter(runner), deadlineAt = Date.now() + 5000;
  const capabilities = await adapter.probe({ maxBytes: 4096, deadlineAt });
  assert.equal(capabilities.detectedVersion, "0.11.3");
  assert.equal(capabilities.resolveRawSource, true);
  assert.equal(capabilities.stableExternalIds, false);
  const resolved = await adapter.resolveSource({ provider: "lossless-claw", externalId: "agent:main:example" }, { maxBytes: 4096, deadlineAt });
  assert.deepEqual(runner.calls.map(call => call.args), [["status"], ["messages", "tail", "--session-key", "agent:main:example", "--count", "1"]]);
  assert.equal(resolved?.content, sourceText);
  assert.equal(resolved?.contentHash, createHash("sha256").update(sourceText).digest("hex"));
  assert.equal(resolved?.createdAt, Date.parse("2026-07-30T00:00:00.000Z"));
  assert.equal(resolved?.ref.messageId, "m2");
});

test("Lossless adapter uses documented selectors and rejects malformed or oversized public responses", async () => {
  const commands = new FakeRunner(async (_command, args) => ({ stdout: JSON.stringify({ ok: true, data: { messages: [{ id: "m:2", content: sourceText }] } }), stderr: "", exitCode: 0 }));
  const adapter = new LosslessClawAdapter(commands);
  await adapter.resolveSource({ provider: "lossless-claw", externalId: "session", conversationId: "42", messageId: "m:2" }, { maxBytes: 4096, deadlineAt: Date.now() + 5000 });
  assert.deepEqual(commands.calls[0].args, ["messages", "list", "--conversation-id", "42", "--include-content", "--limit", "20"]);
  const malformed = new LosslessClawAdapter(new FakeRunner(async () => ({ stdout: "not-json", stderr: "", exitCode: 0 })));
  await assert.rejects(() => malformed.probe({ maxBytes: 4096, deadlineAt: Date.now() + 5000 }), error => error instanceof BoundedCommandError && error.category === "invalid_response");
  const oversized = new LosslessClawAdapter(new FakeRunner(async () => ({ stdout: JSON.stringify({ ok: true, data: { messages: [{ content: "x".repeat(17) }] } }), stderr: "", exitCode: 0 })));
  await assert.rejects(() => oversized.resolveSource({ provider: "lossless-claw", externalId: "session" }, { maxBytes: 16, deadlineAt: Date.now() + 5000 }), error => error instanceof BoundedCommandError && error.category === "output_too_large");
});

test("Lossless adapter rejects option-shaped external selectors before invoking its CLI", async () => {
  const runner = new FakeRunner(async () => { throw new Error("must not run"); });
  const adapter = new LosslessClawAdapter(runner);
  await assert.rejects(() => adapter.resolveSource({ provider: "lossless-claw", externalId: "-session" }, { maxBytes: 4096, deadlineAt: Date.now() + 5000 }), error => error instanceof BoundedCommandError && error.category === "invalid_response");
  await assert.rejects(() => adapter.resolveSource({ provider: "lossless-claw", externalId: "session", messageId: "--count" }, { maxBytes: 4096, deadlineAt: Date.now() + 5000 }), error => error instanceof BoundedCommandError && error.category === "invalid_response");
  assert.equal(runner.calls.length, 0);
});

test("command boundary observes cancellation, deadlines, and output limits without a shell", async () => {
  const runner = new SpawnCommandRunner(), controller = new AbortController();
  controller.abort();
  await assert.rejects(() => runner.run(process.execPath, ["-e", "process.exit(0)"], { maxOutputBytes: 1024, deadlineAt: Date.now() + 1000, signal: controller.signal }), error => error instanceof BoundedCommandError && error.category === "cancelled");
  await assert.rejects(() => runner.run(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], { maxOutputBytes: 1024, deadlineAt: Date.now() + 3000 }), error => error instanceof BoundedCommandError && error.category === "output_too_large");
  await assert.rejects(() => runner.run(process.execPath, ["-e", "setTimeout(()=>{},1000)"], { maxOutputBytes: 1024, deadlineAt: Date.now() + 25 }), error => error instanceof BoundedCommandError && error.category === "timeout");
});

test("Mnemora records capability status and ingests a Lossless source only when both integrations and trust anchoring are enabled", async () => {
  const runner = new FakeRunner(async (_command, args) => {
    if (args[0] === "status") return { stdout: JSON.stringify({ ok: true, data: { version: "0.11.3", databasePath: "C:\\private\\lcm.db" } }), stderr: "", exitCode: 0 };
    return { stdout: JSON.stringify({ ok: true, data: { messages: [{ id: "m2", content: sourceText }] } }), stderr: "", exitCode: 0 };
  });
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true }, integrations: { lossless: { enabled: true, timeoutMs: 5000, maxOutputBytes: 4096 } } }, extractor: { extract: async () => extracted }, losslessRunner: runner });
  try {
    const probe = await graph.kg_integrations({ operation: "probe", provider: "lossless-claw" });
    assert.equal(probe.status, "healthy");
    assert.equal(graph.store.db.prepare("SELECT capabilities_json FROM kg_integration_status WHERE provider='lossless-claw'").get().capabilities_json.includes("private"), false);
    const result = await graph.kg_integrations({ operation: "ingest", provider: "lossless-claw", external_ref: { provider: "lossless-claw", externalId: "agent:main:example" }, scope: "project:lossless" });
    assert.equal(result.status, "healthy");
    assert.equal(result.ingestion?.status, "succeeded");
    assert.equal(JSON.stringify(result).includes(sourceText), false);
    const anchor = graph.store.db.prepare("SELECT provider,external_id,scope,status FROM kg_source_anchors").get();
    assert.deepEqual({ ...anchor }, { provider: "lossless-claw", external_id: "agent:main:example", scope: "project:lossless", status: "available" });
    assert.equal(graph.store.db.prepare("SELECT status FROM kg_claim_verifications").get().status, "pending");
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_external_refs WHERE provider='lossless-claw'").get().n, 1);
  } finally { graph.close(); }
});

test("disabled integration and provider failures fail closed without graph writes or provider bodies", async () => {
  const disabled = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const result = await disabled.kg_integrations({ operation: "probe", provider: "lossless-claw" });
    assert.deepEqual(result, { provider: "lossless-claw", operation: "probe", status: "disabled", warning_code: "disabled" });
  } finally { disabled.close(); }
  const failed = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true }, integrations: { lossless: { enabled: true } } }, losslessRunner: new FakeRunner(async () => { throw new BoundedCommandError("timeout"); }) });
  try {
    const result = await failed.kg_integrations({ operation: "ingest", provider: "lossless-claw", external_ref: { provider: "lossless-claw", externalId: "session" } });
    assert.deepEqual(result, { provider: "lossless-claw", operation: "ingest", status: "degraded", warning_code: "timeout", external_id: "session" });
    assert.equal(failed.store.db.prepare("SELECT COUNT(*) AS n FROM kg_observations").get().n, 0);
  } finally { failed.close(); }
});
