import { Type } from "typebox";
import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createOpenClawToolDefinitions } from "./openclaw.js";
import { PluginRuntime } from "./plugin-runtime.js";
import { runMnemoraOperatorCommand } from "./operator-command.js";

const configSchema = Type.Object({
  dbPath: Type.Optional(Type.String()),
  mode: Type.Optional(Type.Union([Type.Literal("companion"), Type.Literal("standalone")], { description: "Standalone is the only runtime lifecycle. companion is accepted as a deprecated configuration alias and never enables hooks." })),
  toolSurface: Type.Optional(Type.Union([Type.Literal("core"), Type.Literal("research"), Type.Literal("full")])),
  llm: Type.Optional(Type.Object({ apiKey: Type.Optional(Type.String()), baseURL: Type.Optional(Type.String()), model: Type.Optional(Type.String()) }, { additionalProperties: false })),
  extraction: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean()), autoExtract: Type.Optional(Type.Boolean({ description: "Run bounded automatic extraction only from a selected ContextEngine afterTurn lifecycle." })), minConfidenceToStore: Type.Optional(Type.Number()), timeoutMs: Type.Optional(Type.Number()), maxInputChars: Type.Optional(Type.Number()), autoInputQuality: Type.Optional(Type.Object({ mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("shadow"), Type.Literal("enforce")])), maxSegments: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })) }, { additionalProperties: false })) }, { additionalProperties: false })),
  recall: Type.Optional(Type.Object({
    autoRecall: Type.Optional(Type.Boolean({ description: "Deprecated compatibility key. It is accepted but never registers a prompt hook; enable unifiedRetrieval with ContextEngine instead." })), maxNodes: Type.Optional(Type.Number()), maxDepth: Type.Optional(Type.Number()), confidenceThreshold: Type.Optional(Type.Number()), tokenBudget: Type.Optional(Type.Number()),
    injection: Type.Optional(Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("shadow"), Type.Literal("inject")])),
      maxMemoryTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: 1500 })),
      maxMemoryItems: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
      minRelevanceScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      maxInjectionsPerMemory: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      maxConsecutiveInjections: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 }))
    }, { additionalProperties: false })),
    mode: Type.Optional(Type.Union([Type.Literal("lexical"), Type.Literal("semantic"), Type.Literal("hybrid")])),
    semanticMinScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    hybridWeights: Type.Optional(Type.Object({
      semantic: Type.Number({ minimum: 0, maximum: 1 }), lexical: Type.Number({ minimum: 0, maximum: 1 }),
      confidence: Type.Number({ minimum: 0, maximum: 1 }), freshness: Type.Number({ minimum: 0, maximum: 1 })
    }, { additionalProperties: false })),
    queryRouting: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      tagPrefix: Type.Optional(Type.Boolean({ default: true })),
      queryExpansion: Type.Optional(Type.Boolean({ default: true })),
      intentRouting: Type.Optional(Type.Boolean({ default: true })),
      identifierHints: Type.Optional(Type.Boolean({ default: true }))
    }, { additionalProperties: false })),
    excludedAgentIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 40, description: "Host-exposed agent IDs excluded from automatic ContextEngine-derived work when the public lifecycle provides an identity." }))
  }, { additionalProperties: false })),
  scope: Type.Optional(Type.Object({ default: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) }, { additionalProperties: false })),
  memory: Type.Optional(Type.Object({
    captureOnAutoExtract: Type.Optional(Type.Boolean({ default: false })),
    maxDocumentChars: Type.Optional(Type.Integer({ default: 12000, minimum: 256, maximum: 100000 })),
    maxResults: Type.Optional(Type.Integer({ default: 3, minimum: 1, maximum: 10 })),
    retrieval: Type.Optional(Type.Object({
      candidateMultiplier: Type.Optional(Type.Integer({ default: 3, minimum: 1, maximum: 10 })),
      minScore: Type.Optional(Type.Number({ default: 0, minimum: 0, maximum: 1 })),
      mmrLambda: Type.Optional(Type.Number({ default: 1, minimum: 0, maximum: 1 })),
      reranker: Type.Optional(Type.Object({
        enabled: Type.Optional(Type.Boolean({ default: false })),
        endpoint: Type.Optional(Type.String({ maxLength: 2048 })),
        apiKey: Type.Optional(Type.String({ maxLength: 4096 })),
        model: Type.Optional(Type.String({ maxLength: 120 })),
        timeoutMs: Type.Optional(Type.Integer({ default: 5000, minimum: 1000, maximum: 30000 })),
        maxCandidates: Type.Optional(Type.Integer({ default: 12, minimum: 1, maximum: 20 })),
        maxQueryChars: Type.Optional(Type.Integer({ default: 512, minimum: 32, maximum: 4096 })),
        maxDocumentChars: Type.Optional(Type.Integer({ default: 4000, minimum: 128, maximum: 16000 }))
      }, { additionalProperties: false })),
      aging: Type.Optional(Type.Object({
        enabled: Type.Optional(Type.Boolean({ default: false })),
        shape: Type.Optional(Type.Number({ default: 1.5, minimum: .25, maximum: 5 })),
        scaleDays: Type.Optional(Type.Integer({ default: 180, minimum: 1, maximum: 3650 })),
        minimumFreshness: Type.Optional(Type.Number({ default: .1, minimum: 0, maximum: 1 }))
      }, { additionalProperties: false })),
    }, { additionalProperties: false })),
    lifecycle: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false, description: "Enable a non-destructive memory-document retrieval overlay; it never archives or deletes memory." })),
      accessReinforcement: Type.Optional(Type.Boolean({ default: true, description: "Count selected manual documents and promote only from working to core at the configured threshold." })),
      corePromotionAccesses: Type.Optional(Type.Integer({ default: 12, minimum: 2, maximum: 1000 })),
      temporalInference: Type.Optional(Type.Boolean({ default: false, description: "Infer bounded local expiry review hints. Expiry only affects ranking; it never archives a document." }))
    }, { additionalProperties: false }))
  }, { additionalProperties: false })),
  conversationJournal: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean({ default: false })),
    maxInlineChars: Type.Optional(Type.Integer({ default: 16000, minimum: 256, maximum: 16000 })),
    maxEventBytes: Type.Optional(Type.Integer({ default: 262144, minimum: 1024, maximum: 262144 })),
    retentionDays: Type.Optional(Type.Integer({ default: 0, minimum: 0, maximum: 3650 })),
    sensitiveContentPolicy: Type.Optional(Type.Union([Type.Literal("redact"), Type.Literal("hash_only"), Type.Literal("metadata_only"), Type.Literal("drop")])),
    ignoreSessionPatterns: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 32 })),
    statelessSessionPatterns: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 32 })),
    replayFloodThresholdExternal: Type.Optional(Type.Integer({ default: 24, minimum: 1, maximum: 512 })),
    replayFloodThresholdInternal: Type.Optional(Type.Integer({ default: 8, minimum: 1, maximum: 512 }))
  }, { additionalProperties: false })),
  contextEngine: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean({ default: false })),
    maxContextTokens: Type.Optional(Type.Integer({ default: 8000, minimum: 256, maximum: 64000 })),
    maxSummaryChars: Type.Optional(Type.Integer({ default: 8000, minimum: 256, maximum: 32000 })),
    protectedRecentEvents: Type.Optional(Type.Integer({ default: 6, minimum: 2, maximum: 50 })),
    compaction: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      minEvents: Type.Optional(Type.Integer({ default: 4, minimum: 2, maximum: 50 })),
      maxInputChars: Type.Optional(Type.Integer({ default: 12000, minimum: 1024, maximum: 100000 })),
      maxOutputChars: Type.Optional(Type.Integer({ default: 4000, minimum: 256, maximum: 16000 })),
      timeoutMs: Type.Optional(Type.Integer({ default: 15000, minimum: 1000, maximum: 120000 })),
      maxRunsPerHour: Type.Optional(Type.Integer({ default: 4, minimum: 1, maximum: 24 })),
      maxDailyTokens: Type.Optional(Type.Integer({ default: 32000, minimum: 1000, maximum: 1000000 })),
      circuitCooldownMs: Type.Optional(Type.Integer({ default: 3600000, minimum: 60000, maximum: 86400000 })),
      summaryMaxCallsPerWindow: Type.Optional(Type.Integer({ default: 24, minimum: 1, maximum: 100 })),
      summaryCallWindowMs: Type.Optional(Type.Integer({ default: 600000, minimum: 60000, maximum: 86400000 })),
      summarySpendBackoffMs: Type.Optional(Type.Integer({ default: 1800000, minimum: 60000, maximum: 86400000 })),
      contextThreshold: Type.Optional(Type.Number({ default: .75, minimum: .5, maximum: .95 })),
      freshTailCount: Type.Optional(Type.Integer({ default: 8, minimum: 2, maximum: 50 })),
      leafChunkTokens: Type.Optional(Type.Integer({ default: 3000, minimum: 256, maximum: 24000 })),
      maxChunksPerRun: Type.Optional(Type.Integer({ default: 4, minimum: 1, maximum: 12 })),
      condensedMinFanout: Type.Optional(Type.Integer({ default: 4, minimum: 2, maximum: 12 })),
      deadlineMs: Type.Optional(Type.Integer({ default: 45000, minimum: 1000, maximum: 300000 }))
    }, { additionalProperties: false }))
  }, { additionalProperties: false })),
  artifacts: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean({ default: false })),
    inlineThresholdChars: Type.Optional(Type.Integer({ default: 12000, minimum: 1024, maximum: 100000 })),
    maxArtifactBytes: Type.Optional(Type.Integer({ default: 262144, minimum: 1024, maximum: 2097152 })),
    toolPayloads: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false, description: "Archive qualifying public string tool results and replace only verified later copies with an opaque local artifact reference." })) }, { additionalProperties: false }))
  }, { additionalProperties: false })),
  corpus: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean({ default: false })),
    workspaceRoot: Type.Optional(Type.String({ maxLength: 4096, description: "Explicit local workspace root for the citation-only corpus cache; never persisted or returned." })),
    syncOnSearch: Type.Optional(Type.Boolean({ default: true })),
    syncIntervalMs: Type.Optional(Type.Integer({ default: 60000, minimum: 60000, maximum: 86400000 })),
    maxFileBytes: Type.Optional(Type.Integer({ default: 1048576, minimum: 1024, maximum: 1048576 })),
    maxFiles: Type.Optional(Type.Integer({ default: 500, minimum: 1, maximum: 1000 })),
    maxSessionFilesPerAgent: Type.Optional(Type.Integer({ default: 25, minimum: 1, maximum: 25 })),
    maxChunkChars: Type.Optional(Type.Integer({ default: 4000, minimum: 256, maximum: 8000 })),
    maxChunkLines: Type.Optional(Type.Integer({ default: 80, minimum: 1, maximum: 200 })),
    includeSessions: Type.Optional(Type.Boolean({ default: false, description: "Opt in to configured workspace sessions/**/*.jsonl only." })),
    includeDreamingArtifacts: Type.Optional(Type.Boolean({ default: false, description: "Opt in to configured workspace dreaming artifacts only." }))
  }, { additionalProperties: false })),
  workspaceBoundary: Type.Optional(Type.Object({ userMdExclusive: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false, description: "Keep USER.md externally managed: never ingest it as a graph source or corpus document." })) }, { additionalProperties: false })) }, { additionalProperties: false })),
  episodicMemory: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean({ default: false })), autoExtract: Type.Optional(Type.Boolean({ default: false })),
    maxEpisodesPerTurn: Type.Optional(Type.Integer({ default: 3, minimum: 1, maximum: 3 })), minImportance: Type.Optional(Type.Number({ default: .5, minimum: 0, maximum: 1 })),
    extractionMode: Type.Optional(Type.Union([Type.Literal("basic"), Type.Literal("signal")])),
    smartExtraction: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false, description: "Use only the public ContextEngine runtime completion to create bounded, source-linked episode projections. It never writes graph facts or beliefs." })),
      maxInputChars: Type.Optional(Type.Integer({ default: 12000, minimum: 1000, maximum: 32000 })),
      maxOutputChars: Type.Optional(Type.Integer({ default: 6000, minimum: 512, maximum: 16000 })),
      maxEpisodesPerTurn: Type.Optional(Type.Integer({ default: 3, minimum: 1, maximum: 3 })),
      timeoutMs: Type.Optional(Type.Integer({ default: 15000, minimum: 1000, maximum: 120000 })),
      minImportance: Type.Optional(Type.Number({ default: .5, minimum: 0, maximum: 1 }))
    }, { additionalProperties: false }))
  }, { additionalProperties: false })),
  unifiedRetrieval: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false })), shadowMode: Type.Optional(Type.Boolean({ default: false })), tokenBudget: Type.Optional(Type.Integer({ default: 800, minimum: 64, maximum: 8000 })), maxItems: Type.Optional(Type.Integer({ default: 8, minimum: 1, maximum: 20 })), diversityLambda: Type.Optional(Type.Number({ default: .75, minimum: 0, maximum: 1 })), minConfidence: Type.Optional(Type.Number({ default: .6, minimum: 0, maximum: 1 })), maxStalenessDays: Type.Optional(Type.Integer({ default: 36500, minimum: 1, maximum: 36500 })) }, { additionalProperties: false })),
  embeddings: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false })), provider: Type.Optional(Type.Literal("ollama", { default: "ollama" })), baseURL: Type.Optional(Type.String({ default: "http://127.0.0.1:11434" })), model: Type.Optional(Type.String({ default: "qwen3-embedding:4b" })), timeoutMs: Type.Optional(Type.Number({ default: 10000, minimum: 1000, maximum: 120000 })), batchSize: Type.Optional(Type.Number({ default: 16, minimum: 1, maximum: 128 })), maxInputChars: Type.Optional(Type.Number({ default: 16000, minimum: 256, maximum: 100000 })), queryCacheSize: Type.Optional(Type.Number({ default: 256, minimum: 0, maximum: 4096 })), maxVectorScanNodes: Type.Optional(Type.Number({ default: 10000, minimum: 100, maximum: 100000 })) }, { additionalProperties: false })),
  insights: Type.Optional(Type.Object({
    maxNodes: Type.Optional(Type.Number({ default: 10000, minimum: 1, maximum: 10000 })),
    maxEdges: Type.Optional(Type.Number({ default: 50000, minimum: 1, maximum: 50000 })),
    confidenceFloor: Type.Optional(Type.Number({ default: .6, minimum: 0, maximum: 1 })),
    recentWindowDays: Type.Optional(Type.Number({ default: 7, minimum: 1, maximum: 3650 })),
    baselineWindowDays: Type.Optional(Type.Number({ default: 28, minimum: 1, maximum: 3650 })),
    minEmergingEntities: Type.Optional(Type.Number({ default: 3, minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    minEmergingGrowth: Type.Optional(Type.Number({ default: 2, minimum: Number.MIN_VALUE, maximum: Number.MAX_SAFE_INTEGER })),
    maxPathLength: Type.Optional(Type.Number({ default: 4, minimum: 2, maximum: 4 })),
    maxResults: Type.Optional(Type.Number({ default: 20, minimum: 1, maximum: 20 })),
    explanationTimeoutMs: Type.Optional(Type.Number({ default: 10000, minimum: 1000, maximum: 60000 })),
    maxExplanationCandidates: Type.Optional(Type.Number({ default: 5, minimum: 0, maximum: 5 }))
  }, { additionalProperties: false })),
  quality: Type.Optional(Type.Object({
    edgeMinConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    relatedToMinConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    edgeTypeMinConfidence: Type.Optional(Type.Object({}, { additionalProperties: Type.Number({ minimum: 0, maximum: 1 }) })),
    singleValuedEdgeTypes: Type.Optional(Type.Array(Type.Union([
      Type.Literal("works_at"), Type.Literal("invested_in"), Type.Literal("supplies"), Type.Literal("supplies_product"), Type.Literal("supplied_to"), Type.Literal("competes_with"),
      Type.Literal("uses"), Type.Literal("develops"), Type.Literal("owns"), Type.Literal("partners_with"), Type.Literal("in_portfolio"), Type.Literal("related_to")
    ]), { default: [] })),
    recencyHalfLifeDays: Type.Optional(Type.Number({ default: 90, minimum: 1, maximum: 3650 })),
    conflictPenaltyFactor: Type.Optional(Type.Number({ default: .75, minimum: 0, maximum: 1 })),
    hubPenaltyFloor: Type.Optional(Type.Number({ default: .6, minimum: 0, maximum: 1 })),
    rankingWeights: Type.Optional(Type.Object({
      semantic: Type.Number({ minimum: 0 }), lexical: Type.Number({ minimum: 0 }), confidence: Type.Number({ minimum: 0 }),
      recency: Type.Number({ minimum: 0 }), sourceDiversity: Type.Number({ minimum: 0 }), ppr: Type.Number({ minimum: 0 })
    }, { additionalProperties: false })),
    pprDamping: Type.Optional(Type.Number({ default: .85, minimum: 0, maximum: 1 })),
    pprMaxIterations: Type.Optional(Type.Number({ default: 20, minimum: 1, maximum: 100 })),
    pprTolerance: Type.Optional(Type.Number({ default: 1e-6, minimum: 1e-12, maximum: .1 })),
    pprMaxNodes: Type.Optional(Type.Number({ default: 10000, minimum: 1, maximum: 10000 })),
    pprMaxArcs: Type.Optional(Type.Number({ default: 50000, minimum: 1, maximum: 50000 })),
    hygiene: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      intervalHours: Type.Optional(Type.Integer({ default: 168, minimum: 1, maximum: 720 })),
      maxDuplicateScanNodes: Type.Optional(Type.Integer({ default: 100, minimum: 1, maximum: 500 })),
      relatedToWarningRatio: Type.Optional(Type.Number({ default: .4, minimum: 0, maximum: 1 })),
      relatedToWarningMinimumEdges: Type.Optional(Type.Integer({ default: 20, minimum: 1, maximum: 10000 }))
    }, { additionalProperties: false }))
  }, { additionalProperties: false })),
  ingestion: Type.Optional(Type.Object({
    maxPayloadBytes: Type.Optional(Type.Number({ default: 2097152, minimum: 1, maximum: 10485760 })),
    maxBatchItems: Type.Optional(Type.Number({ default: 50, minimum: 1, maximum: 50 })),
    allowedFileExtensions: Type.Optional(Type.Array(Type.Union([Type.Literal(".txt"), Type.Literal(".md")]), { default: [".txt", ".md"] })),
    urlMaxPayloadBytes: Type.Optional(Type.Number({ default: 2097152, minimum: 1, maximum: 10485760 })),
    urlTimeoutMs: Type.Optional(Type.Number({ default: 15000, minimum: 1000, maximum: 15000 })),
    urlMaxRedirects: Type.Optional(Type.Number({ default: 5, minimum: 0, maximum: 5 }))
  }, { additionalProperties: false })),
  query: Type.Optional(Type.Object({
    maxSteps: Type.Optional(Type.Integer({ default: 8, minimum: 1, maximum: 8 })),
    maxDepth: Type.Optional(Type.Integer({ default: 4, minimum: 0, maximum: 4 })),
    maxResults: Type.Optional(Type.Integer({ default: 50, minimum: 1, maximum: 50 })),
    maxNodes: Type.Optional(Type.Integer({ default: 10000, minimum: 1, maximum: 10000 })),
    maxEdges: Type.Optional(Type.Integer({ default: 50000, minimum: 1, maximum: 50000 })),
    timeoutMs: Type.Optional(Type.Integer({ default: 10000, minimum: 1, maximum: 10000 })),
    maxResponseBytes: Type.Optional(Type.Integer({ default: 1048576, minimum: 1, maximum: 1048576 })),
    auditRetentionDays: Type.Optional(Type.Integer({ default: 30, minimum: 1, maximum: 3650 })),
    maxWatches: Type.Optional(Type.Integer({ default: 100, minimum: 1, maximum: 100 })),
    maxDigestWatches: Type.Optional(Type.Integer({ default: 25, minimum: 1, maximum: 25 })),
    maxImportBytes: Type.Optional(Type.Integer({ default: 10485760, minimum: 1, maximum: 10485760 })),
    maxImportRecords: Type.Optional(Type.Integer({ default: 1000, minimum: 1, maximum: 1000 }))
  }, { additionalProperties: false })),
  trustLayer: Type.Optional(Type.Object({
    enabled: Type.Optional(Type.Boolean({ default: false })),
    snapshotMaxBytes: Type.Optional(Type.Integer({ default: 8192, minimum: 256, maximum: 32768 })),
    verification: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      defaultPendingPolicy: Type.Optional(Type.Literal("exclude", { default: "exclude" })),
      automatic: Type.Optional(Type.Object({
        enabled: Type.Optional(Type.Boolean({ default: false })),
        maxConcurrent: Type.Optional(Type.Integer({ default: 1, minimum: 1, maximum: 4 })),
        maxJobsPerRun: Type.Optional(Type.Integer({ default: 5, minimum: 1, maximum: 20 })),
        timeoutMs: Type.Optional(Type.Integer({ default: 15000, minimum: 1000, maximum: 60000 })),
        leaseMs: Type.Optional(Type.Integer({ default: 45000, minimum: 5000, maximum: 300000 })),
        maxInputChars: Type.Optional(Type.Integer({ default: 8000, minimum: 256, maximum: 16000 })),
        maxOutputBytes: Type.Optional(Type.Integer({ default: 16384, minimum: 1024, maximum: 65536 })),
        workerIsolation: Type.Optional(Type.Boolean({ default: true }))
      }, { additionalProperties: false })),
      retrospectiveAudit: Type.Optional(Type.Object({
        enabled: Type.Optional(Type.Boolean({ default: false })),
        maxJobsPerRun: Type.Optional(Type.Integer({ default: 5, minimum: 1, maximum: 20 })),
        minimumAgeDays: Type.Optional(Type.Integer({ default: 30, minimum: 1, maximum: 3650 })),
        minimumRecallCount: Type.Optional(Type.Integer({ default: 3, minimum: 1, maximum: 10000 }))
      }, { additionalProperties: false }))
    }, { additionalProperties: false })),
    recall: Type.Optional(Type.Object({
      shadowMode: Type.Optional(Type.Boolean({ default: true })),
      absoluteFloor: Type.Optional(Type.Number({ default: 0, minimum: 0, maximum: 1 })),
      relativeCutoffRatio: Type.Optional(Type.Number({ default: .6, minimum: 0, maximum: 1 })),
      confidenceGate: Type.Optional(Type.Number({ default: .6, minimum: 0, maximum: 1 })),
      minKeep: Type.Optional(Type.Integer({ default: 1, minimum: 0, maximum: 10 })),
      candidateMultiplier: Type.Optional(Type.Integer({ default: 5, minimum: 1, maximum: 10 })),
      canary: Type.Optional(Type.Object({
        enabled: Type.Optional(Type.Boolean({ default: false })),
        modelId: Type.Optional(Type.String({ default: "default", minLength: 1, maxLength: 120 })),
        scopes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { default: [], maxItems: 20 }))
      }, { additionalProperties: false }))
    }, { additionalProperties: false })),
    governance: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      approvalTtlMs: Type.Optional(Type.Integer({ default: 900000, minimum: 60000, maximum: 86400000 })),
      requireApprovalFor: Type.Optional(Type.Array(Type.Union([Type.Literal("verification.transition"), Type.Literal("conflict.resolve"), Type.Literal("profile.selection")]), { maxItems: 3 }))
    }, { additionalProperties: false }))
  }, { additionalProperties: false })),
  integrations: Type.Optional(Type.Object({
    lossless: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      timeoutMs: Type.Optional(Type.Integer({ default: 5000, minimum: 1000, maximum: 30000 })),
      maxOutputBytes: Type.Optional(Type.Integer({ default: 65536, minimum: 1024, maximum: 262144 }))
    }, { additionalProperties: false })),
    memoryLanceDbPro: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      timeoutMs: Type.Optional(Type.Integer({ default: 5000, minimum: 1000, maximum: 30000 })),
      maxOutputBytes: Type.Optional(Type.Integer({ default: 65536, minimum: 1024, maximum: 262144 }))
    }, { additionalProperties: false }))
  }, { additionalProperties: false })),
  standalone: Type.Optional(Type.Object({ activePluginIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 20 })) }, { additionalProperties: false })),
  consolidation: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false })), maxJobsPerRun: Type.Optional(Type.Integer({ default: 4, minimum: 1, maximum: 20 })), leaseMs: Type.Optional(Type.Integer({ default: 45000, minimum: 5000, maximum: 300000 })), proposalTtlDays: Type.Optional(Type.Integer({ default: 14, minimum: 1, maximum: 90 })), staleAfterDays: Type.Optional(Type.Integer({ default: 90, minimum: 1, maximum: 3650 })) }, { additionalProperties: false })),
  cognition: Type.Optional(Type.Object({ formationShadow: Type.Optional(Type.Boolean({ default: true })), admission: Type.Optional(Type.Object({ mode: Type.Optional(Type.Union([Type.Literal("shadow"), Type.Literal("enforce")], { default: "shadow" })), preAdmission: Type.Optional(Type.Object({ mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("shadow"), Type.Literal("enforce")], { default: "off", description: "Deterministic source/shape gate. Shadow audits only; enforce can skip low-information or repeated automatic evidence before graph persistence." })) }, { additionalProperties: false })) }, { additionalProperties: false })), beliefs: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false })), autoCorroborate: Type.Optional(Type.Boolean({ default: false })) }, { additionalProperties: false })), contextCompiler: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false })), tokenBudget: Type.Optional(Type.Integer({ default: 600, minimum: 64, maximum: 1600 })), maxItems: Type.Optional(Type.Integer({ default: 8, minimum: 1, maximum: 20 })) }, { additionalProperties: false })), reflection: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false })), maxJobsPerRun: Type.Optional(Type.Integer({ default: 4, minimum: 1, maximum: 20 })), staleAfterDays: Type.Optional(Type.Integer({ default: 90, minimum: 1, maximum: 3650 })) }, { additionalProperties: false })), graduation: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false })) }, { additionalProperties: false })), reasoningCuration: Type.Optional(Type.Object({ intake: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false })), maxCandidatesPerTurn: Type.Optional(Type.Integer({ default: 2, minimum: 1, maximum: 2 })), timeoutMs: Type.Optional(Type.Integer({ default: 15000, minimum: 1000, maximum: 120000 })), maxInputChars: Type.Optional(Type.Integer({ default: 8000, minimum: 1000, maximum: 32000 })), maxOutputChars: Type.Optional(Type.Integer({ default: 2000, minimum: 512, maximum: 16000 })) }, { additionalProperties: false })), formation: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false })), maxJobsPerTurn: Type.Optional(Type.Integer({ default: 1, minimum: 1, maximum: 3 })), minOutcomeConfidence: Type.Optional(Type.Number({ default: .75, minimum: 0, maximum: 1 })), timeoutMs: Type.Optional(Type.Integer({ default: 15000, minimum: 1000, maximum: 120000 })), maxInputChars: Type.Optional(Type.Integer({ default: 8000, minimum: 1000, maximum: 32000 })), maxOutputChars: Type.Optional(Type.Integer({ default: 2000, minimum: 512, maximum: 16000 })) }, { additionalProperties: false })), review: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false })), intervalHours: Type.Optional(Type.Integer({ default: 168, minimum: 1, maximum: 720 })), maxItems: Type.Optional(Type.Integer({ default: 12, minimum: 1, maximum: 20 })), timeoutMs: Type.Optional(Type.Integer({ default: 15000, minimum: 1000, maximum: 120000 })), maxInputChars: Type.Optional(Type.Integer({ default: 12000, minimum: 1000, maximum: 32000 })), maxOutputChars: Type.Optional(Type.Integer({ default: 4000, minimum: 512, maximum: 16000 })) }, { additionalProperties: false })) }, { additionalProperties: false })), reasoningRuntime: Type.Optional(Type.Object({ shadowMode: Type.Optional(Type.Boolean({ default: false })), scopes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 20 })), tokenBudget: Type.Optional(Type.Integer({ default: 800, minimum: 64, maximum: 1600 })), maxItems: Type.Optional(Type.Integer({ default: 6, minimum: 1, maximum: 12 })), minConfidence: Type.Optional(Type.Number({ default: .6, minimum: 0, maximum: 1 })), highRiskMinConfidence: Type.Optional(Type.Number({ default: .8, minimum: 0, maximum: 1 })), minEvidenceQuality: Type.Optional(Type.Number({ default: .5, minimum: 0, maximum: 1 })), highRiskMinEvidenceQuality: Type.Optional(Type.Number({ default: .75, minimum: 0, maximum: 1 })), maxStalenessDays: Type.Optional(Type.Integer({ default: 365, minimum: 1, maximum: 3650 })), excludeConflicted: Type.Optional(Type.Boolean({ default: true })), retentionDays: Type.Optional(Type.Integer({ default: 30, minimum: 1, maximum: 365 })), readiness: Type.Optional(Type.Object({ minimumRuns: Type.Optional(Type.Integer({ default: 25, minimum: 1, maximum: 5000 })), maxErrorRate: Type.Optional(Type.Number({ default: .05, minimum: 0, maximum: 1 })), maxEmptyRate: Type.Optional(Type.Number({ default: .8, minimum: 0, maximum: 1 })), maxP95Ms: Type.Optional(Type.Integer({ default: 100, minimum: 1, maximum: 30000 })) }, { additionalProperties: false })), delivery: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false })), scopes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 20 })), adapter: Type.Optional(Type.Literal("openclaw", { default: "openclaw" })), calibrationMaxAgeHours: Type.Optional(Type.Integer({ default: 168, minimum: 1, maximum: 720 })), maxConsecutiveDeliveries: Type.Optional(Type.Integer({ default: 2, minimum: 1, maximum: 10 })), itemRetentionDays: Type.Optional(Type.Integer({ default: 30, minimum: 1, maximum: 365 })) }, { additionalProperties: false })), semantic: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false })), timeoutMs: Type.Optional(Type.Integer({ default: 1500, minimum: 100, maximum: 15000 })), minScore: Type.Optional(Type.Number({ default: .35, minimum: 0, maximum: 1 })), maxCandidates: Type.Optional(Type.Integer({ default: 50, minimum: 1, maximum: 50 })) }, { additionalProperties: false })), verification: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean({ default: false, description: "Process only bounded deterministic ReasoningMemory verification events after completed ContextEngine turns. It never calls a model or enables delivery." })), maxJobsPerRun: Type.Optional(Type.Integer({ default: 5, minimum: 1, maximum: 20 })) }, { additionalProperties: false })) }, { additionalProperties: false })) }, { additionalProperties: false })),
  inspector: Type.Optional(Type.Object({
    maxGraphNodes: Type.Optional(Type.Integer({ default: 5000, minimum: 1, maximum: 5000 })),
    maxGraphEdges: Type.Optional(Type.Integer({ default: 20000, minimum: 1, maximum: 20000 })),
    maxGraphResponseBytes: Type.Optional(Type.Integer({ default: 4194304, minimum: 128, maximum: 4194304 })),
    graphDeadlineMs: Type.Optional(Type.Integer({ default: 5000, minimum: 1, maximum: 5000 }))
  }, { additionalProperties: false }))
}, { additionalProperties: false });

const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "mnemora",
  name: "Mnemora",
  description: "Evidence-first personal memory harness for persistent OpenClaw agents.",
  configSchema: buildJsonPluginConfigSchema({ ...configSchema }),
  register(api) {
    const runtime = new PluginRuntime(api.pluginConfig, api.logger);
    if (runtime.contextEngine) api.registerContextEngine("mnemora", context => runtime.activateContextEngine(context));
    for (const tool of createOpenClawToolDefinitions(() => runtime.openGraph(), runtime.config.toolSurface)) api.registerTool(tool as never);
    api.registerCommand({
      name: "mnemora",
      description: "Read-only Mnemora operator status and canonical corpus commands.",
      acceptsArgs: true,
      handler: async context => {
        const outcome = await runMnemoraOperatorCommand(runtime, context.args ?? "");
        return { text: outcome.message };
      }
    });
    // Mnemora deliberately owns no before_prompt_build or agent_end hook. The
    // public ContextEngine lifecycle is the single prompt/capture producer;
    // without an explicitly selected ContextEngine, Mnemora remains manual-only.
    api.on("gateway_stop", () => runtime.stop());
  }
});

export default plugin;
