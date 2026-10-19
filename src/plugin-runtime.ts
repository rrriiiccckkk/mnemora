import { AutoExtractService, type SafeLogger } from "./auto-extract.js";
import { OperationFailureReporter } from "./operations/failure-ledger.js";
import { normalizeConfig } from "./config.js";
import type { EmbeddingConfig, MnemoraConfig } from "./index.js";
import { Mnemora } from "./tools.js";
import { InsightExplainer } from "./insights/explainer.js";
import { ConversationJournalService } from "./journal/service.js";
import type { JournalDerivedTaskKind, JournalTurnReceipt } from "./journal/types.js";
import { MnemoraContextEngine } from "./context-engine/engine.js";
import { standaloneReadiness, type StandaloneReadiness } from "./standalone/readiness.js";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { ConsolidationService } from "./consolidation/service.js";
import { ReflectionService } from "./cognition/reflection.js";
import type { Embedder } from "./embeddings.js";
import { HostEmbedder, selectHostEmbedding } from "./host-embeddings.js";
import type { CompletedTurn, ContextAssemblyInput } from "./context-engine/lifecycle.js";
import { sessionWriteDisposition } from "./journal/session-policy.js";
import { GraphHygieneService } from "./hygiene/service.js";

type SdkLogger = Pick<OpenClawPluginApi["logger"], "debug" | "info" | "warn">;
type UnknownRecord = Record<string, unknown>;
type ContextEngineFactoryContext = Parameters<Parameters<OpenClawPluginApi["registerContextEngine"]>[1]>[0];

const record = (value: unknown): UnknownRecord | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;

/**
 * The ContextEngine factory is the one public point at which Mnemora receives the
 * selected host configuration.  Derive enabled plugin IDs here rather than
 * treating a plugin-local advisory list as proof that legacy capture and
 * recall are off.  Unknown shapes intentionally contribute no IDs; the host
 * slot check remains the prerequisite for standalone activation.
 */
export function activePluginIdsFromHostConfig(value: unknown): string[] {
  const plugins = record(record(value)?.plugins);
  if (!plugins || plugins.enabled === false) return [];
  const allowed = Array.isArray(plugins.allow) ? new Set(plugins.allow.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(item => item.trim())) : undefined;
  const entries = record(plugins.entries), ids = new Set<string>(), disabled = new Set<string>();
  for (const [id, entry] of Object.entries(entries ?? {})) {
    const normalized = id.trim();
    if (!normalized) continue;
    if (record(entry)?.enabled === false) { disabled.add(normalized); continue; }
    if (!allowed || allowed.has(normalized)) ids.add(normalized);
  }
  for (const id of allowed ?? []) if (!disabled.has(id)) ids.add(id);
  return [...ids].sort();
}

class RuntimeStoppedError extends Error {
  override readonly name = "RuntimeStoppedError";
}

function safeLogger(logger: SdkLogger): SafeLogger {
  const invoke = (level: "debug" | "info" | "warn", message: string, fields: Record<string, unknown> = {}) => {
    // The public SDK logger accepts a single string. A second argument is lost.
    const scalars = Object.fromEntries(Object.entries(fields).slice(0, 32).flatMap<[string, string | number | boolean | null]>(([key, value]) => {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) return [];
      if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return [[key, value]];
      if (typeof value === "string") return [[key, value.slice(0, 256)]];
      return [];
    }));
    try { logger[level]?.(message.slice(0, 512) + (Object.keys(scalars).length ? ` ${JSON.stringify(scalars)}` : "")); } catch { /* logging is fail-open */ }
  };
  return { debug: (message, fields) => invoke("debug", message, fields), info: (message, fields) => invoke("info", message, fields), warn: (message, fields) => invoke("warn", message, fields) };
}

export class PluginRuntime {
  readonly config: MnemoraConfig;
  readonly extract?: AutoExtractService;
  readonly journal?: ConversationJournalService;
  readonly contextEngine?: MnemoraContextEngine;
  standalone: StandaloneReadiness;
  private contextEngineSlotBound = false;
  readonly consolidationEnabled: boolean;
  readonly reflectionEnabled: boolean;
  readonly explainer: InsightExplainer;
  private readonly logger: SafeLogger;
  /** One reporter per runtime: counts survive per-operation graph handles. */
  readonly failures: OperationFailureReporter;
  private stopped = false;
  private readonly shutdown = new AbortController();

  /** Set when `embeddings.provider` is `host` and OpenClaw memory search has a provider. */
  private readonly hostEmbedder?: Embedder;

  constructor(input: Partial<MnemoraConfig> | undefined, logger: SdkLogger, hostConfig?: unknown) {
    const config = normalizeConfig(input);
    const safe = safeLogger(logger);
    if (config.embeddings?.enabled && config.embeddings.provider === "host") {
      const selection = selectHostEmbedding(hostConfig, config.scope?.defaultAgentId ?? "main");
      if (selection.ok) {
        config.embeddings = { ...config.embeddings, provider: selection.provider as `host:${string}`, model: selection.model };
        this.hostEmbedder = new HostEmbedder(selection);
        safe.info?.("embeddings use the OpenClaw memory-search provider", { provider: selection.provider, model: selection.model });
      } else {
        config.embeddings = { ...config.embeddings, enabled: false };
        safe.warn?.("host embeddings unavailable; recall stays lexical", { reason: selection.reason });
      }
    }
    this.config = config;
    this.logger = safe;
    this.failures = new OperationFailureReporter({ warn: (message, fields) => safe.warn?.(message, fields) });
    this.explainer = new InsightExplainer(this.config, fetch, this.shutdown.signal);
    const deps = { config: this.config, openGraph: () => this.openGraph(), openGraphForAdmitted: () => this.openGraphForAdmitted(), logger: safe, signal: this.shutdown.signal };
    if (this.config.extraction?.autoExtract && this.config.contextEngine?.enabled) {
      if (this.config.extraction.enabled && (this.config.llm?.apiKey || process.env.DEEPSEEK_API_KEY)) this.extract = new AutoExtractService(deps);
      else safe.warn?.("automatic extraction disabled: extraction must be enabled and an API key configured", {});
    } else if (this.config.extraction?.autoExtract) {
      safe.warn?.("automatic extraction disabled: ContextEngine must be enabled", {});
    }
    if (this.config.conversationJournal?.enabled || this.config.contextEngine?.enabled || (this.config.episodicMemory?.enabled && this.config.episodicMemory.autoExtract)) this.journal = new ConversationJournalService(this.config, () => this.openSharedGraph(), () => this.derivedTaskKinds());
    if (this.config.contextEngine?.enabled) this.contextEngine = new MnemoraContextEngine(this.config, () => this.openSharedGraph(), undefined, {
      derivedTaskKinds: () => this.derivedTaskKinds(),
      onCompletedTurn: (turn, receipt) => this.handleContextCompletedTurn(turn, receipt),
      // Context capture must fail open for the host. Keep the corresponding
      // gateway signal bounded as well: no host message content or provider
      // error body crosses this observability boundary.
      onCaptureFailure: event => safe.warn?.("ContextEngine capture skipped", event),
      failures: this.failures
    });
    this.standalone = standaloneReadiness(this.config, this.config.standalone?.activePluginIds);
    this.consolidationEnabled = this.config.consolidation?.enabled === true;
    this.reflectionEnabled = this.config.cognition?.reflection?.enabled === true;
    const autoExtract = this.extract !== undefined;
    const conversationJournal = this.journal !== undefined;
    const contextEngine = this.contextEngine !== undefined;
    const episodicMemory = this.config.episodicMemory?.enabled === true;
    safe.info?.("automatic lifecycle configured", {
      autoExtract,
      conversationJournal,
      contextEngine,
      episodicMemory,
      ...(this.consolidationEnabled ? { consolidation: true } : {}),
      ...(this.reflectionEnabled ? { reflection: true } : {}),
      ...(this.config.unifiedRetrieval?.enabled ? { unifiedRetrieval: true, recallTokenBudget: this.config.unifiedRetrieval.tokenBudget } : {}),
      ...(autoExtract ? { extractionTimeoutMs: this.config.extraction?.timeoutMs } : {})
    });
    safe.info?.("standalone readiness evaluated", { activation: this.standalone.activation, diagnostics: this.standalone.diagnostics.length });
  }

  isExcludedAgent(agentId: string | undefined): boolean {
    return Boolean(agentId && this.config.recall?.excludedAgentIds?.includes(agentId.toLowerCase()));
  }

  activateContextEngine(context: ContextEngineFactoryContext): ContextEngine {
    if (!this.contextEngine) throw new RuntimeStoppedError("Mnemora ContextEngine is disabled");
    if (this.config.mode === "standalone") {
      const slot = context.config?.plugins?.slots?.contextEngine;
      if (slot !== "mnemora") throw new Error("standalone_context_engine_slot_unconfirmed");
      const activePluginIds = [...new Set([...(this.config.standalone?.activePluginIds ?? []), ...activePluginIdsFromHostConfig(context.config)])];
      this.standalone = standaloneReadiness(this.config, activePluginIds, true);
      if (this.standalone.activation !== "ready") {
        this.logger.warn?.("standalone ContextEngine activation blocked", { diagnostics: this.standalone.diagnostics.length });
        throw new Error("standalone_context_engine_activation_blocked");
      }
      this.contextEngineSlotBound = true;
      this.logger.info?.("standalone ContextEngine slot confirmed", { activation: this.standalone.activation, conflictingMemoryPluginsDetected: activePluginIds.filter(id => ["lossless-claw", "memory-lancedb-pro"].includes(id)).length });
    } else this.contextEngineSlotBound = true;
    return this.contextEngine;
  }

  openGraph(): Mnemora {
    if (this.stopped) throw new RuntimeStoppedError("Mnemora runtime stopped");
    return new Mnemora({
      config: this.config,
      ...(this.hostEmbedder ? { embedder: this.hostEmbedder } : {}),
      signal: this.shutdown.signal,
      failures: this.failures,
      onRecallEvaluationFailure: (event) => this.logger.warn?.("recall evaluation failed", event),
      onSemanticClassification: (event) => this.logger.info?.("semantic classification observed", { ...event })
    });
  }

  /**
   * One long-lived connection for the per-turn hot path (journal capture and
   * ContextEngine). Opening a fresh Mnemora for every ingest/assemble/afterTurn
   * re-ran migrations and leaked native statement handles (and their file
   * descriptors) until GC. Callers still call close(); the shared handle
   * ignores it and the runtime closes the connection on stop().
   */
  private sharedGraph?: Mnemora;
  private sharedGraphHandle?: Mnemora;
  private openSharedGraph(): Mnemora {
    if (this.stopped) throw new RuntimeStoppedError("Mnemora runtime stopped");
    if (!this.sharedGraph || !this.sharedGraphHandle) {
      const graph = this.openGraph();
      this.sharedGraph = graph;
      this.sharedGraphHandle = new Proxy(graph, {
        get(target, property) {
          if (property === "close") return () => undefined;
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
      });
    }
    return this.sharedGraphHandle;
  }

  private openGraphForAdmitted(): Mnemora {
    return new Mnemora({ config: this.config, ...(this.hostEmbedder ? { embedder: this.hostEmbedder } : {}), signal: this.shutdown.signal, failures: this.failures, onSemanticClassification: (event) => this.logger.info?.("semantic classification observed", { ...event }) });
  }

  runConsolidation(): void {
    if (!this.config.consolidation?.enabled) return;
    const graph = this.openGraph();
    try { const service = new ConsolidationService(graph.store.db); service.schedule(this.config.scope!.default!); const result = service.run({ scope: this.config.scope!.default!, maxJobs: this.config.consolidation.maxJobsPerRun, leaseMs: this.config.consolidation.leaseMs, proposalTtlDays: this.config.consolidation.proposalTtlDays, staleAfterDays: this.config.consolidation.staleAfterDays, signal: this.shutdown.signal }); this.logger.debug?.("consolidation shadow completed", { claimed: result.claimed, proposed: result.proposed }); }
    catch { this.logger.warn?.("consolidation shadow failed", { category: "operation_failed" }); }
    finally { graph.close(); }
  }

  runReflection(): void {
    if (!this.config.cognition?.reflection?.enabled) return;
    const graph = this.openGraph();
    try {
      const service = new ReflectionService(graph.store.db);
      const preview = service.preview({ scope: this.config.scope!.default!, staleAfterDays: this.config.cognition.reflection.staleAfterDays });
      const result = service.runPreview({ scope: preview.scope, previewHash: preview.preview_hash, staleAfterDays: this.config.cognition.reflection.staleAfterDays, maxJobs: this.config.cognition.reflection.maxJobsPerRun, signal: this.shutdown.signal });
      this.logger.debug?.("reflection completed", { queued: result.queued, proposed: result.proposed });
    } catch { this.logger.warn?.("reflection failed", { category: "operation_failed" }); }
    finally { graph.close(); }
  }

  /** Opt-in review maintenance after a durable turn; no graph fact is ever changed here. */
  runGraphHygiene(): void {
    if (!this.config.quality?.hygiene?.enabled) return;
    const graph = this.openGraph();
    try {
      const policy = this.config.quality.hygiene;
      const result = new GraphHygieneService(graph.store).run({ scope: this.config.scope!.default!, policy: {
        intervalHours: policy.intervalHours ?? 168,
        maxDuplicateScanNodes: policy.maxDuplicateScanNodes ?? 100,
        relatedToWarningRatio: policy.relatedToWarningRatio ?? .4,
        relatedToWarningMinimumEdges: policy.relatedToWarningMinimumEdges ?? 20
      } });
      if (result.status !== "not_due") this.logger.info?.("graph hygiene completed", { status: result.status, duplicateCandidates: result.report.pending_duplicate_candidates, selfLinks: result.report.suspicious_self_links });
    } catch { this.logger.warn?.("graph hygiene failed", { category: "operation_failed" }); }
    finally { graph.close(); }
  }

  async processCompletedTurn(turn: CompletedTurn, receipt: JournalTurnReceipt): Promise<void> {
    if (this.isExcludedAgent(turn.agentId)) {
      this.logger.debug?.("automatic turn processing skipped for excluded agent", { agentId: turn.agentId! });
      return;
    }
    const sessionDisposition = sessionWriteDisposition(turn.sessionId, this.config.conversationJournal);
    if (sessionDisposition !== "writable") {
      this.logger.debug?.("automatic turn processing skipped by session write policy", { disposition: sessionDisposition });
      return;
    }
    // A durable receipt is the idempotency boundary for all derived work. A
    // replay must never call the extractor, consolidation, or reflection again.
    if (!receipt.inserted) return;
    if (this.extract) {
      const owner = `extract:${receipt.commitId}`;
      const [task] = this.journal ? this.journal.claimDerivedTask(receipt, "auto_extract", owner) : [];
      if (task) {
        const outcome = await this.extract.handle(turn);
        if (this.journal) this.journal.finishDerivedTask(receipt, task.id, owner, outcome.status === "succeeded" ? "succeeded" : "failed", outcome.status === "failed" ? "extraction_failed" : undefined);
      }
    }
    this.runConsolidation();
    this.runReflection();
    this.runGraphHygiene();
  }

  private async handleContextCompletedTurn(turn: CompletedTurn, receipt: JournalTurnReceipt): Promise<void> {
    await this.journal?.processCapturedTurn(receipt, turn.runtimeLlm, turn.signal);
    await this.processCompletedTurn(turn, receipt);
  }

  private derivedTaskKinds(): JournalDerivedTaskKind[] {
    return [
      ...(this.extract ? ["auto_extract" as const] : []),
      ...(this.config.episodicMemory?.enabled && this.config.episodicMemory.autoExtract
        ? this.config.episodicMemory.smartExtraction?.enabled ? ["smart_episode" as const] : ["episode" as const]
        : [])
    ];
  }

  stop(): void {
    this.stopped = true;
    this.shutdown.abort(new RuntimeStoppedError("Mnemora runtime stopped"));
    const shared = this.sharedGraph;
    this.sharedGraph = undefined; this.sharedGraphHandle = undefined;
    try { shared?.close(); } catch { /* already closed */ }
  }
}
