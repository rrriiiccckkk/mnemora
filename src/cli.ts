#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Mnemora } from "./tools.js";
import { evaluateToolSurface } from "./openclaw.js";
import type { ToolSurface } from "./index.js";
import { resolveDatabasePath } from "./identity.js";
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
import { TaskOutcomeService, type OutcomeImpact, type OutcomeVerdict } from "./cognition/outcomes.js";
import { ReasoningMemoryService, type ReasoningMemoryKind } from "./cognition/reasoning.js";
import { ReasoningCurationService } from "./cognition/reasoning-curation.js";
import { ReasoningIntakeService } from "./cognition/reasoning-intake.js";
import { ReasoningRetrievalService } from "./cognition/reasoning-retrieval.js";
import { ReasoningReflectionService } from "./cognition/reasoning-reflection.js";
import { ReasoningAgentAdapterRegistry, ReasoningContextCompiler } from "./cognition/reasoning-adapters.js";
import { ReasoningRuntimeService } from "./cognition/reasoning-runtime.js";
import { ReasoningRuntimeTelemetryRepository } from "./cognition/reasoning-runtime-telemetry.js";
import { ReasoningRuntimeGovernanceRepository } from "./cognition/reasoning-runtime-governance.js";
import { ReasoningDeliveryFeedbackRepository } from "./cognition/reasoning-delivery-feedback.js";
import { ReasoningVerificationService } from "./cognition/reasoning-verification.js";
import { ReasoningDeliveryEffectivenessEvaluationService, validateReasoningDeliveryEffectivenessDataset } from "./cognition/reasoning-delivery-evaluation.js";
import { ReasoningMemoryEmbeddingRepository } from "./cognition/reasoning-semantic-embeddings.js";
import { createEmbedder } from "./embeddings.js";
import { RecallFeedbackRepository, ReflectionService, type RecallFeedbackKind } from "./cognition/reflection.js";
import { CognitionGraduationService } from "./cognition/graduation.js";
import { EvaluationRunner, serializeEvaluationReport, validateEvaluationDataset } from "./evaluation/index.js";
import { GraphReviewDecisionGate } from "./graph-review/decision-gate.js";

const [, , command, ...args] = process.argv;
const cliDirectory = process.cwd();
const dbPath = process.env.MNEMORA_DB ?? resolveDatabasePath(join(cliDirectory, "mnemora.db"));

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
  const graph = new Mnemora({ config: { dbPath } });
  try {
    if (command === "search") print(await graph.kg_search(args.join(" ")));
    else if (command === "related") { const [entity, ...rest] = args; print(graph.kg_related(entity, Number(process.env.DEPTH ?? 1), rest as RelationshipType[], process.env.DIRECTION as Direction | undefined)); }
    else if (command === "stats") print(graph.kg_stats());
    else if (command === "forget") print(await graph.kg_forget(args[0], process.env.HARD === "true", process.env.CONFIRM === "true"));
    else if (command === "ingest") { const text = args[0] ? readFileSync(args[0], "utf8") : readFileSync(0, "utf8"); print(await graph.kg_ingest(text, process.env.SOURCE ?? "manual")); }
    else if (command === "journal") printOperator(`journal.${args[0] ?? "help"}`, journalCommand(graph, args));
    else if (command === "retrieve") {
      const query = args.join(" ").trim(); if (!query) throw new CliError("invalid_arguments");
      const result = new UnifiedRetrievalService(graph.store.db, journalPolicy(graph.config))
        .find({ scope: process.env.SCOPE ?? "default", query, intent: retrievalIntent(process.env.INTENT), limit: Number(process.env.LIMIT ?? 8), tokenBudget: Number(process.env.TOKEN_BUDGET ?? 800) });
      printOperator("retrieve.find", result);
    }
    else if (command === "evaluate") printOperator("evaluate.recall-quality", await evaluateRecallQuality(graph, args));
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

/** Read-only operational review for memory that has not been attached since
 * its newest write. Lifecycle state changes still require kg_memory's
 * document-bound preview/confirm flow. */
function memoryCommand(graph: Mnemora, raw: string[]): unknown {
  const { positional, options } = parseOptions(raw), operation = positional.shift(), scope = option(options, "scope") ?? process.env.SCOPE ?? "default";
  if (operation !== "decay-review") throw new CliError("invalid_arguments");
  requireNone(positional);
  return graph.kg_memory({ operation: "recall_decay_review", scope, min_age_days: boundedRange(option(options, "min-age-days"), 1, 36500), limit: boundedLimit(option(options, "limit")) });
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
  if (family === "reasoning") {
    const operation = positional.shift(), scope = option(options, "scope") ?? process.env.SCOPE ?? "default", limit = boundedLimit(option(options, "limit")) ?? 20, service = new ReasoningMemoryService(graph.store.db);
    if (operation === "list") { requireNone(positional); const state = option(options, "state"); if (state && !["proposed", "admitted", "needs_review", "quarantined", "disabled", "retired"].includes(state)) throw new CliError("invalid_arguments"); return service.list(scope, state as never, limit); }
    if (operation === "summary") { requireNone(positional); return service.summary(scope); }
    if (operation === "find") { const query = positional.join(" ").trim(); if (!query) throw new CliError("invalid_arguments"); return service.find(scope, query, limit); }
    if (operation === "show") return service.get(requiredArgument(positional, "reasoning_memory_id"), scope) ?? { status: "not_found" };
    if (operation === "history") return service.history(requiredArgument(positional, "reasoning_memory_id"), scope, limit);
    if (operation === "conflicts") { requireNone(positional); return service.conflicts(scope, limit); }
    if (operation === "retrieve") { const query = positional.join(" ").trim(); if (!query) throw new CliError("invalid_arguments"); return new ReasoningRetrievalService(graph.store.db).find(reasoningRetrievalInput(scope, query, limit)); }
    if (operation === "compile") { const query = positional.join(" ").trim(); if (!query) throw new CliError("invalid_arguments"); const context = new ReasoningContextCompiler(graph.store.db).compile({ ...reasoningRetrievalInput(scope, query, limit), tokenBudget: boundedRange(option(options, "token-budget"), 64, 1600), maxItems: boundedRange(option(options, "max-items"), 1, 12) }); const adapters = new ReasoningAgentAdapterRegistry(); return adapters.render(option(options, "adapter") ?? "generic", context); }
    if (operation === "runtime") { const query = positional.join(" ").trim(); if (!query) throw new CliError("invalid_arguments"); return new ReasoningRuntimeService(graph.store.db).prepare({ ...reasoningRetrievalInput(scope, query, limit), tokenBudget: boundedRange(option(options, "token-budget"), 64, 1600), maxItems: boundedRange(option(options, "max-items"), 1, 12), failureSignal: process.env.MNEMORA_REASONING_FAILURE_SIGNAL === "1" }); }
    if (operation === "semantic-status") { requireNone(positional); const embeddings = normalizeConfig({ dbPath: ":memory:", embeddings: { ...graph.config.embeddings, enabled: process.env.MNEMORA_REASONING_SEMANTIC_EMBEDDINGS === "1" } }).embeddings!; return { configured: embeddings.enabled, index: new ReasoningMemoryEmbeddingRepository(graph.store.db).status(scope) }; }
    if (operation === "semantic-backfill") {
      requireNone(positional);
      const embeddings = normalizeConfig({ dbPath: ":memory:", embeddings: { ...graph.config.embeddings, enabled: process.env.MNEMORA_REASONING_SEMANTIC_EMBEDDINGS === "1" } }).embeddings!;
      if (!embeddings.enabled) return { status: "embedding_disabled", required_environment: "MNEMORA_REASONING_SEMANTIC_EMBEDDINGS=1" };
      if (options.confirm !== true) return { status: "confirm_required", operation: "cognition.reasoning.semantic-backfill" };
      return await new ReasoningMemoryEmbeddingRepository(graph.store.db).backfill({ scope, embedder: createEmbedder(embeddings as import("./index.js").EmbeddingConfig), maxInputChars: embeddings.maxInputChars!, batchSize: embeddings.batchSize!, limit, identity: { provider: embeddings.provider!, model: embeddings.model! }, signal: AbortSignal.timeout(embeddings.timeoutMs!) });
    }
    if (operation === "runtime-metrics") { requireNone(positional); return new ReasoningRuntimeTelemetryRepository(graph.store.db).metrics(scope, limit); }
    if (operation === "runtime-readiness") { requireNone(positional); const snapshot = new ReasoningRuntimeGovernanceRepository(graph.store.db).policySnapshot(scope), value = snapshot?.config.readiness ?? graph.config.cognition!.reasoningRuntime!.readiness!; return new ReasoningRuntimeTelemetryRepository(graph.store.db).readiness(scope, { minimumRuns: value.minimumRuns!, maxErrorRate: value.maxErrorRate!, maxEmptyRate: value.maxEmptyRate!, maxP95Ms: value.maxP95Ms! }); }
    if (operation === "runtime-diagnostics") { requireNone(positional); return new ReasoningRuntimeGovernanceRepository(graph.store.db).diagnostics(scope); }
    if (operation === "runtime-calibrate") { requireNone(positional); const governance = new ReasoningRuntimeGovernanceRepository(graph.store.db), snapshot = governance.policySnapshot(scope); if (!snapshot) return { status: "policy_not_observed" as const }; const preview = governance.previewCalibration(scope, snapshot.config); if (options.confirm !== true) return preview; return governance.confirmCalibration(scope, snapshot.config, option(options, "preview-hash") ?? ""); }
    if (operation === "runtime-canary-status") { requireNone(positional); const governance = new ReasoningRuntimeGovernanceRepository(graph.store.db), snapshot = governance.policySnapshot(scope); if (!snapshot) { const status = governance.status(scope); return { ...status, configured: false, active: false, reason: "policy_not_observed" }; } return governance.status(scope, snapshot.config); }
    if (operation === "runtime-canary-enable") { const calibrationId = requiredArgument(positional, "calibration_id"), governance = new ReasoningRuntimeGovernanceRepository(graph.store.db), snapshot = governance.policySnapshot(scope); if (!snapshot) return { status: "policy_not_observed" as const }; const preview = governance.enablePreview(scope, calibrationId, snapshot.config); if (options.confirm !== true) return preview; return governance.enable(scope, calibrationId, snapshot.config, option(options, "preview-hash") ?? ""); }
    if (operation === "runtime-rollback") { requireNone(positional); return confirmMutation(options.confirm === true, "cognition.reasoning.runtime-rollback", () => new ReasoningRuntimeGovernanceRepository(graph.store.db).rollback(scope)); }
    if (operation === "runtime-deliveries") { requireNone(positional); return new ReasoningRuntimeGovernanceRepository(graph.store.db).deliveries(scope, limit); }
    if (operation === "runtime-feedback") { const id = takeArgument(positional), feedback = takeArgument(positional); requireNone(positional); if (!["helpful", "neutral", "harmful"].includes(feedback)) throw new CliError("invalid_arguments"); const governance = new ReasoningRuntimeGovernanceRepository(graph.store.db), preview = governance.feedbackPreview(id, scope, feedback as "helpful" | "neutral" | "harmful"); if (options.confirm !== true) return preview; return governance.feedback(id, scope, feedback as "helpful" | "neutral" | "harmful", option(options, "preview-hash") ?? ""); }
    if (operation === "runtime-delivery-items") { requireNone(positional); return new ReasoningDeliveryFeedbackRepository(graph.store.db).items(scope, limit); }
    if (operation === "runtime-feedback-summary") { requireNone(positional); return new ReasoningDeliveryFeedbackRepository(graph.store.db).summary(scope); }
    if (operation === "runtime-verification-summary") { requireNone(positional); return new ReasoningVerificationService(graph.store.db).summary(scope); }
    if (operation === "runtime-verification-events") { requireNone(positional); return new ReasoningVerificationService(graph.store.db).events(scope, limit); }
    if (operation === "runtime-verification-run") { requireNone(positional); return confirmMutation(options.confirm === true, "cognition.reasoning.runtime-verification-run", () => new ReasoningVerificationService(graph.store.db).run({ scope, limit })); }
    if (operation === "runtime-verification-tool-result") {
      const itemRef = takeArgument(positional), tool = takeArgument(positional), result = takeArgument(positional), sourceRef = takeArgument(positional); requireNone(positional);
      if (result !== "success" && result !== "failure") throw new CliError("invalid_arguments");
      return confirmMutation(options.confirm === true, "cognition.reasoning.runtime-verification-tool-result", () => new ReasoningVerificationService(graph.store.db).recordToolResult({ scope, itemRef, tool, result, sourceRef }));
    }
    if (operation === "runtime-item-feedback") {
      const itemRef = takeArgument(positional), feedback = takeArgument(positional); requireNone(positional);
      if (!["helpful", "neutral", "harmful"].includes(feedback)) throw new CliError("invalid_arguments");
      const repository = new ReasoningDeliveryFeedbackRepository(graph.store.db), preview = repository.feedbackPreview(itemRef, scope, feedback as "helpful" | "neutral" | "harmful");
      if (options.confirm !== true) return preview;
      return repository.feedback(itemRef, scope, feedback as "helpful" | "neutral" | "harmful", option(options, "preview-hash") ?? "");
    }
    if (operation === "runtime-memory-circuit") { const memoryId = requiredArgument(positional, "reasoning_memory_id"); requireNone(positional); return new ReasoningDeliveryFeedbackRepository(graph.store.db).circuit(scope, memoryId) ?? { status: "not_found" }; }
    if (operation === "runtime-memory-circuit-reset") {
      const memoryId = requiredArgument(positional, "reasoning_memory_id"); requireNone(positional);
      const repository = new ReasoningDeliveryFeedbackRepository(graph.store.db), preview = repository.resetPreview(memoryId, scope);
      if (options.confirm !== true) return preview;
      return repository.reset(memoryId, scope, option(options, "preview-hash") ?? "");
    }
    if (operation === "runtime-effectiveness") {
      const datasetPath = requiredArgument(positional, "dataset_path"); requireNone(positional);
      return new ReasoningDeliveryEffectivenessEvaluationService().evaluate(validateReasoningDeliveryEffectivenessDataset(JSON.parse(readFileSync(resolve(datasetPath), "utf8"))));
    }
    if (operation === "reflection") {
      const action = takeArgument(positional); requireNone(positional); const reflections = new ReasoningReflectionService(graph.store.db);
      if (action === "proposals") return reflections.proposals(scope, limit);
      if (action === "metrics") return reflections.metrics(scope);
      if (action === "preview") return reflections.preview(scope);
      if (action === "run") { const preview = reflections.preview(scope); if (options.confirm !== true) return { status: "confirm_required", operation: "cognition.reasoning.reflection.run", preview_hash: preview.preview_hash }; if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash }; return reflections.run(scope, preview.preview_hash); }
      throw new CliError("invalid_arguments");
    }
    if (operation === "intake") {
      const action = takeArgument(positional), intake = new ReasoningIntakeService(graph.store.db);
      if (action === "candidates") { requireNone(positional); return intake.list(scope, limit); }
      if (action === "show") return intake.get(requiredArgument(positional, "candidate_id"), scope) ?? { status: "not_found" };
      if (action === "confirm") {
        const id = requiredArgument(positional, "candidate_id"); requireNone(positional); const preview = intake.confirmationPreview(id, scope);
        if (options.confirm !== true) return preview;
        if (preview.status !== "preview") return preview;
        if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
        return intake.confirm(id, scope, option(options, "preview-hash") ?? "");
      }
      if (action === "discard") {
        const id = requiredArgument(positional, "candidate_id"); requireNone(positional); const preview = intake.discardPreview(id, scope);
        if (options.confirm !== true) return preview;
        if (preview.status !== "preview") return preview;
        if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
        return intake.discard(id, scope, option(options, "preview-hash") ?? "");
      }
      throw new CliError("invalid_arguments");
    }
    if (operation === "curation") {
      const action = takeArgument(positional), curation = new ReasoningCurationService(graph.store.db);
      if (action === "formations") { requireNone(positional); return curation.formationProposals(scope, limit); }
      if (action === "reviews") { requireNone(positional); return curation.reviewProposals(scope, limit); }
      if (action === "runs") { requireNone(positional); return curation.runs(scope, limit); }
      if (action === "promote") {
        const id = requiredArgument(positional, "formation_proposal_id"); requireNone(positional); const preview = curation.promotionPreview(id, scope);
        if (options.confirm !== true) return preview;
        if (preview.status !== "preview") return preview;
        if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
        return curation.promote(id, scope, option(options, "preview-hash") ?? "");
      }
      if (action === "discard") {
        const id = requiredArgument(positional, "formation_proposal_id"); requireNone(positional); const preview = curation.discardPreview(id, scope);
        if (options.confirm !== true) return preview;
        if (preview.status !== "preview") return preview;
        if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
        return curation.discard(id, scope, option(options, "preview-hash") ?? "");
      }
      if (action === "resolve-review") {
        const id = requiredArgument(positional, "review_proposal_id"), decision = requiredArgument(positional, "retain|retire|dismiss"); requireNone(positional);
        if (decision !== "retain" && decision !== "retire" && decision !== "dismiss") throw new CliError("invalid_arguments");
        const preview = curation.reviewResolutionPreview(id, scope, decision);
        if (options.confirm !== true) return preview;
        if (preview.status !== "preview") return preview;
        if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
        return curation.resolveReview(id, scope, decision, option(options, "preview-hash") ?? "");
      }
      throw new CliError("invalid_arguments");
    }
    if (operation === "propose") {
      const strategy = positional.join(" ").trim(); if (!strategy) throw new CliError("invalid_arguments");
      const input = reasoningInput(scope, strategy), preview = service.preview(input);
      if (options.confirm !== true) return preview;
      if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
      return service.propose(input, preview.preview_hash);
    }
    if (operation === "link-outcome") {
      const id = takeArgument(positional), outcomeRef = takeArgument(positional); requireNone(positional); const preview = service.outcomeLinkPreview(id, scope, outcomeRef);
      if (options.confirm !== true) return preview;
      if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
      return service.linkOutcome(id, scope, outcomeRef, preview.preview_hash);
    }
    if (operation === "refresh-utility") {
      const id = requiredArgument(positional, "reasoning_memory_id"), preview = service.utilityPreview(id, scope);
      if (options.confirm !== true) return preview;
      if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
      return service.refreshUtility(id, scope, preview.preview_hash);
    }
    if (operation === "transition") {
      const id = takeArgument(positional), toState = takeArgument(positional); requireNone(positional); const input = reasoningTransitionInput(id, scope, toState), preview = service.transitionPreview(input);
      if (options.confirm !== true) return preview;
      if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
      return service.transition(input, preview.preview_hash);
    }
    if (operation === "rollback") {
      const id = requiredArgument(positional, "reasoning_memory_id"), preview = service.rollbackPreview(id, scope);
      if (options.confirm !== true) return preview;
      if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
      return service.rollback(id, scope, preview.preview_hash);
    }
    if (operation === "admit") {
      const id = requiredArgument(positional, "reasoning_memory_id"); requireNone(positional);
      const preview = service.admissionPreview(id, scope);
      if (options.confirm !== true) return preview;
      if (option(options, "preview-hash") !== preview.preview_hash) return { status: "preview_confirmation_required", preview_hash: preview.preview_hash };
      return service.admit(id, scope, preview.preview_hash);
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
  return { scope, taskRef, verdict: verdict as OutcomeVerdict, impact: impact as OutcomeImpact, confidence, summary: process.env.MNEMORA_OUTCOME_SUMMARY, evidenceRefs: refs, supersedesId: process.env.MNEMORA_OUTCOME_SUPERSEDES };
}

function reasoningInput(scope: string, strategy: string) {
  const list = (name: string): string[] => { const raw = process.env[name]; try { const parsed = raw ? JSON.parse(raw) : []; if (!Array.isArray(parsed) || parsed.some(value => typeof value !== "string")) throw new Error(); return parsed; } catch { throw new CliError("invalid_arguments"); } };
  const rawApplicability = process.env.MNEMORA_REASONING_APPLICABILITY;
  let applicability: Record<string, unknown> | undefined;
  try { if (rawApplicability) { const parsed = JSON.parse(rawApplicability); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); applicability = parsed as Record<string, unknown>; } } catch { throw new CliError("invalid_arguments"); }
  const kind = process.env.MNEMORA_REASONING_KIND ?? "strategy";
  if (!["strategy", "procedure", "failure_guard", "anti_pattern"].includes(kind)) throw new CliError("invalid_arguments");
  const rawConfidence = process.env.MNEMORA_REASONING_CONFIDENCE, confidence = rawConfidence === undefined ? undefined : Number(rawConfidence);
  if (confidence !== undefined && !Number.isFinite(confidence)) throw new CliError("invalid_arguments");
  return { scope, strategy, kind: kind as ReasoningMemoryKind, applicability, contraindications: list("MNEMORA_REASONING_CONTRAINDICATIONS"), sourceTaskRefs: list("MNEMORA_REASONING_TASKS"), outcomeRefs: list("MNEMORA_REASONING_OUTCOMES"), evidenceRefs: list("MNEMORA_REASONING_EVIDENCE"), confidence, supersedesId: process.env.MNEMORA_REASONING_SUPERSEDES };
}

function reasoningTransitionInput(id: string, scope: string, toState: string) {
  if (!["provisional", "admitted", "needs_review", "quarantined", "disabled", "retired"].includes(toState)) throw new CliError("invalid_arguments");
  const raw = process.env.MNEMORA_REASONING_TRANSITION_EVIDENCE;
  let evidenceRefs: string[] | undefined;
  try { if (raw !== undefined) { const parsed = JSON.parse(raw); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== "string")) throw new Error(); evidenceRefs = parsed; } } catch { throw new CliError("invalid_arguments"); }
  const reasonCode = process.env.MNEMORA_REASONING_TRANSITION_REASON ?? "operator_confirmed";
  return { id, scope, toState: toState as "provisional" | "admitted" | "needs_review" | "quarantined" | "disabled" | "retired", reasonCode, evidenceRefs };
}

function reasoningRetrievalInput(scope: string, query: string, limit: number) {
  const rawTools = process.env.MNEMORA_REASONING_AVAILABLE_TOOLS;
  let availableTools: string[] | undefined;
  try { if (rawTools !== undefined) { const parsed = JSON.parse(rawTools); if (!Array.isArray(parsed) || parsed.some(value => typeof value !== "string")) throw new Error(); availableTools = parsed; } } catch { throw new CliError("invalid_arguments"); }
  const riskLevel = process.env.MNEMORA_REASONING_RISK_LEVEL;
  if (riskLevel !== undefined && !["low", "medium", "high"].includes(riskLevel)) throw new CliError("invalid_arguments");
  return { scope, query, limit, taskType: process.env.MNEMORA_REASONING_TASK_TYPE, riskLevel: riskLevel as "low" | "medium" | "high" | undefined, environment: process.env.MNEMORA_REASONING_ENVIRONMENT, availableTools };
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
  const values = new Set(["scope", "limit", "preview-hash", "issued-by", "token-budget", "max-items", "historical-at", "stale-after-days", "min-age-days", "adapter", "status", "after-id"]);
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
class CliError extends Error { constructor(readonly code: "invalid_arguments") { super(code); } }

await main();

async function inspect(allowOperations: boolean): Promise<void> {
  const graph = new Mnemora({ config: { dbPath } }); let running: Awaited<ReturnType<typeof startInspector>> | undefined;
  try {
    const root = process.env.MNEMORA_ARTIFACTS ?? resolve(dbPath === ":memory:" ? "." : dirname(resolve(dbPath)), ".mnemora-artifacts");
    const application = createInspectorApplication({ graph, allowOperations, artifactDirectory: root });
    running = await startInspector({ graph: application, allowOperations });
    console.log(JSON.stringify({ url: running.url, mode: allowOperations ? "operations" : "read-only" }));
    await new Promise<void>(resolveStop => { process.once("SIGINT", resolveStop); process.once("SIGTERM", resolveStop); });
  } finally { if (running) await running.close(); graph.close(); }
}

function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function printOperator(command: string, result: unknown): void { console.log(JSON.stringify({ ok: true, command, result })); }
function fail(command: string, error: unknown): void { console.error(JSON.stringify({ ok: false, command, error: { code: error instanceof CliError ? error.code : "operation_failed" } })); process.exitCode = 1; }
function usage(): string { return "Usage: mnemora <ingest|search|related|stats|forget|inspect|surface|trust|profile|recall|governance|journal|retrieve|evaluate|memory-impact|review|standalone|consolidation|cognition> [...]. Operator commands return structured JSON; use `review gate --scope <scope>`, `review worklist --scope <scope> --status <pending|rejected|invalidated>`, `review anomalies preview <edge_id> --scope <scope>`, `review anomalies confirm <edge_id> --scope <scope> --preview-hash <hash> --confirm`, `journal compaction prepared`, `journal compaction reconcile <run_id> <rewrite_confirmed|rewrite_not_applied> --confirm`, `cognition status`, `cognition graduation status`, `cognition context compile <query>`, `cognition reflection preview`, `cognition feedback list`, `cognition decision list`, `cognition decision create <objective>`, `consolidation status`, `consolidation adopt preview <proposal_id>`, `consolidation adopt apply <proposal_id> --preview-hash <hash> --confirm`, `standalone guide`, `retrieve <query>`, `evaluate recall-quality <deidentified-golden.json>`, or `memory-impact preview <event|artifact|episode|summary> <id>`. Reflection, feedback, consolidation adoption, and anomaly cleanup require explicit confirmation; Decision creation also requires a preview hash."; }
