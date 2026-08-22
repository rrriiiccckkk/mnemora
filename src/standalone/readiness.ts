import type { MnemoraConfig } from "../index.js";

export type StandaloneDiagnosticCode =
  | "conversation_journal_required"
  | "context_engine_required"
  | "episodic_memory_required"
  | "context_engine_slot_unconfirmed"
  | "legacy_hook_configuration_ignored"
  | "companion_memory_plugin_detected";

export interface StandaloneDiagnostic {
  code: StandaloneDiagnosticCode;
  severity: "info" | "warning" | "blocking";
  plugin_id?: string;
}

export interface StandaloneReadiness {
  mode: "standalone";
  activation: "ready" | "blocked";
  requirements: { conversationJournal: boolean; contextEngine: boolean; episodicMemory: boolean };
  diagnostics: StandaloneDiagnostic[];
}

const companionPlugins = new Set(["lossless-claw", "memory-lancedb-pro"]);

/**
 * Evaluates only caller-supplied public deployment metadata. It never probes a
 * Provider store or edits host configuration. The runtime uses the same result
 * to validate the one public ContextEngine lifecycle. Mnemora never falls back to
 * private stores or legacy hooks.
 */
export function standaloneReadiness(config: MnemoraConfig, activePluginIds: readonly string[] = [], contextEngineSlotBound = false): StandaloneReadiness {
  const mode = "standalone" as const;
  const requirements = {
    conversationJournal: config.conversationJournal?.enabled === true,
    contextEngine: config.contextEngine?.enabled === true,
    episodicMemory: config.episodicMemory?.enabled === true
  };
  const diagnostics: StandaloneDiagnostic[] = [];
  if (!requirements.conversationJournal) diagnostics.push({ code: "conversation_journal_required", severity: "blocking" });
  if (!requirements.contextEngine) diagnostics.push({ code: "context_engine_required", severity: "blocking" });
  if (requirements.contextEngine && !contextEngineSlotBound) diagnostics.push({ code: "context_engine_slot_unconfirmed", severity: "blocking" });
  if (!requirements.episodicMemory) diagnostics.push({ code: "episodic_memory_required", severity: "blocking" });
  if (config.recall?.autoRecall || config.recall?.injection?.mode !== "off") diagnostics.push({ code: "legacy_hook_configuration_ignored", severity: "info" });
  for (const pluginId of normalizedPluginIds(activePluginIds)) {
    if (companionPlugins.has(pluginId)) diagnostics.push({ code: "companion_memory_plugin_detected", severity: "blocking", plugin_id: pluginId });
  }
  const blocked = diagnostics.some(item => item.severity === "blocking");
  return {
    mode,
    activation: blocked ? "blocked" : "ready",
    requirements,
    diagnostics
  };
}

export function standaloneGuide(): { standalone: Record<string, unknown>; rollback: Record<string, Record<string, unknown>> } {
  return {
    standalone: {
      mode: "standalone",
      conversationJournal: { enabled: true },
      contextEngine: { enabled: true },
      episodicMemory: { enabled: true },
      // Standalone has one prompt producer: the ContextEngine. Enable its
      // unified retrieval explicitly instead of leaving the generated guide in
      // a journal-only mode that cannot replace long-term recall.
      unifiedRetrieval: { enabled: true, shadowMode: false }
    },
    rollback: { host_context_engine: { contextEngine: { enabled: false }, unifiedRetrieval: { enabled: false } } }
  };
}

function normalizedPluginIds(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => typeof value === "string").map(value => value.trim().toLowerCase()).filter(value => /^[a-z][a-z0-9-]{0,79}$/.test(value)))].slice(0, 20);
}
