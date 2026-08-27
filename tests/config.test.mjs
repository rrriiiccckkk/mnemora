import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../dist/config.js";

test("automatic features are opt-in with bounded defaults", () => {
  const config = normalizeConfig({});
  assert.equal(config.extraction.autoExtract, false);
  assert.equal(config.extraction.timeoutMs, 15000);
  assert.equal(config.extraction.maxInputChars, 16000);
  assert.deepEqual(config.artifacts, { enabled: false, inlineThresholdChars: 12000, maxArtifactBytes: 262144, toolPayloads: { enabled: false } });
  assert.deepEqual(config.extraction.autoInputQuality, { mode: "off", maxSegments: 16 });
  assert.equal(config.recall.autoRecall, false);
  assert.deepEqual(config.recall.queryRouting, { enabled: false, tagPrefix: true, queryExpansion: true, intentRouting: true, identifierHints: true });
  assert.deepEqual(config.recall.excludedAgentIds, []);
  assert.deepEqual(config.contextEngine.compaction, { enabled: false, minEvents: 4, maxInputChars: 12000, maxOutputChars: 4000, timeoutMs: 15000, maxRunsPerHour: 4, maxDailyTokens: 32000, circuitCooldownMs: 3600000, summaryMaxCallsPerWindow: 24, summaryCallWindowMs: 600000, summarySpendBackoffMs: 1800000, contextThreshold: .75, freshTailCount: 8, leafChunkTokens: 3000, maxChunksPerRun: 4, condensedMinFanout: 4, deadlineMs: 45000 });
  assert.deepEqual(config.conversationJournal, { enabled: false, maxInlineChars: 16000, maxEventBytes: 262144, retentionDays: 0, sensitiveContentPolicy: "redact", ignoreSessionPatterns: [], statelessSessionPatterns: [], replayFloodThresholdExternal: 24, replayFloodThresholdInternal: 8 });
  assert.deepEqual(config.corpus, { enabled: false, workspaceRoot: "", syncOnSearch: true, syncIntervalMs: 60000, maxFileBytes: 1048576, maxFiles: 500, maxSessionFilesPerAgent: 25, maxChunkChars: 4000, maxChunkLines: 80, includeSessions: false, includeDreamingArtifacts: false });
  assert.deepEqual(config.workspaceBoundary, { userMdExclusive: { enabled: false } });
  const { reasoningCuration, ...cognition } = config.cognition;
  assert.deepEqual(cognition, { formationShadow: true, admission: { mode: "shadow", preAdmission: { mode: "off" } }, beliefs: { enabled: false, autoCorroborate: false }, contextCompiler: { enabled: false, tokenBudget: 600, maxItems: 8 }, reflection: { enabled: false, maxJobsPerRun: 4, staleAfterDays: 90 }, graduation: { enabled: false }, reasoningRuntime: { shadowMode: false, scopes: [], tokenBudget: 800, maxItems: 6, minConfidence: .6, highRiskMinConfidence: .8, minEvidenceQuality: .5, highRiskMinEvidenceQuality: .75, maxStalenessDays: 365, excludeConflicted: true, retentionDays: 30, readiness: { minimumRuns: 25, maxErrorRate: .05, maxEmptyRate: .8, maxP95Ms: 100 }, delivery: { enabled: false, scopes: [], adapter: "openclaw", calibrationMaxAgeHours: 168, maxConsecutiveDeliveries: 2, itemRetentionDays: 30 }, semantic: { enabled: false, timeoutMs: 1500, minScore: .35, maxCandidates: 50 }, verification: { enabled: false, maxJobsPerRun: 5 } } });
  assert.deepEqual(reasoningCuration, { formation: { enabled: false, maxJobsPerTurn: 1, minOutcomeConfidence: .75, timeoutMs: 15000, maxInputChars: 8000, maxOutputChars: 2000 }, review: { enabled: false, intervalHours: 168, maxItems: 12, timeoutMs: 15000, maxInputChars: 12000, maxOutputChars: 4000 } });
  assert.deepEqual(config.quality, {
    edgeMinConfidence: 0,
    relatedToMinConfidence: 0.8,
    edgeTypeMinConfidence: {},
    singleValuedEdgeTypes: [],
    recencyHalfLifeDays: 90,
    conflictPenaltyFactor: .75,
    hubPenaltyFloor: .6,
    rankingWeights: { semantic: .35, lexical: .20, confidence: .15, recency: .10, sourceDiversity: .05, ppr: .15 },
    pprDamping: .85, pprMaxIterations: 20, pprTolerance: 1e-6, pprMaxNodes: 10000, pprMaxArcs: 50000
  });
});

test("canonical corpus stays opt-in and clamps local-only limits", () => {
  const value = normalizeConfig({ corpus: { enabled: true, workspaceRoot: "  C:/workspace  ", syncOnSearch: false, syncIntervalMs: 1, maxFileBytes: 99999999, maxFiles: 99999, maxSessionFilesPerAgent: 999, maxChunkChars: 1, maxChunkLines: 999, includeSessions: true, includeDreamingArtifacts: true }, workspaceBoundary: { userMdExclusive: { enabled: true } } });
  assert.deepEqual(value.corpus, { enabled: true, workspaceRoot: "C:/workspace", syncOnSearch: false, syncIntervalMs: 60000, maxFileBytes: 1048576, maxFiles: 1000, maxSessionFilesPerAgent: 25, maxChunkChars: 256, maxChunkLines: 200, includeSessions: true, includeDreamingArtifacts: true });
  assert.equal(value.workspaceBoundary.userMdExclusive.enabled, true);
  assert.equal(normalizeConfig({ corpus: { enabled: true, workspaceRoot: "\u0000unsafe" } }).corpus.workspaceRoot, "");
});

test("local compaction cooldown is opt-in-safe and bounded", () => {
  const value = normalizeConfig({ contextEngine: { compaction: { enabled: true, circuitCooldownMs: 1 } } }).contextEngine.compaction;
  assert.equal(value.enabled, true);
  assert.equal(value.circuitCooldownMs, 60000);
  assert.equal(normalizeConfig({ contextEngine: { compaction: { circuitCooldownMs: 999999999 } } }).contextEngine.compaction.circuitCooldownMs, 86400000);
});

test("compaction spend and replay-flood controls are independently bounded", () => {
  const compaction = normalizeConfig({ contextEngine: { compaction: { summaryMaxCallsPerWindow: 0, summaryCallWindowMs: 1, summarySpendBackoffMs: 999999999 } } }).contextEngine.compaction;
  assert.deepEqual({ max: compaction.summaryMaxCallsPerWindow, window: compaction.summaryCallWindowMs, backoff: compaction.summarySpendBackoffMs }, { max: 1, window: 60000, backoff: 86400000 });
  const journal = normalizeConfig({ conversationJournal: { replayFloodThresholdExternal: 0, replayFloodThresholdInternal: 9999 } }).conversationJournal;
  assert.deepEqual({ external: journal.replayFloodThresholdExternal, internal: journal.replayFloodThresholdInternal }, { external: 1, internal: 512 });
});

test("incremental compaction controls are opt-in-safe and bounded", () => {
  const value = normalizeConfig({ contextEngine: { compaction: { contextThreshold: 0, freshTailCount: 1, leafChunkTokens: 1, maxChunksPerRun: 99, condensedMinFanout: 1, deadlineMs: 9999999 } } }).contextEngine.compaction;
  assert.deepEqual({ threshold: value.contextThreshold, tail: value.freshTailCount, leaf: value.leafChunkTokens, chunks: value.maxChunksPerRun, fanout: value.condensedMinFanout, deadline: value.deadlineMs }, { threshold: .5, tail: 2, leaf: 256, chunks: 12, fanout: 2, deadline: 300000 });
});

test("session write patterns are additive, bounded, and preserve ordinary sessions by default", () => {
  const patterns = normalizeConfig({ conversationJournal: { ignoreSessionPatterns: [" agent:*:cron:** ", "agent:*:cron:**", "x".repeat(161)], statelessSessionPatterns: ["agent:*:readonly:**", 42] } }).conversationJournal;
  assert.deepEqual(patterns.ignoreSessionPatterns, ["agent:*:cron:**"]);
  assert.deepEqual(patterns.statelessSessionPatterns, ["agent:*:readonly:**"]);
});

test("configured session patterns are retained when the environment already has the cap", () => {
  const prior = process.env.MNEMORA_IGNORE_SESSION_PATTERNS;
  process.env.MNEMORA_IGNORE_SESSION_PATTERNS = Array.from({ length: 32 }, (_item, index) => `agent:env:${index}:**`).join(",");
  try {
    const patterns = normalizeConfig({ conversationJournal: { ignoreSessionPatterns: ["agent:configured:cron:**"] } }).conversationJournal.ignoreSessionPatterns;
    assert.equal(patterns.length, 32);
    assert.equal(patterns[0], "agent:configured:cron:**");
    assert.equal(patterns.includes("agent:env:31:**"), false);
  } finally {
    if (prior == null) delete process.env.MNEMORA_IGNORE_SESSION_PATTERNS;
    else process.env.MNEMORA_IGNORE_SESSION_PATTERNS = prior;
  }
});

test("query routing remains opt-in and agent exclusions use bounded host identifiers", () => {
  const config = normalizeConfig({ recall: { queryRouting: { enabled: true, tagPrefix: false }, excludedAgentIds: [" Background:Worker ", "background:worker", "bad id", "x".repeat(81)] } });
  assert.deepEqual(config.recall.queryRouting, { enabled: true, tagPrefix: false, queryExpansion: true, intentRouting: true, identifierHints: true });
  assert.deepEqual(config.recall.excludedAgentIds, ["background:worker"]);
});

test("cognition admission remains opt-in and accepts only closed modes", () => {
  const runtimeDefaults = { shadowMode: false, scopes: [], tokenBudget: 800, maxItems: 6, minConfidence: .6, highRiskMinConfidence: .8, minEvidenceQuality: .5, highRiskMinEvidenceQuality: .75, maxStalenessDays: 365, excludeConflicted: true, retentionDays: 30, readiness: { minimumRuns: 25, maxErrorRate: .05, maxEmptyRate: .8, maxP95Ms: 100 }, delivery: { enabled: false, scopes: [], adapter: "openclaw", calibrationMaxAgeHours: 168, maxConsecutiveDeliveries: 2, itemRetentionDays: 30 }, semantic: { enabled: false, timeoutMs: 1500, minScore: .35, maxCandidates: 50 }, verification: { enabled: false, maxJobsPerRun: 5 } };
  const curationDefaults = { formation: { enabled: false, maxJobsPerTurn: 1, minOutcomeConfidence: .75, timeoutMs: 15000, maxInputChars: 8000, maxOutputChars: 2000 }, review: { enabled: false, intervalHours: 168, maxItems: 12, timeoutMs: 15000, maxInputChars: 12000, maxOutputChars: 4000 } };
  assert.deepEqual(normalizeConfig({ cognition: { formationShadow: true, admission: { mode: "enforce", preAdmission: { mode: "off" } }, beliefs: { enabled: true, autoCorroborate: true }, contextCompiler: { enabled: true, tokenBudget: 64, maxItems: 1 }, reflection: { enabled: true, maxJobsPerRun: 1, staleAfterDays: 1 }, graduation: { enabled: true } } }).cognition, { formationShadow: true, admission: { mode: "enforce", preAdmission: { mode: "off" } }, beliefs: { enabled: true, autoCorroborate: true }, contextCompiler: { enabled: true, tokenBudget: 64, maxItems: 1 }, reflection: { enabled: true, maxJobsPerRun: 1, staleAfterDays: 1 }, graduation: { enabled: true }, reasoningCuration: curationDefaults, reasoningRuntime: runtimeDefaults });
  assert.deepEqual(normalizeConfig({ cognition: { formationShadow: true, admission: { mode: "unsafe" } } }).cognition, { formationShadow: true, admission: { mode: "shadow", preAdmission: { mode: "off" } }, beliefs: { enabled: false, autoCorroborate: false }, contextCompiler: { enabled: false, tokenBudget: 600, maxItems: 8 }, reflection: { enabled: false, maxJobsPerRun: 4, staleAfterDays: 90 }, graduation: { enabled: false }, reasoningCuration: curationDefaults, reasoningRuntime: runtimeDefaults });
});

test("reasoning curation is off by default and bounds every host-runtime model call", () => {
  const value = normalizeConfig({ cognition: { reasoningCuration: { formation: { enabled: true, maxJobsPerTurn: 99, minOutcomeConfidence: -1, timeoutMs: 1, maxInputChars: 1, maxOutputChars: 999999 }, review: { enabled: true, intervalHours: 0, maxItems: 99, timeoutMs: 999999, maxInputChars: 999999, maxOutputChars: 1 } } } }).cognition.reasoningCuration;
  assert.deepEqual(value, { formation: { enabled: true, maxJobsPerTurn: 3, minOutcomeConfidence: 0, timeoutMs: 1000, maxInputChars: 1000, maxOutputChars: 16000 }, review: { enabled: true, intervalHours: 1, maxItems: 20, timeoutMs: 120000, maxInputChars: 32000, maxOutputChars: 512 } });
});

test("pre-admission stays off by default and accepts only its closed modes", () => {
  assert.equal(normalizeConfig({ cognition: { admission: { preAdmission: { mode: "shadow" } } } }).cognition.admission.preAdmission.mode, "shadow");
  assert.equal(normalizeConfig({ cognition: { admission: { preAdmission: { mode: "enforce" } } } }).cognition.admission.preAdmission.mode, "enforce");
  assert.equal(normalizeConfig({ cognition: { admission: { preAdmission: { mode: "unsafe" } } } }).cognition.admission.preAdmission.mode, "off");
});

test("automatic input quality remains off by default and bounds its deterministic selector", () => {
  assert.deepEqual(normalizeConfig({ extraction: { autoInputQuality: { mode: "shadow", maxSegments: 0 } } }).extraction.autoInputQuality, { mode: "shadow", maxSegments: 1 });
  assert.deepEqual(normalizeConfig({ extraction: { autoInputQuality: { mode: "enforce", maxSegments: 999 } } }).extraction.autoInputQuality, { mode: "enforce", maxSegments: 32 });
  assert.deepEqual(normalizeConfig({ extraction: { autoInputQuality: { mode: "unsafe", maxSegments: 16 } } }).extraction.autoInputQuality, { mode: "off", maxSegments: 16 });
});

test("reasoning runtime shadow remains off and clamps scope, quality, retention, and readiness policy", () => {
  const value = normalizeConfig({ cognition: { reasoningRuntime: { shadowMode: true, scopes: ["project:A", "bad scope", "project:a"], tokenBudget: 1, maxItems: 99, minConfidence: -1, highRiskMinConfidence: 2, minEvidenceQuality: -1, highRiskMinEvidenceQuality: 2, maxStalenessDays: 0, retentionDays: 999, readiness: { minimumRuns: 0, maxErrorRate: 2, maxEmptyRate: -1, maxP95Ms: 0 }, verification: { enabled: true, maxJobsPerRun: 99 } } } }).cognition.reasoningRuntime;
  assert.deepEqual(value, { shadowMode: true, scopes: ["project:a"], tokenBudget: 64, maxItems: 12, minConfidence: 0, highRiskMinConfidence: 1, minEvidenceQuality: 0, highRiskMinEvidenceQuality: 1, maxStalenessDays: 1, excludeConflicted: true, retentionDays: 365, readiness: { minimumRuns: 1, maxErrorRate: 1, maxEmptyRate: 0, maxP95Ms: 1 }, delivery: { enabled: false, scopes: [], adapter: "openclaw", calibrationMaxAgeHours: 168, maxConsecutiveDeliveries: 2, itemRetentionDays: 30 }, semantic: { enabled: false, timeoutMs: 1500, minScore: .35, maxCandidates: 50 }, verification: { enabled: true, maxJobsPerRun: 20 } });
});

test("governed reasoning delivery requires explicit exact scopes and clamps canary controls", () => {
  const value = normalizeConfig({ cognition: { reasoningRuntime: { delivery: { enabled: true, scopes: ["project:A", "bad scope", "project:a"], adapter: "unsafe", calibrationMaxAgeHours: 0, maxConsecutiveDeliveries: 99, itemRetentionDays: 999 } } } }).cognition.reasoningRuntime.delivery;
  assert.deepEqual(value, { enabled: true, scopes: ["project:a"], adapter: "openclaw", calibrationMaxAgeHours: 1, maxConsecutiveDeliveries: 10, itemRetentionDays: 365 });
});

test("tool surfaces preserve the full historical default and normalize to documented values", () => {
  assert.equal(normalizeConfig({}).toolSurface, "full");
  assert.equal(normalizeConfig({ toolSurface: "core" }).toolSurface, "core");
  assert.equal(normalizeConfig({ toolSurface: "research" }).toolSurface, "research");
  assert.equal(normalizeConfig({ toolSurface: "unknown" }).toolSurface, "full");
});

test("memory retrieval quality expands a bounded local pool by default and bounds optional MMR and reranker controls", () => {
  const reranker = { enabled: false, endpoint: "", apiKey: "", model: "", timeoutMs: 5000, maxCandidates: 12, maxQueryChars: 512, maxDocumentChars: 4000 };
  const aging = { enabled: false, shape: 1.5, scaleDays: 180, minimumFreshness: .1 };
  assert.deepEqual(normalizeConfig({}).memory.retrieval, { candidateMultiplier: 3, minScore: 0, mmrLambda: 1, reranker, aging });
  assert.deepEqual(normalizeConfig({ memory: { retrieval: { candidateMultiplier: 99, minScore: -1, mmrLambda: 2 } } }).memory.retrieval, { candidateMultiplier: 10, minScore: 0, mmrLambda: 1, reranker, aging });
  const configured = normalizeConfig({ memory: { retrieval: { reranker: { enabled: true, endpoint: "https://rerank.example.test///", apiKey: " key ", model: " demo ", timeoutMs: 1, maxCandidates: 99, maxQueryChars: 1, maxDocumentChars: 999999 } } } }).memory.retrieval.reranker;
  assert.deepEqual(configured, { enabled: true, endpoint: "https://rerank.example.test", apiKey: "key", model: "demo", timeoutMs: 1000, maxCandidates: 20, maxQueryChars: 32, maxDocumentChars: 16000 });
  assert.deepEqual(normalizeConfig({ memory: { retrieval: { aging: { enabled: true, shape: 99, scaleDays: 0, minimumFreshness: -1 } } } }).memory.retrieval.aging, { enabled: true, shape: 5, scaleDays: 1, minimumFreshness: 0 });
});

test("standalone ownership remains explicit and public topology metadata is bounded", () => {
  assert.deepEqual(normalizeConfig({}).standalone, { activePluginIds: [] });
  const config = normalizeConfig({ mode: "standalone", standalone: { activePluginIds: [" Lossless-Claw ", "lossless-claw", "bad value", "x".repeat(81)] } });
  assert.equal(config.mode, "standalone");
  assert.deepEqual(config.standalone, { activePluginIds: ["lossless-claw"] });
});

test("shadow-only formation and recall telemetry default on, remain opt-out, and keep their policy inputs bounded", () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.cognition.formationShadow, true);
  assert.deepEqual(defaults.trustLayer.recall, { shadowMode: true, absoluteFloor: 0, relativeCutoffRatio: .6, confidenceGate: .6, minKeep: 1, candidateMultiplier: 5, canary: { enabled: false, modelId: "default", scopes: [] } });
  assert.equal(normalizeConfig({ cognition: { formationShadow: false }, trustLayer: { recall: { shadowMode: false } } }).cognition.formationShadow, false);
  assert.equal(normalizeConfig({ trustLayer: { recall: { shadowMode: false } } }).trustLayer.recall.shadowMode, false);
  const bounded = normalizeConfig({ trustLayer: { recall: { shadowMode: true, absoluteFloor: -1, relativeCutoffRatio: 2, confidenceGate: -1, minKeep: 99, candidateMultiplier: 0, canary: { enabled: true, modelId: " fixture-v1 ", scopes: ["project:A", "bad scope", "project:a"] } } } });
  assert.deepEqual(bounded.trustLayer.recall, { shadowMode: true, absoluteFloor: 0, relativeCutoffRatio: 1, confidenceGate: 0, minKeep: 10, candidateMultiplier: 1, canary: { enabled: true, modelId: "fixture-v1", scopes: ["project:a"] } });
});

test("automatic anchor verification and retrospective audit remain disabled with bounded settings", () => {
  const defaults = normalizeConfig({});
  assert.deepEqual(defaults.trustLayer.verification.automatic, { enabled: false, maxConcurrent: 1, maxJobsPerRun: 5, timeoutMs: 15000, leaseMs: 45000, maxInputChars: 8000, maxOutputBytes: 16384, workerIsolation: true });
  assert.deepEqual(defaults.trustLayer.verification.retrospectiveAudit, { enabled: false, maxJobsPerRun: 5, minimumAgeDays: 30, minimumRecallCount: 3 });
  const bounded = normalizeConfig({ trustLayer: { verification: { automatic: { enabled: true, maxConcurrent: 99, maxJobsPerRun: 99, timeoutMs: 1, leaseMs: 1, maxInputChars: 1, maxOutputBytes: 999999, workerIsolation: false }, retrospectiveAudit: { enabled: true, maxJobsPerRun: 99, minimumAgeDays: 0, minimumRecallCount: 0 } } } });
  assert.deepEqual(bounded.trustLayer.verification.automatic, { enabled: true, maxConcurrent: 4, maxJobsPerRun: 20, timeoutMs: 1000, leaseMs: 5000, maxInputChars: 256, maxOutputBytes: 65536, workerIsolation: false });
  assert.deepEqual(bounded.trustLayer.verification.retrospectiveAudit, { enabled: true, maxJobsPerRun: 20, minimumAgeDays: 1, minimumRecallCount: 1 });
});

test("relationship quality thresholds are clamped independently", () => {
  const config = normalizeConfig({
    quality: {
      edgeMinConfidence: -1,
      relatedToMinConfidence: 2,
      edgeTypeMinConfidence: { works_at: 0.75, related_to: -2, invented: 0.9 },
      singleValuedEdgeTypes: ["works_at", "invented", "works_at"]
    }
  });
  assert.deepEqual(config.quality, {
    edgeMinConfidence: 0,
    relatedToMinConfidence: 1,
    edgeTypeMinConfidence: { works_at: 0.75, related_to: 0 },
    singleValuedEdgeTypes: ["works_at"],
    recencyHalfLifeDays: 90,
    conflictPenaltyFactor: .75,
    hubPenaltyFloor: .6,
    rankingWeights: { semantic: .35, lexical: .20, confidence: .15, recency: .10, sourceDiversity: .05, ppr: .15 },
    pprDamping: .85, pprMaxIterations: 20, pprTolerance: 1e-6, pprMaxNodes: 10000, pprMaxArcs: 50000
  });
});

test("numeric limits are clamped", () => {
  const config = normalizeConfig({
    extraction: { timeoutMs: -1, maxInputChars: 999999 },
    recall: { maxNodes: 0, maxDepth: 99, confidenceThreshold: 5, tokenBudget: 1 }
  });
  assert.deepEqual(
    [config.extraction.timeoutMs, config.extraction.maxInputChars],
    [1000, 100000]
  );
  assert.deepEqual(
    [config.recall.maxNodes, config.recall.maxDepth, config.recall.confidenceThreshold, config.recall.tokenBudget],
    [1, 5, 1, 100]
  );
});

test("embedding defaults are optional and bounded", () => {
  const config = normalizeConfig({ embeddings: { enabled: true, timeoutMs: -1, batchSize: 9999 } });
  assert.deepEqual(config.embeddings, {
    enabled: true,
    provider: "ollama",
    baseURL: "http://127.0.0.1:11434",
    model: "qwen3-embedding:4b",
    timeoutMs: 1000,
    batchSize: 128,
    maxInputChars: 16000,
    queryCacheSize: 256,
    maxVectorScanNodes: 10000
  });
  assert.equal(config.recall.mode, "hybrid");
  assert.deepEqual(config.recall.hybridWeights, { semantic: 0.45, lexical: 0.25, confidence: 0.20, freshness: 0.10 });
});

test("embedding transport is explicitly Ollama-only until another provider adapter ships", () => {
  assert.equal(normalizeConfig({ embeddings: { provider: "unsupported" } }).embeddings.provider, "ollama");
});

test("embedding and semantic limits are normalized", () => {
  const config = normalizeConfig({
    embeddings: {
      enabled: true,
      baseURL: "https://localhost:11434///",
      maxInputChars: 1,
      queryCacheSize: 99999,
      maxVectorScanNodes: 1
    },
    recall: { semanticMinScore: 2 }
  });
  assert.equal(config.embeddings.baseURL, "https://localhost:11434");
  assert.deepEqual(
    [config.embeddings.maxInputChars, config.embeddings.queryCacheSize, config.embeddings.maxVectorScanNodes],
    [256, 4096, 100]
  );
  assert.equal(config.recall.semanticMinScore, 1);
});

test("invalid embedding URLs and hybrid weights restore complete defaults", () => {
  const config = normalizeConfig({
    embeddings: { enabled: true, baseURL: "file:///tmp/ollama" },
    recall: { hybridWeights: { semantic: 1, lexical: 1, confidence: 0, freshness: 0 } }
  });
  assert.equal(config.embeddings.baseURL, "http://127.0.0.1:11434");
  assert.deepEqual(config.recall.hybridWeights, { semantic: 0.45, lexical: 0.25, confidence: 0.20, freshness: 0.10 });
});
