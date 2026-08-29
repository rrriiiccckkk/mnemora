export * from "./schema.js";
export * from "./relationships.js";
export * from "./slug.js";
export * from "./types.js";
export * from "./extractor.js";
export * from "./store.js";
export * from "./tools.js";
export * from "./openclaw.js";
export * from "./config.js";
export * from "./scope.js";
export * from "./memory.js";
export * from "./memory-exchange.js";
export * from "./context-engine/lifecycle.js";
export * from "./plugin-runtime.js";
export * from "./embeddings.js";
export * from "./resolution.js";
export * from "./quality.js";
export * from "./ingestion.js";
export * from "./url-ingestion.js";
export * from "./temporal.js";
export * from "./conflicts.js";
export * from "./ranking.js";
export * from "./ppr.js";
export * from "./insights/types.js";
export * from "./insights/metrics.js";
export * from "./insights/detectors.js";
export * from "./insights/service.js";
export * from "./query/types.js";
export * from "./query/validation.js";
export * from "./query/planner.js";
export * from "./query/service.js";
export * from "./query/question.js";
export * from "./query/watch.js";
export * from "./query/timeline.js";
export * from "./query/compare.js";
export * from "./query/exchange.js";
export * from "./query/errors.js";
export * from "./operations/types.js";
export * from "./inspector/types.js";
export * from "./inspector/validation.js";
export * from "./inspector/redaction.js";
export * from "./inspector/service.js";
export * from "./inspector/http.js";
export * from "./inspector/application.js";
export * from "./operations/source-trust.js";
export * from "./operations/artifacts.js";
export * from "./operations/backup.js";
export * from "./operations/migration.js";
export * from "./operations/restore.js";
export * from "./operations/health.js";
export * from "./operations/maintenance.js";
export * from "./trust/index.js";
export * from "./integrations/index.js";
export * from "./profiles/index.js";
export * from "./vectors/index.js";
export * from "./governance/index.js";
export * from "./context/context-ref.js";
export * from "./evaluation/index.js";
export * from "./journal/index.js";
export * from "./context-engine/index.js";
export * from "./artifacts/repository.js";
export * from "./episodes/index.js";
export * from "./retrieval/index.js";
export * from "./correction/index.js";
export * from "./standalone/index.js";
export * from "./consolidation/index.js";
export * from "./personal-memory/index.js";
export * from "./intelligence/index.js";
export * from "./cognition/index.js";
export * from "./recall-lifecycle/repository.js";
export * from "./identity.js";
export { Mnemora } from "./tools.js";

export type SearchMode = "lexical" | "semantic" | "hybrid";

export interface EmbeddingConfig {
  enabled: boolean;
  provider: "ollama";
  baseURL: string;
  model: string;
  timeoutMs: number;
  batchSize: number;
  maxInputChars: number;
  queryCacheSize: number;
  maxVectorScanNodes: number;
}

export interface InsightsConfig {
  maxNodes?: number;
  maxEdges?: number;
  confidenceFloor?: number;
  recentWindowDays?: number;
  baselineWindowDays?: number;
  minEmergingEntities?: number;
  minEmergingGrowth?: number;
  maxPathLength?: number;
  maxResults?: number;
  explanationTimeoutMs?: number;
  maxExplanationCandidates?: number;
}

export interface InspectorConfig {
  maxGraphNodes?: number;
  maxGraphEdges?: number;
  maxGraphResponseBytes?: number;
  graphDeadlineMs?: number;
}

export interface TrustLayerConfig {
  /** Opt-in source anchoring; does not alter existing recall decisions. */
  enabled?: boolean;
  /** Maximum bytes retained per local evidence snapshot. */
  snapshotMaxBytes?: number;
  /** Opt-in strict gate for automatic Mnemora recall. Manual graph queries are unchanged. */
  verification?: {
    enabled?: boolean;
    defaultPendingPolicy?: "exclude";
    /** Explicit opt-in bounded model verification queue; disabled by default. */
    automatic?: { enabled?: boolean; maxConcurrent?: number; maxJobsPerRun?: number; timeoutMs?: number; leaseMs?: number; maxInputChars?: number; maxOutputBytes?: number; /** Run the built-in verifier request in a killable, memory-bounded child process. */ workerIsolation?: boolean };
    /** Explicit opt-in scheduler that creates review work but never changes verified claims. */
    retrospectiveAudit?: { enabled?: boolean; maxJobsPerRun?: number; minimumAgeDays?: number; minimumRecallCount?: number };
  };
  /** Local-only evaluation; enabled by default and never changes recalled context. */
  recall?: {
    shadowMode?: boolean;
    absoluteFloor?: number;
    relativeCutoffRatio?: number;
    confidenceGate?: number;
    minKeep?: number;
    candidateMultiplier?: number;
    /** Three-gated adaptive injection: configuration, ready calibration, and per-scope activation. */
    canary?: { enabled?: boolean; modelId?: string; scopes?: string[] };
  };
  /** Disabled by default: scoped authority and approval ledger for host-bound agents. */
  governance?: import("./governance/types.js").GovernanceConfig;
}

export interface LosslessIntegrationConfig {
  /** Explicitly permits Mnemora to invoke the public `lcm` CLI. */
  enabled?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface MemoryLanceDbProIntegrationConfig {
  /** Explicitly permits Mnemora to invoke public read-only `openclaw memory-pro` commands. */
  enabled?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface MnemoraConfig {
  dbPath: string;
  /** `companion` is accepted as a deprecated alias and normalizes to standalone. */
  mode?: "companion" | "standalone";
  /** Controls the OpenClaw tool definitions registered for an agent session. */
  toolSurface?: ToolSurface;
  llm?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
  };
  extraction?: {
    enabled?: boolean;
    autoExtract?: boolean;
    minConfidenceToStore?: number;
    timeoutMs?: number;
    maxInputChars?: number;
    /** Disabled by default: bounded deterministic filtering and selection for autoExtract input. */
    autoInputQuality?: { mode?: "off" | "shadow" | "enforce"; maxSegments?: number; };
  };
  recall?: {
    /** Deprecated compatibility key. Mnemora never registers a recall hook. */
    autoRecall?: boolean;
    /** Deprecated hook-injection compatibility policy; ContextEngine owns prompt assembly. */
    injection?: { mode?: "off" | "shadow" | "inject"; maxMemoryTokens?: number; maxMemoryItems?: number; minRelevanceScore?: number; maxInjectionsPerMemory?: number; maxConsecutiveInjections?: number; };
    maxNodes?: number;
    maxDepth?: number;
    confidenceThreshold?: number;
    tokenBudget?: number;
    mode?: SearchMode;
    semanticMinScore?: number;
    hybridWeights?: { semantic: number; lexical: number; confidence: number; freshness: number };
    /** Optional deterministic query routing. It is disabled by default. */
    queryRouting?: { enabled?: boolean; tagPrefix?: boolean; queryExpansion?: boolean; intentRouting?: boolean; identifierHints?: boolean; };
    /** Host-exposed agent IDs whose automatic capture and recall must be skipped. */
    excludedAgentIds?: string[];
  };
  scope?: { default?: string };
  memory?: {
    captureOnAutoExtract?: boolean;
    maxDocumentChars?: number;
    maxResults?: number;
    /** Bounded local post-retrieval quality policy. Set candidateMultiplier to 1 to retain the former shallow candidate pool. */
    retrieval?: {
      candidateMultiplier?: number;
      minScore?: number;
      /** 1 keeps relevance-only order; lower values trade relevance for diversity. */
      mmrLambda?: number;
      /** Optional OpenAI-compatible /rerank endpoint. It is disabled by default. */
      reranker?: {
        enabled?: boolean;
        endpoint?: string;
        apiKey?: string;
        model?: string;
        timeoutMs?: number;
        maxCandidates?: number;
        maxQueryChars?: number;
        maxDocumentChars?: number;
      };
      /** Optional Weibull freshness decay for volatile memory documents. */
      aging?: {
        enabled?: boolean;
        shape?: number;
        scaleDays?: number;
        minimumFreshness?: number;
      };
    };
    /** Optional non-destructive memory-document selection lifecycle. */
    lifecycle?: {
      enabled?: boolean;
      accessReinforcement?: boolean;
      corePromotionAccesses?: number;
      /** Infer only bounded local expiry review hints; it never archives data. */
      temporalInference?: boolean;
    };
  };
  conversationJournal?: {
    enabled?: boolean;
    maxInlineChars?: number;
    maxEventBytes?: number;
    retentionDays?: number;
    sensitiveContentPolicy?: "redact" | "hash_only" | "metadata_only" | "drop";
    /** Glob patterns for sessions that must never create persistent memory. */
    ignoreSessionPatterns?: string[];
    /** Glob patterns for read-capable sessions that must not write new memory. */
    statelessSessionPatterns?: string[];
    /** Repeated host-delivered copies allowed for one exact turn before suppression. */
    replayFloodThresholdExternal?: number;
    /** Repeated locally originated copies allowed for one exact turn before suppression. */
    replayFloodThresholdInternal?: number;
  };
  /** Explicitly opt in to Mnemora owning OpenClaw's exclusive ContextEngine slot. */
  contextEngine?: {
    enabled?: boolean;
    maxContextTokens?: number;
    maxSummaryChars?: number;
    protectedRecentEvents?: number;
    /** Explicit local model compaction. Disabled by default; otherwise OpenClaw remains the compactor. */
    compaction?: {
      enabled?: boolean;
      minEvents?: number;
      maxInputChars?: number;
      maxOutputChars?: number;
      timeoutMs?: number;
      maxRunsPerHour?: number;
      maxDailyTokens?: number;
      /** Failure-circuit cooldown. Failed model calls are retried only after this interval. */
      circuitCooldownMs?: number;
      /** Maximum model-summary attempts for one session in the rolling call window. */
      summaryMaxCallsPerWindow?: number;
      summaryCallWindowMs?: number;
      /** Additional pause after a session exhausts its summary-call window. */
      summarySpendBackoffMs?: number;
      /** Start proactive compaction once active context reaches this share of its budget. */
      contextThreshold?: number;
      /** Conversation events retained verbatim beside a compacted projection. */
      freshTailCount?: number;
      /** Conservative token cap for one source-linked leaf summary request. */
      leafChunkTokens?: number;
      /** Maximum leaf chunks compacted by one bounded maintenance attempt. */
      maxChunksPerRun?: number;
      /** Number of leaf summaries required before creating a deterministic parent projection. */
      condensedMinFanout?: number;
      /** Total wall-clock deadline for one chunked compaction attempt. */
      deadlineMs?: number;
    };
  };
  artifacts?: { enabled?: boolean; inlineThresholdChars?: number; maxArtifactBytes?: number; /** Archive and later reference qualifying public string tool results; disabled by default. */ toolPayloads?: { enabled?: boolean; }; };
  /** Explicit, local-only canonical corpus cache. It is not graph evidence or automatic recall input. */
  corpus?: {
    enabled?: boolean;
    /** Required local workspace root. It is never persisted or returned by corpus APIs. */
    workspaceRoot?: string;
    syncOnSearch?: boolean;
    syncIntervalMs?: number;
    maxFileBytes?: number;
    maxFiles?: number;
    maxSessionFilesPerAgent?: number;
    maxChunkChars?: number;
    maxChunkLines?: number;
    includeSessions?: boolean;
    includeDreamingArtifacts?: boolean;
  };
  /** Preserve USER.md as an externally managed profile boundary rather than graph/corpus input. */
  workspaceBoundary?: { userMdExclusive?: { enabled?: boolean; }; };
  episodicMemory?: { enabled?: boolean; autoExtract?: boolean; maxEpisodesPerTurn?: number; minImportance?: number; /** Basic preserves historical interaction capture; signal classifies explicit task events locally. */ extractionMode?: "basic" | "signal"; /** Optional host-runtime LLM episode projection. It is source-linked, bounded, and off by default. */ smartExtraction?: { enabled?: boolean; maxInputChars?: number; maxOutputChars?: number; maxEpisodesPerTurn?: number; timeoutMs?: number; minImportance?: number; }; };
  /** Read-only cross-record recall. Injection is opt-in and only the standalone ContextEngine may produce it. */
  unifiedRetrieval?: { enabled?: boolean; shadowMode?: boolean; tokenBudget?: number; maxItems?: number; minConfidence?: number; maxStalenessDays?: number; /** MMR weight for automatic context only; lower values prefer diversity. */ diversityLambda?: number; };
  embeddings?: Partial<EmbeddingConfig> & Pick<EmbeddingConfig, "enabled">;
  insights?: InsightsConfig;
  quality?: {
    edgeMinConfidence?: number;
    relatedToMinConfidence?: number;
    edgeTypeMinConfidence?: Partial<Record<import("./relationships.js").RelationshipType, number>>;
    singleValuedEdgeTypes?: import("./relationships.js").RelationshipType[];
    recencyHalfLifeDays?: number;
    conflictPenaltyFactor?: number;
    hubPenaltyFloor?: number;
    rankingWeights?: { semantic: number; lexical: number; confidence: number; recency: number; sourceDiversity: number; ppr: number };
    pprDamping?: number;
    pprMaxIterations?: number;
    pprTolerance?: number;
    pprMaxNodes?: number;
    pprMaxArcs?: number;
  };
  ingestion?: Partial<import("./types.js").IngestionConfig>;
  query?: import("./types.js").QueryConfig;
  inspector?: InspectorConfig;
  trustLayer?: TrustLayerConfig;
  integrations?: { lossless?: LosslessIntegrationConfig; memoryLanceDbPro?: MemoryLanceDbProIntegrationConfig };
  /** Public deployment metadata supplied by the host/operator for standalone readiness diagnostics. */
  standalone?: { activePluginIds?: string[] };
  /** Proposal-only local consolidation. Disabled by default and never alters recall or facts. */
  consolidation?: { enabled?: boolean; maxJobsPerRun?: number; leaseMs?: number; proposalTtlDays?: number; staleAfterDays?: number; };
  cognition?: { formationShadow?: boolean; admission?: { mode?: "shadow" | "enforce"; preAdmission?: { mode?: "off" | "shadow" | "enforce"; }; }; beliefs?: { enabled?: boolean; autoCorroborate?: boolean; }; contextCompiler?: { enabled?: boolean; tokenBudget?: number; maxItems?: number; }; reflection?: { enabled?: boolean; maxJobsPerRun?: number; staleAfterDays?: number; }; graduation?: { enabled?: boolean; }; reasoningCuration?: { intake?: { enabled?: boolean; maxCandidatesPerTurn?: number; timeoutMs?: number; maxInputChars?: number; maxOutputChars?: number; }; formation?: { enabled?: boolean; maxJobsPerTurn?: number; minOutcomeConfidence?: number; timeoutMs?: number; maxInputChars?: number; maxOutputChars?: number; }; review?: { enabled?: boolean; intervalHours?: number; maxItems?: number; timeoutMs?: number; maxInputChars?: number; maxOutputChars?: number; }; }; reasoningRuntime?: { shadowMode?: boolean; scopes?: string[]; tokenBudget?: number; maxItems?: number; minConfidence?: number; highRiskMinConfidence?: number; minEvidenceQuality?: number; highRiskMinEvidenceQuality?: number; maxStalenessDays?: number; excludeConflicted?: boolean; retentionDays?: number; readiness?: { minimumRuns?: number; maxErrorRate?: number; maxEmptyRate?: number; maxP95Ms?: number; }; delivery?: { enabled?: boolean; scopes?: string[]; adapter?: "openclaw"; calibrationMaxAgeHours?: number; maxConsecutiveDeliveries?: number; itemRetentionDays?: number; }; semantic?: { enabled?: boolean; timeoutMs?: number; minScore?: number; maxCandidates?: number; }; verification?: { enabled?: boolean; maxJobsPerRun?: number; }; }; };
}

/** A deliberately small everyday tool surface, a research surface, or every supported tool. */
export type ToolSurface = "core" | "research" | "full";

export const defaultConfig: MnemoraConfig = {
  dbPath: "~/.openclaw/mnemora.db",
  mode: "standalone",
  // Keep the historical registration behavior until users explicitly choose a smaller surface.
  toolSurface: "full",
  llm: {
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat"
  },
  extraction: {
    enabled: true,
    autoExtract: false,
    minConfidenceToStore: 0,
    timeoutMs: 15000,
    maxInputChars: 16000,
    autoInputQuality: { mode: "off", maxSegments: 16 }
  },
  recall: {
    autoRecall: false,
    injection: { mode: "off", maxMemoryTokens: 1200, maxMemoryItems: 8, minRelevanceScore: 0.72, maxInjectionsPerMemory: 2, maxConsecutiveInjections: 3 },
    maxNodes: 5,
    maxDepth: 1,
    confidenceThreshold: 0.6,
    tokenBudget: 800,
    mode: "hybrid",
    semanticMinScore: 0.35,
    hybridWeights: { semantic: 0.45, lexical: 0.25, confidence: 0.20, freshness: 0.10 },
    queryRouting: { enabled: false, tagPrefix: true, queryExpansion: true, intentRouting: true, identifierHints: true },
    excludedAgentIds: []
  },
  scope: { default: "default" },
  memory: {
    captureOnAutoExtract: false,
    maxDocumentChars: 12000,
    maxResults: 3,
    retrieval: {
      // Fetch a small local candidate pool before final ranking. This remains
      // bounded (at most 50) and makes hybrid fusion able to recover a result
      // that neither individual top-k list would otherwise return.
      candidateMultiplier: 3,
      minScore: 0,
      mmrLambda: 1,
      reranker: { enabled: false, endpoint: "", model: "", timeoutMs: 5000, maxCandidates: 12, maxQueryChars: 512, maxDocumentChars: 4000 },
      aging: { enabled: false, shape: 1.5, scaleDays: 180, minimumFreshness: 0.1 }
    },
    lifecycle: { enabled: false, accessReinforcement: true, corePromotionAccesses: 12, temporalInference: false }
  },
  conversationJournal: {
    enabled: false,
    maxInlineChars: 16000,
    maxEventBytes: 262144,
    retentionDays: 0,
    sensitiveContentPolicy: "redact",
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    replayFloodThresholdExternal: 24,
    replayFloodThresholdInternal: 8
  },
  contextEngine: { enabled: false, maxContextTokens: 8000, maxSummaryChars: 8000, protectedRecentEvents: 6, compaction: { enabled: false, minEvents: 4, maxInputChars: 12000, maxOutputChars: 4000, timeoutMs: 15000, maxRunsPerHour: 4, maxDailyTokens: 32000, circuitCooldownMs: 3600000, summaryMaxCallsPerWindow: 24, summaryCallWindowMs: 600000, summarySpendBackoffMs: 1800000, contextThreshold: .75, freshTailCount: 8, leafChunkTokens: 3000, maxChunksPerRun: 4, condensedMinFanout: 4, deadlineMs: 45000 } },
  artifacts: { enabled: false, inlineThresholdChars: 12000, maxArtifactBytes: 262144, toolPayloads: { enabled: false } },
  corpus: { enabled: false, workspaceRoot: "", syncOnSearch: true, syncIntervalMs: 60000, maxFileBytes: 1048576, maxFiles: 500, maxSessionFilesPerAgent: 25, maxChunkChars: 4000, maxChunkLines: 80, includeSessions: false, includeDreamingArtifacts: false },
  workspaceBoundary: { userMdExclusive: { enabled: false } },
  episodicMemory: { enabled: false, autoExtract: false, maxEpisodesPerTurn: 3, minImportance: 0.5, extractionMode: "basic", smartExtraction: { enabled: false, maxInputChars: 12000, maxOutputChars: 6000, maxEpisodesPerTurn: 3, timeoutMs: 15000, minImportance: .5 } },
  standalone: { activePluginIds: [] },
  consolidation: { enabled: false, maxJobsPerRun: 4, leaseMs: 45000, proposalTtlDays: 14, staleAfterDays: 90 },
  cognition: { formationShadow: true, admission: { mode: "shadow", preAdmission: { mode: "off" } }, beliefs: { enabled: false, autoCorroborate: false }, contextCompiler: { enabled: false, tokenBudget: 600, maxItems: 8 }, reflection: { enabled: false, maxJobsPerRun: 4, staleAfterDays: 90 }, graduation: { enabled: false }, reasoningCuration: { intake: { enabled: false, maxCandidatesPerTurn: 2, timeoutMs: 15000, maxInputChars: 8000, maxOutputChars: 2000 }, formation: { enabled: false, maxJobsPerTurn: 1, minOutcomeConfidence: .75, timeoutMs: 15000, maxInputChars: 8000, maxOutputChars: 2000 }, review: { enabled: false, intervalHours: 168, maxItems: 12, timeoutMs: 15000, maxInputChars: 12000, maxOutputChars: 4000 } }, reasoningRuntime: { shadowMode: false, scopes: [], tokenBudget: 800, maxItems: 6, minConfidence: .6, highRiskMinConfidence: .8, minEvidenceQuality: .5, highRiskMinEvidenceQuality: .75, maxStalenessDays: 365, excludeConflicted: true, retentionDays: 30, readiness: { minimumRuns: 25, maxErrorRate: .05, maxEmptyRate: .8, maxP95Ms: 100 }, delivery: { enabled: false, scopes: [], adapter: "openclaw", calibrationMaxAgeHours: 168, maxConsecutiveDeliveries: 2, itemRetentionDays: 30 }, semantic: { enabled: false, timeoutMs: 1500, minScore: .35, maxCandidates: 50 }, verification: { enabled: false, maxJobsPerRun: 5 } } },
  unifiedRetrieval: { enabled: false, shadowMode: false, tokenBudget: 800, maxItems: 8, minConfidence: .6, maxStalenessDays: 36500, diversityLambda: .75 },
  embeddings: {
    enabled: false,
    provider: "ollama",
    baseURL: "http://127.0.0.1:11434",
    model: "qwen3-embedding:4b",
    timeoutMs: 10000,
    batchSize: 16,
    maxInputChars: 16000,
    queryCacheSize: 256,
    maxVectorScanNodes: 10000
  },
  insights: {
    maxNodes: 10000,
    maxEdges: 50000,
    confidenceFloor: .6,
    recentWindowDays: 7,
    baselineWindowDays: 28,
    minEmergingEntities: 3,
    minEmergingGrowth: 2,
    maxPathLength: 4,
    maxResults: 20,
    explanationTimeoutMs: 10000,
    maxExplanationCandidates: 5
  },
  quality: {
    edgeMinConfidence: 0,
    relatedToMinConfidence: 0.8,
    edgeTypeMinConfidence: {},
    singleValuedEdgeTypes: [],
    recencyHalfLifeDays: 90,
    conflictPenaltyFactor: .75,
    hubPenaltyFloor: .6,
    rankingWeights: { semantic: .35, lexical: .20, confidence: .15, recency: .10, sourceDiversity: .05, ppr: .15 },
    pprDamping: .85,
    pprMaxIterations: 20,
    pprTolerance: 1e-6,
    pprMaxNodes: 10000,
    pprMaxArcs: 50000
  },
  ingestion: { maxPayloadBytes: 2 * 1024 * 1024, maxBatchItems: 50, allowedFileExtensions: [".txt", ".md"], urlMaxPayloadBytes: 2 * 1024 * 1024, urlTimeoutMs: 15000, urlMaxRedirects: 5 },
  query: { maxSteps: 8, maxDepth: 4, maxResults: 50, maxNodes: 10000, maxEdges: 50000, timeoutMs: 10000, maxResponseBytes: 1048576, auditRetentionDays: 30, maxWatches: 100, maxDigestWatches: 25, maxImportBytes: 10485760, maxImportRecords: 1000 },
  inspector: { maxGraphNodes: 5000, maxGraphEdges: 20000, maxGraphResponseBytes: 4 * 1024 * 1024, graphDeadlineMs: 5000 },
  trustLayer: {
    enabled: false,
    snapshotMaxBytes: 8192,
    verification: { enabled: false, defaultPendingPolicy: "exclude", automatic: { enabled: false, maxConcurrent: 1, maxJobsPerRun: 5, timeoutMs: 15000, leaseMs: 45000, maxInputChars: 8000, maxOutputBytes: 16384, workerIsolation: true }, retrospectiveAudit: { enabled: false, maxJobsPerRun: 5, minimumAgeDays: 30, minimumRecallCount: 3 } },
    recall: { shadowMode: true, absoluteFloor: 0, relativeCutoffRatio: .6, confidenceGate: .6, minKeep: 1, candidateMultiplier: 5, canary: { enabled: false, modelId: "default", scopes: [] } }
  },
  integrations: {
    lossless: { enabled: false, timeoutMs: 5000, maxOutputBytes: 65536 },
    memoryLanceDbPro: { enabled: false, timeoutMs: 5000, maxOutputBytes: 65536 }
  }
};
