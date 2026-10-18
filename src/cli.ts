#!/usr/bin/env node
import { operationFailureSummary } from "./operations/failure-ledger.js";
import { HealthService } from "./operations/health.js";
import { SemanticMemoryClassifier, type MemoryClassificationInput, type SemanticClassifierConfig } from "./cognition/semantic-classifier.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Mnemora } from "./tools.js";
import { evaluateToolSurface } from "./openclaw.js";
import type { ToolSurface } from "./index.js";
import { expandUserPath, resolveDatabasePath } from "./identity.js";
import type { Direction, RelationshipType } from "./relationships.js";
import { createInspectorApplication } from "./inspector/application.js";
import { startInspector } from "./inspector/http.js";
import { ConversationEventRepository } from "./journal/repository.js";
import { CompactionRunRepository, type CompactionReconciliationOutcome } from "./context-engine/compaction-run-repository.js";
import { UnifiedRetrievalService } from "./retrieval/service.js";
import { MemoryImpactService } from "./correction/impact-service.js";
import { normalizeConfig } from "./config.js";
import { standaloneGuide, standaloneReadiness } from "./standalone/readiness.js";
import { ConsolidationService } from "./consolidation/service.js";
import { FormationService } from "./cognition/service.js";
import { DecisionMemoryService, type DecisionMaker } from "./cognition/decisions.js";
import { TaskOutcomeService, type OutcomeImpact, type OutcomeVerdict, type TaskActionState } from "./cognition/outcomes.js";
import { journalEmbeddingCoverage } from "./journal/search-index.js";
import { RecallFeedbackRepository, ReflectionService, type RecallFeedbackKind } from "./cognition/reflection.js";
import { CognitionGraduationService } from "./cognition/graduation.js";
import { TaskResumeService } from "./task-resume/service.js";
import { renderTaskResumeMemory } from "./task-resume/memory.js";
import { TaskResumeComparisonRunner, validateTaskResumeComparisonPlan } from "./task-resume/comparison.js";
import { TaskResumeValueGate } from "./task-resume/preregistration.js";
import { EvaluationRunner, serializeEvaluationReport, validateEvaluationDataset, RecallThresholdScanRunner, validateRecallThresholdScanPlan } from "./evaluation/index.js";
import { openMnemoraDatabase } from "./sqlite.js";
import { SUPPORTED_SCHEMA_VERSION } from "./schema.js";
import { RecallUsefulnessReviewService } from "./cognition/recall-usefulness.js";
import { GraphReviewDecisionGate } from "./graph-review/decision-gate.js";

const [, , command, ...args] = process.argv;
const dbPath = resolveDatabasePath(process.env.MNEMORA_DB);
const initializedDatabasePath = databasePathCreated(dbPath);

async function main(): Promise<void> {
  if (command === "inspect") {
    const allowed = new Set(["--allow-operations"]); const unknown = args.find(arg => !allowed.has(arg));
    if (unknown) { console.error(`unknown option: ${unknown}`); process.exitCode = 1; return; }
    await inspect(args.includes("--allow-operations"));
    return;
  }
  if (command === "surface") {
    try {
      const surface = args[0] === undefined ? "full" : toolSurface(args[0]);
      if (args.length > 1) throw new CliError("invalid_arguments");
      printOperator("surface.evaluate", evaluateToolSurface(surface));
    } catch (error) { fail("surface.evaluate", error); }
    return;
  }
  if (command === "standalone") {
    try { standalone(args); } catch (error) { fail("standalone", error); }
    return;
  }
  if (command === "evaluate" && ["task-resume-comparison", "task-resume-register", "task-resume-decision"].includes(args[0])) {
    try { printOperator(`evaluate.${args[0]}`, evaluateTaskResumeCommand(args)); }
    catch (error) { fail(`evaluate.${args[0]}`, error); }
    return;
  }
  if (command === "evaluate" && args[0] === "recall-threshold-scan") {
    try { printOperator("evaluate.recall-threshold-scan", await evaluateRecallThresholdScan(args)); }
    catch (error) { fail("evaluate.recall-threshold-scan", error); }
    return;
  }
  if (command === "cognition" && args[0] === "classify") {
    try {
      if (args.length !== 4 || args[2] !== "--config") throw new CliError("invalid_arguments");
      const readBoundedJson = (file: string): unknown => {
        if (statSync(file).size > 65536) throw new CliError("invalid_arguments");
        return JSON.parse(readFileSync(file, "utf8"));
      };
      const config = readBoundedJson(args[3]) as SemanticClassifierConfig;
      const request = readBoundedJson(args[1]) as MemoryClassificationInput;
      if (!config || typeof config !== "object" || Array.isArray(config) || !request || typeof request !== "object" || Array.isArray(request)) throw new CliError("invalid_arguments");
      printOperator("cognition.classify", await new SemanticMemoryClassifier(config).classify(request));
    } catch (error) { fail("cognition.classify", error); }
    return;
  }
  if (command === "cognition") {
    try {
      const { positional } = parseOptions(args);
      if (positional[0] === "feedback" && positional[1] === "evidence") {
        printOperator("cognition.feedback.evidence", await recallUsefulnessEvidence(args));
        return;
      }
    } catch (error) { fail("cognition.feedback.evidence", error); return; }
  }
  const graph = new Mnemora({ config: { dbPath } });
  reportInitializedDatabase();
  try {
    if (command === "search") print(await graph.kg_search(args.join(" ")));
    else if (command === "related") { const [entity, ...rest] = args; print(graph.kg_related(entity, Number(process.env.DEPTH ?? 1), rest as RelationshipType[], process.env.DIRECTION as Direction | undefined)); }
    else if (command === "stats") print(graph.kg_stats());
    else if (command === "health") printOperator("health", healthCommand(graph, args));
    else if (command === "forget") print(await graph.kg_forget(args[0], process.env.HARD === "true", process.env.CONFIRM === "true"));
    else if (command === "ingest") { const text = args[0] ? readFileSync(args[0], "utf8") : readFileSync(0, "utf8"); print(await graph.kg_ingest(text, process.env.SOURCE ?? "manual")); }
    else if (command === "journal" && args[0] === "embed") printOperator("journal.embed", await journalEmbedCommand(dbPath, args.slice(1)));
    else if (command === "journal") printOperator(`journal.${args[0] ?? "help"}`, journalCommand(graph, args));
    else if (command === "retrieve") {
      const query = args.join(" ").trim(); if (!query) throw new CliError("invalid_arguments");
      const result = new UnifiedRetrievalService(graph.store.db, journalPolicy(graph.config))
        .find({ scope: process.env.SCOPE ?? "default", query, intent: retrievalIntent(process.env.INTENT), limit: Number(process.env.LIMIT ?? 8), tokenBudget: Number(process.env.TOKEN_BUDGET ?? 800), recordedBefore: process.env.RECORDED_BEFORE === undefined ? undefined : Number(process.env.RECORDED_BEFORE) });
      printOperator("retrieve.find", result);
    }
    else if (command === "evaluate") printOperator(`evaluate.${args[0] ?? "help"}`, await evaluateCommand(graph, args));
    else if (command === "memory-impact") {
      const [operation, kind, id] = args; if (!operation || !kind || !id || args.length !== 3) throw new CliError("invalid_arguments");
      const service = new MemoryImpactService(graph.store.db), target = memoryTarget(kind);
      if (operation === "preview") printOperator("memory-impact.preview", service.preview({ scope: process.env.SCOPE ?? "default", kind: target, id }));
      else if (operation === "forget") printOperator("memory-impact.forget", service.forget({ scope: process.env.SCOPE ?? "default", kind: target, id, previewHash: process.env.PREVIEW_HASH ?? "", confirm: process.env.CONFIRM === "true" }));
      else throw new CliError("invalid_arguments");
    }
    else if (command === "memory") printOperator(`memory.${args[0] ?? "help"}`, memoryCommand(graph, args));
    else if (command === "review") printOperator(`review.${args[0] ?? "help"}`, reviewCommand(graph, args));
    else if (command === "consolidation") printOperator(`consolidation.${args[0] ?? "help"}`, consolidationCommand(graph, args));
    else if (command === "cognition") printOperator(`cognition.${args[0] ?? "help"}`, await cognitionCommand(graph, args));
    else if (command === "resume") printOperator("resume.read", taskResumeCommand(graph, args));
    else if (command === "trust" || command === "profile" || command === "recall" || command === "governance") printOperator(`${command}.${args[0] ?? "help"}`, await operator(graph, command, args));
    else { console.error(usage()); process.exitCode = 1; }
  } catch (error) { fail(`${command ?? "help"}.${args[0] ?? ""}`.replace(/\.$/, ""), error); }
  finally { graph.close(); }
}

function journalPolicy(config: import("./index.js").MnemoraConfig) {
  const value = config.conversationJournal;
  return { maxInlineChars: value?.maxInlineChars ?? 16000, maxEventBytes: value?.maxEventBytes ?? 262144, sensitiveContentPolicy: value?.sensitiveContentPolicy ?? "redact" } as const;
}

/**
 * Runs an operator-supplied, de-identified golden set against the local
 * canonical store. It is read-only and deliberately cannot change admission,
 * autoExtract, or recall policy from benchmark output.
 */
async function evaluateRecallQuality(graph: Mnemora, raw: string[]): Promise<unknown> {
  if (raw.length !== 2 || raw[0] !== "recall-quality") throw new CliError("invalid_arguments");
  const dataset = validateEvaluationDataset(JSON.parse(readFileSync(resolve(raw[1]), "utf8")) as import("./evaluation/types.js").EvaluationDataset);
  const retrieval = new UnifiedRetrievalService(graph.store.db, journalPolicy(graph.config));
  const subject = async ({ scope, query, limit, signal }: { scope: string; query: string; limit: number; signal: AbortSignal }) => {
    const result = retrieval.find({ scope, query, limit, tokenBudget: 800, signal });
    return { candidates: result.candidates.map(item => ({ contextRef: item.contextRef, score: item.score, sourceRecovered: item.sourceRefs.length > 0, estimatedTokens: item.estimatedTokens, bytes: item.bytes })) };
  };
  const report = await new EvaluationRunner({ find: subject, search: subject }).run(dataset, { candidateLimit: 10, operationTimeoutMs: 2_000, deadlineMs: 30_000 });
  return {
    version: "recall-quality-operator-v1",
    evidence_kind: "operator_asserted_deidentified",
    report: JSON.parse(serializeEvaluationReport(report)),
    automated_admission_decision: "not_performed"
  };
}

async function evaluateRecallThresholdScan(raw: string[]): Promise<unknown> {
  if (raw.length !== 2) throw new CliError("invalid_arguments");
  const path = resolve(raw[1]);
  if (!statSync(path).isFile() || statSync(path).size > 1_048_576) throw new CliError("invalid_arguments");
  const plan = validateRecallThresholdScanPlan(JSON.parse(readFileSync(path, "utf8")));
  const snapshot = await withReadOnlySnapshot(async (db, scoringTimeMs) => {
    const retrieval = new UnifiedRetrievalService(db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" }, () => scoringTimeMs);
    return new RecallThresholdScanRunner((threshold, config) => {
      const find = async ({ query, scope, limit, signal }: import("./evaluation/types.js").EvaluationRetrievalRequest) => {
        const result = retrieval.find({ query, scope, limit, signal, tokenBudget: config.tokenBudget, hardMinScore: threshold });
        return { candidates: result.candidates.map(item => ({ contextRef: item.contextRef, score: item.score, sourceRecovered: item.sourceRefs.length > 0, estimatedTokens: item.estimatedTokens, bytes: item.bytes })) };
      };
      return { find, search: find };
    }).run(plan);
  });
  return { report: snapshot.value, database: snapshot.database, evaluationSurface: "manual_unified_retrieval", automaticInjectionEvaluated: false };
}

async function recallUsefulnessEvidence(raw: string[]): Promise<unknown> {
  const { positional, options } = parseOptions(raw);
  positional.splice(0, 2);
  const targetRef = takeArgument(positional); requireNone(positional);
  if (Object.keys(options).some(key => !["scope", "limit"].includes(key))) throw new CliError("invalid_arguments");
  const scope = option(options, "scope") ?? process.env.SCOPE ?? "default", limit = boundedLimit(option(options, "limit")) ?? 20;
  if (limit > 50) throw new CliError("invalid_arguments");
  const snapshot = await withReadOnlySnapshot((db, scoringTimeMs) => new RecallUsefulnessReviewService(db, () => scoringTimeMs).review({ scope, targetRef, limit }));
  return { review: snapshot.value, database: snapshot.database };
}

/** All snapshot-only operator commands skip normal store initialization. */
async function withReadOnlySnapshot<T>(read: (db: import("@photostructure/sqlite").DatabaseSyncInstance, scoringTimeMs: number) => T | Promise<T>) {
  if (!process.env.MNEMORA_DB?.trim() || dbPath === ":memory:") throw new CliError("explicit_existing_database_required");
  const snapshotPath = expandUserPath(dbPath);
  if (!existsSync(snapshotPath) || !statSync(snapshotPath).isFile()) throw new CliError("explicit_existing_database_required");
  const db = openMnemoraDatabase(snapshotPath, { readOnly: true }), scoringTimeMs = Date.now();
  try {
    db.exec("BEGIN");
    const version = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    if (version.user_version !== SUPPORTED_SCHEMA_VERSION) throw new CliError("unsupported_snapshot_schema");
    const value = await read(db, scoringTimeMs);
    return { value, database: { readOnly: true, readTransaction: true, schemaVersion: version.user_version, scoringTimeMs } };
  } finally {
    try { db.exec("ROLLBACK"); } finally { db.close(); }
  }
}

function journalCommand(graph: Mnemora, raw: string[]): unknown {
  if (raw[0] === "status" && raw.length === 1) return new ConversationEventRepository(graph.store.db, journalPolicy(graph.config)).diagnostics(false);
  if (raw[0] === "search" && raw.length > 1) return new ConversationEventRepository(graph.store.db, journalPolicy(graph.config)).search(process.env.SCOPE ?? "default", raw.slice(1).join(" "), Number(process.env.LIMIT ?? 20));
  const { positional, options } = parseOptions(raw), family = positional.shift();
  if (family !== "compaction") throw new CliError("invalid_arguments");
  const operation = positional.shift(), scope = option(options, "scope") ?? process.env.SCOPE ?? "default", limit = boundedLimit(option(options, "limit")) ?? 20, runs = new CompactionRunRepository(graph.store.db);
  if (operation === "prepared") { requireNone(positional); return { scope, runs: runs.prepared(scope, limit) }; }
  if (operation === "reconcile") {
    const id = takeArgument(positional), outcome = compactionOutcome(takeArgument(positional)); requireNone(positional);
    if (options.confirm !== true) return { status: "confirm_required", operation: "journal.compaction.reconcile" };
    return runs.reconcilePrepared({ scope, id, outcome }) ?? { status: "not_found_or_not_prepared" };
  }
  throw new CliError("invalid_arguments");
}

/**
 * Embed the journal backlog for semantic recall (after enabling embeddings on
 * an existing database). Bounded, resumable and local: only the configured
 * Ollama endpoint is called, and nothing else in the database changes.
 */
async function journalEmbedCommand(dbPath: string, raw: string[]): Promise<unknown> {
  const { positional, options } = parseOptions(raw);
  requireNone(positional);
  const model = option(options, "model") ?? process.env.MNEMORA_EMBED_MODEL;
  if (!model) throw new CliError("invalid_arguments");
  const baseURL = option(options, "base-url") ?? process.env.MNEMORA_EMBED_URL ?? "http://127.0.0.1:11434";
  const scope = option(options, "scope");
  const limit = boundedRange(option(options, "limit"), 1, 1_000_000) ?? 10_000;
  const graph = new Mnemora({ config: { dbPath, embeddings: { enabled: true, provider: "ollama", baseURL, model } } });
  try {
    let embedded = 0, failed = 0;
    while (embedded < limit) {
      const step = await graph.embedJournalChunks({ limit: Math.min(500, limit - embedded), ...(scope ? { scope } : {}) });
      embedded += step.embedded; failed += step.failed;
      if (!step.embedded || step.failed) break;
    }
    const identity = await graph.journalQueryVector("coverage probe");
    return { model, scope: scope ?? "all", embedded, failed, ...(identity ? { coverage: journalEmbeddingCoverage(graph.store.db, identity.identity, scope) } : {}) };
  } finally { graph.close(); }
}

/** Read-only operational review for memory that has not been attached since
 * its newest write. Lifecycle state changes still require kg_memory's
 * document-bound preview/confirm flow. */
function memoryCommand(graph: Mnemora, raw: string[]): unknown {
  const { positional, options } = parseOptions(raw), operation = positional.shift(), scope = option(options, "scope") ?? process.env.SCOPE ?? "default";
  if (operation !== "decay-review") throw new CliError("invalid_arguments");
  requireNone(positional);
  return graph.kg_memory({ operation: "recall_decay_review", scope, min_age_days: boundedRange(option(options, "min-age-days"), 1, 36500), limit: boundedLimit(option(options, "limit")) });
}

async function evaluateCommand(graph: Mnemora, raw: string[]): Promise<unknown> {
  return evaluateRecallQuality(graph, raw);
}

function evaluateTaskResumeCommand(raw: string[]): unknown {
  if (raw.length !== (raw[0] === "task-resume-decision" ? 3 : 2)) throw new CliError("invalid_arguments");
  const input = JSON.parse(readFileSync(resolve(raw[1]), "utf8"));
  if (raw[0] === "task-resume-register") return new TaskResumeValueGate().register(input);
  if (raw[0] === "task-resume-decision") return new TaskResumeValueGate().evaluate(input, JSON.parse(readFileSync(resolve(raw[2]), "utf8")));
  return new TaskResumeComparisonRunner().run(validateTaskResumeComparisonPlan(input));
}

/** The graph decision gate is deliberately CLI-only: it is a human review
 * report, not another context-consuming agent tool or a policy mutation. */
function reviewCommand(graph: Mnemora, raw: string[]): unknown {
  const { positional, options } = parseOptions(raw), operation = positional.shift(), scope = option(options, "scope") ?? process.env.SCOPE ?? "default";
  if (operation === "gate") {
    if (positional.length || Object.keys(options).some(key => key !== "scope")) throw new CliError("invalid_arguments");
    const hygiene = graph.config.quality?.hygiene;
    return new GraphReviewDecisionGate(graph.store, {
      relatedToWarningRatio: hygiene?.relatedToWarningRatio ?? .4,
      relatedToWarningMinimumEdges: hygiene?.relatedToWarningMinimumEdges ?? 20
    }).report(scope);
  }
  if (operation === "worklist") {
    if (positional.length || Object.keys(options).some(key => !["scope", "status", "limit", "after-id"].includes(key))) throw new CliError("invalid_arguments");
    const status = option(options, "status") ?? "pending";
    if (status !== "pending" && status !== "rejected" && status !== "invalidated") throw new CliError("invalid_arguments");
    return graph.kg_review("worklist", status, false, boundedLimit(option(options, "limit")) ?? 20, option(options, "after-id"), undefined, undefined, scope);
  }
  if (operation === "vocabulary") {
    const phase = takeArgument(positional);
    if (phase === "scan") {
      if (positional.length || Object.keys(options).some(key => !["scope", "limit", "after-id"].includes(key))) throw new CliError("invalid_arguments");
      return graph.kg_review("semantic_vocabulary", "pending", true, boundedLimit(option(options, "limit")) ?? 20, option(options, "after-id"), undefined, undefined, scope);
    }
    if (phase === "list") {
      if (positional.length || Object.keys(options).some(key => !["scope", "limit", "status"].includes(key))) throw new CliError("invalid_arguments");
      const status = option(options, "status") ?? "pending";
      if (status !== "pending" && status !== "accepted" && status !== "rejected") throw new CliError("invalid_arguments");
      return graph.kg_review("semantic_vocabulary", status, false, boundedLimit(option(options, "limit")) ?? 20, undefined, undefined, undefined, scope);
    }
    if (phase === "preview" || phase === "confirm") {
      const candidateId = takeArgument(positional), decision = takeArgument(positional);
      if (positional.length || (decision !== "accepted" && decision !== "rejected") || Object.keys(options).some(key => !["scope", "preview-hash", "confirm"].includes(key))) throw new CliError("invalid_arguments");
      if (phase === "preview") {
        if (options.confirm === true || option(options, "preview-hash")) throw new CliError("invalid_arguments");
        return graph.kg_review("semantic_vocabulary", "pending", false, 20, undefined, candidateId, decision, scope);
      }
      if (options.confirm !== true) return { status: "confirm_required", operation: "review.vocabulary.confirm" };
      const previewHash = option(options, "preview-hash");
      if (!previewHash) throw new CliError("invalid_arguments");
      return graph.kg_review("semantic_vocabulary", "pending", false, 20, undefined, candidateId, decision, scope, undefined, undefined, previewHash, true);
    }
    throw new CliError("invalid_arguments");
  }
  if (operation === "anomalies") {
    const phase = takeArgument(positional), edgeIds = positional.splice(0);
    if (!edgeIds.length || edgeIds.length > 20 || Object.keys(options).some(key => !["scope", "preview-hash", "confirm"].includes(key))) throw new CliError("invalid_arguments");
    if (phase === "preview") {
      if (options.confirm === true || option(options, "preview-hash")) throw new CliError("invalid_arguments");
      return graph.store.cleanupAnomalies(edgeIds, false, undefined, scope);
    }
    if (phase === "confirm") {
      if (options.confirm !== true) return { status: "confirm_required", operation: "review.anomalies.confirm" };
      const previewHash = option(options, "preview-hash");
      if (!previewHash) throw new CliError("invalid_arguments");
      return graph.store.cleanupAnomalies(edgeIds, true, previewHash, scope);
    }
  }
  throw new CliError("invalid_arguments");
}

/** Read-only operational health: fail-open failures, automation outcomes and evidence freshness. */
function healthCommand(graph: Mnemora, raw: string[]): unknown {
  const { positional, options } = parseOptions(raw);
  if (positional.length || Object.keys(options).some(key => key !== "days")) throw new CliError("invalid_arguments");
  const daysOption = option(options, "days");
  const days = daysOption === undefined ? 7 : Number(daysOption);
  if (!Number.isSafeInteger(days) || days < 1 || days > 30) throw new CliError("invalid_arguments");
  const failures = operationFailureSummary(graph.store.db, days);
  const report = new HealthService({ store: graph.store }).report();
  const suggestions = [...report.suggestions, ...(failures.total ? [{ code: "inspect_operation_failures" as const, count: failures.total }] : [])];
  return { status: failures.total || report.suggestions.length ? "attention" : "ok", operation_failures: failures, automatic: report.automatic, evidence: { current: report.evidence.current, stale: report.evidence.stale, unverified: report.evidence.unverified }, suggestions };
}

function standalone(raw: string[]): void {
  if (raw.length !== 1) throw new CliError("invalid_arguments");
  if (raw[0] === "guide") { printOperator("standalone.guide", standaloneGuide()); return; }
  if (raw[0] === "rollback") { printOperator("standalone.rollback", standaloneGuide().rollback); return; }
  if (raw[0] !== "status") throw new CliError("invalid_arguments");
  const config = normalizeConfig({
    dbPath,
    mode: "standalone",
    conversationJournal: { enabled: process.env.MNEMORA_JOURNAL === "true" },
    contextEngine: { enabled: process.env.MNEMORA_CONTEXT_ENGINE === "true" },
    episodicMemory: { enabled: process.env.MNEMORA_EPISODIC_MEMORY === "true" },
    recall: { autoRecall: process.env.MNEMORA_AUTO_RECALL === "true" },
    standalone: { activePluginIds: (process.env.MNEMORA_ACTIVE_PLUGINS ?? "").split(",").filter(Boolean) }
  });
  printOperator("standalone.status", standaloneReadiness(config, config.standalone?.activePluginIds));
}

function consolidationCommand(graph: Mnemora, raw: string[]): unknown {
  const { positional, options } = parseOptions(raw), command = positional.shift(), scope = option(options, "scope") ?? "default", limit = boundedLimit(option(options, "limit")) ?? 50, confirm = options.confirm === true;
  const service = new ConsolidationService(graph.store.db);
  if (command === "status") { requireNone(positional); return { scope, ...service.metrics(scope), proposals: service.proposals(scope, undefined, limit) }; }
  if (command === "proposals") { requireNone(positional); return service.proposals(scope, undefined, limit); }
  if (command === "schedule") { requireNone(positional); return confirmMutation(confirm, "consolidation.schedule", () => service.schedule(scope)); }
  if (command === "run") { requireNone(positional); return confirmMutation(confirm, "consolidation.run", () => { service.schedule(scope); return service.run({ scope, maxJobs: Math.min(20, limit) }); }); }
  if (command === "expire") { requireNone(positional); return confirmMutation(confirm, "consolidation.expire", () => ({ expired: service.expire(scope) })); }
  if (command === "reclaim-stale") { requireNone(positional); return confirmMutation(confirm, "consolidation.reclaim-stale", () => ({ reclaimed: service.reclaimStale(scope) })); }
  if (command === "review") { const id = takeArgument(positional), decision = takeArgument(positional); requireNone(positional); if (decision !== "approved" && decision !== "rejected") throw new CliError("invalid_arguments"); return confirmMutation(confirm, "consolidation.review", () => service.review(scope, id, decision)); }
  if (command === "adopt") {
    const operation=takeArgument(positional), id=takeArgument(positional); requireNone(positional);
    if (Object.keys(options).some(key=>!["scope","preview-hash","confirm"].includes(key))) throw new CliError("invalid_arguments");
    if (operation === "preview") return service.previewAdoption(scope,id);
    if (operation === "apply") {
      if (!confirm) return { status:"confirm_required", operation:"consolidation.adopt.apply" };
      const previewHash=option(options,"preview-hash"); if (!previewHash) throw new CliError("invalid_arguments");
      return service.adopt({scope,id,previewHash});
    }
    throw new CliError("invalid_arguments");
  }
  throw new CliError("invalid_arguments");
}

/** Explicit, read-only task continuation. It never changes recall or schedules work. */
function taskResumeCommand(graph: Mnemora, raw: string[]): unknown {
  const { positional, options } = parseOptions(raw);
  if (Object.keys(options).some(key => !["scope", "limit", "task-ref", "format"].includes(key))) throw new CliError("invalid_arguments");
  const format = option(options, "format") ?? "full";
  if (format !== "full" && format !== "compact") throw new CliError("invalid_arguments");
  const query = positional.join(" ").trim(), limit = boundedLimit(option(options, "limit"));
  const result = new TaskResumeService(graph.store.db).resume({
    scope: option(options, "scope") ?? process.env.SCOPE ?? "default",
    ...(query ? { query } : {}),
    ...(option(options, "task-ref") ? { taskRef: option(options, "task-ref") } : {}),
    ...(limit ? { limit } : {})
  });
  return format === "full" ? result : JSON.parse(renderTaskResumeMemory(result, "compact"));
}

async function cognitionCommand(graph: Mnemora, raw: string[]): Promise<unknown> {
  if (raw.length === 1 && raw[0] === "status") return new FormationService(graph.store.db).status(process.env.SCOPE ?? "default");
  const { positional, options } = parseOptions(raw), family = positional.shift();
  if (family === "context") {
    const operation = positional.shift();
    if (operation !== "compile" || Object.keys(options).some(key => !["scope", "token-budget", "max-items", "historical-at"].includes(key))) throw new CliError("invalid_arguments");
    const scope = option(options, "scope") ?? process.env.SCOPE ?? "default";
    return graph.personalContext.compile({ scope, query: positional.join(" "), tokenBudget: boundedRange(option(options, "token-budget"), 64, 1600), maxItems: boundedRange(option(options, "max-items"), 1, 20), historicalAt: boundedRange(option(options, "historical-at"), 0, Number.MAX_SAFE_INTEGER) });
  }
  if (family === "graduation") {
    const operation = positional.shift(), scope = option(options, "scope") ?? process.env.SCOPE ?? "default", cognition = graph.config.cognition;
    if (operation !== "status" && operation !== "audit") throw new CliError("invalid_arguments");
    requireNone(positional);
    const service = new CognitionGraduationService(graph.store.db, { enabled: cognition?.graduation?.enabled, formationShadow: cognition?.formationShadow, admissionMode: cognition?.admission?.mode, beliefsEnabled: cognition?.beliefs?.enabled, contextCompilerEnabled: cognition?.contextCompiler?.enabled, reflectionEnabled: cognition?.reflection?.enabled });
    const status = service.status(scope);
    return operation === "audit" ? { scope: status.scope, audit: status.audit } : status;
  }
  if (family === "reflection") {
    const operation = positional.shift(), scope = option(options, "scope") ?? process.env.SCOPE ?? "default", staleAfterDays = boundedRange(option(options, "stale-after-days"), 1, 3650), service = new ReflectionService(graph.store.db);
    if (operation === "status") { requireNone(positional); return { scope, ...service.metrics(scope), candidates: service.candidates(scope, boundedLimit(option(options, "limit")) ?? 50) }; }
    if (operation === "preview") { requireNone(positional); return service.preview({ scope, staleAfterDays }); }
    if (operation === "run") { requireNone(positional); const preview = service.preview({ scope, staleAfterDays }); if (options.confirm !== true) return { status: "confirm_required", operation: "cognition.reflection.run", preview_hash: preview.preview_hash }; if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash }; return service.runPreview({ scope, previewHash: preview.preview_hash, staleAfterDays, maxJobs: boundedLimit(option(options, "limit")) }); }
    throw new CliError("invalid_arguments");
  }
  if (family === "feedback") {
    const operation = positional.shift(), scope = option(options, "scope") ?? process.env.SCOPE ?? "default", service = new RecallFeedbackRepository(graph.store.db);
    if (operation === "list") { requireNone(positional); return service.list(scope, boundedLimit(option(options, "limit")) ?? 50); }
    if (operation === "record") { const targetRef = takeArgument(positional), kind = takeArgument(positional); requireNone(positional); if (options.confirm !== true) return { status: "confirm_required", operation: "cognition.feedback.record" }; return service.record({ scope, targetRef, kind: feedbackKind(kind) }); }
    throw new CliError("invalid_arguments");
  }
  if (family === "outcome") {
    const operation = positional.shift(), scope = option(options, "scope") ?? process.env.SCOPE ?? "default", limit = boundedLimit(option(options, "limit")) ?? 20, service = new TaskOutcomeService(graph.store.db);
    if (operation === "list") { requireNone(positional); return service.list(scope, limit); }
    if (operation === "summary") { requireNone(positional); return service.summary(scope); }
    if (operation === "task") return service.forTask(scope, requiredArgument(positional, "task_ref"), limit);
    if (operation === "show") return service.get(requiredArgument(positional, "outcome_id"), scope) ?? { status: "not_found" };
    if (operation === "record") {
      const taskRef = requiredArgument(positional, "task_ref"); requireNone(positional);
      const input = outcomeInput(scope, taskRef), preview = service.preview(input);
      if (options.confirm !== true) return preview;
      if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
      return service.confirm(input, preview.preview_hash);
    }
    throw new CliError("invalid_arguments");
  }
  if (family !== "decision") throw new CliError("invalid_arguments");
  const operation = positional.shift(), scope = option(options, "scope") ?? process.env.SCOPE ?? "default", limit = boundedLimit(option(options, "limit")) ?? 20, service = new DecisionMemoryService(graph.store.db);
  if (operation === "list") { requireNone(positional); return service.list(scope, limit); }
  if (operation === "find") { const query = positional.join(" ").trim(); if (!query) throw new CliError("invalid_arguments"); return service.find(scope, query, limit); }
  if (operation === "show") return service.get(requiredArgument(positional, "decision_id"), scope) ?? { status: "not_found" };
  if (operation === "create") {
    const objective = positional.join(" ").trim(); if (!objective) throw new CliError("invalid_arguments");
    const input = decisionInput(scope, objective), preview = service.preview(input);
    if (options.confirm !== true) return preview;
    if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
    return service.confirm(input, preview.preview_hash);
  }
  if (operation === "invalidate" || operation === "archive") {
    const id = requiredArgument(positional, "decision_id");
    return confirmMutation(options.confirm === true, `cognition.decision.${operation}`, () => service.changeStatus({ id, scope, action: operation }));
  }
  throw new CliError("invalid_arguments");
}

function decisionInput(scope: string, objective: string) {
  const maker = process.env.MNEMORA_DECISION_MAKER ?? "user";
  if (!["user", "assistant", "joint", "tool", "external"].includes(maker)) throw new CliError("invalid_arguments");
  const list = (name: string): string[] => { const raw = process.env[name]; if (!raw) return []; try { const parsed = JSON.parse(raw); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== "string")) throw new Error(); return parsed; } catch { throw new CliError("invalid_arguments"); } };
  const evidence = (() => { const raw = process.env.MNEMORA_DECISION_EVIDENCE; if (!raw) return []; try { const parsed = JSON.parse(raw); if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item.sourceRef !== "string")) throw new Error(); return parsed; } catch { throw new CliError("invalid_arguments"); } })();
  const number = (name: string): number | undefined => { const raw = process.env[name]; if (raw === undefined) return undefined; const value = Number(raw); if (!Number.isFinite(value)) throw new CliError("invalid_arguments"); return value; };
  return { scope, objective, scenario: process.env.MNEMORA_DECISION_SCENARIO, alternatives: list("MNEMORA_DECISION_ALTERNATIVES"), chosenAction: process.env.MNEMORA_DECISION_ACTION, outcome: process.env.MNEMORA_DECISION_OUTCOME, rationale: process.env.MNEMORA_DECISION_RATIONALE, constraints: list("MNEMORA_DECISION_CONSTRAINTS"), confidence: number("MNEMORA_DECISION_CONFIDENCE"), decisionMaker: maker as DecisionMaker, decidedAt: number("MNEMORA_DECISION_DECIDED_AT"), validFrom: number("MNEMORA_DECISION_VALID_FROM"), validUntil: number("MNEMORA_DECISION_VALID_UNTIL"), evidence, episodeIds: list("MNEMORA_DECISION_EPISODES"), previousDecisionId: process.env.MNEMORA_PREVIOUS_DECISION_ID };
}

function outcomeInput(scope: string, taskRef: string) {
  const verdict = process.env.MNEMORA_OUTCOME_VERDICT ?? "unknown", impact = process.env.MNEMORA_OUTCOME_IMPACT ?? "neutral";
  if (!["success", "partial", "failure", "unknown"].includes(verdict) || !["helpful", "neutral", "harmful"].includes(impact)) throw new CliError("invalid_arguments");
  const refs = (() => { const raw = process.env.MNEMORA_OUTCOME_EVIDENCE; try { const parsed = raw ? JSON.parse(raw) : []; if (!Array.isArray(parsed) || parsed.some(value => typeof value !== "string")) throw new Error(); return parsed; } catch { throw new CliError("invalid_arguments"); } })();
  const rawConfidence = process.env.MNEMORA_OUTCOME_CONFIDENCE, confidence = rawConfidence === undefined ? undefined : Number(rawConfidence);
  if (confidence !== undefined && !Number.isFinite(confidence)) throw new CliError("invalid_arguments");
  const actionRef = process.env.MNEMORA_OUTCOME_ACTION_REF, actionState = process.env.MNEMORA_OUTCOME_ACTION_STATE;
  if ((actionRef === undefined) !== (actionState === undefined) || actionState !== undefined && !["attempted", "partial", "completed", "failed", "cancelled", "superseded"].includes(actionState)) throw new CliError("invalid_arguments");
  return { scope, taskRef, verdict: verdict as OutcomeVerdict, impact: impact as OutcomeImpact, confidence, summary: process.env.MNEMORA_OUTCOME_SUMMARY, evidenceRefs: refs, supersedesId: process.env.MNEMORA_OUTCOME_SUPERSEDES, actionRef, actionState: actionState as TaskActionState | undefined };
}

async function operator(graph: Mnemora, family: "trust" | "profile" | "recall" | "governance", raw: string[]): Promise<unknown> {
  const { positional, options } = parseOptions(raw);
  const subcommand = positional.shift();
  const scope = option(options, "scope");
  const limit = boundedLimit(option(options, "limit"));
  const confirm = options.confirm === true;
  const previewHash = option(options, "preview-hash"), issuedBy = option(options, "issued-by");
  if (family === "trust") return trustCommand(graph, subcommand, positional, { scope, limit, confirm });
  if (family === "profile") return profileCommand(graph, subcommand, positional, { scope, limit, confirm, previewHash });
  if (family === "governance") return governanceCommand(graph, subcommand, positional, { scope, limit, confirm, issuedBy });
  return recallCommand(graph, subcommand, positional, { scope, limit, confirm, previewHash });
}

function governanceCommand(graph: Mnemora, command: string | undefined, args: string[], input: { scope?: string; limit?: number; confirm: boolean; issuedBy?: string }): unknown {
  const scope = input.scope ?? "default", limit = input.limit;
  switch (command) {
    case "status":
      requireNone(args);
      return { enabled: graph.governance.active, scope, principals: graph.governanceRepository.principals(limit), grants: graph.governanceRepository.grants(scope, limit), approvals: graph.governanceRepository.approvals(scope, limit), events: graph.governanceRepository.events(scope, limit) };
    case "principal-register": {
      const id = takeArgument(args), kind = takeArgument(args); requireNone(args);
      return confirmMutation(input.confirm, "governance.principal-register", () => graph.governanceRepository.registerPrincipal({ id, kind: governancePrincipalKind(kind) }));
    }
    case "principal-revoke": {
      const id = takeArgument(args); requireNone(args);
      return confirmMutation(input.confirm, "governance.principal-revoke", () => ({ revoked: graph.governanceRepository.revokePrincipal(id) }));
    }
    case "grant": {
      const principalId = takeArgument(args), action = takeArgument(args); requireNone(args);
      const issuer = input.issuedBy; if (!issuer) throw new CliError("invalid_arguments");
      return confirmMutation(input.confirm, "governance.grant", () => graph.governanceRepository.grant({ principal_id: principalId, scope, action: governanceAction(action), issued_by: issuer }));
    }
    case "grant-revoke": {
      const id = takeArgument(args); requireNone(args);
      const issuer = input.issuedBy; if (!issuer) throw new CliError("invalid_arguments");
      return confirmMutation(input.confirm, "governance.grant-revoke", () => ({ revoked: graph.governanceRepository.revokeGrant(id, issuer) }));
    }
    case "approval-request": {
      const actorId = takeArgument(args), action = takeArgument(args), resourceId = takeArgument(args), requestHash = takeArgument(args); requireNone(args);
      return confirmMutation(input.confirm, "governance.approval-request", () => graph.governance.requestApproval({ actor_id: actorId, action: governanceAction(action), scope, resource_id: resourceId, request_hash: requestHash }));
    }
    case "approval-resolve": {
      const approvalId = takeArgument(args), actorId = takeArgument(args), decision = takeArgument(args); requireNone(args);
      if (decision !== "approve" && decision !== "reject") throw new CliError("invalid_arguments");
      return confirmMutation(input.confirm, "governance.approval-resolve", () => graph.governance.approve({ approval_id: approvalId, actor_id: actorId, approve: decision === "approve" }));
    }
    default: throw new CliError("invalid_arguments");
  }
}

function trustCommand(graph: Mnemora, command: string | undefined, args: string[], input: { scope?: string; limit?: number; confirm: boolean }): unknown {
  const scope = input.scope, limit = input.limit;
  switch (command) {
    case "status":
      requireNone(args);
      return { scope: scope ?? "default", verifications: graph.kg_verify({ operation: "list", scope, limit }), jobs: graph.kg_verify({ operation: "jobs", scope, limit }), audits: graph.kg_verify({ operation: "audits", scope, limit }), recall_canary: graph.kg_recall_canary({ operation: "status", scope }) };
    case "list": requireNone(args); return graph.kg_verify({ operation: "list", scope, limit });
    case "sources": requireNone(args); return graph.kg_verify({ operation: "sources", scope, limit });
    case "jobs": requireNone(args); return graph.kg_verify({ operation: "jobs", scope, limit });
    case "audits": requireNone(args); return graph.kg_verify({ operation: "audits", scope, limit });
    case "queue": requireNone(args); return confirmMutation(input.confirm, "trust.queue", () => graph.kg_verify({ operation: "queue", scope, limit }));
    case "run": requireNone(args); return confirmMutation(input.confirm, "trust.run", () => graph.kg_verify({ operation: "run", scope, limit }));
    case "cancel": return confirmMutation(input.confirm, "trust.cancel", () => graph.kg_verify({ operation: "cancel", job_id: requiredArgument(args, "job_id") }));
    case "audit-schedule": requireNone(args); return confirmMutation(input.confirm, "trust.audit-schedule", () => graph.kg_verify({ operation: "audit_schedule", scope, limit }));
    case "audit-run": requireNone(args); return confirmMutation(input.confirm, "trust.audit-run", () => graph.kg_verify({ operation: "audit_run", scope, limit }));
    case "audit-cancel": return confirmMutation(input.confirm, "trust.audit-cancel", () => graph.kg_verify({ operation: "audit_cancel", audit_id: requiredArgument(args, "audit_id") }));
    case "audit-requeue": return confirmMutation(input.confirm, "trust.audit-requeue", () => graph.kg_verify({ operation: "audit_requeue", audit_id: requiredArgument(args, "audit_id") }));
    case "audit-review": return confirmMutation(input.confirm, "trust.audit-review", () => graph.kg_verify({ operation: "audit_review", audit_id: requiredArgument(args, "audit_id") }));
    case "audit-reclaim-stale": requireNone(args); return confirmMutation(input.confirm, "trust.audit-reclaim-stale", () => graph.kg_verify({ operation: "audit_reclaim_stale", scope }));
    default: throw new CliError("invalid_arguments");
  }
}

function profileCommand(graph: Mnemora, command: string | undefined, args: string[], input: { scope?: string; limit?: number; confirm: boolean; previewHash?: string }): unknown {
  if (command === "show") return graph.kg_profile(requiredArgument(args, "subject"), input.scope, input.limit);
  if (command === "history") return graph.kg_profile_history({ operation: "list", subject: requiredArgument(args, "subject"), scope: input.scope, limit: input.limit });
  if (command === "diff") {
    const subject = takeArgument(args), beforeId = optionalArgument(args), afterId = optionalArgument(args);
    requireNone(args);
    return graph.kg_profile_history({ operation: "diff", subject, scope: input.scope, ...(beforeId ? { before_id: beforeId } : {}), ...(afterId ? { after_id: afterId } : {}) });
  }
  const subject = takeArgument(args), field = takeArgument(args);
  if (command === "select") { const target = takeArgument(args); requireNone(args); return graph.kg_profile_lock({ action: "set", subject, field_key: field as never, target_id: target, scope: input.scope, preview_hash: input.previewHash, confirm: input.confirm }); }
  if (command === "clear") { requireNone(args); return graph.kg_profile_lock({ action: "clear", subject, field_key: field as never, scope: input.scope, preview_hash: input.previewHash, confirm: input.confirm }); }
  throw new CliError("invalid_arguments");
}

function recallCommand(graph: Mnemora, command: string | undefined, args: string[], input: { scope?: string; limit?: number; confirm: boolean; previewHash?: string }): unknown {
  const scope = input.scope;
  switch (command) {
    case "explain": return graph.kg_recall_explain({ query: requiredArgument(args, "query"), scope });
    case "status": requireNone(args); return graph.kg_recall_canary({ operation: "status", scope });
    case "metrics": requireNone(args); return graph.kg_recall_metrics({ scope, limit: input.limit });
    case "calibrations": requireNone(args); return graph.kg_recall_canary({ operation: "calibrations", scope, limit: input.limit });
    case "evaluate": requireNone(args); return graph.kg_recall_canary({ operation: "evaluate", scope });
    case "calibrate": requireNone(args); return graph.kg_recall_canary({ operation: "calibrate", scope, preview_hash: input.previewHash, confirm: input.confirm });
    case "enable": return graph.kg_recall_canary({ operation: "enable", scope, calibration_id: requiredArgument(args, "calibration_id"), preview_hash: input.previewHash, confirm: input.confirm });
    case "rollback": requireNone(args); return confirmMutation(input.confirm, "recall.rollback", () => graph.kg_recall_canary({ operation: "rollback", scope, confirm: true }));
    default: throw new CliError("invalid_arguments");
  }
}

function parseOptions(args: string[]): { positional: string[]; options: Record<string, string | true> } {
  const positional: string[] = [], options: Record<string, string | true> = {};
  const values = new Set(["scope", "limit", "task-ref", "format", "preview-hash", "issued-by", "token-budget", "max-items", "historical-at", "stale-after-days", "min-age-days", "adapter", "status", "after-id", "model", "base-url", "days"]);
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const name = item.slice(2);
    if (name === "confirm") { options.confirm = true; continue; }
    if (!values.has(name) || options[name] !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) throw new CliError("invalid_arguments");
    options[name] = args[++index];
  }
  return { positional, options };
}

function option(options: Record<string, string | true>, name: string): string | undefined { const value = options[name]; return typeof value === "string" ? value : undefined; }
function boundedLimit(value: string | undefined): number | undefined { if (value === undefined) return undefined; const number = Number(value); if (!Number.isInteger(number) || number < 1 || number > 100) throw new CliError("invalid_arguments"); return number; }
function boundedRange(value: string | undefined, min: number, max: number): number | undefined { if (value === undefined) return undefined; const number = Number(value); if (!Number.isSafeInteger(number) || number < min || number > max) throw new CliError("invalid_arguments"); return number; }
function feedbackKind(value: string): RecallFeedbackKind { if (["helpful", "unused", "irrelevant", "wrong", "outdated", "user_corrected", "context_mismatch"].includes(value)) return value as RecallFeedbackKind; throw new CliError("invalid_arguments"); }
function requiredArgument(args: string[], label: string): string { const value = args.shift(); if (!value || args.length) throw new CliError("invalid_arguments"); return value; }
function takeArgument(args: string[]): string { const value = args.shift(); if (!value) throw new CliError("invalid_arguments"); return value; }
function optionalArgument(args: string[]): string | undefined { const value = args.shift(); return value || undefined; }
function requireNone(args: string[]): void { if (args.length) throw new CliError("invalid_arguments"); }
function confirmMutation<T>(confirmed: boolean, operation: string, run: () => T): T | { status: "confirm_required"; operation: string } { return confirmed ? run() : { status: "confirm_required", operation }; }
function toolSurface(value: string): ToolSurface { if (value === "core" || value === "research" || value === "full") return value; throw new CliError("invalid_arguments"); }
function governancePrincipalKind(value: string): "human" | "agent" | "system" { if (value === "human" || value === "agent" || value === "system") return value; throw new CliError("invalid_arguments"); }
function governanceAction(value: string): "verification.transition" | "conflict.resolve" | "profile.selection" { if (value === "verification.transition" || value === "conflict.resolve" || value === "profile.selection") return value; throw new CliError("invalid_arguments"); }
function retrievalIntent(value: string | undefined): import("./retrieval/types.js").RetrievalIntent | undefined { if (value === undefined) return undefined; if (["exact_history", "prior_episode", "artifact", "structured_fact", "general"].includes(value)) return value as import("./retrieval/types.js").RetrievalIntent; throw new CliError("invalid_arguments"); }
function memoryTarget(value: string): "event"|"artifact"|"episode"|"summary" { if (["event","artifact","episode","summary"].includes(value)) return value as "event"|"artifact"|"episode"|"summary"; throw new CliError("invalid_arguments"); }
function compactionOutcome(value: string): CompactionReconciliationOutcome { if (value === "rewrite_confirmed" || value === "rewrite_not_applied") return value; throw new CliError("invalid_arguments"); }
class CliError extends Error { constructor(readonly code: "invalid_arguments" | "explicit_existing_database_required" | "unsupported_snapshot_schema") { super(code); } }

await main();

async function inspect(allowOperations: boolean): Promise<void> {
  const graph = new Mnemora({ config: { dbPath } }); reportInitializedDatabase(); let running: Awaited<ReturnType<typeof startInspector>> | undefined;
  try {
    const root = process.env.MNEMORA_ARTIFACTS ?? resolve(dbPath === ":memory:" ? "." : dirname(expandUserPath(dbPath)), ".mnemora-artifacts");
    const application = createInspectorApplication({ graph, allowOperations, artifactDirectory: root });
    running = await startInspector({ graph: application, allowOperations });
    console.log(JSON.stringify({ url: running.url, mode: allowOperations ? "operations" : "read-only" }));
    await new Promise<void>(resolveStop => { process.once("SIGINT", resolveStop); process.once("SIGTERM", resolveStop); });
  } finally { if (running) await running.close(); graph.close(); }
}

/** A path notice makes a first-use empty result distinguishable from the intended store. */
function databasePathCreated(path: string): string | undefined {
  if (path === ":memory:" || path.startsWith("file::memory:")) return undefined;
  const expanded = expandUserPath(path);
  return existsSync(expanded) ? undefined : expanded;
}

function reportInitializedDatabase(): void {
  if (initializedDatabasePath) console.error(`Mnemora initialized a new database at ${initializedDatabasePath}. Set MNEMORA_DB to select a different database.`);
}

function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function printOperator(command: string, result: unknown): void { console.log(JSON.stringify({ ok: true, command, result })); }
function fail(command: string, error: unknown): void { console.error(JSON.stringify({ ok: false, command, error: { code: error instanceof CliError ? error.code : "operation_failed" } })); process.exitCode = 1; }
function usage(): string { return "Usage: mnemora <ingest|search|related|stats|health|forget|inspect|surface|trust|profile|recall|governance|journal|retrieve|resume|evaluate|memory-impact|review|standalone|consolidation|cognition> [...]. Operator commands return structured JSON; use `resume <task query> --scope <scope>` or `resume --task-ref <mnemora-task-episode-ref> --scope <scope>` for a read-only, source-linked task continuation; `review gate --scope <scope>`, `review worklist --scope <scope> --status <pending|rejected|invalidated>`, `review vocabulary scan --scope <scope>`, `review vocabulary list --scope <scope> --status <pending|accepted|rejected>`, `review vocabulary preview <candidate_id> <accepted|rejected> --scope <scope>`, `review vocabulary confirm <candidate_id> <accepted|rejected> --scope <scope> --preview-hash <hash> --confirm`, `review anomalies preview <edge_id> --scope <scope>`, `review anomalies confirm <edge_id> --scope <scope> --preview-hash <hash> --confirm`, `journal compaction prepared`, `journal compaction reconcile <run_id> <rewrite_confirmed|rewrite_not_applied> --confirm`, `cognition status`, `cognition graduation status`, `cognition context compile <query>`, `cognition reflection preview`, `cognition feedback list`, `cognition decision list`, `cognition decision create <objective>`, `consolidation status`, `consolidation adopt preview <proposal_id>`, `consolidation adopt apply <proposal_id> --preview-hash <hash> --confirm`, `standalone guide`, `retrieve <query>`, `evaluate recall-quality <deidentified-golden.json>`, `evaluate task-resume-comparison <plan.json>`, or `memory-impact preview <event|artifact|episode|summary> <id>`. Reflection, feedback, consolidation adoption, vocabulary review, and anomaly cleanup require explicit confirmation; Decision creation also requires a preview hash."; }
