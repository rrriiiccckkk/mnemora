import type { Mnemora } from "../tools.js";
import { InspectorService } from "./service.js";
import { configuredScope } from "../scope.js";
import { normalizeInspectorRequest, normalizeOperationResult } from "./validation.js";
import { ArtifactRegistry } from "../operations/artifacts.js";
import { BackupService } from "../operations/backup.js";
import { RestoreService } from "../operations/restore.js";
import { SourceTrustService } from "../operations/source-trust.js";
import { MaintenanceService } from "../operations/maintenance.js";
import { TrustDashboardService } from "../trust/dashboard.js";
import { ConsolidationService } from "../consolidation/service.js";
import { PersonalMemoryInspectorService } from "../personal-memory/service.js";
import { MemoryIntelligenceService } from "../intelligence/service.js";
import type { OperationConfirmRequest, OperationPreviewRequest, OperationResult } from "../operations/types.js";
import type { InspectorGraphApi } from "./routes.js";

export interface InspectorApplication extends InspectorGraphApi {
  operationPreview?: (input: unknown) => Promise<OperationResult>;
  operationConfirm?: (input: unknown) => Promise<OperationResult>;
}

export function createInspectorApplication(options: { graph: Mnemora; allowOperations: boolean; artifactDirectory: string; now?: () => number; randomBytes?: (size: number) => Buffer }): InspectorApplication {
  const registry = new ArtifactRegistry(options.artifactDirectory, { create: options.allowOperations });
  const read = new InspectorService({ store: options.graph.store, analytics: options.graph.insights, trust: options.graph.sourceAnchors, now: options.now, scopeDefault: configuredScope(options.graph.config.scope?.default), recoveryHealth: () => registry.health() });
  const trust = new TrustDashboardService(options.graph.store.db, { scopeDefault: configuredScope(options.graph.config.scope?.default), adaptiveConfigured: options.graph.config.trustLayer?.recall?.canary?.enabled === true, governanceEnabled: options.graph.governance.active, now: options.now });
  const consolidation = new ConsolidationService(options.graph.store.db, options.now);
  const memory = new PersonalMemoryInspectorService(options.graph.store.db, options.now);
  const intelligence = new MemoryIntelligenceService(options.graph.store.db);
  const base: InspectorApplication = {
    overview: () => read.overview(), graph: input => read.graph(input), entity: input => read.entity(input), research: input => read.research(input), sources: input => read.sources(input), trust: input => trust.get(input), consolidation: input => { const scope = configuredScope(typeof input === "object" && input !== null && typeof (input as { scope?: unknown }).scope === "string" ? (input as { scope: string }).scope : options.graph.config.scope?.default); return { scope, ...consolidation.metrics(scope), proposals: consolidation.proposals(scope, undefined, 50) }; }, memory: input => memory.read({ ...(typeof input === "object" && input !== null ? input as Record<string, unknown> : {}), scope: typeof input === "object" && input !== null && typeof (input as { scope?: unknown }).scope === "string" ? (input as { scope: string }).scope : options.graph.config.scope?.default }), intelligence: input => intelligenceView(options.graph, intelligence, input), healthSummary: () => read.healthSummary(), capabilities: () => ({ operations: false })
  };
  if (!options.allowOperations) return base;
  const sourceTrust = new SourceTrustService({ store: options.graph.store, now: options.now, randomBytes: options.randomBytes });
  const backup = new BackupService({ store: options.graph.store, registry, now: options.now, randomBytes: options.randomBytes, portableConfig: options.graph.config });
  const restore = new RestoreService({ store: options.graph.store, registry, now: options.now, randomBytes: options.randomBytes });
  const maintenance = new MaintenanceService({ store: options.graph.store, now: options.now, randomBytes: options.randomBytes });
  const dispatch = async (input: unknown, phase: "preview" | "confirm"): Promise<OperationResult> => {
    const request = normalizeInspectorRequest(input);
    if (!("operation" in request) || request.phase !== phase) throw new Error("invalid inspector request");
    const result = phase === "preview" ? await preview(request as OperationPreviewRequest) : await confirm(request as OperationConfirmRequest);
    return normalizeOperationResult(result);
  };
  const preview = (request: OperationPreviewRequest) => {
    switch (request.operation) { case "source_trust": return sourceTrust.preview(request); case "backup": return backup.preview(request); case "restore": return restore.preview(request); default: return maintenance.preview(request); }
  };
  const confirm = (request: OperationConfirmRequest) => {
    switch (request.operation) { case "source_trust": return sourceTrust.confirm(request); case "backup": return backup.confirm(request); case "restore": return restore.confirm(request); default: return maintenance.confirm(request); }
  };
  return { ...base, capabilities: () => ({ operations: true, graph_revision: options.graph.store.graphRevision(), config_revision: options.graph.store.sourceTrustRevision() }), operationPreview: input => dispatch(input, "preview"), operationConfirm: input => dispatch(input, "confirm") };
}

function intelligenceView(graph: Mnemora, intelligence: MemoryIntelligenceService, input: unknown): unknown | Promise<unknown> {
  const value = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const scope = configuredScope(typeof value.scope === "string" ? value.scope : graph.config.scope?.default);
  if (value.view !== "retrieval") return intelligence.read({ ...value, scope });
  const query = typeof value.query === "string" ? value.query.trim().slice(0, 512) : "";
  if (!query) return { kind: "memory_intelligence", view: "retrieval", scope, items: [{ status: "query_required" }], truncated: false };
  /** Inspector traces are intentionally lexical-only: explainability must not create model/provider egress. */
  return graph.kg_recall_explain({ query, scope, max_nodes: 10, max_depth: 1, token_budget: 800, mode: "lexical" }).then(result => ({
    kind: "memory_intelligence", view: "retrieval", scope, query_hash: result.query_hash, automatic_recall_configured: result.automatic_recall_configured, strict_verification_enabled: result.strict_verification_enabled,
    policy: result.policy, candidates: result.candidates.map(item => ({ kind: item.kind, id: item.id, score: item.score ?? null, ranking: { lexical: item.score_components?.lexical ?? 0, semantic: item.score_components?.semantic ?? 0, trust: item.claims.length ? item.claims.some(claim => claim.eligible) ? 1 : 0 : null, scope: 1, freshness: item.score_components?.freshness ?? null }, decision: item.decision, reason: item.reason, pending_conflict: item.pending_conflict, claim_ids: item.claim_ids })),
    injected: { candidates_considered: result.candidates.length, nodes: result.candidates.filter(item => item.decision === "included").length, memories: result.memories.length, budget_tokens: 800 }, truncated: result.truncated, mode: "lexical"
  })).catch(() => ({ kind: "memory_intelligence", view: "retrieval", scope, items: [{ status: "unavailable" }], truncated: false }));
}
