import { createTempDir, runInTempProcess } from "../tests/helpers/temp.mjs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "../dist/plugin.js";
import { Mnemora, createInspectorApplication, startInspector } from "../dist/index.js";
export async function runSmoke() {
  const status = await runInTempProcess([fileURLToPath(import.meta.url), "--worker"]);
  if (status !== 0) throw Object.assign(new Error(`smoke worker failed (${status})`), { operationExitCode: status });
}

export async function runSmokeScenario({ registerPlugin = api => plugin.register(api) } = {}) {
    const dir = createTempDir("smoke-");
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
    const tools = [], hooks = [], contextEngines = [];
    let primary;
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      registerPlugin({
        pluginConfig: { dbPath, conversationJournal: { enabled: true }, contextEngine: { enabled: true }, episodicMemory: { enabled: true }, unifiedRetrieval: { enabled: true }, llm: { apiKey: "smoke", baseURL: `http://127.0.0.1:${address.port}/v1`, model: "smoke" }, extraction: { enabled: true, autoExtract: true } },
        logger: { debug() { }, warn() { } }, registerTool(value) { tools.push(value); }, registerCommand() { }, registerContextEngine(id, factory) { contextEngines.push({ id, factory }); }, on(name, handler) { hooks.push({ name, handler }); }
      });
      const tool = (name) => tools.find((value) => value.name === name);
      const execute = async (name, params) => JSON.parse((await tool(name).execute(`smoke-${name}`, params)).content[0].text);
      if (tools.length !== 32)
        throw new Error(`expected thirty-two tools, received ${tools.length}`);
      if (hooks.some((value) => value.name === "before_prompt_build" || value.name === "agent_end"))
        throw new Error("legacy hook registered");
      if (!hooks.some((value) => value.name === "gateway_stop"))
        throw new Error("missing gateway_stop hook");
      const engine = contextEngines.find(value => value.id === "mnemora")?.factory({ config: { plugins: { slots: { contextEngine: "mnemora" } } } });
      if (!engine)
        throw new Error("missing ContextEngine");
      await execute("kg_ingest", { text: "Murata supplies MLCC to Huawei", source: "smoke-manual" });
      const search = await execute("kg_search", { query: "MLCC" });
      const profile = await execute("kg_profile", { subject: "Murata" });
      const canary = await execute("kg_recall_canary", { operation: "status" });
      const recallExplain = await execute("kg_recall_explain", { query: "Who supplies MLCC?" });
      const scopes = await execute("kg_scopes", { limit: 5 });
      const related = await execute("kg_related", { entity: "MLCC", depth: 1, edge_types: ["supplies_product"], direction: "in" });
      if (search.length === 0)
        throw new Error("expected MLCC search result");
      if (profile.status !== "ok" || !profile.fields.some((field) => field.key === "supplies_product"))
        throw new Error("expected read-only evidence-backed profile");
      if (canary.configured !== false || canary.active !== false)
        throw new Error("expected adaptive recall canary to default off");
      if (recallExplain.trace_version !== "recall-explain-v1" || !Array.isArray(recallExplain.candidates))
        throw new Error("expected bounded recall explanation");
      if (scopes.default_scope !== "default" || !Array.isArray(scopes.scopes) || scopes.scopes.some((scope) => Object.keys(scope).some((key) => !["id", "observations", "memory_documents", "updated_at"].includes(key))))
        throw new Error("expected aggregate-only scope discovery");
      if (!related.semantic_labels.some((label) => label.source.name === "Murata" && label.predicate === "supplies_product"))
        throw new Error("expected Murata supplier label");
      const recall = await engine.assemble({ sessionId: "smoke", prompt: "Who supplies MLCC?", messages: [{ role: "user", content: "Who supplies MLCC?" }], tokenBudget: 800 });
      if (!recall.systemPromptAddition?.includes("Murata"))
        throw new Error("expected seeded graph recall");
      const messages = [{ id: "user", role: "user", content: "Murata supplies MLCC to Huawei" }, { id: "assistant", role: "assistant", content: "Recorded." }];
      await engine.afterTurn({ sessionId: "smoke", prePromptMessageCount: 0, messages });
      const beforeReplay = await execute("kg_stats", {});
      await engine.afterTurn({ sessionId: "smoke", prePromptMessageCount: 0, messages });
      const afterReplay = await execute("kg_stats", {});
      if (afterReplay.observations.total !== beforeReplay.observations.total)
        throw new Error("automatic extraction replay duplicated observations");
      const inspectorGraph = new Mnemora({ config: { dbPath } });
      let inspector;
      let inspectorError;
      try {
        inspector = await startInspector({ graph: createInspectorApplication({ graph: inspectorGraph, allowOperations: false, artifactDirectory: dir }), allowOperations: false });
        const shell = await fetch(inspector.url);
        if (shell.status !== 200 || !shell.headers.get("content-security-policy") || !((await shell.text()).includes("Mnemora Inspector")))
          throw new Error("Inspector smoke failed");
      }
      catch (error) {
        inspectorError = error;
        throw error;
      }
      finally {
        await cleanupResources([() => inspector?.close(), () => inspectorGraph.close()], inspectorError);
      }
      console.log("smoke ok");
    }
    catch (error) {
      primary = error;
      throw error;
    }
    finally {
      await cleanupResources([
        () => hooks.find(value => value.name === "gateway_stop")?.handler(),
        () => { if (server.listening) {
          server.closeAllConnections();
          return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        } }
      ], primary);
    }
}
async function cleanupResources(operations, primary) {
  const errors = [];
  for (const operation of operations)
    try {
      await operation();
    }
    catch (error) {
      errors.push(error);
    }
  if (errors.length)
    throw new AggregateError(primary ? [primary, ...errors] : errors, "smoke_cleanup_failed", { cause: primary ?? errors[0] });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--worker")) {
    if (!process.env.MNEMORA_TEST_TEMP_ROOT) throw new Error("managed_test_worker_required");
    await runSmokeScenario();
  } else await runSmoke();
}
