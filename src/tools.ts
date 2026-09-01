import { type MnemoraConfig, type EmbeddingConfig, type SearchMode } from "./index.js";
import { createExtractor, type ExtractOptions, type Extractor } from "./extractor.js";
import { createEmbedder, embeddingInput, embeddingInputVersion, memoryChunkEmbeddingInput, MEMORY_CHUNK_EMBEDDING_INPUT_VERSION, normalizeEmbeddingVector, type Embedder } from "./embeddings.js";
import { GraphologyStore, type IngestResult } from "./store.js";
import type { Direction, RelationshipType } from "./relationships.js";
import type { DuplicateCandidateStatus, ExtractionResult, KgContextResult, KgForgetResult, KgRelatedResult, KgScopesResult, KgSearchResult, KgSourceSummary, KgStatsResult, MergeResult, MergeUndoResult } from "./types.js";
import { createHash } from "node:crypto";
import { canonicalizeIngestionSource, fingerprintExtractedTemporal, fingerprintIngestion, INGESTION_FINGERPRINT_VERSION, normalizeIngestionText } from "./ingestion.js";
import type { BatchIngestionResult, IngestionItem, IngestionItemResult } from "./types.js";
import { lstat, open } from "node:fs/promises";
import { basename, extname } from "node:path";
import { canonicalizeUrl, fetchUrlResource, type SafeUrlErrorCategory, type UrlFetchResult } from "./url-ingestion.js";
import { rankQualityCandidates } from "./ranking.js";
import { personalizedPageRank } from "./ppr.js";
import { GraphAnalyticsService } from "./insights/service.js";
import { InsightExplainer } from "./insights/explainer.js";
import { normalizeConfig } from "./config.js";
import { QueryPlanner } from "./query/planner.js";
import type { KgInsightsInput, KgInsightsResult } from "./types.js";
import { GraphQueryService } from "./query/service.js";
import type { KgQueryResult } from "./query/types.js";
import { buildTimeline, type TimelineInput } from "./query/timeline.js";
import { compareSubjects, type CompareInput } from "./query/compare.js";
import { resolveCompareSubject } from "./query/subject-resolution.js";
import type { KgCompareResult, KgTimelineResult } from "./query/types.js";
import type { KgDigestInput, KgExportInput, KgImportInput, KgQueryHistoryInput, KgWatchInput } from "./types.js";
import { WatchService } from "./query/watch.js";
import { confirmJsonlImport, exportGraph, previewJsonlImport, type KgImportConfirmInput } from "./query/exchange.js";
import { confirmMemoryImport, exportMemoryDocuments, previewMemoryImport } from "./memory-exchange.js";
import { normalizeScope } from "./scope.js";
import { AdaptiveRecallCanaryService, AdaptiveRecallShadowService, AnchorVerificationRepository, AnchorVerificationService, ClaimVerificationService, createAnchorVerificationProvider, RecallCanaryRepository, RecallExplanationService, RecallPolicyService, RecallShadowRepository, RetrospectiveAuditService, SourceAnchorRepository, SourceAnchoringService, SourceLifecycleService, VerificationRepository, type AnchorVerificationProvider, type RecallCalibrationCriteria, type VerificationStatus } from "./trust/index.js";
import { BoundedCommandError, IntegrationStatusRepository, LosslessClawAdapter, MemoryLanceDbProAdapter, ProviderAdapterRegistry, ProviderMigrationAuditRepository, PublicProviderMigrationService, type CommandRunner, type IntegrationProviderId, type KgIntegrationInput, type KgIntegrationResult, type ProviderAdapterRegistration, type ProviderCapabilities, type ProviderSourceIngestionInput } from "./integrations/index.js";
import { ProfileHistoryRepository, ProfileHistoryService, ProfileProjectionRepository, ProfileProjectionService, ProfileSelectionRepository, ProfileSelectionService } from "./profiles/index.js";
import type { ProfileProjection, ProfileSelectionInput } from "./profiles/index.js";
import { VectorBackendCallError, VectorBackendRegistry, VectorBackendService, type VectorBackendRegistration } from "./vectors/index.js";
import { GovernanceRepository, GovernanceService, governanceRequestHash } from "./governance/index.js";
import { FormationService } from "./cognition/service.js";
import type { FormationAuthority } from "./cognition/admission.js";
import { PersonalContextCompiler } from "./cognition/context-compiler.js";
import { RecallFeedbackRepository } from "./cognition/reflection.js";
import { createMnemoraContextRef } from "./context/context-ref.js";
import { MemoryReranker } from "./retrieval/memory-reranker.js";
import { memoryMatchesTags, planRecallQuery } from "./retrieval/query-routing.js";
import { UnifiedRecallShadowRepository } from "./retrieval/unified-recall-shadow.js";
import { RecallDecayReviewService, RecallUsageRepository } from "./recall-lifecycle/repository.js";
import { CanonicalCorpusIndexer } from "./corpus/indexer.js";
import { isExclusiveUserMdPath, isExclusiveUserMdSource } from "./workspace-boundary.js";
import { ArtifactRepository } from "./artifacts/repository.js";
import { MemoryDocumentLifecycleService, type MemoryTier } from "./memory-lifecycle/service.js";
import { GraphHygieneService, type GraphHygienePolicy } from "./hygiene/service.js";
import { EmbeddingHealthRepository } from "./embedding-health/repository.js";
import { RelatedEdgeRefinementService } from "./related-edge-refinement/service.js";
import { RelatedEdgeSemanticService } from "./related-edge-semantics/service.js";
import { GraphReviewLifecycleRepository } from "./graph-review/lifecycle.js";
import { GraphReviewWorklistService, type GraphReviewWorklistStatus } from "./graph-review/worklist.js";

export type SemanticSearchUnavailableCategory = "disabled" | "timeout" | "aborted" | "provider" | "invalid_response" | "scale_limit";
export type ReviewStatus = DuplicateCandidateStatus | "invalidated";
export class SemanticSearchUnavailableError extends Error {
  constructor(readonly category: SemanticSearchUnavailableCategory, readonly count?: number) {
    super(`semantic search unavailable: ${category}${count == null ? "" : ` (${count})`}`);
    this.name = "SemanticSearchUnavailableError";
  }
}

/** Deterministic pre-admission may adjust only automatic evidence strength.
 * It never changes extracted shape, source text, or manual ingestion. */
const scaleAutomaticExtractionConfidence = (extraction: ExtractionResult, multiplier: number): ExtractionResult => {
  const bounded = Math.max(0, Math.min(1.25, multiplier));
  if (bounded === 1) return extraction;
  const confidence = (value: number) => Math.max(0, Math.min(1, value * bounded));
  return {
    ...extraction,
    entities: extraction.entities.map(entity => ({ ...entity, confidence: confidence(entity.confidence) })),
    relations: extraction.relations.map(relation => ({ ...relation, confidence: confidence(relation.confidence) }))
  };
};

export interface MnemoraOptions {
  config?: Partial<MnemoraConfig>;
  extractor?: Extractor;
  embedder?: Embedder;
  signal?: AbortSignal;
  onEmbeddingFailure?: (event: { operation: "ingest" | "backfill" | "memory_backfill"; category: "timeout" | "provider" | "invalid_response" | "persistence" | "unknown"; failed: number }) => void;
  /** Bounded operational signal for optional recall evaluation only. */
  onRecallEvaluationFailure?: (event: { stage: "candidate_widen" | "shadow_record" | "canary_apply"; category: "operation_failed" }) => void;
  urlFetcher?: (url: string, limits: { maxBytes: number; maxRedirects: number; timeoutMs: number }) => Promise<UrlFetchResult>;
  now?: () => number;
  fetcher?: typeof fetch;
  losslessRunner?: CommandRunner;
  memoryLanceDbProRunner?: CommandRunner;
  /** Explicit host-level opt-in for third-party public Provider Adapters. */
  providerAdapters?: readonly ProviderAdapterRegistration[];
  /** Registered indexes remain inactive until this id is explicitly selected. */
  vectorBackends?: readonly VectorBackendRegistration[];
  /** Explicit host-level opt-in for one registered optional vector index. */
  vectorBackendId?: string;
  /** Immutable host-bound principal. Tool arguments can never select an actor. */
  governanceActorId?: string;
  anchorVerifier?: AnchorVerificationProvider;
}

export class Mnemora {
  readonly config: MnemoraConfig;
  readonly store: GraphologyStore;
  private readonly extractor: Extractor;
  private readonly embedder?: Embedder;
  private readonly embeddingConfig: EmbeddingConfig;
  private readonly onEmbeddingFailure?: MnemoraOptions["onEmbeddingFailure"];
  private readonly onRecallEvaluationFailure?: MnemoraOptions["onRecallEvaluationFailure"];
  private readonly queryCache = new Map<string, import("./embeddings.js").EmbeddingResult>();
  private readonly runtimeSignal?: AbortSignal;
  private readonly fetcher: typeof fetch;
  private readonly memoryReranker?: MemoryReranker;
  private readonly urlFetcher: NonNullable<MnemoraOptions["urlFetcher"]>;
  private readonly now: () => number;
  readonly insights: GraphAnalyticsService;
  readonly queryService: GraphQueryService;
  readonly watches: WatchService;
  /** Separate trust persistence; GraphologyStore remains graph-only. */
  readonly sourceAnchors: SourceAnchorRepository;
  /** Read-only source freshness and revalidation projection. */
  readonly sourceLifecycle: SourceLifecycleService;
  /** Separate, read-only profile projection; it never owns graph or trust rows. */
  readonly profileRepository: ProfileProjectionRepository;
  /** Separate user-preference storage; it never mutates source evidence. */
  readonly profileSelections: ProfileSelectionRepository;
  /** Independent material-change profile history; it never owns graph facts. */
  readonly profileHistoryRepository: ProfileHistoryRepository;
  readonly profiles: ProfileProjectionService;
  readonly profileHistory: ProfileHistoryService;
  readonly profileSelectionService: ProfileSelectionService;
  private readonly sourceAnchoring?: SourceAnchoringService;
  readonly verificationRepository: VerificationRepository;
  readonly verifications: ClaimVerificationService;
  readonly anchorVerificationJobs: AnchorVerificationRepository;
  readonly anchorVerifier: AnchorVerificationService;
  readonly retrospectiveAudits: RetrospectiveAuditService;
  private readonly recallPolicy: RecallPolicyService;
  private readonly recallExplanation: RecallExplanationService;
  readonly recallShadowRepository: RecallShadowRepository;
  /** ContextEngine automatic-recall telemetry, separate from graph canary metrics. */
  readonly unifiedRecallShadow: UnifiedRecallShadowRepository;
  private readonly recallShadow: AdaptiveRecallShadowService;
  readonly recallCanaryRepository: RecallCanaryRepository;
  private readonly recallCanary: AdaptiveRecallCanaryService;
  readonly integrationStatuses: IntegrationStatusRepository;
  readonly providerMigrationAudits: ProviderMigrationAuditRepository;
  /** Preview/apply/resume migration through public Provider Adapter capabilities only. */
  readonly providerMigrations: PublicProviderMigrationService;
  /** Public, bounded Provider Adapter SDK execution boundary. */
  readonly providerAdapters: ProviderAdapterRegistry;
  /** Public optional vector-index SDK registry; SQLite is still canonical. */
  readonly vectorBackends: VectorBackendRegistry;
  /** Bounded external-vector routing with local fallback and scope reauthorization. */
  readonly vectors: VectorBackendService;
  /** Separate durable multi-agent authority, approval, and decision ledger. */
  readonly governanceRepository: GovernanceRepository;
  readonly governance: GovernanceService;
  readonly formation?: FormationService;
  /** Disposable read projection; it never owns cognition rows or writes memory. */
  readonly personalContext: PersonalContextCompiler;
  /** User-confirmed recall feedback affects ranking salience, never truth. */
  private readonly recallFeedback: RecallFeedbackRepository;
  /** Review-only graph diagnostics, kept outside GraphologyStore mutation paths. */
  private readonly hygiene: GraphHygieneService;
  /** Preview/confirm refinement of legacy weak edges; it owns no live recall policy. */
  private readonly relatedEdgeRefinements: RelatedEdgeRefinementService;
  /** Source-backed semantic labels for fallback edges; it never changes topology. */
  private readonly relatedEdgeSemantics: RelatedEdgeSemanticService;
  /** Invalidation overlays make stale review proposals visible without touching graph facts. */
  private readonly graphReviewLifecycle: GraphReviewLifecycleRepository;
  /** Bounded read model joining graph-remediation proposals and self-link findings. */
  private readonly graphReviewWorklist: GraphReviewWorklistService;
  /** Local categorical provider outcomes; never a live probe or provider log. */
  private readonly embeddingHealth: EmbeddingHealthRepository;
  /** Non-destructive tier/expiry selection overlay for canonical memory documents. */
  readonly memoryLifecycle: MemoryDocumentLifecycleService;
  /** Aggregate-only record of memories that were actually attached to context. */
  readonly recallUsage: RecallUsageRepository;
  /** Read-only lifecycle review derived from actual attachment history. */
  readonly recallDecay: RecallDecayReviewService;
  /** Explicit local citation cache; it has no graph or automatic recall writer. */
  readonly corpus: CanonicalCorpusIndexer;
  private readonly governanceActorId?: string;

  constructor(options: MnemoraOptions = {}) {
    this.config = normalizeConfig(options.config ?? {});
    this.embeddingConfig = this.config.embeddings as EmbeddingConfig;
    this.store = new GraphologyStore(this.config.dbPath);
    this.corpus = new CanonicalCorpusIndexer(this.store.db, this.config.corpus!, this.config.workspaceBoundary?.userMdExclusive?.enabled === true, options.now ?? Date.now);
    this.extractor = createExtractor(this.config, options.extractor);
    this.embedder = options.embedder ?? (this.embeddingConfig.enabled ? createEmbedder(this.embeddingConfig) : undefined);
    this.onEmbeddingFailure = options.onEmbeddingFailure;
    this.onRecallEvaluationFailure = options.onRecallEvaluationFailure;
    this.runtimeSignal = options.signal;
    this.urlFetcher = options.urlFetcher ?? ((url, limits) => fetchUrlResource(url, limits));
    this.fetcher = options.fetcher ?? fetch;
    if (this.config.memory?.retrieval?.reranker?.enabled) this.memoryReranker = new MemoryReranker(this.config.memory.retrieval.reranker, this.fetcher);
    this.now = options.now ?? Date.now;
    this.sourceAnchors = new SourceAnchorRepository(this.store.db);
    this.sourceLifecycle = new SourceLifecycleService(this.store.db, this.now);
    this.profileRepository = new ProfileProjectionRepository(this.store.db);
    this.profileSelections = new ProfileSelectionRepository(this.store.db);
    this.profileHistoryRepository = new ProfileHistoryRepository(this.store.db, this.now);
    this.profiles = new ProfileProjectionService(this.profileRepository, this.profileSelections, this.profileHistoryRepository);
    this.profileHistory = new ProfileHistoryService(this.profileRepository, this.profileHistoryRepository);
    this.profileSelectionService = new ProfileSelectionService(this.profileRepository, this.profileSelections, this.now);
    this.verificationRepository = new VerificationRepository(this.store.db, this.now);
    this.verifications = new ClaimVerificationService(this.verificationRepository);
    this.governanceRepository = new GovernanceRepository(this.store.db, this.now);
    this.governance = new GovernanceService(this.governanceRepository, this.config.trustLayer?.governance);
    this.personalContext = new PersonalContextCompiler(this.store.db, this.now, { staleAfterDays: this.config.cognition?.reflection?.staleAfterDays });
    this.recallFeedback = new RecallFeedbackRepository(this.store.db, this.now);
    this.hygiene = new GraphHygieneService(this.store, this.now);
    this.graphReviewLifecycle = new GraphReviewLifecycleRepository(this.store.db, this.now);
    this.relatedEdgeRefinements = new RelatedEdgeRefinementService(this.store.db, this.now, this.graphReviewLifecycle);
    this.relatedEdgeSemantics = new RelatedEdgeSemanticService(this.store.db, this.now, this.graphReviewLifecycle);
    this.graphReviewWorklist = new GraphReviewWorklistService(this.store.db, this.graphReviewLifecycle);
    this.embeddingHealth = new EmbeddingHealthRepository(this.store, this.now);
    this.memoryLifecycle = new MemoryDocumentLifecycleService(this.store.db, {
      enabled: this.config.memory?.lifecycle?.enabled === true,
      accessReinforcement: this.config.memory?.lifecycle?.accessReinforcement !== false,
      corePromotionAccesses: this.config.memory?.lifecycle?.corePromotionAccesses ?? 12,
      temporalInference: this.config.memory?.lifecycle?.temporalInference === true
    }, this.now);
    this.recallUsage = new RecallUsageRepository(this.store.db, this.now);
    this.recallDecay = new RecallDecayReviewService(this.store.db, this.recallUsage, this.now);
    if (this.config.cognition?.formationShadow) this.formation = new FormationService(this.store.db, this.now, { mode: this.config.cognition.admission?.mode, preAdmissionMode: this.config.cognition.admission?.preAdmission?.mode, beliefs: this.config.cognition.beliefs });
    this.governanceActorId = options.governanceActorId;
    this.sourceAnchoring = this.config.trustLayer?.enabled
      ? new SourceAnchoringService({ repository: this.sourceAnchors, snapshotMaxBytes: this.config.trustLayer.snapshotMaxBytes ?? 8192, now: this.now })
      : undefined;
    this.recallPolicy = new RecallPolicyService(this.verificationRepository, this.config.trustLayer?.verification?.enabled === true, this.config.recall?.tokenBudget ?? 800);
    this.recallExplanation = new RecallExplanationService(this.verificationRepository, this.config.trustLayer?.verification?.enabled === true, this.config.unifiedRetrieval?.enabled === true);
    this.recallShadowRepository = new RecallShadowRepository(this.store.db);
    this.unifiedRecallShadow = new UnifiedRecallShadowRepository(this.store.db, this.now);
    this.recallShadow = new AdaptiveRecallShadowService(this.recallShadowRepository, {
      shadowMode: this.config.trustLayer?.recall?.shadowMode === true,
      absoluteFloor: this.config.trustLayer?.recall?.absoluteFloor ?? 0,
      relativeCutoffRatio: this.config.trustLayer?.recall?.relativeCutoffRatio ?? .6,
      confidenceGate: this.config.trustLayer?.recall?.confidenceGate ?? .6,
      minKeep: this.config.trustLayer?.recall?.minKeep ?? 1,
      candidateMultiplier: this.config.trustLayer?.recall?.candidateMultiplier ?? 5
    }, this.now);
    this.recallCanaryRepository = new RecallCanaryRepository(this.store.db);
    this.recallCanary = new AdaptiveRecallCanaryService(this.recallCanaryRepository, {
      shadowMode: this.config.trustLayer?.recall?.shadowMode === true,
      absoluteFloor: this.config.trustLayer?.recall?.absoluteFloor ?? 0,
      relativeCutoffRatio: this.config.trustLayer?.recall?.relativeCutoffRatio ?? .6,
      confidenceGate: this.config.trustLayer?.recall?.confidenceGate ?? .6,
      minKeep: this.config.trustLayer?.recall?.minKeep ?? 1,
      candidateMultiplier: this.config.trustLayer?.recall?.candidateMultiplier ?? 5
    }, {
      enabled: this.config.trustLayer?.recall?.canary?.enabled === true,
      modelId: this.config.trustLayer?.recall?.canary?.modelId ?? "default",
      scopes: this.config.trustLayer?.recall?.canary?.scopes ?? []
    }, this.now);
    this.integrationStatuses = new IntegrationStatusRepository(this.store.db);
    this.providerMigrationAudits = new ProviderMigrationAuditRepository(this.store.db);
    const providerAdapters: ProviderAdapterRegistration[] = [
      ...(this.config.integrations?.lossless?.enabled ? [{ adapter: new LosslessClawAdapter(options.losslessRunner), limits: { timeoutMs: this.config.integrations.lossless.timeoutMs, maxOutputBytes: this.config.integrations.lossless.maxOutputBytes } }] : []),
      ...(this.config.integrations?.memoryLanceDbPro?.enabled ? [{ adapter: new MemoryLanceDbProAdapter(options.memoryLanceDbProRunner), limits: { timeoutMs: this.config.integrations.memoryLanceDbPro.timeoutMs, maxOutputBytes: this.config.integrations.memoryLanceDbPro.maxOutputBytes } }] : []),
      ...(options.providerAdapters ?? [])
    ];
    this.providerAdapters = new ProviderAdapterRegistry(providerAdapters, this.now);
    this.providerMigrations = new PublicProviderMigrationService(this.store.db, this.providerAdapters, async ({ source, scope }) => {
      const outcome = await this.ingestProviderSource({ source, scope });
      this.providerMigrationAudits.record({ provider: source.ref.provider as IntegrationProviderId, scope, source, status: outcome.status === "succeeded" ? "imported" : outcome.status });
      return outcome;
    }, this.now);
    this.vectorBackends = new VectorBackendRegistry(options.vectorBackends ?? [], this.now);
    if (options.vectorBackendId != null && !this.vectorBackends.has(options.vectorBackendId)) throw new Error("unregistered_vector_backend");
    this.vectors = new VectorBackendService(this.store, this.vectorBackends, options.vectorBackendId);
    const fetcher = this.fetcher;
    this.anchorVerificationJobs = new AnchorVerificationRepository(this.store.db, this.now);
    this.anchorVerifier = new AnchorVerificationService(this.anchorVerificationJobs, {
      enabled: this.config.trustLayer?.verification?.automatic?.enabled === true,
      maxConcurrent: this.config.trustLayer?.verification?.automatic?.maxConcurrent ?? 1,
      maxJobsPerRun: this.config.trustLayer?.verification?.automatic?.maxJobsPerRun ?? 5,
      timeoutMs: this.config.trustLayer?.verification?.automatic?.timeoutMs ?? 15000,
      leaseMs: this.config.trustLayer?.verification?.automatic?.leaseMs ?? 45000,
      maxInputChars: this.config.trustLayer?.verification?.automatic?.maxInputChars ?? 8000,
      maxOutputBytes: this.config.trustLayer?.verification?.automatic?.maxOutputBytes ?? 16384
    }, options.anchorVerifier ?? createAnchorVerificationProvider(this.config, fetcher), this.verificationRepository, this.now, this.governance.active ? ({ verification_id, scope, model }) => {
      const resourceId = governanceResourceId("verification", [verification_id]);
      const requestHash = governanceRequestHash({ action: "verification.transition", scope, resource_id: resourceId, details: { mode: "automatic", model } });
      return this.governance.authorize({ actor_id: "system:anchor-verifier", action: "verification.transition", scope, resource_id: resourceId, request_hash: requestHash }).allowed;
    } : undefined);
    this.retrospectiveAudits = new RetrospectiveAuditService(this.store.db, {
      enabled: this.config.trustLayer?.verification?.retrospectiveAudit?.enabled === true,
      maxJobsPerRun: this.config.trustLayer?.verification?.retrospectiveAudit?.maxJobsPerRun ?? 5,
      minimumAgeDays: this.config.trustLayer?.verification?.retrospectiveAudit?.minimumAgeDays ?? 30,
      minimumRecallCount: this.config.trustLayer?.verification?.retrospectiveAudit?.minimumRecallCount ?? 3
    }, this.now);
    this.insights = new GraphAnalyticsService({ store: this.store, config: this.config, now: this.now, signal: this.runtimeSignal, explainer: new InsightExplainer(this.config, fetcher, this.runtimeSignal) });
    this.queryService = new GraphQueryService({ store: this.store, config: this.config, now: this.now, signal: this.runtimeSignal, planner: new QueryPlanner(this.config, fetcher, this.runtimeSignal) });
    this.watches = new WatchService({ store: this.store, config: this.config, now: this.now, execute: async (plan, run) => {
      const result = await this.queryService.query({ plan, scope: run.scope, signal: run.signal });
      const projection = this.store.queryGraphProjection({ maxNodes: this.config.query?.maxNodes ?? 10000, maxEdges: this.config.query?.maxEdges ?? 50000, asOf: this.now(), scope: run.scope });
      const freshNodes = new Set(projection.nodes.filter(node => run.since == null || Math.max(node.createdAt, node.updatedAt) > run.since).map(node => node.id));
      const freshEdges = new Set(projection.edges.filter(edge => run.since == null || edge.lastSeenAt > run.since).map(edge => edge.id));
      const insightResult = await this.insights.analyze({ explain: false, limit: 20, scope: run.scope });
      return { entities: result.entities.filter(item => freshNodes.has(item.id)), relationships: result.relationships.filter(item => freshEdges.has(item.id)), warnings: [...result.warnings, ...insightResult.warnings], insights: insightResult.insights };
    } });
  }

  close(): void {
    this.store.close();
  }

  async kg_insights(input: KgInsightsInput = {}): Promise<KgInsightsResult> { return this.insights.analyze({ ...input, scope: normalizeScope(input.scope, this.config.scope?.default ?? "default") }); }
  async kg_query(input: { question?: string; plan?: unknown; scope?: string; signal?: AbortSignal }): Promise<KgQueryResult> { return this.queryService.query({ ...input, scope: normalizeScope(input.scope, this.config.scope?.default ?? "default") }); }
  kg_verify(input: { operation: "list"; scope?: string; status?: VerificationStatus; after_id?: string; limit?: number } | { operation: "sources"; scope?: string; limit?: number; freshness_after_days?: number } | { operation: "transition"; verification_id: string; status: VerificationStatus; support_type?: "direct" | "inferred" | "contradicted" | "none"; verification_confidence?: number; source_quality?: number; verifier_kind?: "rule" | "model" | "human"; reason_code?: "manual_review" | "direct_support" | "indirect_support" | "insufficient_source" | "source_changed" | "source_deleted" | "conflict"; approval_id?: string; confirm?: boolean } | { operation: "queue"; scope?: string; limit?: number } | { operation: "run"; scope?: string; limit?: number; signal?: AbortSignal } | { operation: "jobs"; scope?: string; limit?: number } | { operation: "cancel"; job_id: string } | { operation: "audit_schedule"; scope?: string; limit?: number } | { operation: "audit_run"; scope?: string; limit?: number } | { operation: "audits"; scope?: string; limit?: number } | { operation: "audit_cancel"; audit_id: string } | { operation: "audit_requeue"; audit_id: string } | { operation: "audit_review"; audit_id: string } | { operation: "audit_reclaim_stale"; scope?: string }) {
    return input.operation === "list"
      ? this.verifications.list({ scope: input.scope == null ? undefined : normalizeScope(input.scope, this.config.scope?.default ?? "default"), status: input.status, after_id: input.after_id, limit: input.limit })
      : input.operation === "sources" ? this.sourceLifecycle.status({ scope: normalizeScope(input.scope, this.config.scope?.default ?? "default"), limit: input.limit, freshnessAfterDays: input.freshness_after_days })
      : input.operation === "transition" ? this.transitionVerification(input)
        : input.operation === "queue" ? this.anchorVerifier.queue(normalizeScope(input.scope, this.config.scope?.default ?? "default"), input.limit)
          : input.operation === "run" ? this.anchorVerifier.run(normalizeScope(input.scope, this.config.scope?.default ?? "default"), input.signal ?? this.runtimeSignal, input.limit)
            : input.operation === "jobs" ? this.anchorVerifier.list(normalizeScope(input.scope, this.config.scope?.default ?? "default"), input.limit)
              : input.operation === "audit_schedule" ? this.retrospectiveAudits.schedule(normalizeScope(input.scope, this.config.scope?.default ?? "default"), input.limit)
                : input.operation === "audit_run" ? this.retrospectiveAudits.run(normalizeScope(input.scope, this.config.scope?.default ?? "default"), input.limit)
                  : input.operation === "audits" ? this.retrospectiveAudits.list(normalizeScope(input.scope, this.config.scope?.default ?? "default"), input.limit)
                    : input.operation === "audit_cancel" ? this.retrospectiveAudits.cancel(input.audit_id)
                      : input.operation === "audit_requeue" ? this.retrospectiveAudits.requeue(input.audit_id)
                        : input.operation === "audit_review" ? this.retrospectiveAudits.review(input.audit_id)
                          : input.operation === "audit_reclaim_stale" ? this.retrospectiveAudits.reclaimStale(normalizeScope(input.scope, this.config.scope?.default ?? "default"))
                            : this.anchorVerifier.cancel(input.job_id);
  }

  /**
   * Explicit, cursor-based initial sync for an already-populated optional
   * vector index. It only transfers opaque IDs and stored vectors.
   */
  async syncVectorBackend(input: { identity: import("./embeddings.js").EmbeddingIdentity; inputVersion?: string; after_id?: string; limit?: number; signal?: AbortSignal }) {
    return this.vectors.syncStoredNodes({ identity: input.identity, inputVersion: input.inputVersion ?? embeddingInputVersion, afterId: input.after_id, limit: input.limit, signal: input.signal ?? this.runtimeSignal });
  }
  /** Explicit opaque-id sweep for a selected optional index after a seed pass. */
  async reconcileVectorBackend(input: { identity: import("./embeddings.js").EmbeddingIdentity; inputVersion?: string; cursor?: string; limit?: number; signal?: AbortSignal }) {
    return this.vectors.reconcileStoredNodes({ identity: input.identity, inputVersion: input.inputVersion ?? embeddingInputVersion, cursor: input.cursor, limit: input.limit, signal: input.signal ?? this.runtimeSignal });
  }
  /** Bounded status probe for a selected optional index; no graph text is returned. */
  async vectorBackendHealth(input: { identity: import("./embeddings.js").EmbeddingIdentity; inputVersion?: string; signal?: AbortSignal }) {
    return this.vectors.health({ identity: input.identity, inputVersion: input.inputVersion ?? embeddingInputVersion, signal: input.signal ?? this.runtimeSignal });
  }
  private transitionVerification(input: { operation: "transition"; verification_id: string; status: VerificationStatus; support_type?: "direct" | "inferred" | "contradicted" | "none"; verification_confidence?: number; source_quality?: number; verifier_kind?: "rule" | "model" | "human"; reason_code?: "manual_review" | "direct_support" | "indirect_support" | "insufficient_source" | "source_changed" | "source_deleted" | "conflict"; approval_id?: string; confirm?: boolean }) {
    if (input.confirm !== true) throw new Error("confirmation_required");
    const current = this.verificationRepository.get(input.verification_id);
    if (!current) throw new Error("invalid_verification_transition");
    const requestHash = governanceRequestHash({
      action: "verification.transition", scope: current.scope, resource_id: current.id,
      details: { status: input.status, support_type: input.support_type ?? null, verification_confidence: input.verification_confidence ?? null, source_quality: input.source_quality ?? null, verifier_kind: input.verifier_kind ?? null, reason_code: input.reason_code ?? null }
    });
    const authorization = this.governance.authorize({ actor_id: this.governanceActorId, action: "verification.transition", scope: current.scope, resource_id: current.id, request_hash: requestHash, approval_id: input.approval_id });
    if (!authorization.allowed) throw new Error("governance_denied");
    const result = this.verifications.transition(input);
    if (result.verification.status === "verified") try { this.retrospectiveAudits.scheduleContradictions(result.verification.scope); } catch { /* local audit scheduling cannot invalidate a confirmed transition */ }
    return result;
  }
  /** Legacy-compatible summary for callers that only need an allow/deny decision. */
  gateAutomaticRecall(context: KgContextResult, scope?: string) {
    const { context: _filtered, ...decision } = this.recallPolicy.evaluateAutomaticContext(context, normalizeScope(scope, this.config.scope?.default ?? "default"));
    return decision;
  }
  /** Internal hook path: strict policy returns a coherent claim-filtered context. */
  filterAutomaticRecallContext(context: KgContextResult, scope?: string) {
    const normalizedScope = normalizeScope(scope, this.config.scope?.default ?? "default");
    const decision = this.recallPolicy.evaluateAutomaticContext(context, normalizedScope);
    try { this.retrospectiveAudits.schedule(normalizedScope); } catch { /* audit scheduling must never block recall */ }
    return decision;
  }
  /** Read-only, redacted explanation of what automatic recall would admit for this query. */
  async kg_recall_explain(input: { query: string; scope?: string; max_nodes?: number; max_depth?: number; confidence_threshold?: number; token_budget?: number; mode?: SearchMode; signal?: AbortSignal }) {
    const scope = normalizeScope(input.scope, this.config.scope?.default ?? "default");
    const context = await this.kg_context(input.query, input.max_nodes, input.max_depth, input.confidence_threshold, input.token_budget, input.mode, input.signal, scope, { recordMetrics: false });
    const { context: _filtered, ...policy } = this.recallPolicy.evaluateAutomaticContext(context, scope, { recordRecall: false });
    return this.recallExplanation.explain(context, scope, policy);
  }
  kg_recall_metrics(input: { scope?: string; limit?: number } = {}) {
    const scope = normalizeScope(input.scope, this.config.scope?.default ?? "default");
    return { ...this.recallShadow.list(scope, input.limit), unified: this.unifiedRecallShadow.list(scope, input.limit) };
  }
  kg_recall_canary(input: { operation: "status"; scope?: string } | { operation: "calibrations"; scope?: string; limit?: number } | { operation: "evaluate"; scope?: string; criteria?: RecallCalibrationCriteria } | { operation: "calibrate"; scope?: string; criteria?: RecallCalibrationCriteria; preview_hash?: string; confirm?: boolean } | { operation: "enable"; scope?: string; calibration_id: string; preview_hash?: string; confirm?: boolean } | { operation: "rollback"; scope?: string; confirm?: boolean }) {
    const scope = normalizeScope(input.scope, this.config.scope?.default ?? "default");
    if (input.operation === "status") return this.recallCanary.status(scope);
    if (input.operation === "calibrations") return this.recallCanaryRepository.listCalibrations(scope, input.limit);
    if (input.operation === "evaluate") return { status: "preview", ...this.recallCanary.evaluate(scope, input.criteria) };
    if (input.operation === "calibrate") {
      const preview = this.recallCanary.evaluate(scope, input.criteria);
      return input.confirm === true ? this.recallCanary.calibrate(scope, input.criteria ?? {}, input.preview_hash) : { status: "preview", ...preview };
    }
    if (input.operation === "enable") return this.recallCanary.enable(scope, input.calibration_id, input.confirm === true ? input.preview_hash : undefined);
    return input.confirm === true ? this.recallCanary.rollback(scope) : { status: "confirm_required", ...this.recallCanary.status(scope) };
  }
  kg_timeline(input: TimelineInput): KgTimelineResult { return buildTimeline(this.store, { ...input, scope: normalizeScope(input.scope, this.config.scope?.default ?? "default") }); }
  async kg_compare(input: CompareInput): Promise<KgCompareResult> {
    const asOf = Number.isFinite(input.as_of) ? input.as_of! : this.now();
    const scope = normalizeScope(input.scope, this.config.scope?.default ?? "default");
    const search = (value: string) => this.kg_search(value, undefined, 8, "hybrid", undefined, scope);
    const left = await resolveCompareSubject(this.store, search, input.left, "left", asOf, scope);
    const right = await resolveCompareSubject(this.store, search, input.right, "right", asOf, scope);
    return compareSubjects(this.store, { ...input, scope, as_of: asOf, left_id: left.id, right_id: right.id });
  }

  kg_watch(input: KgWatchInput) {
    switch (input.operation) {
      case "create": { const { operation: _operation, ...create } = input; return this.watches.create(create); }
      case "list": return this.watches.list(input.limit, input.scope == null ? undefined : normalizeScope(input.scope, this.config.scope?.default ?? "default"));
      case "inspect": return this.store.getWatch(input.id) ?? null;
      case "enable": return this.watches.update(input.id, { enabled: true });
      case "disable": return this.watches.update(input.id, { enabled: false });
      case "delete": return { deleted: this.watches.remove(input.id) };
      case "update": { const { operation: _operation, id, ...patch } = input; return this.watches.update(id, patch); }
    }
  }

  kg_digest(input: KgDigestInput) { return this.watches.digest({ idempotencyKey: input.idempotency_key, watchIds: input.watch_ids, since: input.since, limit: input.limit, scope: normalizeScope(input.scope, this.config.scope?.default ?? "default") }); }
  kg_query_history(input: KgQueryHistoryInput = {}) { return this.store.listQueryRuns(input.limit ?? 20, normalizeScope(input.scope, this.config.scope?.default ?? "default")); }

  async kg_integrations(input: KgIntegrationInput): Promise<KgIntegrationResult> {
    const provider: IntegrationProviderId = input.operation === "status" ? input.provider ?? "lossless-claw" : input.provider;
    const adapter = this.providerAdapters.get(provider);
    if (input.operation === "status") {
      const stored = this.integrationStatuses.get(provider);
      if (!adapter) return { provider, operation: "status", status: "disabled", warning_code: "disabled", ...(stored ? { capabilities: stored.capabilities } : {}) };
      return stored ? { provider, operation: "status", status: stored.status, ...(stored.warning_code ? { warning_code: stored.warning_code } : {}), capabilities: stored.capabilities } : { provider, operation: "status", status: "degraded", warning_code: "unavailable", capabilities: this.providerAdapters.capabilities(provider) ?? integrationCapabilities(provider) };
    }
    if (!adapter) return { provider, operation: input.operation, status: "disabled", warning_code: "disabled", ...(input.operation === "ingest" && "external_id" in input ? { external_id: boundedExternalId(input.external_id) } : {}) };
    if (input.operation === "migration_preview" || input.operation === "migration_apply" || input.operation === "migration_resume" || input.operation === "migration_verify" || input.operation === "migration_rollback") {
      try {
        const run = input.operation === "migration_preview"
          ? await this.providerMigrations.preview({ provider, scope: normalizeScope(input.scope, this.config.scope?.default ?? "default"), query: input.query, providerScope: input.provider_scope, externalRefs: input.external_refs, limit: input.limit, offset: input.offset, signal: composeSignals(input.signal, this.runtimeSignal) })
          : input.operation === "migration_apply" || input.operation === "migration_resume"
            ? await this.providerMigrations.apply({ id: input.run_id, signal: composeSignals(input.signal, this.runtimeSignal) })
            : input.operation === "migration_rollback"
              ? this.providerMigrations.rollback(input.run_id)
              : this.providerMigrations.verify(input.run_id);
        if (!run || run.provider !== provider) return { provider, operation: input.operation, status: "degraded", warning_code: "not_found" };
        return { provider, operation: input.operation, status: "healthy", migration: { id: run.id, status: run.status, items: run.items.map(item => ({ external_id: item.externalId, content_hash: item.contentHash, status: item.status, ...(item.errorCode ? { error_code: item.errorCode } : {}) })), ...(run.inventory ? { inventory: { offset: run.inventory.offset, ...(run.inventory.nextOffset == null ? {} : { next_offset: run.inventory.nextOffset }), complete: run.inventory.complete } } : {}), rollback: input.operation === "migration_rollback" ? "restore_required" : "not_requested" } };
      } catch (error) { return this.integrationFailure(provider, input.operation, error); }
    }
    const signal = composeSignals("signal" in input ? input.signal : undefined, this.runtimeSignal);
    if (input.operation === "probe") {
      try {
        const capabilities = await this.providerAdapters.probe(provider, signal);
        this.integrationStatuses.save({ provider, detected_version: capabilities.detectedVersion ?? null, capabilities, status: "healthy", warning_code: null, last_probe_at: this.now() });
        return { provider, operation: "probe", status: "healthy", capabilities };
      } catch (error) { return this.integrationFailure(provider, "probe", error); }
    }
    if (input.operation === "search") {
      try {
        const candidates = await this.providerAdapters.searchCandidates(provider, input.query, input.provider_scope ?? "global", input.limit ?? 5, signal);
        this.integrationStatuses.save({ provider, detected_version: null, capabilities: this.providerAdapters.capabilities(provider) ?? integrationCapabilities(provider), status: "healthy", warning_code: null, last_probe_at: this.now() });
        return { provider, operation: "search", status: "healthy", candidates: candidates.map(item => ({ external_id: item.ref.externalId, content_hash: item.contentHash })) };
      } catch (error) { return this.integrationFailure(provider, "search", error); }
    }
    if (input.operation !== "ingest") return { provider, operation: input.operation, status: "degraded", warning_code: "operation_failed" };
    const requestedExternalId = input.provider === "lossless-claw" ? input.external_ref.externalId : input.external_id;
    if (!this.sourceAnchoring) return { provider, operation: "ingest", status: "disabled", warning_code: "disabled", external_id: boundedExternalId(requestedExternalId) };
    try {
      const capabilities = this.providerAdapters.capabilities(provider);
      const resolved = input.provider === "lossless-claw"
        ? await this.providerAdapters.resolveSource(provider, input.external_ref, signal)
        // Search candidates are a discovery result, never an authoritative
        // exact-id lookup.  Prefer an Adapter's public resolver when present
        // so a selected memory outside a later top-N window remains importable.
        : capabilities?.resolveRawSource
          ? await this.providerAdapters.resolveSource(provider, { provider, externalId: input.external_id }, signal)
          : (await this.providerAdapters.searchCandidates(provider, input.query, input.provider_scope ?? "global", 10, signal)).find(item => item.ref.externalId === input.external_id) ?? null;
      if (!resolved) {
        const warning = input.provider === "memory-lancedb-pro" && capabilities?.resolveRawSource !== true ? "not_in_search_window" : "not_found";
        this.integrationStatuses.save({ provider, detected_version: null, capabilities: this.providerAdapters.capabilities(provider) ?? integrationCapabilities(provider), status: "degraded", warning_code: warning, last_probe_at: this.now() });
        return { provider, operation: "ingest", status: "degraded", warning_code: warning, external_id: boundedExternalId(requestedExternalId) };
      }
      this.integrationStatuses.save({ provider, detected_version: null, capabilities: this.providerAdapters.capabilities(provider) ?? integrationCapabilities(provider), status: "healthy", warning_code: null, last_probe_at: this.now() });
      const source = `${provider === "lossless-claw" ? "lossless" : "memory-lancedb-pro"}:${resolved.ref.externalId}`;
      const outcome = await this.ingestItemDetailed({ text: resolved.content, source, scope: input.scope, sourceRef: resolved.ref });
      this.providerMigrationAudits.record({ provider, scope: input.scope ?? this.config.scope?.default ?? "default", source: resolved, status: outcome.status === "failed" ? "failed" : outcome.status === "skipped_duplicate" ? "skipped_duplicate" : "imported" });
      const { ingest_result: _private, ...ingestion } = outcome;
      return { provider, operation: "ingest", status: outcome.status === "failed" ? "degraded" : "healthy", external_id: boundedExternalId(resolved.ref.externalId), content_hash: resolved.contentHash, ingestion: { ...ingestion, warnings: ingestion.warnings.map(item => item.category) } };
    } catch (error) { return this.integrationFailure(provider, "ingest", error, boundedExternalId(requestedExternalId)); }
  }

  extract(text: string, source?: string, options?: ExtractOptions): Promise<ExtractionResult> {
    if (this.config.extraction?.enabled !== true) return Promise.reject(new Error("extraction_disabled"));
    const bounded = truncateInput(text, this.config.extraction!.maxInputChars!);
    return requestWithTimeout(
      signal => this.extractor.extract(bounded, source, { signal }),
      this.config.extraction!.timeoutMs!,
      composeSignals(options?.signal, this.runtimeSignal)
    );
  }

  async ingestItem(item: IngestionItem, extraction?: ExtractionResult): Promise<IngestionItemResult> {
    const detailed = await this.ingestItemDetailed(item, extraction);
    const { ingest_result: _private, ...publicResult } = detailed;
    return publicResult;
  }

  /** Internal hook boundary: automatic extraction reuses the canonical ingestion lifecycle. */
  async ingestAutomaticExtraction(input: { text: string; source: string; scope?: string; extraction: ExtractionResult }): Promise<IngestionItemResult> {
    const detailed = await this.ingestItemDetailed({ text: input.text, source: input.source, scope: input.scope }, input.extraction, { origin: "automatic_extract", authority: "user_self_report" });
    const { ingest_result: _private, ...publicResult } = detailed;
    return publicResult;
  }

  /**
   * Ingest a source returned by this instance's explicitly registered Adapter.
   * The method intentionally has no OpenClaw tool descriptor: a host must opt
   * in by registering executable Adapter code, then choose the source itself.
   */
  async ingestProviderSource(input: ProviderSourceIngestionInput): Promise<IngestionItemResult> {
    const source = input?.source;
    const provider = source?.ref?.provider;
    const externalId = boundedExternalId(source?.ref?.externalId);
    const expectedHash = typeof source?.content === "string" ? createHash("sha256").update(source.content).digest("hex") : undefined;
    if (!provider || !externalId || !this.providerAdapters.has(provider) || source.contentHash !== expectedHash) {
      return { status: "failed", source: "provider", fingerprint: "", counts: { entities: 0, relations: 0, observations: 0 }, warnings: [], error: { category: "invalid_input", summary: "invalid ingestion input" } };
    }
    const outcome = await this.ingestItem({ text: source.content, source: `${provider}:${externalId}`, scope: input.scope, force: input.force === true, sourceRef: source.ref });
    if (outcome.status === "succeeded") this.store.upsertMemoryDocument({ content: source.content, source: `${provider}:${externalId}`, scope: input.scope, metadata: { provider, external_id: externalId, ...(source.metadata ?? {}) } });
    return outcome;
  }

  private async ingestItemDetailed(item: IngestionItem, extraction?: ExtractionResult, provenance?: { origin: "explicit_ingest" | "automatic_extract"; authority: FormationAuthority }): Promise<IngestionItemResult & { ingest_result?: IngestResult }> {
    const validItem = item && typeof item === "object" ? item : { text: "" };
    const effectiveProvenance = provenance ?? { origin: "explicit_ingest" as const, authority: validItem.sourceRef ? "external_source" as const : "manual_operator" as const };
    const text = normalizeIngestionText(typeof validItem.text === "string" ? validItem.text : "");
    const source = canonicalizeIngestionSource(validItem.source, "manual");
    let scope: string;
    try { scope = normalizeScope(validItem.scope, this.config.scope?.default ?? "default"); }
    catch { return { status: "failed", source, fingerprint: "", counts: { entities: 0, relations: 0, observations: 0 }, warnings: [], error: { category: "invalid_input", summary: "invalid ingestion input" } }; }
    const inputFingerprint = fingerprintIngestion(text, scope === "default" ? source : `${scope}\0${source}`);
    let fingerprint = inputFingerprint;
    const empty = { entities: 0, relations: 0, observations: 0 };
    if (!text || Buffer.byteLength(text, "utf8") > this.config.ingestion!.maxPayloadBytes!) return { status: "failed", source, fingerprint, counts: empty, warnings: [], error: { category: "invalid_input", summary: "invalid ingestion input" } };
    if (!validItem.force && this.store.getCompletedIngestion(inputFingerprint, scope)) return { status: "skipped_duplicate", source, fingerprint, counts: empty, warnings: [] };
    let extracted: ExtractionResult;
    try { extracted = extraction ?? await this.extract(text, source); }
    catch (error) {
      const disabled = error instanceof Error && error.message === "extraction_disabled";
      return { status: "failed", source, fingerprint, counts: empty, warnings: [], error: { category: disabled ? "extraction_disabled" : "extraction_failed", summary: disabled ? "extraction disabled" : "extraction failed" } };
    }
    try {
      fingerprint = fingerprintExtractedTemporal(inputFingerprint, extracted);
      let formation;
      try { formation = this.formation?.observe({ scope, origin: effectiveProvenance.origin, authority: effectiveProvenance.authority, kind: "graph_extraction", source, entities: extracted.entities.length, relations: extracted.relations.length, content: text }); } catch { /* shadow audit never blocks ingestion */ }
      const preAdmissionEnforced = effectiveProvenance.origin === "automatic_extract" && this.config.cognition?.formationShadow === true && this.config.cognition.admission?.preAdmission?.mode === "enforce";
      if (preAdmissionEnforced && formation?.preAdmission?.decision === "drop") {
        if (formation.preAdmission.reason === "same_source_duplicate") return { status: "skipped_duplicate", source, fingerprint, counts: empty, warnings: [] };
        return { status: "succeeded", source, fingerprint, counts: empty, warnings: [{ category: "pre_admission_dropped" }] };
      }
      const admittedExtraction = preAdmissionEnforced && formation?.preAdmission
        ? scaleAutomaticExtractionConfidence(extracted, formation.preAdmission.confidenceMultiplier)
        : extracted;
      const result = this.store.ingestWithCompletedRecord(admittedExtraction.entities, admittedExtraction.relations, source, fingerprint, inputFingerprint, INGESTION_FINGERPRINT_VERSION, this.config.extraction?.minConfidenceToStore ?? 0, { edgeMinConfidence: this.config.quality?.edgeMinConfidence ?? 0, relatedToMinConfidence: this.config.quality?.relatedToMinConfidence ?? .85, edgeTypeMinConfidence: this.config.quality?.edgeTypeMinConfidence ?? {} }, scope);
      const embedded = await this.embedNodes(result.entities.map(({ node }) => node), "ingest");
      const warnings: IngestionItemResult["warnings"] = embedded.failed ? [{ category: "embedding_failed", count: embedded.failed }] : [];
      if (this.sourceAnchoring && result.observations.length) {
        try {
          if (validItem.sourceRef) this.verificationRepository.markSourceChanged({ scope, provider: validItem.sourceRef.provider, external_id: validItem.sourceRef.externalId, content_hash: createHash("sha256").update(text).digest("hex") });
          this.sourceAnchoring.anchorIngestion({ scope, source, text, observations: result.observations, externalRef: validItem.sourceRef });
          // Queueing is durable and local. Workers are invoked explicitly through
          // kg_verify so ingestion and gateway shutdown never wait on a model.
          this.anchorVerifier.queue(scope);
        }
        catch { warnings.push({ category: "source_anchoring_failed" }); }
      }
      try { this.store.scanDuplicateCandidatesForIds(result.entities.map(item => item.node.id)); } catch { warnings.push({ category: "candidate_discovery_failed" }); }
      try {
        const conflicts = this.store.scanConflictCandidates(this.config.quality?.singleValuedEdgeTypes ?? [], result.relations.map(({ edge }) => ({ source_id: edge.source_id, type: edge.type })));
        if (conflicts.created > 0 || conflicts.updated > 0) this.retrospectiveAudits.scheduleContradictions(scope);
      } catch { warnings.push({ category: "conflict_discovery_failed" }); }
      return { status: "succeeded", source, fingerprint, counts: { entities: result.entities.length, relations: result.relations.length, observations: result.observations.length }, warnings, ingest_result: result };
    } catch { return { status: "failed", source, fingerprint, counts: empty, warnings: [], error: { category: "persistence_failed", summary: "persistence failed" } }; }
  }

  async kg_ingest_batch(items: IngestionItem[], cursor = 0, limit = this.config.ingestion!.maxBatchItems!): Promise<BatchIngestionResult> {
    if (!Array.isArray(items)) throw new Error("invalid_input");
    const start = Math.min(items.length, Math.max(0, Math.trunc(cursor)));
    const bounded = Math.min(this.config.ingestion!.maxBatchItems!, Math.max(1, Math.trunc(limit)));
    const end = Math.min(items.length, start + bounded);
    const outcomes: BatchIngestionResult["items"] = [];
    for (let index = start; index < end; index++) {
      try { outcomes.push({ ...(await this.ingestItem(items[index])), index }); }
      catch {
        const raw = items[index] as unknown as { source?: unknown } | undefined;
        outcomes.push({ index, status: "failed", source: canonicalizeIngestionSource(raw?.source, "manual"), fingerprint: "", counts: { entities: 0, relations: 0, observations: 0 }, warnings: [], error: { category: "invalid_input", summary: "invalid ingestion input" } });
      }
    }
    return { processed: outcomes.length, succeeded: outcomes.filter(x => x.status === "succeeded").length, skipped: outcomes.filter(x => x.status === "skipped_duplicate").length, failed: outcomes.filter(x => x.status === "failed").length, items: outcomes, next_cursor: end < items.length ? end : null };
  }

  async kg_ingest_file(path: string, source?: string, force = false, scope?: string): Promise<IngestionItemResult> {
    const safeSource = canonicalizeIngestionSource(source ?? `file:${basename(path || "unknown")}`);
    const failed = (category: "invalid_input" | "unsupported_file" | "file_too_large" | "workspace_boundary"): IngestionItemResult => ({ status: "failed", source: safeSource, fingerprint: "", counts: { entities: 0, relations: 0, observations: 0 }, warnings: [], error: { category, summary: category.replaceAll("_", " ") } });
    if (isExclusiveUserMdPath(path, this.config.workspaceBoundary?.userMdExclusive?.enabled === true) || isExclusiveUserMdSource(safeSource, this.config.workspaceBoundary?.userMdExclusive?.enabled === true)) return failed("workspace_boundary");
    if (!path || !this.config.ingestion!.allowedFileExtensions!.includes(extname(path).toLowerCase())) return failed("unsupported_file");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink()) return failed("unsupported_file");
      if (before.size > this.config.ingestion!.maxPayloadBytes!) return failed("file_too_large");
      handle = await open(path, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) return failed("unsupported_file");
      if (stat.size > this.config.ingestion!.maxPayloadBytes!) return failed("file_too_large");
      const buffer = Buffer.alloc(this.config.ingestion!.maxPayloadBytes! + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > this.config.ingestion!.maxPayloadBytes!) return failed("file_too_large");
      const bytes = buffer.subarray(0, bytesRead);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return failed("unsupported_file"); }
      if (text.includes("\0")) return failed("unsupported_file");
      return await this.ingestItem({ text, source: safeSource, force, scope });
    } catch { return failed("invalid_input"); }
    finally { await handle?.close().catch(() => undefined); }
  }

  async kg_ingest_url(url: string, force = false, scope?: string): Promise<IngestionItemResult & { requested_url: string; final_url: string; redirects: number; content_type: string }> {
    let fetched: UrlFetchResult;
    try { fetched = await this.urlFetcher(url, { maxBytes: this.config.ingestion!.urlMaxPayloadBytes!, maxRedirects: this.config.ingestion!.urlMaxRedirects!, timeoutMs: this.config.ingestion!.urlTimeoutMs! }); }
    catch (error) {
      let requestedUrl = "";
      try { requestedUrl = canonicalizeUrl(url); } catch { /* invalid input has no safe URL */ }
      const category = safeUrlCategory(error);
      return { status: "failed", source: requestedUrl ? `url:${requestedUrl}` : "url", fingerprint: "", counts: { entities: 0, relations: 0, observations: 0 }, warnings: [], error: { category, summary: category.replaceAll("_", " ") }, requested_url: requestedUrl, final_url: requestedUrl, redirects: 0, content_type: "" };
    }
    const outcome = await this.ingestItem({ text: fetched.text, source: `url:${fetched.finalUrl}`, force, scope });
    return { ...outcome, requested_url: fetched.requestedUrl, final_url: fetched.finalUrl, redirects: fetched.redirects, content_type: fetched.contentType };
  }

  async kg_ingest(text: string, source = "manual", extraction?: ExtractionResult, scope?: string): Promise<IngestResult> {
    const outcome = await this.ingestItemDetailed({ text, source, scope }, extraction);
    if (outcome.status === "skipped_duplicate") return { entities: [], relations: [], observations: [], skipped_relations: [], skipped: true };
    if (outcome.status === "failed") throw new Error(outcome.error?.category ?? "ingestion_failed");
    return outcome.ingest_result!;
  }

  async kg_embed_backfill(limit = 100, after_id = ""): Promise<{ processed: number; embedded: number; failed: number; next_after_id: string | null }> {
    const bounded = Math.max(1, Math.min(1000, Math.trunc(limit)));
    if (!this.embedder) return { processed: 0, embedded: 0, failed: 0, next_after_id: null };
    const identity = { provider: this.embeddingConfig.provider, model: this.embeddingConfig.model };
    const nodes = this.store.listStaleEmbeddingNodes(identity, embeddingInputVersion, after_id, bounded);
    const counts = await this.embedNodes(nodes, "backfill");
    return { processed: counts.embedded + counts.failed, embedded: counts.embedded, failed: counts.failed, next_after_id: counts.lastSuccessfulId ?? (after_id || null) };
  }

  async kg_memory_embed_backfill(limit = 100, after_id = "", scope?: string): Promise<{ processed: number; embedded: number; failed: number; next_after_id: string | null }> {
    const bounded = Math.max(1, Math.min(1000, Math.trunc(limit)));
    if (!this.embedder) return { processed: 0, embedded: 0, failed: 0, next_after_id: null };
    const normalizedScope = normalizeScope(scope, this.config.scope?.default ?? "default");
    const identity = { provider: this.embeddingConfig.provider, model: this.embeddingConfig.model };
    const chunks = this.store.listStaleMemoryChunks(identity, MEMORY_CHUNK_EMBEDDING_INPUT_VERSION, after_id, bounded, normalizedScope);
    const counts = await this.embedMemoryChunks(chunks);
    return { processed: counts.embedded + counts.failed, embedded: counts.embedded, failed: counts.failed, next_after_id: counts.lastSuccessfulId ?? (after_id || null) };
  }

  private async embedNodes(nodes: import("./types.js").KgNode[], operation: "ingest" | "backfill"): Promise<{ embedded: number; failed: number; lastSuccessfulId?: string }> {
    if (!this.embedder || nodes.length === 0) return { embedded: 0, failed: 0 };
    let embedded = 0, failed = 0;
    let lastSuccessfulId: string | undefined;
    const size = this.embeddingConfig.batchSize;
    for (let offset = 0; offset < nodes.length; offset += size) {
      const batch = nodes.slice(offset, offset + size);
      try {
        const inputs = batch.map(node => truncateInput(embeddingInput(node), this.embeddingConfig.maxInputChars));
        const result = await requestWithTimeout(signal => this.embedder!.embed(inputs, signal), this.embeddingConfig.timeoutMs, this.runtimeSignal);
        if (result.vectors.length !== batch.length) throw new Error("embedding vectors: count mismatch");
        result.vectors.forEach((vector, index) => this.store.putEmbedding(batch[index].id, result.identity, embeddingInputVersion, vector));
        try { await this.vectors.mirrorNodes(batch.map((node, index) => ({ id: node.id, identity: result.identity, inputVersion: embeddingInputVersion, vector: result.vectors[index] })), this.runtimeSignal); } catch { /* Optional vector index is fail-open after canonical SQLite persistence. */ }
        this.embeddingHealth.recordSuccess(this.embeddingConfig);
        embedded += batch.length;
        lastSuccessfulId = batch.at(-1)?.id;
      } catch (error) {
        failed += batch.length;
        const category = classifyEmbeddingFailure(error);
        this.embeddingHealth.recordFailure(this.embeddingConfig, category);
        try { this.onEmbeddingFailure?.({ operation, category, failed: batch.length }); } catch { /* logging is fail-open */ }
        if (operation === "backfill") break;
      }
    }
    return { embedded, failed, lastSuccessfulId };
  }

  private async embedMemoryChunks(chunks: import("./types.js").KgMemoryChunk[]): Promise<{ embedded: number; failed: number; lastSuccessfulId?: string }> {
    if (!this.embedder || chunks.length === 0) return { embedded: 0, failed: 0 };
    let embedded = 0, failed = 0;
    let lastSuccessfulId: string | undefined;
    const size = this.embeddingConfig.batchSize;
    for (let offset = 0; offset < chunks.length; offset += size) {
      const batch = chunks.slice(offset, offset + size);
      try {
        const inputs = batch.map(chunk => truncateInput(memoryChunkEmbeddingInput(chunk.document_title ?? "Memory", chunk.content), this.embeddingConfig.maxInputChars));
        const result = await requestWithTimeout(signal => this.embedder!.embed(inputs, signal), this.embeddingConfig.timeoutMs, this.runtimeSignal);
        if (result.vectors.length !== batch.length) throw new Error("embedding vectors: count mismatch");
        result.vectors.forEach((vector, index) => this.store.putMemoryChunkEmbedding(batch[index].id, result.identity, MEMORY_CHUNK_EMBEDDING_INPUT_VERSION, vector));
        this.embeddingHealth.recordSuccess(this.embeddingConfig);
        embedded += batch.length;
        lastSuccessfulId = batch.at(-1)?.id;
      } catch (error) {
        failed += batch.length;
        const category = classifyEmbeddingFailure(error);
        this.embeddingHealth.recordFailure(this.embeddingConfig, category);
        try { this.onEmbeddingFailure?.({ operation: "memory_backfill", category, failed: batch.length }); } catch { /* Local observability must remain fail-open. */ }
        break;
      }
    }
    return { embedded, failed, lastSuccessfulId };
  }

  async kg_search(query: string, node_type?: string, limit = 10, mode: SearchMode = this.config.recall?.mode ?? "hybrid", signal?: AbortSignal, scope?: string): Promise<KgSearchResult[]> {
    const bounded = Math.min(50, Math.max(0, Math.trunc(limit)));
    const normalizedScope = normalizeScope(scope, this.config.scope?.default ?? "default");
    const lexical = this.store.lexicalCandidates(query, node_type, Math.max(bounded * 8, 64), normalizedScope);
    if (mode === "lexical") return this.store.rankHybrid({ lexical, semantic: [], limit: bounded, now: Date.now(), scope: normalizedScope, weights: { semantic: 0, lexical: 1, confidence: 0, freshness: 0 } });
    try {
      if (!this.embedder) throw new SemanticSearchUnavailableError("disabled");
      const result = await this.queryEmbedding(query, signal);
      if (result.vectors.length !== 1) throw new Error("embedding vectors: count mismatch");
      if (result.vectors[0].length !== result.identity.dimensions) throw new Error("embedding dimensions do not match identity");
      const candidateCount = this.store.embeddingCandidateCount(result.identity, embeddingInputVersion, normalizedScope);
      if (!this.vectors.externalNodeSearchEnabled && candidateCount > this.embeddingConfig.maxVectorScanNodes) {
        throw new SemanticSearchUnavailableError("scale_limit", candidateCount);
      }
      const routed = await this.vectors.searchNodes({ vector: result.vectors[0], identity: result.identity, inputVersion: embeddingInputVersion, nodeType: node_type, limit: bounded, minimum: this.config.recall?.semanticMinScore ?? .35, maxScanNodes: this.embeddingConfig.maxVectorScanNodes, scope: normalizedScope }, signal);
      if (routed.source === "sqlite" && candidateCount > this.embeddingConfig.maxVectorScanNodes) throw new SemanticSearchUnavailableError("scale_limit", candidateCount);
      const semantic = routed.candidates;
      const ranked = this.store.rankHybrid({
        lexical: mode === "hybrid" ? lexical : [], semantic, limit: mode === "hybrid" ? Math.max(bounded * 8, 64) : bounded, now: this.now(),
        scope: normalizedScope, weights: mode === "semantic" ? { semantic: 1, lexical: 0, confidence: 0, freshness: 0 } : this.config.recall?.hybridWeights
      });
      if (mode !== "hybrid") return ranked;
      // Quality/PPR operates on a whole graph snapshot.  Keeping scoped recall
      // isolated is more important than applying a cross-scope ranking signal.
      if (normalizedScope !== "default") return ranked.slice(0, bounded);
      try { return this.applyQualityRanking(ranked, bounded, signal); }
      catch { return ranked.slice(0, bounded); }
    } catch (error) {
      if (mode === "semantic") throw semanticError(error);
      return this.store.rankHybrid({ lexical, semantic: [], limit: bounded, now: Date.now(), scope: normalizedScope, weights: { semantic: 0, lexical: 1, confidence: 0, freshness: 0 } });
    }
  }

  private applyQualityRanking(results: KgSearchResult[], limit: number, signal?: AbortSignal): KgSearchResult[] {
    if (!results.length) return [];
    const now = this.now();
    const quality = this.config.quality!;
    const weights = quality.rankingWeights!;
    let pprScores: Record<string, number> = {};
    let pprAvailable = false;
    let graphSnapshot: { nodes: string[]; arcs: import("./ppr.js").PprArc[] } | undefined;
    if (weights.ppr > 0) try {
      graphSnapshot = this.store.qualityGraphSnapshot(results.map(result => result.node.id), { maxNodes: quality.pprMaxNodes!, maxArcs: quality.pprMaxArcs! }, now);
      pprScores = personalizedPageRank({ nodes: graphSnapshot.nodes, arcs: graphSnapshot.arcs, seeds: Object.fromEntries(results.map(result => [result.node.id, Math.max(0, result.score)])) }, {
        damping: quality.pprDamping, maxIterations: quality.pprMaxIterations, tolerance: quality.pprTolerance,
        maxNodes: quality.pprMaxNodes, maxArcs: quality.pprMaxArcs, signal
      });
      pprAvailable = true;
    } catch { /* PPR is an optional fail-open signal */ }
    const snapshot = this.store.qualityEvidenceSummaries(results.map(result => result.node.id), now, graphSnapshot);
    const ranked = rankQualityCandidates({
      now, halfLifeDays: quality.recencyHalfLifeDays, conflictFactor: quality.conflictPenaltyFactor, hubFloor: quality.hubPenaltyFloor, degreeP95: snapshot.degree_p95, limit,
      weights: { semantic: weights.semantic, lexical: weights.lexical, confidence: weights.confidence, recency: weights.recency, source_diversity: weights.sourceDiversity, ppr: pprAvailable ? weights.ppr : 0 },
      candidates: results.map(result => {
        const summary = snapshot.items[result.node.id] ?? { source_count: 0, confidence: 0, reference_time: null, unresolved_conflict: false, degree: 0 };
        return { id: result.node.id, semantic: result.score_components?.semantic ?? 0, lexical: result.score_components?.lexical ?? 0, confidence: summary.confidence, reference_time: summary.reference_time, source_count: summary.source_count, ppr: pprScores[result.node.id] ?? 0, unresolved_conflict: summary.unresolved_conflict, degree: summary.degree, exactLexical: result.score_components?.lexical === 1 };
      })
    });
    const byId = new Map(results.map(result => [result.node.id, result]));
    return ranked.slice(0, limit).map(item => ({ ...byId.get(item.id)!, score: item.score, rank_components: item.components, penalties: item.penalties }));
  }

  private async queryEmbedding(query: string, signal?: AbortSignal): Promise<import("./embeddings.js").EmbeddingResult> {
    const input = truncateInput(query, this.embeddingConfig.maxInputChars);
    const key = createHash("sha256").update([this.embeddingConfig.provider, this.embeddingConfig.model, embeddingInputVersion, input].join("\0")).digest("hex");
    const cached = this.queryCache.get(key);
    if (cached) { this.queryCache.delete(key); this.queryCache.set(key, cached); return cached; }
    let raw: import("./embeddings.js").EmbeddingResult;
    try {
      raw = await requestWithTimeout((requestSignal) => this.embedder!.embed([input], requestSignal), this.embeddingConfig.timeoutMs, composeSignals(signal, this.runtimeSignal));
    } catch (error) {
      this.embeddingHealth.recordFailure(this.embeddingConfig, classifyEmbeddingFailure(error));
      throw error;
    }
    if (raw.identity.provider !== this.embeddingConfig.provider || raw.identity.model !== this.embeddingConfig.model || raw.vectors.length !== 1 || raw.vectors[0].length !== raw.identity.dimensions) {
      this.embeddingHealth.recordFailure(this.embeddingConfig, "invalid_response");
      throw new Error("invalid embedding identity or dimensions");
    }
    const result = { identity: { ...raw.identity }, vectors: [normalizeEmbeddingVector(raw.vectors[0])] };
    this.embeddingHealth.recordSuccess(this.embeddingConfig);
    if (this.embeddingConfig.queryCacheSize > 0) {
      this.queryCache.set(key, result);
      while (this.queryCache.size > this.embeddingConfig.queryCacheSize) this.queryCache.delete(this.queryCache.keys().next().value!);
    }
    return result;
  }

  private async searchMemoryDocuments(query: string, scope: string, limit: number | undefined, mode: SearchMode, signal?: AbortSignal): Promise<import("./types.js").KgMemorySearchResult[]> {
    const bounded = Math.max(1, Math.min(10, Math.trunc(limit ?? this.config.memory?.maxResults ?? 3)));
    const policy = this.config.memory!.retrieval!;
    const candidateLimit = Math.min(50, Math.max(bounded, bounded * policy.candidateMultiplier!));
    const plan = planRecallQuery(query, this.config.recall?.queryRouting);
    const queries = [plan.query, ...plan.alternates].filter(Boolean);
    const lexicalById = new Map<string, import("./types.js").KgMemorySearchResult>();
    for (const candidate of queries.length ? queries : [""]) for (const item of this.store.searchMemoryDocuments(candidate, scope, candidateLimit, plan.tags)) {
      if (!memoryMatchesTags(item.metadata, plan.tags)) continue;
      if ((lexicalById.get(item.id)?.score ?? -1) < item.score) lexicalById.set(item.id, item);
    }
    const lexical = [...lexicalById.values()];
    // A tag-only request is a scalar metadata filter, not a semantic question.
    // Do not send `tag:...` to an embedding provider or reinterpret the tag as
    // content; the already scope-local lexical result is authoritative.
    if (mode === "lexical" || !plan.query) return this.rankMemoryCandidates(lexical, bounded, policy);
    try {
      if (!this.embedder) throw new SemanticSearchUnavailableError("disabled");
      const result = await this.queryEmbedding(plan.query || query, signal);
      const candidateCount = this.store.memoryEmbeddingCandidateCount(result.identity, MEMORY_CHUNK_EMBEDDING_INPUT_VERSION, scope);
      if (candidateCount > this.embeddingConfig.maxVectorScanNodes) throw new SemanticSearchUnavailableError("scale_limit", candidateCount);
      const semantic = this.store.semanticMemorySearch(result.vectors[0], result.identity, MEMORY_CHUNK_EMBEDDING_INPUT_VERSION, scope, candidateLimit, this.config.recall?.semanticMinScore, this.embeddingConfig.maxVectorScanNodes).filter(item => memoryMatchesTags(item.metadata, plan.tags));
      if (mode === "semantic") return this.finalizeMemoryCandidates(plan.query || query, semantic, bounded, policy, signal);
      const byId = new Map<string, { lexical?: import("./types.js").KgMemorySearchResult; semantic?: import("./types.js").KgMemorySearchResult }>();
      for (const item of lexical) byId.set(item.id, { ...(byId.get(item.id) ?? {}), lexical: item });
      for (const item of semantic) byId.set(item.id, { ...(byId.get(item.id) ?? {}), semantic: item });
      const merged = [...byId.values()].map(item => mergeHybridMemoryCandidate(item));
      return this.finalizeMemoryCandidates(plan.query || query, merged, bounded, policy, signal);
    } catch (error) {
      if (mode === "semantic") throw semanticError(error);
      return this.finalizeMemoryCandidates(plan.query || query, lexical.map(item => ({ ...item, score_components: { lexical: item.score, semantic: 0 } })), bounded, policy, signal);
    }
  }

  private async finalizeMemoryCandidates(query: string, candidates: import("./types.js").KgMemorySearchResult[], limit: number, policy: NonNullable<NonNullable<MnemoraConfig["memory"]>["retrieval"]>, signal?: AbortSignal): Promise<import("./types.js").KgMemorySearchResult[]> {
    const reranked = this.memoryReranker ? await this.memoryReranker.rerank(query, candidates, signal) : candidates;
    return this.rankMemoryCandidates(reranked, limit, policy);
  }

  /** The public lexical memory API is synchronous; retain that contract while
   * sharing the optional local ranking policy with the async retrieval path. */
  private searchMemoryDocumentsLexically(query: string, scope: string, limit: number | undefined): import("./types.js").KgMemorySearchResult[] {
    const bounded = Math.max(1, Math.min(10, Math.trunc(limit ?? this.config.memory?.maxResults ?? 3)));
    const policy = this.config.memory!.retrieval!;
    const candidateLimit = Math.min(50, Math.max(bounded, bounded * policy.candidateMultiplier!));
    const plan = planRecallQuery(query, this.config.recall?.queryRouting);
    const found = new Map<string, import("./types.js").KgMemorySearchResult>();
    const queries = [plan.query, ...plan.alternates].filter(Boolean);
    for (const candidate of queries.length ? queries : [""]) for (const item of this.store.searchMemoryDocuments(candidate, scope, candidateLimit, plan.tags)) {
      if (memoryMatchesTags(item.metadata, plan.tags) && (found.get(item.id)?.score ?? -1) < item.score) found.set(item.id, item);
    }
    return this.rankMemoryCandidates([...found.values()], bounded, policy);
  }

  private rankMemoryCandidates(items: import("./types.js").KgMemorySearchResult[], limit: number, policy: NonNullable<NonNullable<MnemoraConfig["memory"]>["retrieval"]>): import("./types.js").KgMemorySearchResult[] {
    const ranked = rankMemoryCandidates(this.memoryLifecycle.decorate(items), limit, policy, item => this.recallFeedback.salience(item.scope, createMnemoraContextRef({ scope: item.scope, kind: "memory-document", id: item.id })), this.now);
    // This is a retrieval-only reinforcement signal. It never changes content,
    // evidence, confidence, graph facts, or automatic-capture documents.
    this.memoryLifecycle.recordAccess(ranked);
    return ranked;
  }

  kg_related(entity: string, depth = 1, edge_types?: RelationshipType[], direction?: Direction, scope?: string): KgRelatedResult {
    return this.store.related(entity, depth, edge_types, direction, normalizeScope(scope, this.config.scope?.default ?? "default"));
  }

  kg_stats(): KgStatsResult {
    return { ...this.store.stats(), embedding_health: this.embeddingHealth.status(this.embeddingConfig) };
  }

  /** Bounded review maintenance. It only records duplicate candidates and never merges or deletes graph data. */
  runGraphHygiene(scope?: string, force = false) {
    const policy = this.hygienePolicy();
    return this.hygiene.run({ scope: normalizeScope(scope, this.config.scope?.default ?? "default"), policy, force });
  }

  private hygienePolicy(): GraphHygienePolicy {
    const value = this.config.quality?.hygiene;
    return {
      intervalHours: value?.intervalHours ?? 168,
      maxDuplicateScanNodes: value?.maxDuplicateScanNodes ?? 100,
      relatedToWarningRatio: value?.relatedToWarningRatio ?? .4,
      relatedToWarningMinimumEdges: value?.relatedToWarningMinimumEdges ?? 20
    };
  }

  kg_profile(subject: string, scope?: string, limit?: number): ProfileProjection {
    return this.profiles.project({ subject, scope: normalizeScope(scope, this.config.scope?.default ?? "default"), limit });
  }

  /** Operator-facing, bounded history/diff over redacted profile snapshots. */
  kg_profile_history(input: { operation: "list"; subject: string; scope?: string; limit?: number; before_id?: string } | { operation: "diff"; subject: string; scope?: string; before_id?: string; after_id?: string }) {
    const scope = normalizeScope(input.scope, this.config.scope?.default ?? "default");
    return input.operation === "list"
      ? this.profileHistory.list({ subject: input.subject, scope, limit: input.limit, before_id: input.before_id })
      : this.profileHistory.diff({ subject: input.subject, scope, before_id: input.before_id, after_id: input.after_id });
  }

  /** Preview-first user choice over an existing sourced profile value; it never overwrites graph evidence. */
  kg_profile_lock(input: ProfileSelectionInput) {
    const scope = normalizeScope(input.scope, this.config.scope?.default ?? "default");
    const normalized = { ...input, scope };
    if (input.confirm !== true) return this.profileSelectionService.manage(normalized);
    const preview = this.profileSelectionService.manage({ ...normalized, confirm: false });
    if (preview.status !== "ready") return preview;
    if (preview.preview_hash !== input.preview_hash) return { ...preview, status: "stale_preview" as const };
    const resourceId = governanceResourceId("profile", [preview.subject!.id, preview.field_key]);
    const requestHash = governanceRequestHash({
      action: "profile.selection", scope, resource_id: resourceId,
      details: { action: input.action, field_key: preview.field_key, target_hash: createHash("sha256").update(preview.proposed_selection?.entity.id ?? "").digest("hex"), preview_hash: preview.preview_hash }
    });
    const authorization = this.governance.authorize({ actor_id: this.governanceActorId, action: "profile.selection", scope, resource_id: resourceId, request_hash: requestHash, approval_id: (input as ProfileSelectionInput & { approval_id?: string }).approval_id });
    if (!authorization.allowed) throw new Error("governance_denied");
    return this.profileSelectionService.manage(normalized);
  }

  /**
   * Discover the configured default and a bounded aggregate view of available
   * scopes before an agent deliberately retries a lookup in another scope.
   */
  kg_scopes(limit = 50): KgScopesResult {
    return {
      default_scope: normalizeScope(this.config.scope?.default, "default"),
      scopes: this.store.listScopes(limit)
    };
  }

  async kg_context(query: string, max_nodes?: number, max_depth?: number, confidence_threshold?: number, token_budget?: number, mode?: SearchMode, signal?: AbortSignal, scope?: string, options: { recordMetrics?: boolean } = {}): Promise<KgContextResult> {
    const normalizedScope = normalizeScope(scope, this.config.scope?.default ?? "default");
    const selectedMode = mode ?? this.config.recall?.mode ?? "hybrid";
    // Default recall uses only the fixed seed search. A wider pool is observed
    // only for shadow mode or an explicitly configured canary.
    const seedLimit = max_nodes ?? this.config.recall?.maxNodes ?? 5;
    const nodes = await this.kg_search(query, undefined, seedLimit, selectedMode, signal, normalizedScope);
    let candidates = nodes;
    if (this.recallShadow.enabled || this.recallCanary.configured) try {
      const candidateLimit = this.recallShadow.candidateLimit(seedLimit);
      candidates = candidateLimit > Math.min(50, Math.max(0, Math.trunc(seedLimit)))
        ? await this.kg_search(query, undefined, candidateLimit, selectedMode, signal, normalizedScope)
        : nodes;
    } catch { candidates = nodes; this.reportRecallEvaluationFailure("candidate_widen"); /* Evaluation/canary widening is strictly fail-open. */ }
    if (options.recordMetrics !== false && this.recallShadow.enabled) try { this.recallShadow.observe(normalizedScope, candidates.map(item => ({ id: item.node.id, score: item.score })), nodes.map(item => ({ id: item.node.id, score: item.score })), seedLimit); } catch { this.reportRecallEvaluationFailure("shadow_record"); /* Shadow storage is fail-open. */ }
    let selectedNodes = nodes;
    try {
      const applied = this.recallCanary.apply(normalizedScope, candidates.map(item => ({ id: item.node.id, score: item.score })), nodes.map(item => ({ id: item.node.id, score: item.score })), seedLimit, { record: options.recordMetrics !== false });
      if (applied.applied) {
        const byId = new Map(candidates.map(item => [item.node.id, item]));
        selectedNodes = applied.selected.flatMap(item => byId.get(item.id) ?? []);
      }
    } catch { this.reportRecallEvaluationFailure("canary_apply"); /* Canary failures must never degrade default context assembly. */ }
    const memories = await this.searchMemoryDocuments(query, normalizedScope, this.config.memory?.maxResults, selectedMode, signal);
    return this.store.contextFromSeeds(query, selectedNodes, {
      maxDepth: max_depth ?? this.config.recall?.maxDepth,
      confidenceThreshold: confidence_threshold ?? this.config.recall?.confidenceThreshold,
      tokenBudget: token_budget ?? this.config.recall?.tokenBudget,
      scope: normalizedScope,
      memories
    });
  }

  private reportRecallEvaluationFailure(stage: "candidate_widen" | "shadow_record" | "canary_apply"): void {
    try { this.onRecallEvaluationFailure?.({ stage, category: "operation_failed" }); } catch { /* Operator telemetry is fail-open. */ }
  }

  kg_sources(limit = 20, scope?: string): KgSourceSummary[] {
    return this.store.sources({ limit, scope: normalizeScope(scope, this.config.scope?.default ?? "default") });
  }

  kg_memory(input: { operation: "store"; content: string; title?: string; source?: string; scope?: string; metadata?: Record<string, string | number | boolean | null> } | { operation: "search"; query: string; scope?: string; limit?: number; mode?: SearchMode } | { operation: "artifact_read"; artifact_id: string; scope?: string; offset?: number; max_bytes?: number } | { operation: "corpus_status"; scope?: string } | { operation: "corpus_sync"; scope?: string } | { operation: "corpus_search"; query: string; scope?: string; limit?: number; sync?: boolean } | { operation: "embed_backfill"; scope?: string; limit?: number; after_id?: string } | { operation: "list_scopes"; limit?: number } | { operation: "expiry_review"; scope?: string; older_than_days?: number; limit?: number; after_id?: string } | { operation: "tier_review"; scope?: string; limit?: number } | { operation: "tier"; document_id: string; tier: MemoryTier; scope?: string; preview_hash?: string; confirm?: boolean } | { operation: "recall_decay_review"; scope?: string; min_age_days?: number; limit?: number } | { operation: "lifecycle"; action: "archive" | "recover" | "delete"; document_id: string; scope?: string; preview_hash?: string; confirm?: boolean } | { operation: "lifecycle_audit"; scope?: string; limit?: number } | { operation: "export"; scope?: string; max_bytes?: number; max_records?: number } | { operation: "import"; data: string; scope?: string; preview_hash?: string; confirm?: boolean; max_bytes?: number; max_records?: number }) {
    if (input.operation === "store") { const scope=normalizeScope(input.scope, this.config.scope?.default ?? "default"); try { this.formation?.observe({ scope, origin:"memory_store", authority:"manual_operator", kind:"memory_document", source:input.source??"manual", content:input.content }); } catch {} const stored = this.store.upsertMemoryDocument({ ...input, scope }); this.memoryLifecycle.inferForDocument({ documentId: stored.id, scope }); return stored; }
    if (input.operation === "search") {
      const normalizedScope = normalizeScope(input.scope, this.config.scope?.default ?? "default");
      if (!input.mode || input.mode === "lexical") return this.searchMemoryDocumentsLexically(input.query, normalizedScope, input.limit);
      return this.searchMemoryDocuments(input.query, normalizedScope, input.limit, input.mode);
    }
    if (input.operation === "artifact_read") {
      const scope = normalizeScope(input.scope, this.config.scope?.default ?? "default"), offset = Number.isInteger(input.offset) ? Math.min(2_097_152, Math.max(0, input.offset!)) : 0, maxBytes = Number.isInteger(input.max_bytes) ? Math.min(16_384, Math.max(1, input.max_bytes!)) : 16_384;
      const journal = this.config.conversationJournal!;
      const result = new ArtifactRepository(this.store.db, { maxInlineChars: journal.maxInlineChars!, maxEventBytes: journal.maxEventBytes!, sensitiveContentPolicy: journal.sensitiveContentPolicy! }).readRange(input.artifact_id, scope, offset, maxBytes);
      return result ? { status: "ok" as const, ...result } : { status: "not_found" as const };
    }
    if (input.operation === "corpus_status") return this.corpus.status(normalizeScope(input.scope, this.config.scope?.default ?? "default"));
    if (input.operation === "corpus_sync") return this.corpus.sync(normalizeScope(input.scope, this.config.scope?.default ?? "default"));
    if (input.operation === "corpus_search") return this.corpus.search({ query: input.query, scope: normalizeScope(input.scope, this.config.scope?.default ?? "default"), limit: input.limit, sync: input.sync });
    if (input.operation === "embed_backfill") return this.kg_memory_embed_backfill(input.limit, input.after_id, input.scope);
    if (input.operation === "expiry_review") return this.store.reviewMemoryExpiry({ ...input, scope: normalizeScope(input.scope, this.config.scope?.default ?? "default") });
    if (input.operation === "tier_review") return this.memoryLifecycle.review(normalizeScope(input.scope, this.config.scope?.default ?? "default"), input.limit);
    if (input.operation === "tier") {
      const scope = normalizeScope(input.scope, this.config.scope?.default ?? "default");
      return input.confirm === true
        ? this.memoryLifecycle.confirmTier({ documentId: input.document_id, scope, tier: input.tier, previewHash: input.preview_hash ?? "" })
        : this.memoryLifecycle.previewTier({ documentId: input.document_id, scope, tier: input.tier });
    }
    if (input.operation === "recall_decay_review") return this.recallDecay.preview({ scope: normalizeScope(input.scope, this.config.scope?.default ?? "default"), minAgeDays: input.min_age_days, limit: input.limit });
    if (input.operation === "lifecycle") {
      const scope = normalizeScope(input.scope, this.config.scope?.default ?? "default");
      if (input.confirm === true) return this.store.confirmMemoryLifecycle({ action: input.action, document_id: input.document_id, scope, preview_hash: input.preview_hash ?? "" });
      return this.store.previewMemoryLifecycle({ action: input.action, document_id: input.document_id, scope });
    }
    if (input.operation === "lifecycle_audit") return this.store.listMemoryLifecycleAudits({ ...input, scope: normalizeScope(input.scope, this.config.scope?.default ?? "default") });
    if (input.operation === "export") return exportMemoryDocuments(this.store, { scope: normalizeScope(input.scope, this.config.scope?.default ?? "default"), maxBytes: input.max_bytes, maxRecords: input.max_records });
    if (input.operation === "import") {
      const scope = normalizeScope(input.scope, this.config.scope?.default ?? "default");
      return input.confirm === true
        ? confirmMemoryImport(this.store, { data: input.data, scope, preview_hash: input.preview_hash ?? "", confirm: true, maxBytes: input.max_bytes, maxRecords: input.max_records })
        : previewMemoryImport(this.store, input.data, scope, { maxBytes: input.max_bytes, maxRecords: input.max_records });
    }
    return this.store.listScopes(input.limit);
  }

  async kg_forget(entity_id: string, hard = false, confirm = false): Promise<KgForgetResult> {
    // Keep the canonical vector identity before SQLite removes or retires it.
    // External cleanup is deliberately best-effort: recall is locally
    // re-authorized even when an optional index is unavailable.
    const embedding = this.store.getEmbedding(entity_id);
    const result = this.store.forget(entity_id, hard, confirm);
    if (!embedding || result.deleted_nodes === 0) return { ...result, vector_index_cleanup: "not_indexed" };
    try {
      const cleanup = await this.vectors.removeNodes({ ids: [entity_id], identity: { provider: embedding.provider, model: embedding.model, dimensions: embedding.dimensions }, inputVersion: embedding.input_version, signal: this.runtimeSignal });
      return { ...result, vector_index_cleanup: cleanup === "removed" ? "removed" : "deferred" };
    } catch { return { ...result, vector_index_cleanup: "deferred" }; }
  }

  kg_review(kind: "duplicates" | "anomalies" | "identity" | "schema_drift" | "semantic_patterns" | "related_edge_refinements" | "related_edge_semantics" | "hygiene" | "worklist" = "duplicates", status: ReviewStatus = "pending", scan = false, limit = 20, after_id?: string, candidate_id?: string, decision?: "ignored" | "rejected" | "accepted", scope?: string, approval_id?: string, repair_type?: "depends_on" | "part_of" | "instance_of" | "related_to", preview_hash?: string, confirm = false): unknown {
    const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
    const normalizedScope = normalizeScope(scope, this.config.scope?.default ?? "default");
    if (kind === "worklist") {
      if (scan || candidate_id || decision || approval_id || repair_type || preview_hash || confirm) throw new Error("graph_review_worklist_is_read_only");
      if (status !== "pending" && status !== "rejected" && status !== "invalidated") throw new Error("invalid_graph_review_worklist_status");
      return this.graphReviewWorklist.list({ scope: normalizedScope, status: status as GraphReviewWorklistStatus, limit: bounded, afterId: after_id });
    }
    if (status === "invalidated") throw new Error("invalid_review_status");
    const candidateStatus = status as DuplicateCandidateStatus;
    if (kind === "hygiene") {
      if (status !== "pending" || after_id || candidate_id || decision || approval_id || repair_type || preview_hash || confirm) throw new Error("hygiene review is read-only");
      if (!scan) return this.hygiene.report(normalizedScope, this.hygienePolicy());
      // The scheduled pass follows configuration; an operator-requested pass
      // follows the tool's documented limit so an inspection stays bounded.
      const policy = this.hygienePolicy();
      return this.hygiene.run({ scope: normalizedScope, policy: { ...policy, maxDuplicateScanNodes: Math.min(policy.maxDuplicateScanNodes, bounded) }, force: true });
    }
    // Schema-drift repair intentionally uses a preview hash instead of a
    // duplicate/conflict decision. Do not apply the legacy pair requirement
    // to that separate, confirmation-gated workflow.
    if (kind !== "schema_drift" && (candidate_id == null) !== (decision == null)) throw new Error("candidate_id and decision must be provided together");
    if (kind === "identity") {
      if (status !== "pending" || scan || candidate_id || decision) throw new Error("identity audit is read-only");
      return this.store.auditLegacyIdentities(after_id, bounded);
    }
    if (kind === "schema_drift") {
      if (status !== "pending" || decision) throw new Error("invalid_schema_drift_review");
      if (repair_type) {
        if (!candidate_id || scan || after_id) throw new Error("schema_drift_candidate_required");
        return confirm ? this.store.confirmSchemaDriftRepair(candidate_id, repair_type, preview_hash ?? "", normalizedScope) : this.store.previewSchemaDriftRepair(candidate_id, repair_type, normalizedScope);
      }
      if (after_id && !scan) throw new Error("schema_drift_scan_required_for_cursor");
      if (candidate_id) throw new Error("schema_drift_repair_type_required");
      const scan_result = scan ? this.store.scanLegacySchemaDrift(normalizedScope, after_id, bounded) : undefined;
      return { ...this.store.reviewSchemaDrift(normalizedScope, bounded), ...(scan_result ? { scan: scan_result } : {}) };
    }
    if (kind === "semantic_patterns") {
      if (status !== "pending" || scan || after_id || approval_id || repair_type) throw new Error("invalid_semantic_pattern_review");
      if (candidate_id && (decision === "accepted" || decision === "rejected")) {
        return confirm
          ? this.store.confirmSemanticPatternReview(candidate_id, decision, preview_hash ?? "", normalizedScope)
          : this.store.previewSemanticPatternReview(candidate_id, decision, normalizedScope);
      }
      if (candidate_id || decision) throw new Error("semantic_pattern_decision_required");
      return this.store.reviewSemanticPatterns(normalizedScope, bounded);
    }
    if (kind === "related_edge_refinements") {
      if (status !== "pending" || approval_id || repair_type) throw new Error("invalid_related_edge_refinement_review");
      if (after_id && !scan) throw new Error("related_edge_refinement_scan_required_for_cursor");
      if (scan && (candidate_id || decision)) throw new Error("related_edge_refinement_scan_only");
      if (candidate_id && (decision === "accepted" || decision === "rejected")) {
        return confirm
          ? this.relatedEdgeRefinements.confirm(candidate_id, decision, preview_hash ?? "", normalizedScope)
          : this.relatedEdgeRefinements.preview(candidate_id, decision, normalizedScope);
      }
      if (candidate_id || decision) throw new Error("related_edge_refinement_decision_required");
      const scan_result = scan ? this.relatedEdgeRefinements.scan({ scope: normalizedScope, afterEdgeId: after_id, limit: bounded }) : undefined;
      return { ...this.relatedEdgeRefinements.list(normalizedScope, bounded), ...(scan_result ? { scan: scan_result } : {}) };
    }
    if (kind === "related_edge_semantics") {
      if (status !== "pending" || approval_id || repair_type) throw new Error("invalid_related_edge_semantic_review");
      if (after_id && !scan) throw new Error("related_edge_semantic_scan_required_for_cursor");
      if (scan && (candidate_id || decision)) throw new Error("related_edge_semantic_scan_only");
      if (candidate_id && (decision === "accepted" || decision === "rejected")) {
        return confirm
          ? this.relatedEdgeSemantics.confirm(candidate_id, decision, preview_hash ?? "", normalizedScope)
          : this.relatedEdgeSemantics.preview(candidate_id, decision, normalizedScope);
      }
      if (candidate_id || decision) throw new Error("related_edge_semantic_decision_required");
      const scan_result = scan ? this.relatedEdgeSemantics.scan({ scope: normalizedScope, afterEdgeId: after_id, limit: bounded }) : undefined;
      return { ...this.relatedEdgeSemantics.list(normalizedScope, bounded), ...(scan_result ? { scan: scan_result } : {}) };
    }
    if (kind === "anomalies") {
      if (decision === "accepted") throw new Error("invalid_conflict_decision");
      if (candidate_id && decision) {
        const candidate = this.store.getConflictCandidate(candidate_id, normalizedScope);
        if (!candidate || candidate.status !== "pending") throw new Error("Pending conflict candidate not found");
        const requestHash = governanceRequestHash({ action: "conflict.resolve", scope: normalizedScope, resource_id: candidate.id, details: { decision, preview_hash: candidate.preview_hash } });
        const authorization = this.governance.authorize({ actor_id: this.governanceActorId, action: "conflict.resolve", scope: normalizedScope, resource_id: candidate.id, request_hash: requestHash, approval_id });
        if (!authorization.allowed) throw new Error("governance_denied");
        return this.store.decideConflictCandidate(candidate_id, decision, normalizedScope);
      }
      const scan_result = scan ? this.store.scanConflictCandidates(this.config.quality?.singleValuedEdgeTypes ?? []) : undefined;
      const revalidation_schedule = scan_result && (scan_result.created > 0 || scan_result.updated > 0)
        ? this.store.listScopes(100).map(item => ({ scope: item.id, ...this.retrospectiveAudits.scheduleContradictions(item.id) })) : undefined;
      const anomalies = this.store.reviewAnomalies({ limit: bounded }).items;
      const conflicts = this.store.reviewConflictCandidates({ status: candidateStatus === "merged" ? undefined : candidateStatus, limit: bounded, scope: normalizedScope }).items;
      return { items: [...anomalies, ...conflicts].slice(0, bounded), ...(scan_result ? { scan: scan_result } : {}), ...(revalidation_schedule ? { revalidation_schedule } : {}) };
    }
    if (candidate_id || decision) throw new Error("conflict decisions require kind anomalies");
    const scan_result = scan ? this.store.scanDuplicateCandidates(after_id, bounded, { persistCursor: after_id == null }) : undefined;
    return { ...this.store.reviewCandidates({ status: candidateStatus, limit: bounded }), ...(scan_result ? { scan: scan_result } : {}) };
  }

  kg_merge(canonical_entity_id: string, duplicate_entity_id: string, confirm = false, preview_hash?: string): MergeResult {
    return this.store.merge(canonical_entity_id, duplicate_entity_id, confirm, preview_hash);
  }

  kg_merge_undo(audit_id: string, confirm = false, preview_hash?: string): MergeUndoResult {
    return this.store.undoMerge(audit_id, confirm, preview_hash);
  }

  kg_export(input: KgExportInput) { return exportGraph(this.store, { format: input.format, maxBytes: input.max_bytes, maxRecords: input.max_records }); }
  kg_import_preview(input: string | Uint8Array) { return previewJsonlImport(this.store, input, this.importLimits()); }
  kg_import_confirm(input: KgImportConfirmInput) { return confirmJsonlImport(this.store, input, this.importLimits()); }
  kg_import(input: KgImportInput) {
    if (input.format !== "jsonl") throw new Error("unsupported import format");
    return input.confirm === true
      ? confirmJsonlImport(this.store, { previewHash: input.preview_hash ?? "", input: input.data, confirm: true }, this.importLimits())
      : previewJsonlImport(this.store, input.data, this.importLimits());
  }

  private integrationFailure(provider: IntegrationProviderId, operation: Exclude<KgIntegrationResult["operation"], "status">, error: unknown, externalId?: string): KgIntegrationResult {
    const warning = integrationWarning(error), status = warning === "unavailable" ? "unavailable" : "degraded";
    this.integrationStatuses.save({ provider, detected_version: null, capabilities: this.providerAdapters.capabilities(provider) ?? integrationCapabilities(provider), status, warning_code: warning, last_probe_at: this.now() });
    return { provider, operation, status, warning_code: warning, ...(externalId ? { external_id: externalId } : {}) };
  }

  private importLimits() { return { maxBytes: this.config.query?.maxImportBytes, maxRecords: this.config.query?.maxImportRecords }; }
}

const safeUrlCategories = new Set<SafeUrlErrorCategory>(["invalid_url", "blocked_address", "redirect_blocked", "too_many_redirects", "timeout", "http_error", "unsupported_content", "response_too_large", "invalid_text", "network_error"]);
function safeUrlCategory(error: unknown): SafeUrlErrorCategory {
  const category = typeof error === "object" && error !== null && "category" in error ? String(error.category) : "network_error";
  return safeUrlCategories.has(category as SafeUrlErrorCategory) ? category as SafeUrlErrorCategory : "network_error";
}

export function createMnemoraTools(options: MnemoraOptions = {}) {
  const graphology = new Mnemora(options);
  return {
    graphology,
    tools: {
      kg_ingest: graphology.kg_ingest.bind(graphology),
      kg_ingest_batch: graphology.kg_ingest_batch.bind(graphology),
      kg_ingest_file: graphology.kg_ingest_file.bind(graphology),
      kg_ingest_url: graphology.kg_ingest_url.bind(graphology),
      kg_embed_backfill: graphology.kg_embed_backfill.bind(graphology),
      kg_search: graphology.kg_search.bind(graphology),
      kg_related: graphology.kg_related.bind(graphology),
      kg_stats: graphology.kg_stats.bind(graphology),
      kg_profile: graphology.kg_profile.bind(graphology),
      kg_profile_lock: graphology.kg_profile_lock.bind(graphology),
      kg_scopes: graphology.kg_scopes.bind(graphology),
      kg_context: graphology.kg_context.bind(graphology),
      kg_recall_explain: graphology.kg_recall_explain.bind(graphology),
      kg_sources: graphology.kg_sources.bind(graphology),
      kg_memory: graphology.kg_memory.bind(graphology),
      kg_forget: graphology.kg_forget.bind(graphology),
      kg_review: graphology.kg_review.bind(graphology),
      kg_merge: graphology.kg_merge.bind(graphology),
      kg_merge_undo: graphology.kg_merge_undo.bind(graphology),
      kg_insights: graphology.kg_insights.bind(graphology),
      kg_query: graphology.kg_query.bind(graphology),
      kg_verify: graphology.kg_verify.bind(graphology),
      kg_recall_metrics: graphology.kg_recall_metrics.bind(graphology),
      kg_recall_canary: graphology.kg_recall_canary.bind(graphology),
      kg_timeline: graphology.kg_timeline.bind(graphology),
      kg_compare: graphology.kg_compare.bind(graphology),
      kg_watch: graphology.kg_watch.bind(graphology),
      kg_digest: graphology.kg_digest.bind(graphology),
      kg_export: graphology.kg_export.bind(graphology),
      kg_import: graphology.kg_import.bind(graphology),
      kg_query_history: graphology.kg_query_history.bind(graphology),
      kg_integrations: graphology.kg_integrations.bind(graphology)
    }
  };
}

/**
 * Optional post-retrieval quality pass for memory documents. It runs only on
 * already scope-filtered, bounded candidates. With the default multiplier of
 * one and lambda of one, it is intentionally an identity ranking.
 */
function rankMemoryCandidates(
  items: import("./types.js").KgMemorySearchResult[],
  limit: number,
  policy: NonNullable<NonNullable<MnemoraConfig["memory"]>["retrieval"]>,
  feedbackSalience?: (item: import("./types.js").KgMemorySearchResult) => number,
  now: () => number = Date.now
): import("./types.js").KgMemorySearchResult[] {
  const bounded = Math.max(1, Math.min(10, Math.trunc(limit)));
  const floor = Math.max(0, Math.min(1, Number(policy.minScore ?? 0)));
  const aging = policy.aging;
  const lambda = Math.max(0, Math.min(1, Number(policy.mmrLambda ?? 1)));
  const rank = (values: import("./types.js").KgMemorySearchResult[]) => selectMemoryCandidates(values, bounded, floor, lambda);
  // Ranking may be evaluated more than once to determine whether feedback or
  // freshness changed the selected order.  Cache the bounded, read-only
  // salience lookup by scope and document id so a candidate never causes
  // duplicate feedback queries in one ranking pass.
  const feedbackCache = new Map<string, number>();
  const feedbackFor = (item: import("./types.js").KgMemorySearchResult): number => {
    if (!feedbackSalience) return .5;
    const key = `${item.scope}\u0000${item.id}`;
    const cached = feedbackCache.get(key);
    if (cached != null) return cached;
    const value = Math.max(0, Math.min(1, Number(feedbackSalience(item))));
    feedbackCache.set(key, value);
    return value;
  };
  const apply = (includeFeedback: boolean, includeAging: boolean) => items.map(item => {
    let value = item;
    if (includeFeedback && feedbackSalience) {
      const salience = feedbackFor(item);
      if (salience !== .5) value = { ...value, score: Math.round(value.score * (.5 + salience) * 1e6) / 1e6, feedback_score: Math.round(salience * 1e6) / 1e6 };
    }
    if (includeAging && aging?.enabled === true) {
      const ageDays = Math.max(0, now() - item.updated_at) / 86_400_000;
      const shape = Math.max(.25, Math.min(5, Number(aging.shape ?? 1.5)));
      const scale = Math.max(1, Math.min(3650, Number(aging.scaleDays ?? 180)));
      const minimum = Math.max(0, Math.min(1, Number(aging.minimumFreshness ?? .1)));
      const freshness = Math.max(minimum, Math.exp(-Math.pow(ageDays / scale, shape)));
      value = { ...value, score: Math.round(value.score * freshness * 1e6) / 1e6, freshness_score: Math.round(freshness * 1e6) / 1e6 };
    }
    return value;
  });
  const final = rank(apply(true, true));
  // Derived component fields are explanations, not persistent facts. Expose
  // each only when that specific signal actually changed selected ordering.
  const feedbackChanged = feedbackSalience != null && !sameMemoryOrder(final, rank(apply(false, true)));
  const freshnessChanged = aging?.enabled === true && !sameMemoryOrder(final, rank(apply(true, false)));
  return final.map(item => {
    const { feedback_score: _feedback, freshness_score: _freshness, ...plain } = item;
    return {
      ...plain,
      ...(feedbackChanged && item.feedback_score != null ? { feedback_score: item.feedback_score } : {}),
      ...(freshnessChanged && item.freshness_score != null ? { freshness_score: item.freshness_score } : {})
    };
  });
}

/**
 * Hybrid retrieval deliberately protects a strong local lexical match from a
 * semantically similar but textually unrelated document.  The floor applies
 * only once the normalized lexical score is high enough to be meaningful; it
 * is not a boost for ordinary fuzzy/LIKE candidates.  An optional reranker
 * still receives the same bounded, scope-local pool and can make the final
 * ordering decision afterwards.
 */
function mergeHybridMemoryCandidate(item: { lexical?: import("./types.js").KgMemorySearchResult; semantic?: import("./types.js").KgMemorySearchResult }): import("./types.js").KgMemorySearchResult {
  const lexicalScore = item.lexical?.score ?? 0;
  const semanticScore = item.semantic?.score ?? 0;
  const chosen = item.semantic && (!item.lexical || semanticScore >= lexicalScore) ? item.semantic : item.lexical!;
  const blended = roundMemoryScore(.45 * lexicalScore + .55 * semanticScore);
  // FTS/direct-name results normalize to the top end of the lexical range.
  // Keep those results discoverable even when a vector tie or near-match has a
  // stronger semantic score. A .92 floor preserves the lexical signal without
  // turning it into an absolute, unreviewable rank lock.
  const lexicalFloor = lexicalScore >= .75 ? roundMemoryScore(lexicalScore * .92) : 0;
  const preserved = lexicalFloor > blended;
  return {
    ...chosen,
    score: preserved ? lexicalFloor : blended,
    score_components: { lexical: lexicalScore, semantic: semanticScore },
    ...(preserved ? { lexical_preservation_score: lexicalFloor } : {})
  };
}

function roundMemoryScore(value: number): number { return Math.round(Math.max(0, Math.min(1, value)) * 1e6) / 1e6; }

function selectMemoryCandidates(items: import("./types.js").KgMemorySearchResult[], bounded: number, floor: number, lambda: number): import("./types.js").KgMemorySearchResult[] {
  const ordered = items
    .filter(item => Number.isFinite(item.score) && item.score >= floor)
    .sort((a, b) => b.score - a.score || b.updated_at - a.updated_at || a.id.localeCompare(b.id));
  if (lambda === 1 || ordered.length <= bounded) return ordered.slice(0, bounded);
  const selected: import("./types.js").KgMemorySearchResult[] = [];
  const remaining = [...ordered];
  while (remaining.length && selected.length < bounded) {
    let bestIndex = 0, bestScore = -Infinity;
    for (let index = 0; index < remaining.length; index++) {
      const candidate = remaining[index];
      const redundancy = selected.reduce((maximum, prior) => Math.max(maximum, lexicalOverlap(candidate, prior)), 0);
      const value = lambda * candidate.score - (1 - lambda) * redundancy;
      if (value > bestScore || (value === bestScore && candidate.id.localeCompare(remaining[bestIndex].id) < 0)) { bestIndex = index; bestScore = value; }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function sameMemoryOrder(left: readonly import("./types.js").KgMemorySearchResult[], right: readonly import("./types.js").KgMemorySearchResult[]): boolean {
  return left.length === right.length && left.every((item, index) => item.id === right[index]?.id);
}

function lexicalOverlap(left: import("./types.js").KgMemorySearchResult, right: import("./types.js").KgMemorySearchResult): number {
  const terms = (value: string) => new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2).slice(0, 256));
  const a = terms(`${left.title}\n${left.excerpt}`), b = terms(`${right.title}\n${right.excerpt}`);
  if (!a.size || !b.size) return 0;
  let shared = 0; for (const term of a) if (b.has(term)) shared++;
  return shared / Math.min(a.size, b.size);
}

function classifyEmbeddingFailure(error: unknown): "timeout" | "provider" | "invalid_response" | "persistence" | "unknown" {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timeout")) return "timeout";
  if (message.includes("embedding request failed") || error instanceof TypeError) return "provider";
  if (message.includes("embedding") && (message.includes("invalid") || message.includes("mismatch") || message.includes("dimensions") || message.includes("vectors"))) return "invalid_response";
  if (message.includes("sqlite") || message.includes("database")) return "persistence";
  return "unknown";
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value!)) : fallback;
}

function governanceResourceId(kind: string, fields: readonly string[]): string {
  return `${kind}:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
}

function integrationCapabilities(provider: IntegrationProviderId): ProviderCapabilities {
  return provider === "lossless-claw"
    ? { providerId: provider, searchSources: false, resolveRawSource: true, resolveSummaryLineage: true, stableExternalIds: true, returnsContentHash: false, returnsScores: false, supportsAbortSignal: true }
    : { providerId: provider, searchSources: true, resolveRawSource: false, resolveSummaryLineage: false, stableExternalIds: true, returnsContentHash: false, returnsScores: false, supportsAbortSignal: true };
}
function boundedExternalId(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value) ? value : undefined; }
function integrationWarning(error: unknown): "unavailable" | "timeout" | "cancelled" | "output_too_large" | "invalid_response" | "not_found" | "operation_failed" {
  if (error instanceof BoundedCommandError) return error.category;
  return "operation_failed";
}

function truncateInput(input: string, maxChars: number): string { return input.slice(0, Math.max(0, Math.trunc(maxChars))); }
function composeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal != null);
  return present.length === 0 ? undefined : present.length === 1 ? present[0] : AbortSignal.any(present);
}

async function requestWithTimeout<T>(request: (signal: AbortSignal) => Promise<T>, timeoutMs: number, callerSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let rejectCaller!: (error: Error) => void;
  const callerAbort = new Promise<T>((_, reject) => { rejectCaller = reject; });
  const abort = () => { controller.abort(callerSignal?.reason); rejectCaller(new SemanticSearchUnavailableError("aborted")); };
  callerSignal?.addEventListener("abort", abort, { once: true });
  if (callerSignal?.aborted) abort();
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<T>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(new Error("embedding timeout")); rejectTimeout(new SemanticSearchUnavailableError("timeout")); }, timeoutMs);
  try { return await Promise.race([request(controller.signal), timeout, callerAbort]); }
  catch (error) { if (controller.signal.aborted && !callerSignal?.aborted) throw new SemanticSearchUnavailableError("timeout"); throw error; }
  finally { clearTimeout(timer); callerSignal?.removeEventListener("abort", abort); }
}

function semanticError(error: unknown): SemanticSearchUnavailableError {
  if (error instanceof SemanticSearchUnavailableError) return error;
  if (error instanceof VectorBackendCallError && error.code === "cancelled") return new SemanticSearchUnavailableError("aborted");
  const category = classifyEmbeddingFailure(error);
  return new SemanticSearchUnavailableError(category === "invalid_response" ? "invalid_response" : category === "timeout" ? "timeout" : "provider");
}
