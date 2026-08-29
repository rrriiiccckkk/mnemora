import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";

import plugin from "../dist/plugin.js";
import { CORE_TOOL_NAMES, RESEARCH_TOOL_NAMES, createOpenClawToolDefinitions, evaluateToolSurface } from "../dist/openclaw.js";
import { PluginRuntime, activePluginIdsFromHostConfig } from "../dist/plugin-runtime.js";
import { Mnemora, createMnemoraTools } from "../dist/tools.js";
import { ResearchOperationError } from "../dist/query/errors.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const configs = [
  ["defaults", {}, ["gateway_stop"]],
  ["legacy recall configuration", { recall: { autoRecall: true } }, ["gateway_stop"]],
  ["reasoning shadow", { scope: { default: "project:ops" }, cognition: { reasoningRuntime: { shadowMode: true, scopes: ["project:ops"] } } }, ["gateway_stop"]],
  ["reasoning delivery", { scope: { default: "project:ops" }, cognition: { reasoningRuntime: { delivery: { enabled: true, scopes: ["project:ops"] } } } }, ["gateway_stop"]],
  ["reasoning verification", { scope: { default: "project:ops" }, cognition: { reasoningRuntime: { verification: { enabled: true, maxJobsPerRun: 1 } } } }, ["gateway_stop"]],
  ["reasoning curation", { cognition: { reasoningCuration: { formation: { enabled: true, maxJobsPerTurn: 1 }, review: { enabled: true, intervalHours: 24 } } } }, ["gateway_stop"]],
  ["reasoning intake", { cognition: { reasoningCuration: { intake: { enabled: true, maxCandidatesPerTurn: 1 } } } }, ["gateway_stop"]],
  ["legacy extract configuration", { llm: { apiKey: "secret" }, extraction: { enabled: true, autoExtract: true } }, ["gateway_stop"]],
  ["journal configuration", { conversationJournal: { enabled: true } }, ["gateway_stop"]],
  ["all legacy hook settings", { llm: { apiKey: "secret" }, extraction: { enabled: true, autoExtract: true }, recall: { autoRecall: true } }, ["gateway_stop"]]
];

const EXISTING_17_TOOLS = [
  "kg_context", "kg_embed_backfill", "kg_forget", "kg_ingest", "kg_ingest_batch", "kg_ingest_file", "kg_ingest_url", "kg_insights", "kg_merge", "kg_merge_undo", "kg_profile", "kg_related", "kg_review", "kg_scopes", "kg_search", "kg_sources", "kg_stats"
];
const RESEARCH_8_TOOLS = ["kg_compare", "kg_digest", "kg_export", "kg_import", "kg_query", "kg_query_history", "kg_timeline", "kg_watch"];
const EXPECTED_32_TOOLS = [...EXISTING_17_TOOLS, ...RESEARCH_8_TOOLS, "kg_memory", "kg_integrations", "kg_verify", "kg_recall_metrics", "kg_profile_lock", "kg_recall_canary", "kg_recall_explain"].sort();
const EXISTING_CONTRACT_HASHES = {
  kg_context: "6d828b0d1bf435d19cc497803bd05c173af7ccdaded6cbe8f5e58460d6cd8011",
  kg_embed_backfill: "14d5cf728d9e14209e74a4c18e3818a25cd2a0fc35dec84f9b84eea9769606a3",
  kg_forget: "aa556397ad862cfe777f9734d3fb2dca3209d1d30691b122b6b6de30ff4aedb5",
  kg_ingest: "67f562a40844b02449686933039543c2e064b14a9ac5eed87e678cbaa4f17a3c",
  kg_ingest_batch: "b8dae8fc015478425f54b528bcdba686a153dc14029c7f1e4c4708ecc7680980",
  kg_ingest_file: "ef7ec5ef2c14c50d60c887d19252494a15d0310cee5f31c47216719fb60dd24b",
  kg_ingest_url: "37bb3fef8395143dfc9e7456e9868da41afb0c9a552543da2523cffa0c9850aa",
  kg_insights: "0491dd9cee5eb095019355023843eeee917f20f91283ae0e89f1e23b7a4d22a7",
  kg_merge: "92e65ad4b789dfc92677b9dc92c31f8a3ec47b51199cb88d6894a7bec7ddd042",
  kg_merge_undo: "47714e80017fb7ae0116151d347734532063c96598187e15880bb69d31d9843f",
  kg_related: "98d93e7e42d40274402b3c9045021d54a15cb77bfaa6522ea65154a0edb060fd",
  kg_review: "09744a5ab93ef99692b60064df41cff29a3b575ac7497b07415c47dddc050a4c",
  kg_search: "0a3878e0b315e7afcfaf5cfa0d041772619f91e20bf41d402bcf4170ebf79e6f",
  kg_sources: "b58de462214da3ea6a64d8d5b32b3ac520334173ea78237e656aaa2c19760b3a",
  kg_stats: "2d67c2b9c7e565cc65131b595a7e2b840c5cd1d541ab116e2b27b852845b6c21"
};

function harness(pluginConfig = {}, loggerOverride) {
  const tools = [];
  const hooks = [];
  const warnings = [];
  const infos = [];
  const contextEngines = [];
  const commands = [];
  const api = {
    pluginConfig,
    logger: loggerOverride ?? { debug() {}, info(message, fields) { infos.push([message, fields]); }, warn(message, fields) { warnings.push([message, fields]); } },
    registerTool(tool) { tools.push(tool); },
    registerCommand(command) { commands.push(command); },
    registerContextEngine(id, factory) { contextEngines.push({ id, factory }); },
    on(name, handler, options) { hooks.push({ name, handler, options }); }
  };
  plugin.register(api);
  return { api, tools, hooks, warnings, infos, contextEngines, commands };
}

test("plugin registers a bounded read-only mnemora operator command", async () => {
  const result = harness({ dbPath: ":memory:" });
  assert.equal(result.commands.length, 1);
  assert.deepEqual({ name: result.commands[0].name, acceptsArgs: result.commands[0].acceptsArgs }, { name: "mnemora", acceptsArgs: true });
  const status = await result.commands[0].handler({ args: "status" });
  assert.match(status.text, /Mnemora v/);
  const help = await result.commands[0].handler({ args: "corpus search" });
  assert.match(help.text, /use \/mnemora status/i);
});

test("plugin reports ContextEngine-only lifecycle state with bounded fields", () => {
  const result = harness({ dbPath: "C:/SECRET/private.db", llm: { apiKey: "SECRET_API_KEY" } });
  assert.deepEqual(result.infos[0], ["automatic lifecycle configured", { autoExtract: false, conversationJournal: false, contextEngine: false, episodicMemory: false }]);
  assert.doesNotMatch(JSON.stringify(result.infos), /SECRET|private\.db|api[_ ]?key/i);
});

test("legacy automatic configuration is hookless and requires ContextEngine", () => {
  const result = harness({
    llm: { apiKey: "SECRET_API_KEY" },
    recall: { autoRecall: true, mode: "hybrid", tokenBudget: 901 },
    extraction: { enabled: true, autoExtract: true, timeoutMs: 1234 }
  });
  assert.equal(result.hooks.some(hook => hook.name === "agent_end" || hook.name === "before_prompt_build"), false);
  assert.deepEqual(result.warnings, [["automatic extraction disabled: ContextEngine must be enabled", {}]]);
  assert.doesNotMatch(JSON.stringify(result.infos), /SECRET|session|prompt|message|evidence/i);
});

test("missing or throwing info loggers do not affect lifecycle registration", () => {
  const missing = harness({ recall: { autoRecall: true } }, { debug() {}, warn() {} });
  const throwing = harness({ recall: { autoRecall: true } }, { info() { throw new Error("logger failed"); }, debug() {}, warn() {} });
  assert.deepEqual(missing.hooks.map(hook => hook.name).sort(), ["gateway_stop"]);
  assert.deepEqual(throwing.hooks.map(hook => hook.name).sort(), ["gateway_stop"]);
});

for (const [name, config, expectedHooks] of configs) test(`${name} registers thirty-two tools and only expected hooks`, () => {
  const result = harness(config);
  assert.deepEqual(result.hooks.map((hook) => hook.name).sort(), expectedHooks);
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), EXPECTED_32_TOOLS);
  assert.deepEqual(result.contextEngines, []);
});

test("ContextEngine is registered only after explicit opt-in", () => {
  const result = harness({ conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true } });
  assert.deepEqual(result.contextEngines.map(value => value.id), ["mnemora"]);
  assert.equal(result.contextEngines[0].factory({ config: { plugins: { slots: { contextEngine: "mnemora" } } } }).info.ownsCompaction, false);
});

test("ContextEngine capture failures reach the gateway logger with bounded metadata only", async () => {
  const warnings = [];
  const runtime = new PluginRuntime({ dbPath: ":memory:", contextEngine: { enabled: true } }, { debug() {}, info() {}, warn(message, fields) { warnings.push([message, fields]); } });
  await runtime.contextEngine.ingestBatch({ sessionId: "oversized", messages: Array.from({ length: 513 }, () => ({ role: "user", content: "must-not-be-logged" })) });
  assert.deepEqual(warnings, [["ContextEngine capture skipped", { source: "ingest_batch", category: "invalid_input", messageCount: 512 }]]);
  assert.doesNotMatch(JSON.stringify(warnings), /must-not-be-logged/);
  await runtime.stop();
});

test("standalone is ContextEngine-only and never registers legacy hooks", () => {
  const result = harness({ mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, recall: { autoRecall: true } });
  assert.deepEqual(result.hooks.map(hook => hook.name).sort(), ["gateway_stop"]);
  assert.deepEqual(result.contextEngines.map(value => value.id), ["mnemora"]);
  const readiness = result.infos.find(([message]) => message === "standalone readiness evaluated");
  assert.deepEqual(readiness, ["standalone readiness evaluated", { activation: "blocked", diagnostics: 2 }]);
  assert.throws(() => result.contextEngines[0].factory({}), /standalone_context_engine_slot_unconfirmed/);
  assert.equal(result.contextEngines[0].factory({ config: { plugins: { slots: { contextEngine: "mnemora" } } } }).info.ownsCompaction, false);
  assert.deepEqual(result.infos.at(-1), ["standalone ContextEngine slot confirmed", { activation: "ready", conflictingMemoryPluginsDetected: 0 }]);
});

test("standalone activation reads enabled legacy plugins from the public host configuration", () => {
  assert.deepEqual(activePluginIdsFromHostConfig({ plugins: { entries: { "lossless-claw": { enabled: true }, "memory-lancedb-pro": { enabled: false }, "mnemora": { enabled: true } } } }), ["lossless-claw", "mnemora"]);
  assert.deepEqual(activePluginIdsFromHostConfig({ plugins: { allow: ["mnemora", "memory-lancedb-pro"], entries: { "memory-lancedb-pro": { enabled: false } } } }), ["mnemora"]);
  const result = harness({ mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true } });
  assert.throws(() => result.contextEngines[0].factory({ config: { plugins: { slots: { contextEngine: "mnemora" }, entries: { "lossless-claw": { enabled: true }, "memory-lancedb-pro": { enabled: false } } } } }), /standalone_context_engine_activation_blocked/);
  assert.deepEqual(result.warnings.at(-1), ["standalone ContextEngine activation blocked", { diagnostics: 1 }]);
  assert.equal(result.hooks.some(hook => hook.name === "agent_end"), false);
});

test("a selected ContextEngine owns completed-turn capture and automatic extraction", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-hook-convergence-")), dbPath = join(directory, "memory.db");
  const runtime = new PluginRuntime({ dbPath, conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, llm: { apiKey: "fixture" }, extraction: { enabled: true, autoExtract: true } }, { debug() {}, info() {}, warn() {} });
  const calls = [];
  runtime.extract.handle = async turn => { calls.push(turn); return { status: "succeeded", extracted: 0 }; };
  try {
    const engine = runtime.activateContextEngine({ config: { plugins: { slots: { contextEngine: "mnemora" } } } });
    await engine.afterTurn({ sessionId: "selected-engine", prePromptMessageCount: 0, messages: [
      { id: "user", role: "user", content: "Remember my preferred editor is Vim." },
      { id: "assistant", role: "assistant", content: "I will use Vim examples." }
    ] });
    assert.deepEqual(calls, [{ sessionId: "selected-engine", userText: "Remember my preferred editor is Vim.", assistantText: "I will use Vim examples." }]);
    const graph = runtime.openGraph();
    try {
      assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_capture_receipts").get().n, 1);
      assert.deepEqual(graph.store.db.prepare("SELECT kind,status FROM mnemora_derived_tasks").all().map(row => ({ ...row })), [{ kind: "auto_extract", status: "succeeded" }]);
    } finally { graph.close(); }
  } finally { runtime.stop(); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("an occupied extraction lease does not skip consolidation or reflection", async () => {
  const runtime = new PluginRuntime({ dbPath: ":memory:", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, llm: { apiKey: "fixture" }, extraction: { enabled: true, autoExtract: true }, consolidation: { enabled: true }, cognition: { reflection: { enabled: true } } }, { debug() {}, info() {}, warn() {} });
  let extracted = 0, consolidated = 0, reflected = 0;
  try {
    runtime.journal.claimDerivedTask = () => [];
    runtime.extract.handle = async () => { extracted++; return { status: "succeeded", extracted: 0 }; };
    runtime.runConsolidation = () => { consolidated++; };
    runtime.runReflection = () => { reflected++; };
    await runtime.processCompletedTurn({ sessionId: "s", userText: "user", assistantText: "assistant" }, { receiptId: "receipt", commitId: "commit", scope: "default", sessionId: "s", branchId: "main", events: [], tasks: [], inserted: true });
    assert.deepEqual({ extracted, consolidated, reflected }, { extracted: 0, consolidated: 1, reflected: 1 });
  } finally { runtime.stop(); }
});

test("ContextEngine evaluates governed reasoning from assemble without registering a prompt hook", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-reasoning-assembly-")), dbPath = join(directory, "memory.db");
  const runtime = new PluginRuntime({
    dbPath,
    scope: { default: "project:ops" },
    conversationJournal: { enabled: true },
    contextEngine: { enabled: true },
    episodicMemory: { enabled: true },
    cognition: { reasoningRuntime: { shadowMode: true, scopes: ["project:ops"] } }
  }, { debug() {}, info() {}, warn() {} });
  try {
    const engine = runtime.activateContextEngine({ config: { plugins: { slots: { contextEngine: "mnemora" } } } });
    const assembled = await engine.assemble({ sessionId: "reasoning", prompt: "Deploy the production migration safely.", messages: [{ role: "user", content: "Deploy the production migration safely." }], tokenBudget: 800 });
    assert.equal("systemPromptAddition" in assembled, false);
    const graph = runtime.openGraph();
    try { assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_reasoning_runtime_shadow_runs WHERE scope=?").get("project:ops").n, 1); }
    finally { graph.close(); }
  } finally { runtime.stop(); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("kg_insights publishes a strict bounded schema and dispatches the exact input object", async () => {
  let received;
  const graph = {
    async kg_insights(input) { received = input; return { insights: [] }; },
    close() {}
  };
  const insights = createOpenClawToolDefinitions(() => graph).find((tool) => tool.name === "kg_insights");
  const input = { kind: "emerging_topic", limit: 3, communityId: "community:abc", explain: "auto", refresh: true };
  const output = await insights.execute("call", input);
  assert.deepEqual(received, input);
  assert.deepEqual(JSON.parse(output.content[0].text), { insights: [] });
  assert.match(insights.description, /structural analysis/i);
  assert.match(insights.description, /not instructions or newly established facts/i);
  assert.equal(insights.parameters.additionalProperties, false);
  for (const valid of [
    {},
    { kind: "all", limit: 1, communityId: "community:abc", explain: false, refresh: false },
    { kind: "knowledge_gap", limit: 20 },
    { kind: "emerging_topic" },
    { kind: "cross_community_path", explain: true }
  ]) assert.equal(Check(insights.parameters, valid), true);
  for (const invalid of [
    { kind: "unknown" },
    { limit: 21 },
    { path: "irrelevant" },
    { explain: "always" }
  ]) assert.equal(Check(insights.parameters, invalid), false);
});

test("tool surfaces register only their documented schemas and core materially reduces context", () => {
  const core = createOpenClawToolDefinitions(() => ({}), "core");
  const research = createOpenClawToolDefinitions(() => ({}), "research");
  const full = createOpenClawToolDefinitions(() => ({}), "full");
  assert.deepEqual(core.map(tool => tool.name).sort(), [...CORE_TOOL_NAMES].sort());
  assert.deepEqual(research.map(tool => tool.name).sort(), [...RESEARCH_TOOL_NAMES].sort());
  assert.equal(full.length, EXPECTED_32_TOOLS.length);
  const coreMemory = core.find(tool => tool.name === "kg_memory");
  assert.equal(Check(coreMemory.parameters, { operation: "store", content: "fact" }), true);
  assert.equal(Check(coreMemory.parameters, { operation: "search", query: "fact" }), true);
  assert.equal(Check(coreMemory.parameters, { operation: "lifecycle", action: "delete", document_id: "memory:x" }), false);
  const coreSummary = evaluateToolSurface("core");
  const researchSummary = evaluateToolSurface("research");
  const fullSummary = evaluateToolSurface();
  assert.equal(coreSummary.tool_count, CORE_TOOL_NAMES.length);
  assert.equal(researchSummary.tool_count, RESEARCH_TOOL_NAMES.length);
  assert.equal(fullSummary.tool_count, EXPECTED_32_TOOLS.length);
  assert.equal(coreSummary.schema_bytes < fullSummary.schema_bytes, true);
  assert.equal(coreSummary.reduction.tool_count, EXPECTED_32_TOOLS.length - CORE_TOOL_NAMES.length);
  assert.equal(coreSummary.reduction.schema_percent > 0, true);
});

test("kg_recall_metrics is a bounded read-only descriptor", async () => {
  let received;
  const graph = { kg_recall_metrics(input) { received = input; return { items: [], summary: { total_runs: 0, empty_runs: 0, empty_rate: 0 } }; }, close() {} };
  const tool = createOpenClawToolDefinitions(() => graph).find((item) => item.name === "kg_recall_metrics");
  const input = { scope: "project:research", limit: 100 };
  assert.equal(Check(tool.parameters, input), true);
  assert.equal(Check(tool.parameters, { scope: "project:research", limit: 101 }), false);
  assert.equal(Check(tool.parameters, { scope: "project:research", extra: true }), false);
  assert.deepEqual(JSON.parse((await tool.execute("call", input)).content[0].text), { items: [], summary: { total_runs: 0, empty_runs: 0, empty_rate: 0 } });
  assert.deepEqual(received, input);
});

test("kg_recall_explain is bounded, read-only, and dispatches an exact request", async () => {
  let received;
  const graph = { kg_recall_explain(input) { received = input; return { trace_version: "recall-explain-v1", candidates: [] }; }, close() {} };
  const tool = createOpenClawToolDefinitions(() => graph).find((item) => item.name === "kg_recall_explain");
  const input = { query: "why this memory", scope: "project:research", max_nodes: 10, max_depth: 2, confidence_threshold: .5, token_budget: 600, mode: "hybrid" };
  assert.equal(Check(tool.parameters, input), true);
  assert.equal(Check(tool.parameters, { query: "x".repeat(4001) }), false);
  assert.equal(Check(tool.parameters, { query: "why", unknown: true }), false);
  assert.deepEqual(JSON.parse((await tool.execute("call", input)).content[0].text), { trace_version: "recall-explain-v1", candidates: [] });
  assert.deepEqual(received, input);
  assert.match(tool.description, /without changing local state/i);
});

test("public factory exposes exactly thirty-two bound tools including profile choices and adaptive recall controls", async () => {
  mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-factory-"));
  const created = createMnemoraTools({ config: { dbPath: join(directory, "graph.db") } });
  try {
    assert.deepEqual(Object.keys(created.tools).sort(), EXPECTED_32_TOOLS);
    for (const name of RESEARCH_8_TOOLS) assert.equal(typeof created.tools[name], "function", name);
    const scopes = created.tools.kg_scopes();
    assert.equal(scopes.default_scope, "default");
    assert.deepEqual(scopes.scopes.map(item => ({ id: item.id, observations: item.observations, memory_documents: item.memory_documents })), [{ id: "default", observations: 0, memory_documents: 0 }]);
    assert.equal(scopes.scopes[0].updated_at > 0, true);
    const output = await created.tools.kg_insights({ explain: false });
    assert.equal(output.status, "empty");
  } finally { created.graphology.close(); }
});

test("the complete published contracts of the scope-aware graph descriptors remain stable", () => {
  const descriptors = createOpenClawToolDefinitions(() => ({}));
  assert.deepEqual(Object.fromEntries(descriptors.filter(tool => EXISTING_17_TOOLS.includes(tool.name) && !["kg_scopes", "kg_profile"].includes(tool.name)).sort((a, b) => a.name.localeCompare(b.name)).map(tool => {
    const contract = JSON.stringify({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters });
    return [tool.name, createHash("sha256").update(contract).digest("hex")];
  })), EXISTING_CONTRACT_HASHES);
});

test("scope-aware descriptors explain default isolation and kg_scopes exposes aggregate-only discovery", async () => {
  const scopedNames = ["kg_ingest", "kg_ingest_batch", "kg_ingest_file", "kg_ingest_url", "kg_insights", "kg_search", "kg_related", "kg_profile", "kg_profile_lock", "kg_context", "kg_sources", "kg_memory", "kg_query", "kg_verify", "kg_recall_metrics", "kg_recall_canary", "kg_timeline", "kg_compare", "kg_watch", "kg_digest", "kg_query_history"];
  const graph = { kg_scopes(limit) { return { default_scope: "project:alpha", scopes: [{ id: "project:alpha", observations: 2, memory_documents: 1, updated_at: 42 }], limit }; }, close() {} };
  const tools = createOpenClawToolDefinitions(() => graph);
  for (const name of scopedNames) {
    const tool = tools.find(item => item.name === name);
    assert.match(tool.description, /scope\.default/i, name);
    assert.match(tool.description, /never means all scopes/i, name);
  }
  const scopes = tools.find(item => item.name === "kg_scopes");
  assert.equal(Check(scopes.parameters, {}), true);
  assert.equal(Check(scopes.parameters, { limit: 100 }), true);
  assert.equal(Check(scopes.parameters, { limit: 101 }), false);
  assert.equal(Check(scopes.parameters, { limit: 1, scope: "project:alpha" }), false);
  assert.match(scopes.description, /no entity, evidence, source, or memory text/i);
  const output = JSON.parse((await scopes.execute("call", { limit: 2 })).content[0].text);
  assert.deepEqual(output, { default_scope: "project:alpha", scopes: [{ id: "project:alpha", observations: 2, memory_documents: 1, updated_at: 42 }], limit: 2 });
});

test("v0.9 descriptors are closed, bounded, forward exact inputs, and preserve safe failures", async () => {
  const calls = [];
  const graph = { close() {} };
  for (const name of RESEARCH_8_TOOLS) graph[name] = async (input) => { calls.push([name, input]); return { name }; };
  const tools = createOpenClawToolDefinitions(() => graph);
  const valid = {
    kg_query: { question: "Who supplies Acme?" },
    kg_timeline: { subject: "company:acme", from: 1, to: 2, limit: 10 },
    kg_compare: { left: "company:a", right: "company:b", max_depth: 2, confidence_min: .5, valid_from: 1, valid_to: 2, limit: 10, as_of: 2, max_response_bytes: 4096 },
    kg_watch: { operation: "list", limit: 10 },
    kg_digest: { idempotency_key: "digest-1", watch_ids: ["watch:a"], since: 1, limit: 2 },
    kg_export: { format: "jsonl", max_bytes: 1024, max_records: 10 },
    kg_import: { format: "jsonl", data: "", preview_hash: "abc", confirm: true },
    kg_query_history: { limit: 10 }
  };
  for (const name of RESEARCH_8_TOOLS) {
    const tool = tools.find(item => item.name === name);
    if (Array.isArray(tool.parameters.anyOf)) for (const branch of tool.parameters.anyOf) assert.equal(branch.additionalProperties, false, `${name} union branch`);
    else assert.equal(tool.parameters.additionalProperties, false, name);
    assert.equal(Check(tool.parameters, valid[name]), true, name);
    assert.equal(Check(tool.parameters, { ...valid[name], undocumented: true }), false, name);
    assert.equal(tool.execute.length, 2, name);
    const output = await tool.execute(`call-${name}`, valid[name]);
    assert.deepEqual(JSON.parse(output.content[0].text), { name });
  }
  assert.deepEqual(calls, RESEARCH_8_TOOLS.map(name => [name, valid[name]]));
  assert.equal(Check(tools.find(x => x.name === "kg_query").parameters, { question: "x".repeat(4001) }), false);
  assert.equal(Check(tools.find(x => x.name === "kg_timeline").parameters, { subject: "x", limit: 51 }), false);
  assert.equal(Check(tools.find(x => x.name === "kg_compare").parameters, { left: "a", right: "b", max_depth: 5 }), false);
  assert.equal(Check(tools.find(x => x.name === "kg_digest").parameters, { idempotency_key: "x", limit: 26 }), false);
  assert.equal(Check(tools.find(x => x.name === "kg_export").parameters, { format: "xml" }), false);
  const importSchema = tools.find(x => x.name === "kg_import").parameters;
  assert.equal(Check(importSchema, { format: "jsonl", data: "", path: "C:/secret.jsonl" }), false);
  assert.equal(Check(importSchema, { format: "csv", data: "" }), false);
  assert.equal(Check(tools.find(x => x.name === "kg_query_history").parameters, { limit: 101 }), false);

});

test("v0.9 schemas enforce every operation variant, nested closure, enum, and documented maximum", () => {
  const byName = Object.fromEntries(createOpenClawToolDefinitions(() => ({})).map(tool => [tool.name, tool.parameters]));
  const plan = { version: 1, steps: [{ op: "lookup", query: "x", node_types: ["company"], mode: "lexical" }], order_by: "relevance", limit: 50 };
  const watchVariants = [
    { operation: "create", id: "watch:x", name: "x".repeat(200), question: "q".repeat(4000), plan, schedule_hint: "weekly", enabled: true },
    { operation: "list", limit: 100 },
    { operation: "inspect", id: "watch:x" }, { operation: "enable", id: "watch:x" }, { operation: "disable", id: "watch:x" }, { operation: "delete", id: "watch:x" },
    { operation: "update", id: "watch:x", name: "new", plan, schedule_hint: "daily", enabled: false }
  ];
  for (const value of watchVariants) assert.equal(Check(byName.kg_watch, value), true, JSON.stringify(value));
  for (const value of [
    { operation: "list", id: "watch:x" }, { operation: "inspect", id: "watch:x", limit: 1 }, { operation: "delete", id: "watch:x", enabled: true },
    { operation: "create", name: "x", plan, schedule_hint: "hourly" }, { operation: "create", name: "x".repeat(201), plan, schedule_hint: "daily" },
    { operation: "create", name: "x", question: "q".repeat(4001), plan, schedule_hint: "daily" }, { operation: "list", limit: 101 },
    { operation: "inspect", id: "i".repeat(161) }, { operation: "update", id: "watch:x", name: "x".repeat(201) },
    { operation: "update", id: "watch:x", question: "not allowed" }, { operation: "unknown" }
  ]) assert.equal(Check(byName.kg_watch, value), false, JSON.stringify(value));

  const cases = [
    ["kg_query", { question: "q".repeat(4000), plan }, [{ question: "q".repeat(4001) }, { plan: { ...plan, steps: [...plan.steps, ...Array(8).fill(plan.steps[0])] } }, { plan: { ...plan, steps: [{ ...plan.steps[0], query: "q".repeat(4001) }] } }, { plan: { ...plan, steps: [{ ...plan.steps[0], node_types: ["unknown"] }] } }, { plan: { ...plan, steps: [{ ...plan.steps[0], mode: "hybrid" }] } }, { plan: { ...plan, steps: [{ ...plan.steps[0], extra: true }] } }, { plan: { ...plan, order_by: "random" } }]],
    ["kg_timeline", { subject: "s".repeat(160), from: 0, to: Number.MAX_SAFE_INTEGER, limit: 50 }, [{ subject: "s".repeat(161) }, { subject: "s", limit: 51 }, { subject: "s", limit: 1.5 }]],
    ["kg_compare", { left: "l".repeat(160), right: "r".repeat(160), max_depth: 4, confidence_min: 1, valid_from: 0, valid_to: Number.MAX_SAFE_INTEGER, limit: 50, as_of: Number.MAX_SAFE_INTEGER, max_response_bytes: 1048576 }, [{ left: "l".repeat(161), right: "r" }, { left: "l", right: "r", max_depth: 5 }, { left: "l", right: "r", confidence_min: 1.1 }, { left: "l", right: "r", max_response_bytes: 1048577 }]],
    ["kg_digest", { idempotency_key: "i".repeat(300), watch_ids: Array(1000).fill("watch:x"), since: Number.MAX_SAFE_INTEGER, limit: 25 }, [{ idempotency_key: "i".repeat(301) }, { idempotency_key: "i", watch_ids: Array(1001).fill("watch:x") }, { idempotency_key: "i", watch_ids: ["w".repeat(161)] }, { idempotency_key: "i", limit: 26 }]],
    ["kg_export", { format: "graphml", max_bytes: 10485760, max_records: 1000 }, [{ format: "xml" }, { format: "jsonl", max_bytes: 10485761 }, { format: "csv", max_records: 1001 }]],
    ["kg_import", { format: "jsonl", data: "d".repeat(10485760), preview_hash: "h".repeat(128), confirm: true }, [{ format: "csv", data: "" }, { format: "jsonl", data: "", path: "x" }, { format: "jsonl", data: "d".repeat(10485761) }, { format: "jsonl", data: "", preview_hash: "h".repeat(129) }]],
    ["kg_query_history", { limit: 100 }, [{ limit: 101 }, { limit: 1.5 }]]
  ];
  for (const [name, valid, invalid] of cases) {
    assert.equal(Check(byName[name], valid), true, `${name} valid maxima`);
    for (const value of invalid) assert.equal(Check(byName[name], value), false, `${name}: ${Object.keys(value).join(",")}`);
  }
});

test("every v0.9 descriptor forwards exactly one bounded JSON text block for safe and hostile failures", async () => {
  const known = new ResearchOperationError({ error_code: "QUERY_TIMEOUT", retryable: true, details: {} });
  const overLimit = new ResearchOperationError({
    error_code: "COMPARE_SUBJECT_AMBIGUOUS",
    retryable: true,
    details: {
      side: "left",
      truncated: false,
      candidates: Array.from({ length: 5 }, (_, index) => ({
        id: `company:${index}`,
        name: "x".repeat(4096),
        type: "company",
        aliases: Array.from({ length: 10 }, () => "y".repeat(1024)),
        match_reason: "name_exact"
      }))
    }
  });
  for (const name of RESEARCH_8_TOOLS) {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const [failure, expected] of [
      [known, known.public],
      [new Error(`SECRET ${name} C:/private provider body`), { error: "operation_failed", error_code: "RESEARCH_OPERATION_FAILED", stage: "execution", retryable: false, summary: `${name} failed`, details: {} }],
      [new Proxy({}, { get() { throw new Error("SECRET hostile proxy"); } }), { error: "operation_failed", error_code: "RESEARCH_OPERATION_FAILED", stage: "execution", retryable: false, summary: `${name} failed`, details: {} }],
      [revoked.proxy, { error: "operation_failed", error_code: "RESEARCH_OPERATION_FAILED", stage: "execution", retryable: false, summary: `${name} failed`, details: {} }],
      [overLimit, overLimit.public]
    ]) {
      const graph = { close() {}, async [name]() { throw failure; } };
      const tool = createOpenClawToolDefinitions(() => graph).find(item => item.name === name);
      const output = await tool.execute("call", {});
      assert.equal(output.content.length, 1, name);
      assert.equal(output.content[0].type, "text", name);
      assert.ok(Buffer.byteLength(output.content[0].text, "utf8") <= 16 * 1024, name);
      assert.deepEqual(JSON.parse(output.content[0].text), expected, name);
      assert.doesNotMatch(output.content[0].text, /SECRET|private|provider body/i, name);
    }
  }
});

test("every v0.9 descriptor contains graph construction failures in one safe JSON block", async () => {
  for (const name of RESEARCH_8_TOOLS) {
    const tool = createOpenClawToolDefinitions(() => { throw new Error(`SECRET open ${name} C:/private`); }).find(item => item.name === name);
    const output = await tool.execute("call", {});
    assert.deepEqual(output, { content: [{ type: "text", text: JSON.stringify({
      error: "operation_failed", error_code: "RESEARCH_OPERATION_FAILED", stage: "execution", retryable: false, summary: `${name} failed`, details: {}
    }) }] }, name);
    assert.ok(Buffer.byteLength(output.content[0].text, "utf8") <= 16 * 1024, name);
    assert.doesNotMatch(output.content[0].text, /SECRET|private/i, name);
  }
});

test("every v0.9 descriptor contains close failures without overriding operation failures", async () => {
  const known = new ResearchOperationError({ error_code: "QUERY_TIMEOUT", retryable: true, details: {} });
  for (const name of RESEARCH_8_TOOLS) {
    let closes = 0;
    const closeFailure = createOpenClawToolDefinitions(() => ({
      async [name]() { return { ok: true }; },
      close() { closes += 1; throw new Error(`SECRET close ${name} C:/private`); }
    })).find(item => item.name === name);
    const closeOutput = await closeFailure.execute("call", {});
    assert.equal(closes, 1, name);
    assert.deepEqual(JSON.parse(closeOutput.content[0].text), {
      error: "operation_failed", error_code: "RESEARCH_OPERATION_FAILED", stage: "execution", retryable: false, summary: `${name} failed`, details: {}
    }, name);

    closes = 0;
    const operationAndCloseFailure = createOpenClawToolDefinitions(() => ({
      async [name]() { throw known; },
      close() { closes += 1; throw new Error(`SECRET close ${name} C:/private`); }
    })).find(item => item.name === name);
    const operationOutput = await operationAndCloseFailure.execute("call", {});
    assert.equal(closes, 1, name);
    assert.deepEqual(operationOutput, { content: [{ type: "text", text: JSON.stringify(known.public) }] }, name);
    assert.equal(operationOutput.content.length, 1, name);
    assert.doesNotMatch(operationOutput.content[0].text, /SECRET|private/i, name);
  }
});

test("v0.5 review and merge tools forward bounded safety parameters", async () => {
  const received = [];
  const graph = {
    kg_review(...args) { received.push(["review", args]); return { items: [] }; },
    kg_merge(...args) { received.push(["merge", args]); return { confirmed: false }; },
    kg_merge_undo(...args) { received.push(["undo", args]); return { confirmed: false }; },
    close() {}
  };
  const tools = createOpenClawToolDefinitions(() => graph);
  await tools.find(tool => tool.name === "kg_review").execute("review", { kind: "duplicates", status: "pending", scan: true, limit: 25, after_id: "company:a" });
  await tools.find(tool => tool.name === "kg_merge").execute("merge", { canonical_entity_id: "company:a", duplicate_entity_id: "company:b", preview_hash: "hash", confirm: true });
  await tools.find(tool => tool.name === "kg_merge_undo").execute("undo", { audit_id: "merge:1", preview_hash: "undo-hash", confirm: true });
  assert.deepEqual(received, [
    ["review", ["duplicates", "pending", true, 25, "company:a"]],
    ["merge", ["company:a", "company:b", true, "hash"]],
    ["undo", ["merge:1", true, "undo-hash"]]
  ]);
});

for (const config of [
  { extraction: { enabled: true, autoExtract: true } },
  { llm: { apiKey: "secret" }, extraction: { enabled: false, autoExtract: true } }
]) test("invalid automatic extraction warns once and stays hookless", () => {
  const result = harness(config);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.hooks.some((hook) => hook.name === "agent_end"), false);
});

test("environment-only DeepSeek credentials enable ContextEngine automatic extraction", () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = "environment-secret";
    const result = harness({ conversationJournal: { enabled: true }, contextEngine: { enabled: true }, extraction: { enabled: true, autoExtract: true } });
    assert.equal(result.hooks.some((hook) => hook.name === "agent_end"), false);
    assert.equal(result.warnings.length, 0);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("registered tools use official execute signature and JSON text output", async () => {
  const result = harness({ dbPath: ":memory:" });
  const stats = result.tools.find((tool) => tool.name === "kg_stats");
  const output = await stats.execute("call-1", {});
  assert.equal(Object.keys(output).length, 1);
  assert.deepEqual(JSON.parse(output.content[0].text), { nodes: { total: 0, by_type: {} }, edges: { total: 0, by_type: {}, by_layer: { structural: 0, semantic: 0 } }, observations: { total: 0 }, density: 0, updated_at: null });
});

test("kg_related filters unsupported relationship types before graph traversal", async () => {
  let received;
  const graph = {
    kg_related(...args) { received = args; return { nodes: [], edges: [] }; },
    close() {}
  };
  const related = createOpenClawToolDefinitions(() => graph).find((tool) => tool.name === "kg_related");
  await related.execute("call-related", { entity: "Acme", edge_types: ["works_at", "invented_type", "partners_with"] });
  assert.deepEqual(received[2], ["works_at", "partners_with"]);
});

test("plugin runtime logs only bounded embedding failure metadata and remains fail-open", async () => {
  const previousFetch = globalThis.fetch;
  const warnings = [];
  globalThis.fetch = async () => new Response("secret provider body", { status: 503 });
  const runtime = new PluginRuntime({ dbPath: ":memory:", embeddings: { enabled: true } }, {
    warn(message, fields) { warnings.push([message, fields]); }
  });
  const graph = runtime.openGraph();
  try {
    graph.store.ingest([{ name: "SECRET NODE TEXT", type: "company", confidence: 1, evidence_span: "SECRET EVIDENCE" }], [], "secret-source");
    const result = await graph.kg_embed_backfill();
    assert.deepEqual(result, { processed: 1, embedded: 0, failed: 1, next_after_id: null });
    assert.deepEqual(warnings, [["embedding batch failed", { operation: "backfill", category: "provider", failed: 1 }]]);
    assert.doesNotMatch(JSON.stringify(warnings), /secret|503|body|node text|evidence/i);
  } finally {
    graph.close();
    runtime.stop();
    globalThis.fetch = previousFetch;
  }
});
