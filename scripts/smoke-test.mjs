import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import plugin from "../dist/plugin.js";
import { Mnemora, createInspectorApplication, startInspector } from "../dist/index.js";

const tmpRoot = join(process.cwd(), ".tmp");
mkdirSync(tmpRoot, { recursive: true });
const dir = mkdtempSync(join(tmpRoot, "smoke-"));
const dbPath = join(dir, "kg.db");
const extraction = {
  entities: [
    { name: "Murata", type: "company", description: "MLCC supplier", aliases: [], confidence: 0.95, evidence_span: "Murata supplies MLCC to Huawei" },
    { name: "MLCC", type: "product", description: "capacitor", aliases: [], confidence: 0.95, evidence_span: "Murata supplies MLCC to Huawei" },
    { name: "Huawei", type: "company", description: "customer", aliases: [], confidence: 0.95, evidence_span: "Murata supplies MLCC to Huawei" }
  ],
  relations: [
    { source: "Murata", target: "MLCC", type: "supplies_product", confidence: 0.9, evidence_span: "Murata supplies MLCC", edge_props: {} },
    { source: "MLCC", target: "Huawei", type: "supplied_to", confidence: 0.9, evidence_span: "MLCC to Huawei", edge_props: {} }
  ]
};
const server = createServer((request, response) => {
  request.resume();
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(extraction) } }] }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const tools = [], hooks = [], contextEngines = [];
plugin.register({
  pluginConfig: { dbPath, conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, unifiedRetrieval: { enabled: true }, llm: { apiKey: "smoke", baseURL: `http://127.0.0.1:${address.port}/v1`, model: "smoke" }, extraction: { enabled: true, autoExtract: true } },
  logger: { debug() {}, warn() {} }, registerTool(value) { tools.push(value); }, registerCommand() {}, registerContextEngine(id, factory) { contextEngines.push({ id, factory }); }, on(name, handler) { hooks.push({ name, handler }); }
});
const tool = (name) => tools.find((value) => value.name === name);
const hook = (name) => hooks.find((value) => value.name === name).handler;
const execute = async (name, params) => JSON.parse((await tool(name).execute(`smoke-${name}`, params)).content[0].text);
try {
  if (tools.length !== 32) throw new Error(`expected thirty-two tools, received ${tools.length}`);
  if (hooks.some((value) => value.name === "before_prompt_build" || value.name === "agent_end")) throw new Error("legacy hook registered");
  if (!hooks.some((value) => value.name === "gateway_stop")) throw new Error("missing gateway_stop hook");
  const engine = contextEngines.find(value => value.id === "mnemora")?.factory({ config: { plugins: { slots: { contextEngine: "mnemora" } } } });
  if (!engine) throw new Error("missing ContextEngine");
  await execute("kg_ingest", { text: "Murata supplies MLCC to Huawei", source: "smoke-manual" });
  const search = await execute("kg_search", { query: "MLCC" });
  const profile = await execute("kg_profile", { subject: "Murata" });
  const canary = await execute("kg_recall_canary", { operation: "status" });
  const recallExplain = await execute("kg_recall_explain", { query: "Who supplies MLCC?" });
  const scopes = await execute("kg_scopes", { limit: 5 });
  const related = await execute("kg_related", { entity: "MLCC", depth: 1, edge_types: ["supplies_product"], direction: "in" });
  if (search.length === 0) throw new Error("expected MLCC search result");
  if (profile.status !== "ok" || !profile.fields.some((field) => field.key === "supplies_product")) throw new Error("expected read-only evidence-backed profile");
  if (canary.configured !== false || canary.active !== false) throw new Error("expected adaptive recall canary to default off");
  if (recallExplain.trace_version !== "recall-explain-v1" || !Array.isArray(recallExplain.candidates)) throw new Error("expected bounded recall explanation");
  if (scopes.default_scope !== "default" || !Array.isArray(scopes.scopes) || scopes.scopes.some((scope) => Object.keys(scope).some((key) => !["id", "observations", "memory_documents", "updated_at"].includes(key)))) throw new Error("expected aggregate-only scope discovery");
  if (!related.semantic_labels.some((label) => label.source.name === "Murata" && label.predicate === "supplies_product")) throw new Error("expected Murata supplier label");
  const recall = await engine.assemble({ sessionId: "smoke", prompt: "Who supplies MLCC?", messages: [{ role: "user", content: "Who supplies MLCC?" }], tokenBudget: 800 });
  if (!recall.systemPromptAddition?.includes("Murata")) throw new Error("expected seeded graph recall");
  const messages = [{ id: "user", role: "user", content: "Murata supplies MLCC to Huawei" }, { id: "assistant", role: "assistant", content: "Recorded." }];
  await engine.afterTurn({ sessionId: "smoke", prePromptMessageCount: 0, messages });
  const beforeReplay = await execute("kg_stats", {});
  await engine.afterTurn({ sessionId: "smoke", prePromptMessageCount: 0, messages });
  const afterReplay = await execute("kg_stats", {});
  if (afterReplay.observations.total !== beforeReplay.observations.total) throw new Error("automatic extraction replay duplicated observations");
  const inspectorGraph = new Mnemora({ config: { dbPath } });
  const inspector = await startInspector({ graph: createInspectorApplication({ graph: inspectorGraph, allowOperations: false, artifactDirectory: dir }), allowOperations: false });
  try {
    const shell = await fetch(inspector.url);
    if (shell.status !== 200 || !shell.headers.get("content-security-policy") || !((await shell.text()).includes("Mnemora Inspector"))) throw new Error("Inspector smoke failed");
  } finally { await inspector.close(); inspectorGraph.close(); }
  console.log("smoke ok");
} finally {
  await hook("gateway_stop")();
  await new Promise((resolve) => server.close(resolve));
}
