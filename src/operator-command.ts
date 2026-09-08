import type { PluginRuntime } from "./plugin-runtime.js";
import { mnemoraVersion } from "./version.js";
import { ConversationEventRepository } from "./journal/repository.js";
import { firstUseVerification } from "./standalone/first-use.js";
import { FirstUseVerificationRepository } from "./standalone/first-use-repository.js";

export type MnemoraOperatorOutcome = { level: "info" | "warning"; message: string };

/** Minimal operator surface. It does not add a hook, capture path, or mutation. */
export async function runMnemoraOperatorCommand(runtime: PluginRuntime, raw: string): Promise<MnemoraOperatorOutcome> {
  const args = raw.trim().split(/\s+/u).filter(Boolean);
  const command = args[0]?.toLowerCase() || "status";
  const graph = runtime.openGraph();
  try {
    if (command === "status" || command === "doctor") {
      const corpus = graph.kg_memory({ operation: "corpus_status" }) as { status: string; documents: number; chunks: number };
      const engine = runtime.contextEngine ? "selected" : "manual-only";
      const note = command === "doctor" && corpus.status === "configuration_required" ? "; corpus needs workspaceRoot" : "";
      return { level: corpus.status === "configuration_required" && command === "doctor" ? "warning" : "info", message: `Mnemora v${mnemoraVersion}: ContextEngine ${engine}; corpus ${corpus.status} (${corpus.documents} documents, ${corpus.chunks} chunks)${note}.` };
    }
    if (command === "verify" && args.length === 1) return firstUseOutcome(runtime, graph);
    if (command === "verify" && args[1]?.toLowerCase() === "start" && args.length === 2) return startFirstUseVerification(runtime, graph);
    if (command === "corpus" && args[1]?.toLowerCase() === "sync") {
      const result = await graph.kg_memory({ operation: "corpus_sync" }) as { status: string; indexed: number; unchanged: number; removed: number; skipped: number };
      return { level: result.status === "ready" ? "info" : "warning", message: `Mnemora corpus ${result.status}: indexed ${result.indexed}, unchanged ${result.unchanged}, removed ${result.removed}, skipped ${result.skipped}.` };
    }
    if (command === "corpus" && args[1]?.toLowerCase() === "search") {
      const query = raw.trim().split(/\s+/u).slice(2).join(" ").slice(0, 512);
      if (!query) return help();
      const result = await graph.kg_memory({ operation: "corpus_search", query }) as { status: string; results: Array<{ citation: string }> };
      const first = result.results[0]?.citation;
      return { level: result.status === "ready" ? "info" : "warning", message: `Mnemora corpus search: ${result.results.length} citation${result.results.length === 1 ? "" : "s"}${first ? `; first ${first}` : ""}.` };
    }
    return help();
  } finally { graph.close(); }
}

function firstUseOutcome(runtime: PluginRuntime, graph: ReturnType<PluginRuntime["openGraph"]>): MnemoraOperatorOutcome {
  const scope = runtime.config.scope?.default ?? "default", journal = new ConversationEventRepository(graph.store.db, {
    maxInlineChars: runtime.config.conversationJournal?.maxInlineChars ?? 16000,
    maxEventBytes: runtime.config.conversationJournal?.maxEventBytes ?? 262144,
    sensitiveContentPolicy: runtime.config.conversationJournal?.sensitiveContentPolicy ?? "redact"
  });
  const recall = graph.unifiedRecallShadow.list(scope).summary;
  const acceptance = new FirstUseVerificationRepository(graph.store.db).status(scope);
  const result = firstUseVerification({
    contextEngineActive: runtime.standalone.activation === "ready",
    unifiedRetrievalEnabled: runtime.config.unifiedRetrieval?.enabled === true,
    recallTelemetryEnabled: runtime.config.unifiedRetrieval?.shadowMode === true,
    activity: journal.activity(scope),
    recall: { totalRuns: recall.total_runs, attachedRuns: recall.attached_runs }, acceptance
  });
  const markers: Record<import("./standalone/first-use.js").FirstUseCheckState, string> = { passed: "✓", pending: "○", blocked: "!" };
  const lines = result.checks.map(check => `${markers[check.state]} ${label(check.id)}: ${check.detail}`);
  return { level: result.complete ? "info" : "warning", message: `Mnemora first-use verification: ${result.passed}/${result.total} checks complete.\n${lines.join("\n")}\nNext: ${result.nextStep}` };
}

function startFirstUseVerification(runtime: PluginRuntime, graph: ReturnType<PluginRuntime["openGraph"]>): MnemoraOperatorOutcome {
  const scope = runtime.config.scope?.default ?? "default", started = new FirstUseVerificationRepository(graph.store.db).start(scope);
  return { level: "info", message: `Mnemora first-use verification started. Within one hour, include this exact marker in a fact in one conversation, then ask about it in a different conversation:\n${started.marker}\nRun /mnemora verify after the actual attachment.` };
}

function label(id: import("./standalone/first-use.js").FirstUseCheckId): string {
  return ({ context_engine: "ContextEngine", capture: "Capture", cross_session: "Cross-session", recall: "Recall" })[id];
}

function help(): MnemoraOperatorOutcome { return { level: "warning", message: "Mnemora: use /mnemora status, /mnemora verify, /mnemora verify start, /mnemora doctor, /mnemora corpus sync, or /mnemora corpus search <query>." }; }
