import { defaultConfig, type MnemoraConfig } from "./index.js";
import { relationshipDefinitions, type RelationshipType } from "./relationships.js";
import { normalizeOperationsConfig } from "./operations/types.js";
import { configuredScope } from "./scope.js";
import { resolveDatabasePath } from "./identity.js";
import { normalizeSessionPatterns } from "./journal/session-policy.js";

const clamp = (value: unknown, fallback: number, min: number, max: number) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const normalizeBaseURL = (value: unknown, fallback: string) => {
  if (typeof value !== "string") return fallback;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? value.replace(/\/+$/, "")
      : fallback;
  } catch {
    return fallback;
  }
};

const rejectBindOverrides = (value: unknown): void => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  for (const key of ["host", "bindHost", "port"])
    if (key in value) throw new Error("invalid inspector bind config");
};

const normalizeWeights = (value: NonNullable<MnemoraConfig["recall"]>["hybridWeights"]) => {
  const fallback = defaultConfig.recall!.hybridWeights!;
  if (!value) return fallback;
  const weights = [value.semantic, value.lexical, value.confidence, value.freshness];
  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) return fallback;
  return Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) <= 0.000001 ? value : fallback;
};

const normalizeQualityWeights = (value: NonNullable<MnemoraConfig["quality"]>["rankingWeights"]) => {
  const fallback = defaultConfig.quality!.rankingWeights!;
  if (!value) return fallback;
  const values = Object.values(value);
  if (values.some(weight => !Number.isFinite(weight) || weight < 0) || values.reduce((sum, weight) => sum + weight, 0) <= 0) return fallback;
  return value;
};

const normalizeModelId = (value: unknown, fallback = "default") => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120 && !/[\u0000-\u001f]/.test(value)
  ? value.trim() : fallback;
const normalizeCanaryScopes = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.map(item => configuredScope(item, "")).filter(Boolean))].slice(0, 20)
  : [];
const normalizeActivePluginIds = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.filter(item => typeof item === "string").map(item => item.trim().toLowerCase()).filter(item => /^[a-z][a-z0-9-]{0,79}$/.test(item)))].slice(0, 20)
  : [];
const normalizeAgentIds = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === "string").map(item => item.trim().toLowerCase()).filter(item => /^[a-z0-9][a-z0-9_.:-]{0,79}$/.test(item)))].slice(0, 40)
  : [];
/** A workspace root is configuration only: it is never persisted or returned. */
const normalizeWorkspaceRoot = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 4096 && !/[\u0000-\u001f]/u.test(value)
  ? value.trim()
  : "";
// Apply the shared 32-pattern cap only after environment and plugin config
// have been combined.  Capping each source independently can silently discard
// configured rules whenever the environment already contains 32 entries.
const sessionPatterns = (value: unknown, environment: string | undefined) => normalizeSessionPatterns([
  ...(Array.isArray(value) ? value : []),
  ...(typeof environment === "string" ? environment.split(/[\r\n,;]+/u) : [])
]);
const governanceActions = new Set(["verification.transition", "conflict.resolve", "profile.selection"]);

export function normalizeConfig(input: Partial<MnemoraConfig> = {}): MnemoraConfig {
  rejectBindOverrides(input);
  const edgeTypeMinConfidence = Object.fromEntries(Object.entries(input.quality?.edgeTypeMinConfidence ?? {})
    .filter(([type]) => type in relationshipDefinitions)
    .map(([type, value]) => [type, clamp(value, 0, 0, 1)])) as Partial<Record<RelationshipType, number>>;
  const singleValuedEdgeTypes = [...new Set(input.quality?.singleValuedEdgeTypes ?? [])]
    .filter((type): type is RelationshipType => type in relationshipDefinitions);
  return {
    dbPath: resolveDatabasePath(input.dbPath),
    // Mnemora has one ContextEngine lifecycle. Preserve the legacy spelling so
    // old configuration files still validate, but never revive hook behavior.
    mode: "standalone",
    toolSurface: input.toolSurface === "core" || input.toolSurface === "research" ? input.toolSurface : "full",
    llm: { ...defaultConfig.llm, ...input.llm },
    extraction: {
      ...defaultConfig.extraction,
      ...input.extraction,
      timeoutMs: clamp(input.extraction?.timeoutMs, 15000, 1000, 600000),
      maxInputChars: clamp(input.extraction?.maxInputChars, 16000, 1000, 100000),
      autoInputQuality: {
        mode: input.extraction?.autoInputQuality?.mode === "shadow" || input.extraction?.autoInputQuality?.mode === "enforce" ? input.extraction.autoInputQuality.mode : "off",
        maxSegments: clamp(input.extraction?.autoInputQuality?.maxSegments, 16, 1, 32)
      }
    },
    embeddings: {
      ...defaultConfig.embeddings,
      ...input.embeddings,
      // Ollama is the only shipped embedding transport.  Keep an invalid
      // programmatic value from being silently advertised as supported.
      provider: input.embeddings?.provider === "ollama" ? "ollama" : defaultConfig.embeddings!.provider!,
      baseURL: normalizeBaseURL(input.embeddings?.baseURL, defaultConfig.embeddings!.baseURL!),
      timeoutMs: clamp(input.embeddings?.timeoutMs, 10000, 1000, 120000),
      batchSize: clamp(input.embeddings?.batchSize, 16, 1, 128),
      maxInputChars: clamp(input.embeddings?.maxInputChars, 16000, 256, 100000),
      queryCacheSize: clamp(input.embeddings?.queryCacheSize, 256, 0, 4096),
      maxVectorScanNodes: clamp(input.embeddings?.maxVectorScanNodes, 10000, 100, 100000)
    },
    insights: {
      maxNodes: clamp(input.insights?.maxNodes, 10000, 1, 10000),
      maxEdges: clamp(input.insights?.maxEdges, 50000, 1, 50000),
      confidenceFloor: clamp(input.insights?.confidenceFloor, .6, 0, 1),
      recentWindowDays: clamp(input.insights?.recentWindowDays, 7, 1, 3650),
      baselineWindowDays: clamp(input.insights?.baselineWindowDays, 28, 1, 3650),
      minEmergingEntities: clamp(input.insights?.minEmergingEntities, 3, 1, Number.MAX_SAFE_INTEGER),
      minEmergingGrowth: clamp(input.insights?.minEmergingGrowth, 2, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER),
      maxPathLength: clamp(input.insights?.maxPathLength, 4, 2, 4),
      maxResults: clamp(input.insights?.maxResults, 20, 1, 20),
      explanationTimeoutMs: clamp(input.insights?.explanationTimeoutMs, 10000, 1000, 60000),
      maxExplanationCandidates: clamp(input.insights?.maxExplanationCandidates, 5, 0, 5)
    },
    recall: {
      ...defaultConfig.recall,
      ...input.recall,
      injection: {
        mode: input.recall?.injection?.mode === "inject" || input.recall?.injection?.mode === "shadow" ? input.recall.injection.mode : "off",
        maxMemoryTokens: clamp(input.recall?.injection?.maxMemoryTokens, 1200, 0, 1500),
        maxMemoryItems: clamp(input.recall?.injection?.maxMemoryItems, 8, 0, 8),
        minRelevanceScore: clamp(input.recall?.injection?.minRelevanceScore, .72, 0, 1),
        maxInjectionsPerMemory: clamp(input.recall?.injection?.maxInjectionsPerMemory, 2, 1, 10),
        maxConsecutiveInjections: clamp(input.recall?.injection?.maxConsecutiveInjections, 3, 1, 10)
      },
      maxNodes: clamp(input.recall?.maxNodes, 5, 1, 50),
      maxDepth: clamp(input.recall?.maxDepth, 1, 0, 5),
      confidenceThreshold: clamp(input.recall?.confidenceThreshold, 0.6, 0, 1),
      tokenBudget: clamp(input.recall?.tokenBudget, 800, 100, 8000),
      semanticMinScore: clamp(input.recall?.semanticMinScore, 0.35, 0, 1),
      hybridWeights: normalizeWeights(input.recall?.hybridWeights),
      queryRouting: {
        enabled: input.recall?.queryRouting?.enabled === true,
        tagPrefix: input.recall?.queryRouting?.tagPrefix !== false,
        queryExpansion: input.recall?.queryRouting?.queryExpansion !== false,
        intentRouting: input.recall?.queryRouting?.intentRouting !== false,
        identifierHints: input.recall?.queryRouting?.identifierHints !== false
      },
      excludedAgentIds: normalizeAgentIds(input.recall?.excludedAgentIds)
    },
    scope: { default: configuredScope(input.scope?.default, defaultConfig.scope?.default ?? "default") },
    memory: {
      captureOnAutoExtract: input.memory?.captureOnAutoExtract === true,
      maxDocumentChars: clamp(input.memory?.maxDocumentChars, 12000, 256, 100000),
      maxResults: clamp(input.memory?.maxResults, 3, 1, 10),
      retrieval: {
        candidateMultiplier: clamp(input.memory?.retrieval?.candidateMultiplier, 3, 1, 10),
        minScore: clamp(input.memory?.retrieval?.minScore, 0, 0, 1),
        mmrLambda: clamp(input.memory?.retrieval?.mmrLambda, 1, 0, 1),
        reranker: {
          enabled: input.memory?.retrieval?.reranker?.enabled === true,
          endpoint: normalizeBaseURL(input.memory?.retrieval?.reranker?.endpoint, ""),
          apiKey: typeof input.memory?.retrieval?.reranker?.apiKey === "string" ? input.memory.retrieval.reranker.apiKey.trim().slice(0, 4096) : "",
          model: normalizeModelId(input.memory?.retrieval?.reranker?.model, ""),
          timeoutMs: clamp(input.memory?.retrieval?.reranker?.timeoutMs, 5000, 1000, 30000),
          maxCandidates: clamp(input.memory?.retrieval?.reranker?.maxCandidates, 12, 1, 20),
          maxQueryChars: clamp(input.memory?.retrieval?.reranker?.maxQueryChars, 512, 32, 4096),
          maxDocumentChars: clamp(input.memory?.retrieval?.reranker?.maxDocumentChars, 4000, 128, 16000)
        },
        aging: {
          enabled: input.memory?.retrieval?.aging?.enabled === true,
          shape: clamp(input.memory?.retrieval?.aging?.shape, 1.5, .25, 5),
          scaleDays: clamp(input.memory?.retrieval?.aging?.scaleDays, 180, 1, 3650),
          minimumFreshness: clamp(input.memory?.retrieval?.aging?.minimumFreshness, .1, 0, 1)
        }
      },
      lifecycle: {
        enabled: input.memory?.lifecycle?.enabled === true,
        accessReinforcement: input.memory?.lifecycle?.accessReinforcement !== false,
        corePromotionAccesses: clamp(input.memory?.lifecycle?.corePromotionAccesses, 12, 2, 1000),
        temporalInference: input.memory?.lifecycle?.temporalInference === true
      }
    },
    conversationJournal: {
      enabled: input.conversationJournal?.enabled === true,
      maxInlineChars: clamp(input.conversationJournal?.maxInlineChars, 16000, 256, 16000),
      maxEventBytes: clamp(input.conversationJournal?.maxEventBytes, 262144, 1024, 262144),
      retentionDays: clamp(input.conversationJournal?.retentionDays, 0, 0, 3650),
      sensitiveContentPolicy: ["redact", "hash_only", "metadata_only", "drop"].includes(input.conversationJournal?.sensitiveContentPolicy ?? "") ? input.conversationJournal!.sensitiveContentPolicy! : "redact",
      ignoreSessionPatterns: sessionPatterns(input.conversationJournal?.ignoreSessionPatterns, process.env.MNEMORA_IGNORE_SESSION_PATTERNS),
      statelessSessionPatterns: sessionPatterns(input.conversationJournal?.statelessSessionPatterns, process.env.MNEMORA_STATELESS_SESSION_PATTERNS),
      replayFloodThresholdExternal: clamp(input.conversationJournal?.replayFloodThresholdExternal, 24, 1, 512),
      replayFloodThresholdInternal: clamp(input.conversationJournal?.replayFloodThresholdInternal, 8, 1, 512)
    },
    contextEngine: {
      enabled: input.contextEngine?.enabled === true,
      maxContextTokens: clamp(input.contextEngine?.maxContextTokens, 8000, 256, 64000),
      maxSummaryChars: clamp(input.contextEngine?.maxSummaryChars, 8000, 256, 32000),
      protectedRecentEvents: clamp(input.contextEngine?.protectedRecentEvents, 6, 2, 50),
      compaction: {
        enabled: input.contextEngine?.compaction?.enabled === true,
        minEvents: clamp(input.contextEngine?.compaction?.minEvents, 4, 2, 50),
        maxInputChars: clamp(input.contextEngine?.compaction?.maxInputChars, 12000, 1024, 100000),
        maxOutputChars: clamp(input.contextEngine?.compaction?.maxOutputChars, 4000, 256, 16000),
        timeoutMs: clamp(input.contextEngine?.compaction?.timeoutMs, 15000, 1000, 120000),
        maxRunsPerHour: clamp(input.contextEngine?.compaction?.maxRunsPerHour, 4, 1, 24),
        maxDailyTokens: clamp(input.contextEngine?.compaction?.maxDailyTokens, 32000, 1000, 1000000),
        circuitCooldownMs: clamp(input.contextEngine?.compaction?.circuitCooldownMs, 3600000, 60000, 86400000),
        summaryMaxCallsPerWindow: clamp(input.contextEngine?.compaction?.summaryMaxCallsPerWindow, 24, 1, 100),
        summaryCallWindowMs: clamp(input.contextEngine?.compaction?.summaryCallWindowMs, 600000, 60000, 86400000),
        summarySpendBackoffMs: clamp(input.contextEngine?.compaction?.summarySpendBackoffMs, 1800000, 60000, 86400000),
        contextThreshold: clamp(input.contextEngine?.compaction?.contextThreshold, .75, .5, .95),
        freshTailCount: clamp(input.contextEngine?.compaction?.freshTailCount, 8, 2, 50),
        leafChunkTokens: clamp(input.contextEngine?.compaction?.leafChunkTokens, 3000, 256, 24000),
        maxChunksPerRun: clamp(input.contextEngine?.compaction?.maxChunksPerRun, 4, 1, 12),
        condensedMinFanout: clamp(input.contextEngine?.compaction?.condensedMinFanout, 4, 2, 12),
        deadlineMs: clamp(input.contextEngine?.compaction?.deadlineMs, 45000, 1000, 300000)
      }
    },
    artifacts: {
      enabled: input.artifacts?.enabled === true,
      inlineThresholdChars: clamp(input.artifacts?.inlineThresholdChars, 12000, 1024, 100000),
      maxArtifactBytes: clamp(input.artifacts?.maxArtifactBytes, 262144, 1024, 2097152),
      toolPayloads: { enabled: input.artifacts?.toolPayloads?.enabled === true }
    },
    corpus: {
      enabled: input.corpus?.enabled === true,
      workspaceRoot: normalizeWorkspaceRoot(input.corpus?.workspaceRoot),
      syncOnSearch: input.corpus?.syncOnSearch !== false,
      syncIntervalMs: clamp(input.corpus?.syncIntervalMs, 60000, 60000, 86400000),
      maxFileBytes: clamp(input.corpus?.maxFileBytes, 1048576, 1024, 1048576),
      maxFiles: clamp(input.corpus?.maxFiles, 500, 1, 1000),
      maxSessionFilesPerAgent: clamp(input.corpus?.maxSessionFilesPerAgent, 25, 1, 25),
      maxChunkChars: clamp(input.corpus?.maxChunkChars, 4000, 256, 8000),
      maxChunkLines: clamp(input.corpus?.maxChunkLines, 80, 1, 200),
      includeSessions: input.corpus?.includeSessions === true,
      includeDreamingArtifacts: input.corpus?.includeDreamingArtifacts === true
    },
    workspaceBoundary: { userMdExclusive: { enabled: input.workspaceBoundary?.userMdExclusive?.enabled === true } },
    episodicMemory: { enabled: input.episodicMemory?.enabled === true, autoExtract: input.episodicMemory?.autoExtract === true, maxEpisodesPerTurn: clamp(input.episodicMemory?.maxEpisodesPerTurn, 3, 1, 3), minImportance: clamp(input.episodicMemory?.minImportance, .5, 0, 1), extractionMode: input.episodicMemory?.extractionMode === "signal" ? "signal" : "basic", smartExtraction: { enabled: input.episodicMemory?.smartExtraction?.enabled === true, maxInputChars: clamp(input.episodicMemory?.smartExtraction?.maxInputChars, 12000, 1000, 32000), maxOutputChars: clamp(input.episodicMemory?.smartExtraction?.maxOutputChars, 6000, 512, 16000), maxEpisodesPerTurn: clamp(input.episodicMemory?.smartExtraction?.maxEpisodesPerTurn, 3, 1, 3), timeoutMs: clamp(input.episodicMemory?.smartExtraction?.timeoutMs, 15000, 1000, 120000), minImportance: clamp(input.episodicMemory?.smartExtraction?.minImportance, .5, 0, 1) } },
    standalone: { activePluginIds: normalizeActivePluginIds(input.standalone?.activePluginIds) },
    consolidation: { enabled: input.consolidation?.enabled === true, maxJobsPerRun: clamp(input.consolidation?.maxJobsPerRun, 4, 1, 20), leaseMs: clamp(input.consolidation?.leaseMs, 45000, 5000, 300000), proposalTtlDays: clamp(input.consolidation?.proposalTtlDays, 14, 1, 90), staleAfterDays: clamp(input.consolidation?.staleAfterDays, 90, 1, 3650) },
  cognition: { formationShadow: input.cognition?.formationShadow !== false, admission: { mode: input.cognition?.admission?.mode === "enforce" ? "enforce" : "shadow", preAdmission: { mode: input.cognition?.admission?.preAdmission?.mode === "enforce" ? "enforce" : input.cognition?.admission?.preAdmission?.mode === "shadow" ? "shadow" : "off" } }, beliefs: { enabled: input.cognition?.beliefs?.enabled === true, autoCorroborate: input.cognition?.beliefs?.autoCorroborate === true }, contextCompiler: { enabled: input.cognition?.contextCompiler?.enabled === true, tokenBudget: clamp(input.cognition?.contextCompiler?.tokenBudget, 600, 64, 1600), maxItems: clamp(input.cognition?.contextCompiler?.maxItems, 8, 1, 20) }, reflection: { enabled: input.cognition?.reflection?.enabled === true, maxJobsPerRun: clamp(input.cognition?.reflection?.maxJobsPerRun, 4, 1, 20), staleAfterDays: clamp(input.cognition?.reflection?.staleAfterDays, 90, 1, 3650) }, graduation: { enabled: input.cognition?.graduation?.enabled === true }, reasoningCuration: { intake: { enabled: input.cognition?.reasoningCuration?.intake?.enabled === true, maxCandidatesPerTurn: clamp(input.cognition?.reasoningCuration?.intake?.maxCandidatesPerTurn, 2, 1, 2), timeoutMs: clamp(input.cognition?.reasoningCuration?.intake?.timeoutMs, 15000, 1000, 120000), maxInputChars: clamp(input.cognition?.reasoningCuration?.intake?.maxInputChars, 8000, 1000, 32000), maxOutputChars: clamp(input.cognition?.reasoningCuration?.intake?.maxOutputChars, 2000, 512, 16000) }, formation: { enabled: input.cognition?.reasoningCuration?.formation?.enabled === true, maxJobsPerTurn: clamp(input.cognition?.reasoningCuration?.formation?.maxJobsPerTurn, 1, 1, 3), minOutcomeConfidence: clamp(input.cognition?.reasoningCuration?.formation?.minOutcomeConfidence, .75, 0, 1), timeoutMs: clamp(input.cognition?.reasoningCuration?.formation?.timeoutMs, 15000, 1000, 120000), maxInputChars: clamp(input.cognition?.reasoningCuration?.formation?.maxInputChars, 8000, 1000, 32000), maxOutputChars: clamp(input.cognition?.reasoningCuration?.formation?.maxOutputChars, 2000, 512, 16000) }, review: { enabled: input.cognition?.reasoningCuration?.review?.enabled === true, intervalHours: clamp(input.cognition?.reasoningCuration?.review?.intervalHours, 168, 1, 24 * 30), maxItems: clamp(input.cognition?.reasoningCuration?.review?.maxItems, 12, 1, 20), timeoutMs: clamp(input.cognition?.reasoningCuration?.review?.timeoutMs, 15000, 1000, 120000), maxInputChars: clamp(input.cognition?.reasoningCuration?.review?.maxInputChars, 12000, 1000, 32000), maxOutputChars: clamp(input.cognition?.reasoningCuration?.review?.maxOutputChars, 4000, 512, 16000) } }, reasoningRuntime: { shadowMode: input.cognition?.reasoningRuntime?.shadowMode === true, scopes: normalizeCanaryScopes(input.cognition?.reasoningRuntime?.scopes), tokenBudget: clamp(input.cognition?.reasoningRuntime?.tokenBudget, 800, 64, 1600), maxItems: clamp(input.cognition?.reasoningRuntime?.maxItems, 6, 1, 12), minConfidence: clamp(input.cognition?.reasoningRuntime?.minConfidence, .6, 0, 1), highRiskMinConfidence: clamp(input.cognition?.reasoningRuntime?.highRiskMinConfidence, .8, 0, 1), minEvidenceQuality: clamp(input.cognition?.reasoningRuntime?.minEvidenceQuality, .5, 0, 1), highRiskMinEvidenceQuality: clamp(input.cognition?.reasoningRuntime?.highRiskMinEvidenceQuality, .75, 0, 1), maxStalenessDays: clamp(input.cognition?.reasoningRuntime?.maxStalenessDays, 365, 1, 3650), excludeConflicted: input.cognition?.reasoningRuntime?.excludeConflicted !== false, retentionDays: clamp(input.cognition?.reasoningRuntime?.retentionDays, 30, 1, 365), readiness: { minimumRuns: clamp(input.cognition?.reasoningRuntime?.readiness?.minimumRuns, 25, 1, 5000), maxErrorRate: clamp(input.cognition?.reasoningRuntime?.readiness?.maxErrorRate, .05, 0, 1), maxEmptyRate: clamp(input.cognition?.reasoningRuntime?.readiness?.maxEmptyRate, .8, 0, 1), maxP95Ms: clamp(input.cognition?.reasoningRuntime?.readiness?.maxP95Ms, 100, 1, 30000) }, delivery: { enabled: input.cognition?.reasoningRuntime?.delivery?.enabled === true, scopes: normalizeCanaryScopes(input.cognition?.reasoningRuntime?.delivery?.scopes), adapter: "openclaw", calibrationMaxAgeHours: clamp(input.cognition?.reasoningRuntime?.delivery?.calibrationMaxAgeHours, 168, 1, 720), maxConsecutiveDeliveries: clamp(input.cognition?.reasoningRuntime?.delivery?.maxConsecutiveDeliveries, 2, 1, 10), itemRetentionDays: clamp(input.cognition?.reasoningRuntime?.delivery?.itemRetentionDays, 30, 1, 365) }, semantic: { enabled: input.cognition?.reasoningRuntime?.semantic?.enabled === true, timeoutMs: clamp(input.cognition?.reasoningRuntime?.semantic?.timeoutMs, 1500, 100, 15000), minScore: clamp(input.cognition?.reasoningRuntime?.semantic?.minScore, .35, 0, 1), maxCandidates: clamp(input.cognition?.reasoningRuntime?.semantic?.maxCandidates, 50, 1, 50) }, verification: { enabled: input.cognition?.reasoningRuntime?.verification?.enabled === true, maxJobsPerRun: clamp(input.cognition?.reasoningRuntime?.verification?.maxJobsPerRun, 5, 1, 20) } } },
    unifiedRetrieval: { enabled: input.unifiedRetrieval?.enabled === true, shadowMode: input.unifiedRetrieval?.shadowMode === true, tokenBudget: clamp(input.unifiedRetrieval?.tokenBudget, 800, 64, 8000), maxItems: clamp(input.unifiedRetrieval?.maxItems, 8, 1, 20), minConfidence: clamp(input.unifiedRetrieval?.minConfidence, .6, 0, 1), maxStalenessDays: clamp(input.unifiedRetrieval?.maxStalenessDays, 36500, 1, 36500) },
    quality: {
      edgeMinConfidence: clamp(input.quality?.edgeMinConfidence, 0, 0, 1),
      relatedToMinConfidence: clamp(input.quality?.relatedToMinConfidence, 0.8, 0, 1),
      edgeTypeMinConfidence,
      singleValuedEdgeTypes,
      recencyHalfLifeDays: clamp(input.quality?.recencyHalfLifeDays, 90, 1, 3650),
      conflictPenaltyFactor: clamp(input.quality?.conflictPenaltyFactor, .75, 0, 1),
      hubPenaltyFloor: clamp(input.quality?.hubPenaltyFloor, .6, 0, 1),
      rankingWeights: normalizeQualityWeights(input.quality?.rankingWeights),
      pprDamping: clamp(input.quality?.pprDamping, .85, 0, 1),
      pprMaxIterations: clamp(input.quality?.pprMaxIterations, 20, 1, 100),
      pprTolerance: clamp(input.quality?.pprTolerance, 1e-6, 1e-12, .1),
      pprMaxNodes: clamp(input.quality?.pprMaxNodes, 10000, 1, 10000),
      pprMaxArcs: clamp(input.quality?.pprMaxArcs, 50000, 1, 50000)
    },
    ingestion: {
      maxPayloadBytes: clamp(input.ingestion?.maxPayloadBytes, 2 * 1024 * 1024, 1, 10 * 1024 * 1024),
      maxBatchItems: clamp(input.ingestion?.maxBatchItems, 50, 1, 50),
      allowedFileExtensions: (input.ingestion?.allowedFileExtensions ?? [".txt", ".md"]).filter(value => value === ".txt" || value === ".md"),
      urlMaxPayloadBytes: clamp(input.ingestion?.urlMaxPayloadBytes, 2 * 1024 * 1024, 1, 10 * 1024 * 1024),
      urlTimeoutMs: clamp(input.ingestion?.urlTimeoutMs, 15000, 1000, 15000),
      urlMaxRedirects: clamp(input.ingestion?.urlMaxRedirects, 5, 0, 5)
    },
    query: {
      maxSteps: clamp(input.query?.maxSteps, 8, 1, 8),
      maxDepth: clamp(input.query?.maxDepth, 4, 0, 4),
      maxResults: clamp(input.query?.maxResults, 50, 1, 50),
      maxNodes: clamp(input.query?.maxNodes, 10000, 1, 10000),
      maxEdges: clamp(input.query?.maxEdges, 50000, 1, 50000),
      timeoutMs: clamp(input.query?.timeoutMs, 10000, 1, 10000),
      maxResponseBytes: clamp(input.query?.maxResponseBytes, 1048576, 1, 1048576),
      auditRetentionDays: clamp(input.query?.auditRetentionDays, 30, 1, 3650),
      maxWatches: clamp(input.query?.maxWatches, 100, 1, 100),
      maxDigestWatches: clamp(input.query?.maxDigestWatches, 25, 1, 25),
      maxImportBytes: clamp(input.query?.maxImportBytes, 10485760, 1, 10485760),
      maxImportRecords: clamp(input.query?.maxImportRecords, 1000, 1, 1000)
    },
    trustLayer: {
      enabled: input.trustLayer?.enabled === true,
      snapshotMaxBytes: clamp(input.trustLayer?.snapshotMaxBytes, 8192, 256, 32768),
      verification: {
        enabled: input.trustLayer?.verification?.enabled === true, defaultPendingPolicy: "exclude",
        automatic: {
          enabled: input.trustLayer?.verification?.automatic?.enabled === true,
          maxConcurrent: clamp(input.trustLayer?.verification?.automatic?.maxConcurrent, 1, 1, 4),
          maxJobsPerRun: clamp(input.trustLayer?.verification?.automatic?.maxJobsPerRun, 5, 1, 20),
          timeoutMs: clamp(input.trustLayer?.verification?.automatic?.timeoutMs, 15000, 1000, 60000),
          leaseMs: clamp(input.trustLayer?.verification?.automatic?.leaseMs, 45000, 5000, 300000),
          maxInputChars: clamp(input.trustLayer?.verification?.automatic?.maxInputChars, 8000, 256, 16000),
          maxOutputBytes: clamp(input.trustLayer?.verification?.automatic?.maxOutputBytes, 16384, 1024, 65536),
          workerIsolation: input.trustLayer?.verification?.automatic?.workerIsolation !== false
        },
        retrospectiveAudit: {
          enabled: input.trustLayer?.verification?.retrospectiveAudit?.enabled === true,
          maxJobsPerRun: clamp(input.trustLayer?.verification?.retrospectiveAudit?.maxJobsPerRun, 5, 1, 20),
          minimumAgeDays: clamp(input.trustLayer?.verification?.retrospectiveAudit?.minimumAgeDays, 30, 1, 3650),
          minimumRecallCount: clamp(input.trustLayer?.verification?.retrospectiveAudit?.minimumRecallCount, 3, 1, 10000)
        }
      },
      recall: {
        shadowMode: input.trustLayer?.recall?.shadowMode !== false,
        absoluteFloor: clamp(input.trustLayer?.recall?.absoluteFloor, 0, 0, 1),
        relativeCutoffRatio: clamp(input.trustLayer?.recall?.relativeCutoffRatio, .6, 0, 1),
        confidenceGate: clamp(input.trustLayer?.recall?.confidenceGate, .6, 0, 1),
        minKeep: clamp(input.trustLayer?.recall?.minKeep, 1, 0, 10),
        candidateMultiplier: clamp(input.trustLayer?.recall?.candidateMultiplier, 5, 1, 10),
        canary: {
          enabled: input.trustLayer?.recall?.canary?.enabled === true,
          modelId: normalizeModelId(input.trustLayer?.recall?.canary?.modelId),
          scopes: normalizeCanaryScopes(input.trustLayer?.recall?.canary?.scopes)
        }
      },
      governance: {
        enabled: input.trustLayer?.governance?.enabled === true,
        approvalTtlMs: clamp(input.trustLayer?.governance?.approvalTtlMs, 900000, 60000, 86400000),
        requireApprovalFor: [...new Set(input.trustLayer?.governance?.requireApprovalFor ?? ["conflict.resolve"])].filter((action): action is import("./governance/types.js").GovernanceAction => typeof action === "string" && governanceActions.has(action))
      }
    },
    integrations: {
      lossless: {
        enabled: input.integrations?.lossless?.enabled === true,
        timeoutMs: clamp(input.integrations?.lossless?.timeoutMs, 5000, 1000, 30000),
        maxOutputBytes: clamp(input.integrations?.lossless?.maxOutputBytes, 65536, 1024, 262144)
      },
      memoryLanceDbPro: {
        enabled: input.integrations?.memoryLanceDbPro?.enabled === true,
        timeoutMs: clamp(input.integrations?.memoryLanceDbPro?.timeoutMs, 5000, 1000, 30000),
        maxOutputBytes: clamp(input.integrations?.memoryLanceDbPro?.maxOutputBytes, 65536, 1024, 262144)
      }
    },
    inspector: normalizeOperationsConfig(input.inspector)
  } as MnemoraConfig;
}
