import { AutoExtractService, type SafeLogger } from "./auto-extract.js";
import { normalizeConfig } from "./config.js";
import type { EmbeddingConfig, MnemoraConfig } from "./index.js";
import { Mnemora } from "./tools.js";
import { InsightExplainer } from "./insights/explainer.js";
import { ConversationJournalService } from "./journal/service.js";
import type { JournalDerivedTaskKind, JournalTurnReceipt } from "./journal/types.js";
import { MnemoraContextEngine } from "./context-engine/engine.js";
import { standaloneReadiness, type StandaloneReadiness } from "./standalone/readiness.js";
import type { ContextEngine, ContextEngineFactoryContext } from "openclaw/plugin-sdk";
import { ConsolidationService } from "./consolidation/service.js";
import { ReflectionService } from "./cognition/reflection.js";
import { ReasoningRuntimeShadowService, type ReasoningRuntimeTelemetryConfig } from "./cognition/reasoning-runtime-telemetry.js";
import { ReasoningGovernedDeliveryService, ReasoningRuntimeGovernanceRepository, type ReasoningRuntimeGovernanceConfig } from "./cognition/reasoning-runtime-governance.js";
import { ReasoningVerificationService } from "./cognition/reasoning-verification.js";
import { ReasoningCurationService, type ReasoningFormationConfig, type ReasoningReviewConfig } from "./cognition/reasoning-curation.js";
import { ReasoningIntakeService, type ReasoningIntakeConfig } from "./cognition/reasoning-intake.js";
import { LocalReasoningSemanticProvider } from "./cognition/reasoning-semantic-embeddings.js";
import { createEmbedder } from "./embeddings.js";
import type { CompletedTurn, ContextAssemblyInput } from "./context-engine/lifecycle.js";
import { sessionWriteDisposition } from "./journal/session-policy.js";
import { GraphHygieneService } from "./hygiene/service.js";

type Scalar = string | number | boolean | null | undefined;
type SdkLogger = { debug?(message: string, fields?: Record<string, unknown>): void; info?(message: string, fields?: Record<string, unknown>): void; warn?(message: string, fields?: Record<string, unknown>): void };
type UnknownRecord = Record<string, unknown>;

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
    const scalars = Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, Scalar] => entry[1] == null || ["string", "number", "boolean"].includes(typeof entry[1])));
    try { logger[level]?.(message, scalars); } catch { /* logging is fail-open */ }
  };
  return { debug: (message, fields) => invoke("debug", message, fields), info: (message, fields) => invoke("info", message, fields), warn: (message, fields) => invoke("warn", message, fields) };
}

export class PluginRuntime {
  readonly config: MnemoraConfig;
  readonly extract?: AutoExtractService;
  readonly journal?: ConversationJournalService;
  readonly contextEngine?: MnemoraContextEngine;
  standalone: StandaloneReadiness;
  readonly reasoningShadowEnabled: boolean;
  readonly reasoningDeliveryEnabled: boolean;
  readonly reasoningVerificationEnabled: boolean;
  readonly reasoningFormationEnabled: boolean;
  readonly reasoningReviewEnabled: boolean;
  readonly reasoningIntakeEnabled: boolean;
  private contextEngineSlotBound = false;
  readonly consolidationEnabled: boolean;
  readonly reflectionEnabled: boolean;
  readonly explainer: InsightExplainer;
  private readonly logger: SafeLogger;
  private stopped = false;
  private readonly shutdown = new AbortController();
  private readonly reasoningCadence = new Map<string, number>();

  constructor(input: Partial<MnemoraConfig> | undefined, logger: SdkLogger) {
    this.config = normalizeConfig(input);
    const safe = safeLogger(logger);
    this.logger = safe;
    this.explainer = new InsightExplainer(this.config, fetch, this.shutdown.signal);
    const deps = { config: this.config, openGraph: () => this.openGraph(), openGraphForAdmitted: () => this.openGraphForAdmitted(), logger: safe, signal: this.shutdown.signal };
    if (this.config.extraction?.autoExtract && this.config.contextEngine?.enabled) {
      if (this.config.extraction.enabled && (this.config.llm?.apiKey || process.env.DEEPSEEK_API_KEY)) this.extract = new AutoExtractService(deps);
      else safe.warn?.("automatic extraction disabled: extraction must be enabled and an API key configured", {});
    } else if (this.config.extraction?.autoExtract) {
      safe.warn?.("automatic extraction disabled: ContextEngine must be enabled", {});
    }
    if (this.config.conversationJournal?.enabled || this.config.contextEngine?.enabled || (this.config.episodicMemory?.enabled && this.config.episodicMemory.autoExtract)) this.journal = new ConversationJournalService(this.config, () => this.openGraph(), () => this.derivedTaskKinds());
    if (this.config.contextEngine?.enabled) this.contextEngine = new MnemoraContextEngine(this.config, () => this.openGraph(), undefined, {
      derivedTaskKinds: () => this.derivedTaskKinds(),
      onCompletedTurn: (turn, receipt) => this.handleContextCompletedTurn(turn, receipt),
      onAssemble: input => this.runReasoningRuntime(input),
      // Context capture must fail open for the host. Keep the corresponding
      // gateway signal bounded as well: no host message content or provider
      // error body crosses this observability boundary.
      onCaptureFailure: event => safe.warn?.("ContextEngine capture skipped", event)
    });
    this.standalone = standaloneReadiness(this.config, this.config.standalone?.activePluginIds);
    this.reasoningShadowEnabled = this.config.cognition?.reasoningRuntime?.shadowMode === true && (this.config.cognition.reasoningRuntime.scopes ?? []).includes(this.config.scope!.default!);
    this.reasoningDeliveryEnabled = this.config.cognition?.reasoningRuntime?.delivery?.enabled === true && (this.config.cognition.reasoningRuntime.delivery.scopes ?? []).includes(this.config.scope!.default!);
    this.reasoningVerificationEnabled = this.config.cognition?.reasoningRuntime?.verification?.enabled === true;
    this.reasoningFormationEnabled = this.config.cognition?.reasoningCuration?.formation?.enabled === true;
    this.reasoningReviewEnabled = this.config.cognition?.reasoningCuration?.review?.enabled === true;
    this.reasoningIntakeEnabled = this.config.cognition?.reasoningCuration?.intake?.enabled === true;
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
      ...(this.reasoningShadowEnabled ? { reasoningRuntimeShadow: true } : {}),
      ...(this.reasoningDeliveryEnabled ? { reasoningRuntimeDelivery: true } : {}),
      ...(this.reasoningVerificationEnabled ? { reasoningRuntimeVerification: true } : {}),
      ...(this.reasoningFormationEnabled ? { reasoningCurationFormation: true } : {}),
      ...(this.reasoningReviewEnabled ? { reasoningCurationReview: true } : {}),
      ...(this.reasoningIntakeEnabled ? { reasoningCurationIntake: true } : {}),
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
      signal: this.shutdown.signal,
      onEmbeddingFailure: (event) => this.logger.warn?.("embedding batch failed", event),
      onRecallEvaluationFailure: (event) => this.logger.warn?.("recall evaluation failed", event)
    });
  }

  private openGraphForAdmitted(): Mnemora {
    return new Mnemora({ config: this.config, signal: this.shutdown.signal, onEmbeddingFailure: (event) => this.logger.warn?.("embedding batch failed", event) });
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

  /** Runs only the bounded local verifier. It does not call a model, tool, or
   * provider; disabled mode leaves queued events intact for an operator run. */
  runReasoningVerification(): void {
    if (!this.reasoningVerificationEnabled) return;
    const graph = this.openGraph();
    try {
      const result = new ReasoningVerificationService(graph.store.db).run({ scope: this.config.scope!.default!, limit: this.config.cognition!.reasoningRuntime!.verification!.maxJobsPerRun });
      if (result.processed || result.expired) this.logger.debug?.("reasoning verification settled", { ...result });
    } catch { this.logger.warn?.("reasoning verification failed", { category: "operation_failed" }); }
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

  /** Curation is intentionally post-commit and host-runtime only. The model
   * can create advisory records, never a strategy mutation or admission. */
  async runReasoningCuration(turn: CompletedTurn): Promise<void> {
    if (!this.reasoningFormationEnabled && !this.reasoningReviewEnabled) return;
    if (!turn.runtimeLlm) {
      this.logger.debug?.("reasoning curation skipped: host runtime model unavailable", {});
      return;
    }
    const graph = this.openGraph();
    try {
      const service = new ReasoningCurationService(graph.store.db);
      const scope = this.config.scope!.default!, signal = turn.signal ?? this.shutdown.signal, curation = this.config.cognition!.reasoningCuration!;
      const formation = await service.runFormation({ scope, runtime: turn.runtimeLlm, config: curation.formation! as ReasoningFormationConfig, signal });
      const review = await service.runReview({ scope, runtime: turn.runtimeLlm, config: curation.review! as ReasoningReviewConfig, signal });
      if (formation.attempted || review.attempted) this.logger.info?.("reasoning curation completed", { formationProposals: formation.proposed, formationFailed: formation.failed, reviewProposals: review.proposed, reviewFailed: review.failed });
    } catch {
      this.logger.warn?.("reasoning curation failed", { category: "operation_failed" });
    } finally { graph.close(); }
  }

  /** Intake is opt-in and candidate-only. A completed turn is the durable
   * replay boundary; no model suggestion can bypass later human confirmation. */
  async runReasoningIntake(turn: CompletedTurn, receipt: JournalTurnReceipt): Promise<void> {
    if (!this.reasoningIntakeEnabled) return;
    const graph = this.openGraph();
    try {
      const config = this.config.cognition!.reasoningCuration!.intake! as ReasoningIntakeConfig;
      const result = await new ReasoningIntakeService(graph.store.db).capture({
        scope: receipt.scope,
        receipt,
        turn,
        runtime: turn.runtimeLlm,
        config,
        signal: turn.signal ?? this.shutdown.signal
      });
      if (result.status === "succeeded") {
        if (result.proposed) this.logger.info?.("reasoning intake completed", { proposed: result.proposed, skipped: result.skipped });
      } else this.logger.warn?.("reasoning intake skipped", { category: result.category });
    } catch {
      this.logger.warn?.("reasoning intake failed", { category: "operation_failed" });
    } finally { graph.close(); }
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
    this.runReasoningVerification();
    this.runGraphHygiene();
    await this.runReasoningIntake(turn, receipt);
    await this.runReasoningCuration(turn);
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

  async runReasoningRuntime(input: ContextAssemblyInput): Promise<string | undefined> {
    if (!(this.reasoningShadowEnabled || this.reasoningDeliveryEnabled)) return undefined;
    if (this.isExcludedAgent(input.agentId)) return undefined;
    const graph = this.openGraph(), value = this.config.cognition!.reasoningRuntime!;
    try {
      const config: ReasoningRuntimeGovernanceConfig = {
        tokenBudget: value.tokenBudget!, maxItems: value.maxItems!, minConfidence: value.minConfidence!, highRiskMinConfidence: value.highRiskMinConfidence!, minEvidenceQuality: value.minEvidenceQuality!, highRiskMinEvidenceQuality: value.highRiskMinEvidenceQuality!, maxStalenessDays: value.maxStalenessDays!, excludeConflicted: value.excludeConflicted!, retentionDays: value.retentionDays!,
        readiness: { minimumRuns: value.readiness!.minimumRuns!, maxErrorRate: value.readiness!.maxErrorRate!, maxEmptyRate: value.readiness!.maxEmptyRate!, maxP95Ms: value.readiness!.maxP95Ms! },
        delivery: { enabled: value.delivery!.enabled!, scopes: value.delivery!.scopes!, adapter: "openclaw", calibrationMaxAgeHours: value.delivery!.calibrationMaxAgeHours!, maxConsecutiveDeliveries: value.delivery!.maxConsecutiveDeliveries!, itemRetentionDays: value.delivery!.itemRetentionDays! },
        semantic: { enabled: value.semantic!.enabled!, timeoutMs: value.semantic!.timeoutMs!, minScore: value.semantic!.minScore!, maxCandidates: value.semantic!.maxCandidates! }
      };
      const signal = input.signal ?? this.shutdown.signal;
      const embeddingConfig = this.config.embeddings as EmbeddingConfig;
      const semantic = config.semantic?.enabled && embeddingConfig.enabled ? new LocalReasoningSemanticProvider(graph.store.db, createEmbedder(embeddingConfig), { minScore: config.semantic.minScore, maxVectorScan: embeddingConfig.maxVectorScanNodes }) : undefined;
      // The snapshot contains only normalized policy controls. It lets the
      // local operator calibrate the exact live runtime without reading host
      // configuration, and never records this request or any retrieved item.
      new ReasoningRuntimeGovernanceRepository(graph.store.db).observePolicy(this.config.scope!.default!, config);
      if (!this.reasoningDeliveryEnabled) {
        const shadow = new ReasoningRuntimeShadowService(graph.store.db, config as ReasoningRuntimeTelemetryConfig);
        if (semantic) await shadow.captureWithSemantic({ scope: this.config.scope!.default!, query: input.query, signal }, semantic, config.semantic!.timeoutMs, config.semantic!.maxCandidates); else shadow.capture({ scope: this.config.scope!.default!, query: input.query, signal });
        return undefined;
      }
      const consecutive = this.reasoningCadence.get(input.sessionId) ?? 0, delivery = new ReasoningGovernedDeliveryService(graph.store.db, config), output = semantic ? await delivery.handleWithSemantic({ scope: this.config.scope!.default!, query: input.query, signal }, semantic, config.semantic!.timeoutMs, config.semantic!.maxCandidates, { deliveryAllowed: consecutive < config.delivery.maxConsecutiveDeliveries }) : delivery.handle({ scope: this.config.scope!.default!, query: input.query, signal }, { deliveryAllowed: consecutive < config.delivery.maxConsecutiveDeliveries });
      if (output) this.reasoningCadence.set(input.sessionId, consecutive + 1); else this.reasoningCadence.set(input.sessionId, 0);
      if (this.reasoningCadence.size > 128) this.reasoningCadence.delete(this.reasoningCadence.keys().next().value!);
      return output?.appendSystemContext;
    } catch { this.logger.warn?.("reasoning runtime shadow failed", { category: "operation_failed" }); }
    finally { graph.close(); }
    return undefined;
  }

  stop(): void { this.stopped = true; this.shutdown.abort(new RuntimeStoppedError("Mnemora runtime stopped")); }
}
