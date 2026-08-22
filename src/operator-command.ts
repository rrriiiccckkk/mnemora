import type { PluginRuntime } from "./plugin-runtime.js";
import { mnemoraVersion } from "./version.js";

export type MnemoraOperatorOutcome = { level: "info" | "warning"; message: string };

/** Minimal operator surface. It does not add a hook, capture path, or mutation. */
export async function runMnemoraOperatorCommand(runtime: PluginRuntime, raw: string): Promise<MnemoraOperatorOutcome> {
  const args = raw.trim().split(/\s+/u).filter(Boolean);
  const command = args[0]?.toLowerCase() || "status";
  const graph = runtime.openGraph();
  if (command === "status" || command === "doctor") {
    const corpus = graph.kg_memory({ operation: "corpus_status" }) as { status: string; documents: number; chunks: number };
    const engine = runtime.contextEngine ? "selected" : "manual-only";
    const note = command === "doctor" && corpus.status === "configuration_required" ? "; corpus needs workspaceRoot" : "";
    return { level: corpus.status === "configuration_required" && command === "doctor" ? "warning" : "info", message: `Mnemora v${mnemoraVersion}: ContextEngine ${engine}; corpus ${corpus.status} (${corpus.documents} documents, ${corpus.chunks} chunks)${note}.` };
  }
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
}

function help(): MnemoraOperatorOutcome { return { level: "warning", message: "Mnemora: use /mnemora status, /mnemora doctor, /mnemora corpus sync, or /mnemora corpus search <query>." }; }
