import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import plugin from "../dist/plugin.js";
import { CORE_TOOL_NAMES, RESEARCH_TOOL_NAMES } from "../dist/openclaw.js";

const expectedTools = ["kg_compare", "kg_context", "kg_digest", "kg_embed_backfill", "kg_export", "kg_forget", "kg_import", "kg_ingest", "kg_ingest_batch", "kg_ingest_file", "kg_ingest_url", "kg_insights", "kg_integrations", "kg_memory", "kg_merge", "kg_merge_undo", "kg_profile", "kg_profile_lock", "kg_query", "kg_query_history", "kg_recall_canary", "kg_recall_explain", "kg_recall_metrics", "kg_related", "kg_review", "kg_scopes", "kg_search", "kg_sources", "kg_stats", "kg_timeline", "kg_verify", "kg_watch"];
const expectedCoreTools = [...CORE_TOOL_NAMES].sort();
const expectedResearchTools = [...RESEARCH_TOOL_NAMES].sort();
const structuralSchema = (value) => Array.isArray(value) ? value.map(structuralSchema) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !["description", "title", "default"].includes(key)).map(([key, child]) => [key, structuralSchema(child)]))
  : value;

function activate(entry, pluginConfig) {
  const tools = [], hooks = [], contextEngines = [];
  const api = {
    pluginConfig,
    logger: { debug() {}, warn() {} },
    registerTool(tool) { tools.push(tool.name); },
    registerCommand() {},
    on(name) { hooks.push(name); },
    registerContextEngine(id) { contextEngines.push(id); }
  };
  entry.register(api);
  return { tools: tools.sort(), hooks: hooks.sort(), contextEngines: contextEngines.sort() };
}

export function validateAdvancedPlugin({ manifest, pkg, plugin: entry, readme }) {
  assert.equal(entry.id, manifest.id, "entry/manifest id mismatch");
  assert.equal(entry.name, manifest.name, "entry/manifest name mismatch");
  assert.equal(entry.description, manifest.description, "entry/manifest description mismatch");
  assert.equal(pkg.version, manifest.version, "package/manifest version mismatch");
  assert.deepEqual(structuralSchema(entry.configSchema.jsonSchema), structuralSchema(manifest.configSchema), "config schema differs from authoritative OpenClaw SDK entry schema");
  for (const config of [{}, { toolSurface: "core" }, { toolSurface: "research" }, { toolSurface: "full" }, { recall: { autoRecall: true } }, { llm: { apiKey: "x" }, extraction: { enabled: true, autoExtract: true } }, { cognition: { contextCompiler: { enabled: true, tokenBudget: 64, maxItems: 1 } } }, { cognition: { reflection: { enabled: true, maxJobsPerRun: 1, staleAfterDays: 1 } } }, { cognition: { graduation: { enabled: true } } }, { cognition: { reasoningRuntime: { verification: { enabled: true, maxJobsPerRun: 1 } } } }, { inspector: { maxGraphNodes: 1000, maxGraphEdges: 4000, maxGraphResponseBytes: 1048576, graphDeadlineMs: 1000 } }]) {
    assert.equal(entry.configSchema.safeParse(config).success, true, "config schema rejects a supported configuration");
  }
  assert.equal(entry.configSchema.safeParse({ recall: { autoRecall: "yes" } }).success, false, "config schema accepts invalid values");
  assert.deepEqual([...manifest.contracts.tools].sort(), expectedTools, "declared tool contracts mismatch");
  assert.equal("contextEngine" in manifest.contracts, false, "ContextEngine contract is forbidden");
  assert.deepEqual(pkg.openclaw.extensions, ["./dist/plugin.js"], "package entry metadata mismatch");

  const cases = [
    [{}, ["gateway_stop"], expectedTools],
    [{ toolSurface: "core" }, ["gateway_stop"], expectedCoreTools],
    [{ toolSurface: "research" }, ["gateway_stop"], expectedResearchTools],
    [{ recall: { autoRecall: true } }, ["gateway_stop"], expectedTools],
    [{ llm: { apiKey: "x" }, extraction: { enabled: true, autoExtract: true } }, ["gateway_stop"], expectedTools],
    [{ llm: { apiKey: "x" }, extraction: { enabled: true, autoExtract: true }, recall: { autoRecall: true } }, ["gateway_stop"], expectedTools]
  ];
  for (const [config, expectedHooks, expectedRegisteredTools] of cases) {
    const activated = activate(entry, config);
    assert.deepEqual(activated.tools, expectedRegisteredTools, "registered tool contracts mismatch");
    assert.deepEqual(activated.hooks, expectedHooks, "hook activation mismatch");
  }
  assert.match(readme, /ContextEngine lifecycle/i, "single ContextEngine lifecycle must be documented");
  assert.match(readme, /registers no `before_prompt_build` or `agent_end` hook/i, "removed hooks must be documented");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  validateAdvancedPlugin({ manifest, pkg, plugin, readme });
  console.log("advanced OpenClaw plugin validation ok");
}
