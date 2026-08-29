import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { relationshipDefinitions, effectiveDirection, isSemanticRelationship, isStructuralRelationship, semanticRelationshipTypes, semanticVocabularyRecommendation, structuralRelationshipTypes, type Direction, type RelationshipType } from "./relationships.js";
import { coreTablesV21Sql, edgeWeight, entityIdentityTriggerSql, nodeImportance, schemaSql, SUPPORTED_SCHEMA_VERSION } from "./schema.js";
import { retrospectiveAuditTableSql } from "./trust/schema.js";
import { profileOptionalRestoreTables, profileSchemaSql } from "./profiles/schema.js";
import { trustOptionalRestoreTables } from "./trust/schema.js";
import { integrationOptionalRestoreTables } from "./integrations/schema.js";
import { governanceOptionalRestoreTables } from "./governance/schema.js";
import { journalSchemaSql } from "./journal/schema.js";
import { contextEngineSchemaSql } from "./context-engine/schema.js";
import { artifactSchemaSql } from "./artifacts/schema.js";
import { episodeSchemaSql } from "./episodes/schema.js";
import { providerMigrationSchemaSql } from "./integrations/migration-schema.js";
import { consolidationOptionalRestoreTables, consolidationSchemaSql } from "./consolidation/schema.js";
import { cognitionBeliefSchemaSql, cognitionDecisionReviewSchemaSql, cognitionDecisionSchemaSql, cognitionEnforcementSchemaSql, cognitionIntegritySchemaSql, cognitionOptionalRestoreTables, cognitionOutcomeSchemaSql, cognitionPreAdmissionSchemaSql, cognitionReasoningCurationSchemaSql, cognitionReasoningDeliveryCorrectionSchemaSql, cognitionReasoningDeliveryFeedbackSchemaSql, cognitionReasoningGovernanceSchemaSql, cognitionReasoningIntakeSchemaSql, cognitionReasoningReflectionSchemaSql, cognitionReasoningRuntimeGovernanceSchemaSql, cognitionReasoningRuntimePolicySnapshotSchemaSql, cognitionReasoningRuntimeTelemetrySchemaSql, cognitionReasoningSchemaSql, cognitionReasoningSemanticSchemaSql, cognitionReasoningVerificationEventsSchemaSql, cognitionReflectionSchemaSql, cognitionSchemaSql } from "./cognition/schema.js";
import { identityHash, legacyNormalizeSlug, normalizeSlug } from "./slug.js";
import { cosineSimilarity, decodeEmbedding, encodeEmbedding, type EmbeddingIdentity } from "./embeddings.js";
import { duplicatePairKey, entityFingerprint, scoreDuplicatePair } from "./resolution.js";
import { relationshipMinimum, validateRelationship, type RelationshipQualityPolicy, type RelationshipSkipReason } from "./quality.js";
import { normalizeTemporalEvidence } from "./temporal.js";
import { canonicalizeIngestionSource } from "./ingestion.js";
import { detectConflictPairs, type ConflictFact } from "./conflicts.js";
import { PprUnavailableError, type PprArc } from "./ppr.js";
import { sourceDiversityScore } from "./ranking.js";
import { normalizeScope } from "./scope.js";
import { chunkMemoryDocument } from "./memory.js";
import { EntityRepository } from "./entities/repository.js";
import { renderContext } from "./context-renderer.js";
import { memoryMatchesTags } from "./retrieval/query-routing.js";
import { schemaDriftSchemaSql } from "./schema-drift/schema.js";
import { SchemaDriftRepository } from "./schema-drift/repository.js";
import { semanticOptionalRestoreTables, semanticSchemaSql } from "./semantics/schema.js";
import { SemanticPatternRepository } from "./semantics/repository.js";
import { recallLifecycleOptionalRestoreTables, recallLifecycleSchemaSql } from "./recall-lifecycle/schema.js";
import { corpusOptionalRestoreTables, corpusSchemaSql } from "./corpus/schema.js";
import { memoryLifecycleSchemaSql } from "./memory-lifecycle/schema.js";
import { unifiedRecallShadowSchemaSql } from "./retrieval/schema.js";
import { openMnemoraDatabase } from "./sqlite.js";
import type { AutoRunClaim, AutoRunFinishStatus, CommunitySummary, ConflictCandidate, ConflictCandidateStatus, DuplicateCandidate, DuplicateCandidateStatus, DuplicateScanResult, EvidenceSummary, ExtractedEntity, ExtractedRelation, InsightKind, KgContextResult, KgEdge, KgForgetResult, KgInsight, KgMemoryChunk, KgMemoryDocument, KgMemoryExpiryReview, KgMemoryLifecycleAudit, KgMemoryLifecycleConfirm, KgMemoryLifecyclePreview, KgMemorySearchResult, KgNode, KgObservation, KgRelatedResult, KgScopeSummary, KgSearchResult, KgSourceSummary, KgStatsResult, LegacyIdentityAuditResult, MemoryLifecycleAction, MergeResult, MergeUndoResult, NodeType, QualityCleanupResult, QualityEvidenceSummary, RankedNode, RelatedSemanticLabelResult, RelationshipAnomaly, SchemaDriftCandidate, SchemaDriftRepairResult, SchemaDriftScanResult, SemanticPatternCandidate, SemanticPatternReviewResult, StoredEmbedding } from "./types.js";
import type { GraphProjection, InsightSnapshot } from "./insights/types.js";
import type { QueryAuditPlanV1, QueryPlanV1 } from "./query/types.js";
import { normalizeQueryPlan } from "./query/validation.js";
import { watchPlanHash, type DigestClaim, type KgDigestResult, type KgWatch, type WatchScheduleHint } from "./query/watch.js";
import type { EntityDetailSection, GraphFilters } from "./inspector/types.js";

type NodeRow = Omit<KgNode, "aliases"> & { aliases: string };
type EdgeRow = Omit<KgEdge, "edge_props"> & { edge_props: string };
type CandidateRow = Omit<DuplicateCandidate, "signals" | "reasons"> & { signals: string; reasons: string };

const duplicateLookupTerms = (node: KgNode): string[] => [...new Set([node.name, ...node.aliases]
  .map(value => value.normalize("NFKC").trim().toLocaleLowerCase())
  .filter(Boolean))];

export interface IngestEntityResult { node: KgNode; observation: KgObservation }
export interface IngestRelationResult { edge: KgEdge; observation: KgObservation }
export interface SkippedRelation { relation: ExtractedRelation; reason: RelationshipSkipReason }
export interface IngestResult { entities: IngestEntityResult[]; relations: IngestRelationResult[]; observations: KgObservation[]; skipped_relations: SkippedRelation[]; skipped?: boolean }

export interface QueryGraphProjection {
  graphRevision: number;
  nodes: Array<{ id: string; name: string; type: NodeType; aliases: string[]; createdAt: number; updatedAt: number }>;
  edges: Array<{ id: string; source: string; target: string; type: RelationshipType; confidence: number; evidenceCount: number; sourceCount: number; firstSeenAt: number; lastSeenAt: number; validFrom: number | null; validTo: number | null }>;
  truncated: boolean;
}

export interface TimelineProjectionRow {
  timestamp: number; kind: "observed" | "became_valid" | "became_invalid";
  relationshipIds: string[]; observationIds: string[]; evidenceCount: number; sourceCount: number;
}

export interface QueryRunRecord {
  id: string; plan_hash: string; plan_metadata: QueryAuditPlanV1;
  scope: string;
  status: "succeeded" | "failed" | "truncated"; graph_revision: number; result_count: number;
  duration_ms: number; error_category?: string; created_at: number;
}
export interface NewQueryRunRecord extends Omit<QueryRunRecord, "id" | "plan_hash" | "plan_metadata" | "scope"> { id?: string; plan: QueryPlanV1; scope?: string; retention_days?: number }

export class GraphologyStore {
  db: DatabaseSyncInstance;
  readonly entities: EntityRepository;
  readonly schemaDrift: SchemaDriftRepository;
  readonly semanticPatterns: SemanticPatternRepository;
  private readonly location: string;
  private readonly inspectorSessionNonce = randomUUID();

  constructor(dbPath: string) {
    this.location = expandPath(dbPath);
    if (this.location !== ":memory:") mkdirSync(dirname(this.location), { recursive: true });
    this.db = openMnemoraDatabase(this.location);
    this.entities = new EntityRepository(this.db);
    this.schemaDrift = new SchemaDriftRepository(this.db);
    this.semanticPatterns = new SemanticPatternRepository(this.db);
    this.migrate();
  }

  close(): void { this.db.close(); }
  replaceDatabaseFrom(sourcePath: string): void {
    const attached = "restore_source";
    this.db.prepare(`ATTACH DATABASE ? AS ${attached}`).run(sourcePath);
    this.db.exec("PRAGMA foreign_keys=OFF");
    try {
      const sourceTables = new Set((this.db.prepare(`SELECT name FROM ${attached}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'kg_nodes_fts%' AND name NOT LIKE 'kg_memory_documents_fts%' AND name NOT LIKE 'kg_memory_chunks_fts%' AND name NOT LIKE 'mnemora_corpus_chunks_fts%'`).all() as Array<{ name: string }>).map(row => row.name));
      const targetTables = (this.db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'kg_nodes_fts%' AND name NOT LIKE 'kg_memory_documents_fts%' AND name NOT LIKE 'kg_memory_chunks_fts%' AND name NOT LIKE 'mnemora_corpus_chunks_fts%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
      const optionalNewTables = new Set(["kg_scopes", "kg_memory_documents", "kg_memory_chunks", "kg_memory_lifecycle_audits", "kg_memory_import_previews", "kg_memory_import_audits", "kg_entity_identities", "kg_schema_quarantine", ...semanticOptionalRestoreTables, ...trustOptionalRestoreTables, ...integrationOptionalRestoreTables, ...profileOptionalRestoreTables, ...governanceOptionalRestoreTables, ...consolidationOptionalRestoreTables, ...cognitionOptionalRestoreTables, ...recallLifecycleOptionalRestoreTables, ...corpusOptionalRestoreTables]);
      if (targetTables.some(name => !optionalNewTables.has(name) && !sourceTables.has(name))) throw new Error("incompatible_schema");
      this.db.exec("BEGIN IMMEDIATE");
      for (const name of targetTables) {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        this.db.exec(`DELETE FROM main.${quoted}`);
        if (!sourceTables.has(name)) continue;
        const sourceColumns = new Set((this.db.prepare(`PRAGMA ${attached}.table_info(${quoted})`).all() as Array<{ name: string }>).map(row => row.name));
        const targetColumns = (this.db.prepare(`PRAGMA main.table_info(${quoted})`).all() as Array<{ name: string }>).map(row => row.name);
        const columns = targetColumns.filter(column => sourceColumns.has(column));
        if (!columns.length) throw new Error("incompatible_schema");
        const names = columns.map(column => `"${column.replaceAll('"', '""')}"`).join(",");
        this.db.exec(`INSERT INTO main.${quoted}(${names}) SELECT ${names} FROM ${attached}.${quoted}`);
      }
      const now = Date.now();
      this.db.prepare("INSERT OR IGNORE INTO main.kg_scopes(id,created_at,updated_at) VALUES('default',?,?)").run(now, now);
      this.db.prepare("INSERT OR IGNORE INTO main.kg_scopes(id,created_at,updated_at) SELECT DISTINCT scope,?,? FROM main.kg_observations WHERE typeof(scope)='text' AND scope<>''").run(now, now);
      this.ensureMemoryChunks();
      this.entities.rebuild();
      this.db.exec("DELETE FROM main.kg_nodes_fts; INSERT INTO main.kg_nodes_fts(id,name,description,aliases) SELECT id,name,description,aliases FROM main.kg_nodes WHERE deleted_at IS NULL");
      this.db.exec("DELETE FROM main.kg_memory_documents_fts; INSERT INTO main.kg_memory_documents_fts(id,title,content) SELECT id,title,content FROM main.kg_memory_documents");
      this.db.exec("DELETE FROM main.kg_memory_chunks_fts; INSERT INTO main.kg_memory_chunks_fts(id,content) SELECT id,content FROM main.kg_memory_chunks");
      this.db.exec("DELETE FROM main.mnemora_corpus_chunks_fts; INSERT INTO main.mnemora_corpus_chunks_fts(id,content) SELECT id,content FROM main.mnemora_corpus_chunks");
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may not have begun */ }
      throw new Error("restore_failed");
    } finally { try { this.db.exec(`DETACH DATABASE ${attached}`); } finally { this.db.exec("PRAGMA foreign_keys=ON"); } }
  }
  createWatch(input: { id: string; name: string; plan: QueryPlanV1; scope: string; schedule_hint: WatchScheduleHint; enabled: boolean; now: number; maxWatches: number }): KgWatch {
    const plan = canonicalQueryPlan(normalizeQueryPlan(input.plan));
    const scope = normalizeScope(input.scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const count = Number((this.db.prepare("SELECT COUNT(*) AS count FROM kg_watches").get() as { count: number }).count);
      if (count >= Math.min(100, Math.max(1, Math.trunc(input.maxWatches)))) throw new Error("watch limit reached");
      this.db.prepare("INSERT INTO kg_watches(id,name,normalized_plan,plan_hash,scope,schedule_hint,cursor,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?,?)")
        .run(input.id, input.name, JSON.stringify(plan), watchPlanHash(plan), scope, input.schedule_hint, input.enabled ? 1 : 0, input.now, input.now);
      this.touchScope(scope);
      this.db.exec("COMMIT");
      return this.getWatch(input.id)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  getWatch(id: string): KgWatch | undefined {
    const row = this.db.prepare("SELECT * FROM kg_watches WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? mapWatch(row) : undefined;
  }
  resolveExactEntityId(input: string, scope?: string): string | undefined {
    return this.entities.resolveExact(input, scope);
  }
  listWatches(limit = 100, scope?: string): KgWatch[] {
    const bounded = Math.min(100, Math.max(0, Number.isFinite(limit) ? Math.trunc(limit) : 0));
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    return (this.db.prepare("SELECT * FROM kg_watches WHERE (? IS NULL OR scope=?) ORDER BY created_at,id LIMIT ?").all(normalizedScope ?? null, normalizedScope ?? null, bounded) as Array<Record<string, unknown>>).map(mapWatch);
  }
  updateWatch(id: string, input: { name: string; plan: QueryPlanV1; scope: string; schedule_hint: WatchScheduleHint; enabled: boolean; now: number }): KgWatch {
    const plan = canonicalQueryPlan(normalizeQueryPlan(input.plan));
    const scope = normalizeScope(input.scope);
    const changed = this.db.prepare("UPDATE kg_watches SET name=?,normalized_plan=?,plan_hash=?,scope=?,schedule_hint=?,enabled=?,updated_at=? WHERE id=?")
      .run(input.name, JSON.stringify(plan), watchPlanHash(plan), scope, input.schedule_hint, input.enabled ? 1 : 0, input.now, id);
    if (Number(changed.changes) !== 1) throw new Error("watch not found");
    this.touchScope(scope);
    return this.getWatch(id)!;
  }
  removeWatch(id: string): boolean { return Number(this.db.prepare("DELETE FROM kg_watches WHERE id=?").run(id).changes) === 1; }
  selectDigestWatches(ids: string[] | undefined, limit: number, scope?: string): KgWatch[] {
    const bounded = Math.min(25, Math.max(1, Math.trunc(limit)));
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    if (ids) return ids.map(id => this.getWatch(id)).filter((x): x is KgWatch => x != null && x.enabled && (!normalizedScope || x.scope === normalizedScope)).slice(0, bounded);
    return (this.db.prepare("SELECT * FROM kg_watches WHERE enabled=1 AND (? IS NULL OR scope=?) ORDER BY id LIMIT ?").all(normalizedScope ?? null, normalizedScope ?? null, bounded) as Array<Record<string, unknown>>).map(mapWatch);
  }
  claimDigest(idempotencyKey: string, watchIds: string[], scope: string, now: number, staleAfterMs: number): DigestClaim {
    const normalizedScope = normalizeScope(scope);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT status,summary,started_at,watch_ids,scope FROM kg_digest_runs WHERE idempotency_key=?").get(idempotencyKey) as { status: string; summary: string | null; started_at: number; watch_ids: string; scope: string } | undefined;
      if (!row) this.db.prepare("INSERT INTO kg_digest_runs(idempotency_key,status,scope,watch_ids,started_at) VALUES(?,'running',?,?,?)").run(idempotencyKey, normalizedScope, JSON.stringify(watchIds), now);
      else if (row.scope !== normalizedScope) throw new Error("idempotency_key belongs to another scope");
      else if (row.status === "succeeded" && row.summary) { const result = JSON.parse(row.summary) as KgDigestResult; this.db.exec("COMMIT"); return { status: "succeeded", result }; }
      else if (row.status === "running" && now - Number(row.started_at) < staleAfterMs) { this.db.exec("COMMIT"); return { status: "running", startedAt: Number(row.started_at), watchIds: JSON.parse(row.watch_ids) as string[] }; }
      else this.db.prepare("UPDATE kg_digest_runs SET status='running',watch_ids=?,cursor_updates='{}',summary=NULL,started_at=?,finished_at=NULL WHERE idempotency_key=?").run(JSON.stringify(watchIds), now, idempotencyKey);
      this.db.exec("COMMIT"); return { status: "claimed", startedAt: now, watchIds };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  finishDigest(idempotencyKey: string, startedAt: number, result: KgDigestResult, cursorUpdates: Record<string, number>): KgDigestResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT status,started_at,summary,watch_ids FROM kg_digest_runs WHERE idempotency_key=?").get(idempotencyKey) as { status: string; started_at: number; summary: string | null; watch_ids: string } | undefined;
      if (!current || current.status !== "running" || Number(current.started_at) !== startedAt) { this.db.exec("COMMIT"); if (current?.status === "succeeded" && current.summary) return JSON.parse(current.summary) as KgDigestResult; let selectedCount = 0; try { const ids = JSON.parse(current?.watch_ids ?? "[]"); selectedCount = Array.isArray(ids) ? ids.length : 0; } catch { /* bounded empty state */ } return { idempotency_key: idempotencyKey, status: "running", started_at: Number(current?.started_at ?? startedAt), selected_count: selectedCount, succeeded_count: 0, failed_count: 0, watches: [], warnings: [{ category: "already_running" }] }; }
      for (const [id, cursor] of Object.entries(cursorUpdates)) this.db.prepare("UPDATE kg_watches SET cursor=?,updated_at=MAX(updated_at,?) WHERE id=?").run(String(cursor), cursor, id);
      this.db.prepare("UPDATE kg_digest_runs SET status='succeeded',cursor_updates=?,summary=?,finished_at=? WHERE idempotency_key=? AND status='running' AND started_at=?")
        .run(JSON.stringify(cursorUpdates), JSON.stringify(result), result.finished_at ?? startedAt, idempotencyKey, startedAt);
      this.db.exec("COMMIT"); return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  recordQueryRun(record: NewQueryRunRecord): void {
    const createdAt = Number.isFinite(record.created_at) ? Math.trunc(record.created_at) : Date.now();
    const scope = normalizeScope(record.scope ?? "default");
    const plan = canonicalQueryPlan(normalizeQueryPlan(record.plan));
    const canonical = JSON.stringify(plan);
    const hash = createHash("sha256").update(canonical).digest("hex");
    const serialized = JSON.stringify(safeAuditQueryPlan(plan));
    this.db.prepare(`INSERT INTO kg_query_runs(id,plan_hash,normalized_plan,scope,status,graph_revision,result_count,duration_ms,error_category,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(record.id ?? `query:${randomUUID()}`, hash, serialized, scope, record.status, nonNegativeInteger(record.graph_revision), nonNegativeInteger(record.result_count), nonNegativeInteger(record.duration_ms), record.error_category ?? null, createdAt);
    this.maintainQueryRuns(createdAt, record.retention_days ?? 30);
  }

  listQueryRuns(limit: number, scope?: string): QueryRunRecord[] {
    const bounded = Number.isFinite(limit) ? Math.min(1000, Math.max(0, Math.trunc(limit))) : 0;
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const rows = this.db.prepare("SELECT * FROM kg_query_runs WHERE (? IS NULL OR scope=?) ORDER BY created_at DESC,id DESC LIMIT ?").all(normalizedScope ?? null, normalizedScope ?? null, bounded) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: String(row.id), plan_hash: String(row.plan_hash), plan_metadata: JSON.parse(String(row.normalized_plan)) as QueryAuditPlanV1, scope: normalizeScope(row.scope, "default"), status: row.status as QueryRunRecord["status"], graph_revision: Number(row.graph_revision), result_count: Number(row.result_count), duration_ms: Number(row.duration_ms), ...(typeof row.error_category === "string" ? { error_category: row.error_category } : {}), created_at: Number(row.created_at) }));
  }

  private maintainQueryRuns(now: number, retentionDays: number): void {
    const retention = Number.isFinite(retentionDays) ? Math.min(3650, Math.max(1, Math.trunc(retentionDays))) : 30;
    const state = this.db.prepare("SELECT value FROM kg_maintenance_state WHERE key='query_audit_maintained_at'").get() as { value: string } | undefined;
    const previous = Number(state?.value ?? 0);
    if (Number.isFinite(previous) && now - previous < 86400000) return;
    const cutoff = now - retention * 86400000;
    this.db.prepare("DELETE FROM kg_query_runs WHERE id IN (SELECT id FROM kg_query_runs WHERE created_at < ? ORDER BY created_at LIMIT 1000)").run(cutoff);
    this.db.prepare("INSERT INTO kg_maintenance_state(key,value,updated_at) VALUES('query_audit_maintained_at',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(String(now), now);
  }
  graphRevision(): number {
    const row = this.db.prepare("SELECT value FROM kg_graph_state WHERE key='content_revision'").get() as { value: number } | undefined;
    return Number(row?.value ?? 0);
  }

  bumpGraphRevision(): void {
    this.db.prepare("UPDATE kg_graph_state SET value=value+1,updated_at=? WHERE key='content_revision'").run(Date.now());
  }

  runGraphImportTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.bumpGraphRevision();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readInsightSnapshot(key: string, scope = "default"): InsightSnapshot | undefined {
    const row = this.db.prepare("SELECT snapshot FROM kg_insight_snapshots WHERE cache_key=? AND scope=?").get(key, normalizeScope(scope)) as { snapshot: string } | undefined;
    if (!row) return undefined;
    try {
      return canonicalizeInsightSnapshot(JSON.parse(row.snapshot));
    } catch {
      return undefined;
    }
  }

  writeInsightSnapshot(key: string, snapshot: InsightSnapshot, scope = "default"): void {
    const deterministicSnapshot = canonicalizeInsightSnapshot(snapshot);
    if (!deterministicSnapshot) throw new Error("invalid insight snapshot");
    const { graphRevision, algorithmVersion, createdAt } = deterministicSnapshot;
    if (!Number.isSafeInteger(graphRevision) || graphRevision < 0 || !algorithmVersion || !Number.isFinite(createdAt)) throw new Error("invalid insight snapshot");
    this.db.prepare(`INSERT INTO kg_insight_snapshots(cache_key,scope,graph_revision,algorithm_version,snapshot,created_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET scope=excluded.scope,graph_revision=excluded.graph_revision,algorithm_version=excluded.algorithm_version,snapshot=excluded.snapshot,created_at=excluded.created_at`)
      .run(key, normalizeScope(scope), graphRevision, algorithmVersion, JSON.stringify(deterministicSnapshot), createdAt);
  }

  migrate(): void {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version?: number })?.user_version ?? 0);
    if (!Number.isSafeInteger(version) || version < 0 || version > SUPPORTED_SCHEMA_VERSION) throw new Error("unsupported_schema");
    this.db.exec(schemaSql);
    const now = Date.now();
    this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES('default',?,?)").run(now, now);
    const columns = new Set((this.db.prepare("PRAGMA table_info(kg_nodes)").all() as Array<{ name: string }>).map((row) => row.name));
    const additions: Array<[string, string]> = [
      ["embedding", "BLOB"],
      ["embedding_provider", "TEXT"], ["embedding_model", "TEXT"],
      ["embedding_dimensions", "INTEGER"], ["embedding_input_version", "TEXT"],
      ["embedded_at", "INTEGER"]
    ];
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE kg_nodes ADD COLUMN ${name} ${type}`);
    }
    const observationColumns = new Set((this.db.prepare("PRAGMA table_info(kg_observations)").all() as Array<{ name: string }>).map((row) => row.name));
    for (const [name, type] of [["valid_from", "INTEGER"], ["valid_to", "INTEGER"], ["temporal_confidence", "REAL"], ["scope", "TEXT NOT NULL DEFAULT 'default'"]] as const) {
      if (!observationColumns.has(name)) this.db.exec(`ALTER TABLE kg_observations ADD COLUMN ${name} ${type}`);
    }
    this.db.exec("UPDATE kg_observations SET scope='default' WHERE scope IS NULL OR scope=''");
    this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) SELECT DISTINCT scope,?,? FROM kg_observations WHERE typeof(scope)='text' AND scope<>''").run(now, now);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_observations_scope_subject ON kg_observations(scope,source_entity_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_observations_scope_edge ON kg_observations(scope,edge_id)");
    const ingestionColumns = new Set((this.db.prepare("PRAGMA table_info(kg_ingestion_records)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!ingestionColumns.has("input_fingerprint")) {
      this.db.exec("ALTER TABLE kg_ingestion_records ADD COLUMN input_fingerprint TEXT");
      this.db.exec("UPDATE kg_ingestion_records SET input_fingerprint=fingerprint WHERE input_fingerprint IS NULL");
    }
    if (!ingestionColumns.has("scope")) this.db.exec("ALTER TABLE kg_ingestion_records ADD COLUMN scope TEXT NOT NULL DEFAULT 'default'");
    this.db.exec("UPDATE kg_ingestion_records SET scope='default' WHERE scope IS NULL OR scope=''");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_ingestion_records_input ON kg_ingestion_records(input_fingerprint,status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_ingestion_records_scope_input ON kg_ingestion_records(scope,input_fingerprint,status)");
    for (const table of ["kg_insight_snapshots", "kg_query_runs", "kg_watches", "kg_digest_runs"] as const) {
      const columnsForTable = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
      if (!columnsForTable.has("scope")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN scope TEXT NOT NULL DEFAULT 'default'`);
      this.db.exec(`UPDATE ${table} SET scope='default' WHERE scope IS NULL OR scope=''`);
    }
    this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) SELECT DISTINCT scope,?,? FROM kg_watches WHERE typeof(scope)='text' AND scope<>''").run(now, now);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_insight_snapshots_scope_created ON kg_insight_snapshots(scope,created_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_query_runs_scope_created ON kg_query_runs(scope,created_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_watches_scope_created ON kg_watches(scope,created_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_digest_runs_scope_started ON kg_digest_runs(scope,started_at DESC)");
    const memoryColumns = new Set((this.db.prepare("PRAGMA table_info(kg_memory_documents)").all() as Array<{ name: string }>).map(row => row.name));
    if (!memoryColumns.has("lifecycle_state")) this.db.exec("ALTER TABLE kg_memory_documents ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'");
    if (!memoryColumns.has("archived_at")) this.db.exec("ALTER TABLE kg_memory_documents ADD COLUMN archived_at INTEGER");
    this.db.exec("UPDATE kg_memory_documents SET lifecycle_state='active' WHERE lifecycle_state IS NULL OR lifecycle_state NOT IN ('active','archived')");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_memory_documents_scope_lifecycle_updated ON kg_memory_documents(scope,lifecycle_state,updated_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_memory_lifecycle_audits_scope_created ON kg_memory_lifecycle_audits(scope,created_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_memory_import_audits_scope_created ON kg_memory_import_audits(scope,created_at DESC)");
    this.ensureMemoryChunks();
    if (version < 21) this.rebuildCoreTablesV21();
    if (version < 19 && this.ftsTokenizersNeedMigration()) this.rebuildFtsIndexesForTrigram();
    if (version < 21) this.entities.rebuild();
    if (version < 24) this.migrateTrustReliabilityV24();
    if (version < 25) this.migrateProfileHistoryV25();
    if (version < 27) this.migrateScopedConflictCandidatesV27();
    if (version < 28) this.migrateConversationJournalV28();
    if (version < 29) this.migrateContextEngineAndArtifactsV29();
    if (version < 30) this.migrateEpisodesV30();
    if (version < 31) this.migrateProviderAuditV31();
    if (version < 32) this.migrateConsolidationV32();
    if (version < 33) this.db.exec(cognitionSchemaSql);
    if (version < 34) this.db.exec(cognitionEnforcementSchemaSql);
    if (version < 35) this.db.exec(cognitionBeliefSchemaSql);
    if (version < 36) this.migrateContextInjectionSafetyV36();
    if (version < 37) this.db.exec(cognitionDecisionSchemaSql);
    if (version < 38) this.migrateCognitionIntegrityV38();
    if (version < 39) this.db.exec(cognitionReflectionSchemaSql);
    if (version < 40) this.db.exec(cognitionDecisionReviewSchemaSql);
    if (version < 41) this.db.exec(cognitionOutcomeSchemaSql);
    if (version < 42) this.db.exec(cognitionReasoningSchemaSql);
    if (version < 43) this.migrateReasoningGovernanceV43();
    if (version < 44) this.db.exec(cognitionReasoningReflectionSchemaSql);
    if (version < 45) this.db.exec(cognitionReasoningRuntimeTelemetrySchemaSql);
    if (version < 46) this.db.exec(cognitionReasoningRuntimeGovernanceSchemaSql);
    if (version < 47) this.db.exec(journalSchemaSql);
    if (version < 48) this.migrateNodeImportanceV48();
    if (version < 49) this.migrateBoundedCompactionV49();
    if (version < 50) this.migrateReplayFloodGuardsV50();
    if (version < 51) this.migrateReplayFloodCleanupV51();
    if (version < 52) this.migrateSchemaDriftV52();
    if (version < 53) this.migratePreAdmissionV53();
    if (version < 54) this.migratePublicMigrationMetadataV54();
    if (version < 55) this.migrateSchemaDriftRepairsV55();
    if (version < 56) this.migrateLegacySchemaDriftV56();
    if (version < 57) this.migrateRecallLifecycleV57();
    if (version < 58) this.migrateConsolidationAdoptionsV58();
    if (version < 59) this.migrateSemanticBoundaryV59();
    if (version < 60) this.migrateCanonicalCorpusV60();
    if (version < 61) this.migrateMemoryLifecycleV61();
    if (version < 62) this.migrateReasoningDeliveryFeedbackV62();
    if (version < 63) this.migrateReasoningSemanticV63();
    if (version < 64) this.migrateReasoningDeliveryCorrectionsV64();
    if (version < 65) this.migrateReasoningVerificationV65();
    if (version < 66) this.migrateReasoningVerificationEventsV66();
    if (version < 67) this.migrateReasoningVerificationExpiryV67();
    if (version < 68) this.migrateReasoningCurationV68();
    if (version < 69) this.migrateReasoningIntakeV69();
    if (version < 70) this.migrateReasoningRuntimePolicySnapshotV70();
    if (version < 71) this.migrateUnifiedRecallShadowV71();
    this.repairCanonicalCorpusFts();
    this.db.exec(`PRAGMA user_version=${SUPPORTED_SCHEMA_VERSION}`);
  }

  /** The corpus FTS table is a fully derived local index. A completed schema
   * version cannot prove that a prior trigram rebuild was not interrupted, so
   * repair only this cache from immutable corpus chunks at startup. */
  private repairCanonicalCorpusFts(): void {
    let rebuild = this.db.prepare("SELECT COUNT(*) AS value FROM pragma_table_list WHERE name=?").get("mnemora_corpus_chunks_fts") as { value?: unknown } | undefined;
    if (Number(rebuild?.value) === 1) {
      try {
        const drift = this.db.prepare(`SELECT
          (SELECT COUNT(*) FROM mnemora_corpus_chunks) AS chunks,
          (SELECT COUNT(*) FROM mnemora_corpus_chunks_fts) AS indexed,
          EXISTS(SELECT 1 FROM mnemora_corpus_chunks c LEFT JOIN mnemora_corpus_chunks_fts f ON f.id=c.id WHERE f.id IS NULL) AS missing,
          EXISTS(SELECT 1 FROM mnemora_corpus_chunks_fts f LEFT JOIN mnemora_corpus_chunks c ON c.id=f.id WHERE c.id IS NULL) AS stale,
          EXISTS(SELECT 1 FROM mnemora_corpus_chunks c JOIN mnemora_corpus_chunks_fts f ON f.id=c.id WHERE f.content<>c.content) AS changed`).get() as { chunks?: unknown; indexed?: unknown; missing?: unknown; stale?: unknown; changed?: unknown } | undefined;
        rebuild = Number(drift?.chunks) !== Number(drift?.indexed) || Number(drift?.missing) === 1 || Number(drift?.stale) === 1 || Number(drift?.changed) === 1 ? { value: 0 } : { value: 1 };
      } catch { rebuild = { value: 0 }; }
    }
    if (Number(rebuild?.value) === 1) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(corpusSchemaSql);
      this.db.exec("DELETE FROM mnemora_corpus_chunks_fts");
      this.db.exec("INSERT INTO mnemora_corpus_chunks_fts(id,content) SELECT id,content FROM mnemora_corpus_chunks");
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  /** Schema v61 adds a non-destructive lifecycle overlay for memory documents.
   * Existing documents are preserved byte-for-byte and begin at `working`;
   * no row is archived, promoted, or assigned an expiry during migration. */
  private migrateMemoryLifecycleV61(): void {
    const now = Date.now();
    this.db.exec(memoryLifecycleSchemaSql);
    this.db.prepare(`INSERT OR IGNORE INTO mnemora_memory_document_lifecycle(document_id,scope,tier,access_count,updated_at)
      SELECT id,scope,'working',0,? FROM kg_memory_documents`).run(now);
  }

  /** Schema v62 adds delivery provenance and suppression controls without
   * modifying strategy records, personal memory, graph evidence, or outcomes. */
  private migrateReasoningDeliveryFeedbackV62(): void { this.db.exec(cognitionReasoningDeliveryFeedbackSchemaSql); }

  /** Schema v63 is additive: it adds only aggregate shadow diagnostics and a
   * separate local semantic index. Existing strategy, evidence, and outcome
   * rows are intentionally left untouched. */
  private migrateReasoningSemanticV63(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(mnemora_reasoning_runtime_shadow_runs)").all() as Array<{ name: string }>).map(row => row.name));
    for (const [name, type] of [["semantic_candidates", "INTEGER NOT NULL DEFAULT 0"], ["unmatched", "INTEGER NOT NULL DEFAULT 0"], ["task_type_excluded", "INTEGER NOT NULL DEFAULT 0"]] as const) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE mnemora_reasoning_runtime_shadow_runs ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(cognitionReasoningSemanticSchemaSql);
  }

  /** Schema v64 adds append-only item corrections and a pointer to the exact
   * feedback event they supersede. Historic feedback and strategy state stay
   * untouched. */
  private migrateReasoningDeliveryCorrectionsV64(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(mnemora_reasoning_runtime_delivery_items)").all() as Array<{ name: string }>).map(row => row.name));
    if (!columns.has("last_feedback_event_id")) this.db.exec("ALTER TABLE mnemora_reasoning_runtime_delivery_items ADD COLUMN last_feedback_event_id TEXT");
    this.db.exec(cognitionReasoningDeliveryCorrectionSchemaSql);
    this.db.exec(`UPDATE mnemora_reasoning_runtime_delivery_items AS item SET last_feedback_event_id=(
      SELECT event.id FROM mnemora_reasoning_runtime_delivery_feedback_events AS event
      WHERE event.delivery_item_id=item.id AND event.effect IN ('helpful','neutral','harmful')
      ORDER BY event.created_at DESC,event.id DESC LIMIT 1
    ) WHERE last_feedback_event_id IS NULL`);
  }

  /** Schema v65 adds optional, bounded verifier contracts. It never derives a
   * verification result, modifies a strategy, or changes retrieval behavior. */
  private migrateReasoningVerificationV65(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(mnemora_reasoning_memories)").all() as Array<{ name: string }>).map(row => row.name));
    if (!columns.has("verification_json")) this.db.exec("ALTER TABLE mnemora_reasoning_memories ADD COLUMN verification_json TEXT CHECK(verification_json IS NULL OR (json_valid(verification_json) AND length(verification_json)<=4096))");
  }

  /** Schema v66 adds append-only deterministic verification events. The only
   * table rebuild widens a local circuit reason enum; all existing circuit
   * rows retain their exact state and timestamps. */
  private migrateReasoningVerificationEventsV66(): void {
    const circuit = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_memory_delivery_circuits'").get() as { sql?: unknown } | undefined;
    if (!String(circuit?.sql ?? "").includes("verification_mismatch")) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // SQLite keeps a named index attached to the renamed old table. Drop
        // it first so the replacement index is created for the new table.
        this.db.exec("DROP INDEX IF EXISTS idx_mnemora_reasoning_memory_circuits_scope_open");
        this.db.exec("ALTER TABLE mnemora_reasoning_memory_delivery_circuits RENAME TO mnemora_reasoning_memory_delivery_circuits_v65");
        this.db.exec(`CREATE TABLE mnemora_reasoning_memory_delivery_circuits (
          scope TEXT NOT NULL,memory_id TEXT NOT NULL REFERENCES mnemora_reasoning_memories(id) ON DELETE CASCADE,
          circuit_open INTEGER NOT NULL CHECK(circuit_open IN (0,1)),
          reason_code TEXT NOT NULL CHECK(reason_code IN ('harmful_delivery_feedback','harmful_task_outcome','verification_mismatch','operator_reset')),
          opened_at INTEGER,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,memory_id)
        )`);
        this.db.exec("INSERT INTO mnemora_reasoning_memory_delivery_circuits(scope,memory_id,circuit_open,reason_code,opened_at,updated_at) SELECT scope,memory_id,circuit_open,reason_code,opened_at,updated_at FROM mnemora_reasoning_memory_delivery_circuits_v65");
        this.db.exec("DROP TABLE mnemora_reasoning_memory_delivery_circuits_v65");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_memory_circuits_scope_open ON mnemora_reasoning_memory_delivery_circuits(scope,circuit_open,updated_at DESC)");
        this.db.exec("COMMIT");
      } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    }
    this.db.exec(cognitionReasoningVerificationEventsSchemaSql);
  }

  /** Schema v67 makes receipt expiry a terminal verification state. A pending
   * assertion can never open a circuit after the receipt that authorized it
   * has expired. Existing event values and timestamps are copied unchanged. */
  private migrateReasoningVerificationExpiryV67(): void {
    const event = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mnemora_reasoning_runtime_verification_events'").get() as { sql?: unknown } | undefined;
    if (String(event?.sql ?? "").includes("'expired'")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DROP INDEX IF EXISTS idx_mnemora_reasoning_verification_scope_status");
      this.db.exec("DROP INDEX IF EXISTS idx_mnemora_reasoning_verification_scope_memory");
      this.db.exec("ALTER TABLE mnemora_reasoning_runtime_verification_events RENAME TO mnemora_reasoning_runtime_verification_events_v66");
      this.db.exec(cognitionReasoningVerificationEventsSchemaSql);
      this.db.exec(`INSERT INTO mnemora_reasoning_runtime_verification_events(id,scope,delivery_item_id,memory_id,assertion_kind,assertion_ordinal,assertion_key,expected_value,observed_value,verdict,source_kind,source_ref,status,created_at,processed_at)
        SELECT id,scope,delivery_item_id,memory_id,assertion_kind,assertion_ordinal,assertion_key,expected_value,observed_value,verdict,source_kind,source_ref,status,created_at,processed_at
        FROM mnemora_reasoning_runtime_verification_events_v66`);
      this.db.exec("DROP TABLE mnemora_reasoning_runtime_verification_events_v66");
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  /** Schema v68 is additive review work only. It cannot create or alter a
   * strategy during migration, and it does not backfill model proposals. */
  private migrateReasoningCurationV68(): void { this.db.exec(cognitionReasoningCurationSchemaSql); }
  private migrateReasoningIntakeV69(): void { this.db.exec(cognitionReasoningIntakeSchemaSql); }
  private migrateReasoningRuntimePolicySnapshotV70(): void { this.db.exec(cognitionReasoningRuntimePolicySnapshotSchemaSql); }
  /** Schema v71 adds only redacted automatic-recall decision telemetry. */
  private migrateUnifiedRecallShadowV71(): void { this.db.exec(unifiedRecallShadowSchemaSql); }

  /** Schema v58 only adds durable receipts for explicitly confirmed consolidation
   * lifecycle actions. Existing evidence, episodes, and proposals are not
   * rewritten during migration. */
  private migrateConsolidationAdoptionsV58(): void { this.db.exec(consolidationSchemaSql); }

  /** Schema v59 records only aggregate vocabulary-review candidates. Existing
   * nodes, edges, observations, weights, scopes, and source evidence stay
   * byte-for-byte intact; historic semantic edges are projected at read time. */
  private migrateSemanticBoundaryV59(): void { this.db.exec(semanticSchemaSql); }

  /** Schema v60 adds an isolated, source-citable canonical corpus cache. */
  private migrateCanonicalCorpusV60(): void { this.db.exec(corpusSchemaSql); }

  /** Schema v57 adds aggregate-only actual-injection usage. Existing memory rows,
   * content, lifecycle state, and truth confidence are intentionally untouched. */
  private migrateRecallLifecycleV57(): void { this.db.exec(recallLifecycleSchemaSql); }

  /** Schema v48 recomputes the derived importance projection from evidence quality,
   * independent sources, and graph connectivity. It never alters facts. */
  private migrateNodeImportanceV48(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT id FROM kg_nodes WHERE deleted_at IS NULL").all() as Array<{ id: string }>;
      for (const row of rows) this.refreshNodeImportance(row.id);
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  /** Schema v49 adds durable, source-window compaction state. It is additive: no
   * journal event, summary, or host transcript is rewritten by migration. */
  private migrateBoundedCompactionV49(): void { this.db.exec(contextEngineSchemaSql); }

  /** Schema v50 records exact-correlation replay attempts only; existing evidence,
   * commits, and receipts remain immutable and are never reprocessed. */
  private migrateReplayFloodGuardsV50(): void { this.db.exec(journalSchemaSql); }

  /** Schema v51 bounds replay-flood metadata cleanup by its actual scope/time
   * access path. Existing receipt evidence and guard rows remain unchanged. */
  private migrateReplayFloodCleanupV51(): void {
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_mnemora_replay_flood_guards_scope_seen ON mnemora_replay_flood_guards(scope,last_seen_at ASC)");
  }

  /** Schema v52 records schema-drift proposals separately from admitted edges. It
   * never rewrites existing nodes, edges, observations, or source evidence. */
  private migrateSchemaDriftV52(): void { this.db.exec(schemaDriftSchemaSql); }

  /** Schema v53 records formation-quality fingerprints independently from the
   * candidate/admission ledger. Existing cognition rows are not rewritten. */
  private migratePreAdmissionV53(): void { this.db.exec(cognitionPreAdmissionSchemaSql); }

  /** Schema v54 adds bounded, public lifecycle metadata to a migration receipt.
   * It never copies a provider database path, table, or raw source payload. */
  private migratePublicMigrationMetadataV54(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(mnemora_provider_migration_items)").all() as Array<{ name: string }>).map(row => row.name));
    if (!columns.has("metadata_json")) this.db.exec("ALTER TABLE mnemora_provider_migration_items ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  }

  /** Schema v55 widens the controlled structural-edge vocabulary and adds a
   * separate repair receipt. Existing facts are copied byte-for-byte; only a
   * later human-confirmed preview may create a new structural edge. */
  private migrateSchemaDriftRepairsV55(): void {
    this.db.exec("PRAGMA foreign_keys=OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`CREATE TABLE kg_edges_v55 (
        id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES kg_nodes(id),target_id TEXT NOT NULL REFERENCES kg_nodes(id),type TEXT NOT NULL,
        edge_props TEXT NOT NULL DEFAULT '{}',weight REAL NOT NULL DEFAULT 0,deleted_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        UNIQUE(source_id,target_id,type),
        CHECK(type IN ('works_at','invested_in','supplies','supplies_product','supplied_to','competes_with','uses','develops','owns','partners_with','in_portfolio','depends_on','part_of','instance_of','related_to')),
        CHECK(json_valid(edge_props) AND json_type(edge_props)='object'),CHECK(weight>=0 AND weight<=1)
      );
      INSERT INTO kg_edges_v55(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at)
        SELECT id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at FROM kg_edges;
      DROP TABLE kg_edges; ALTER TABLE kg_edges_v55 RENAME TO kg_edges;
      CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id); CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(type); CREATE INDEX IF NOT EXISTS idx_kg_edges_deleted_at ON kg_edges(deleted_at);`);
      this.db.exec(schemaDriftSchemaSql);
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    finally { this.db.exec("PRAGMA foreign_keys=ON"); }
    if (this.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("schema_migration_foreign_key_violation");
  }

  /** Schema v56 makes historic endpoint mismatches reviewable without admitting or
   * rewriting them. Only a later matching human confirmation may retire an
   * old invalid edge after preserving its evidence and audit receipt. */
  private migrateLegacySchemaDriftV56(): void {
    const candidateColumns = new Set((this.db.prepare("PRAGMA table_info(kg_schema_drift_candidates)").all() as Array<{ name: string }>).map(row => row.name));
    const candidateSql = String((this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='kg_schema_drift_candidates'").get() as { sql?: string } | undefined)?.sql ?? "");
    const needsCandidateRebuild = !candidateColumns.has("legacy_edge_id") || !/UNIQUE\s*\(\s*scope\s*,\s*source_entity_id\s*,\s*target_entity_id\s*,\s*relationship_type\s*,\s*legacy_edge_id\s*\)/i.test(candidateSql);
    this.db.exec("PRAGMA foreign_keys=OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (needsCandidateRebuild) this.db.exec(`CREATE TABLE kg_schema_drift_candidates_v56 (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL REFERENCES kg_scopes(id),
        source_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
        target_entity_id TEXT NOT NULL REFERENCES kg_nodes(id),
        relationship_type TEXT NOT NULL,
        source_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        expected_source_types TEXT NOT NULL,
        expected_target_types TEXT NOT NULL,
        legacy_edge_id TEXT NOT NULL DEFAULT '',
        relation_payload TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count>=1),
        first_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(scope,source_entity_id,target_entity_id,relationship_type,legacy_edge_id),
        CHECK(json_valid(relation_payload) AND json_type(relation_payload)='object')
      );
      INSERT INTO kg_schema_drift_candidates_v56(
        id,scope,source_entity_id,target_entity_id,relationship_type,source_type,target_type,expected_source_types,expected_target_types,legacy_edge_id,relation_payload,occurrence_count,first_seen_at,updated_at
      ) SELECT id,scope,source_entity_id,target_entity_id,relationship_type,source_type,target_type,expected_source_types,expected_target_types,${candidateColumns.has("legacy_edge_id") ? "COALESCE(legacy_edge_id,'')" : "''"},relation_payload,occurrence_count,first_seen_at,updated_at FROM kg_schema_drift_candidates;
      DROP TABLE kg_schema_drift_candidates;
      ALTER TABLE kg_schema_drift_candidates_v56 RENAME TO kg_schema_drift_candidates;
      CREATE INDEX idx_kg_schema_drift_scope_updated ON kg_schema_drift_candidates(scope,updated_at DESC,id);`);
      const repairColumns = new Set((this.db.prepare("PRAGMA table_info(kg_schema_drift_repairs)").all() as Array<{ name: string }>).map(row => row.name));
      if (!repairColumns.has("retired_edge_id")) this.db.exec("ALTER TABLE kg_schema_drift_repairs ADD COLUMN retired_edge_id TEXT");
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    finally { this.db.exec("PRAGMA foreign_keys=ON"); }
    if (this.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("schema_migration_foreign_key_violation");
  }

  /**
   * Historical candidates did not retain their observation scope. They are
   * deliberately invalidated instead of guessing, then a later scoped scan
   * recreates only candidates supported by current same-scope evidence.
   */
  private migrateScopedConflictCandidatesV27(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(kg_conflict_candidates)").all() as Array<{ name: string }>).map(row => row.name));
    if (!columns.has("scope")) this.db.exec("ALTER TABLE kg_conflict_candidates ADD COLUMN scope TEXT");
    this.db.prepare("UPDATE kg_conflict_candidates SET status='invalid',reviewed_at=NULL,updated_at=? WHERE scope IS NULL OR scope=''").run(Date.now());
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_conflict_candidates_scope_status ON kg_conflict_candidates(scope,status,updated_at)");
  }

  /** Additive Journal boundary. Existing graph and flat-memory rows remain untouched. */
  private migrateConversationJournalV28(): void { this.db.exec(journalSchemaSql); }
  private migrateContextEngineAndArtifactsV29(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // v28 constrained part kinds before artifact references existed. Rebuild only
      // this additive journal child table; event ids and payloads remain unchanged.
      this.db.exec(`CREATE TABLE IF NOT EXISTS mnemora_conversation_parts_v29 (
        event_id TEXT NOT NULL, scope TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(event_id,ordinal), CHECK(kind IN ('text','image_ref','attachment_ref','context_ref','artifact_ref','tool_call','tool_result')),
        CHECK(json_valid(payload) AND length(payload)<=262144), FOREIGN KEY(event_id) REFERENCES mnemora_conversation_events(id) ON DELETE CASCADE, FOREIGN KEY(scope) REFERENCES kg_scopes(id)
      ); INSERT OR IGNORE INTO mnemora_conversation_parts_v29 SELECT event_id,scope,ordinal,kind,payload,created_at FROM mnemora_conversation_parts;
      DROP TABLE mnemora_conversation_parts; ALTER TABLE mnemora_conversation_parts_v29 RENAME TO mnemora_conversation_parts;
      CREATE INDEX IF NOT EXISTS idx_mnemora_parts_scope_event ON mnemora_conversation_parts(scope,event_id,ordinal);`);
      this.db.exec(`${contextEngineSchemaSql}\n${artifactSchemaSql}`);
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  /** v4.2 widens the v4.1 state CHECK to include provisional without losing audit rows. */
  private migrateReasoningGovernanceV43(): void {
    this.db.exec("PRAGMA foreign_keys=OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("ALTER TABLE mnemora_reasoning_memory_events RENAME TO mnemora_reasoning_memory_events_v42; ALTER TABLE mnemora_reasoning_memories RENAME TO mnemora_reasoning_memories_v42;");
      this.db.exec(cognitionReasoningSchemaSql);
      this.db.exec(`INSERT INTO mnemora_reasoning_memories(id,scope,kind,strategy,applicability_json,contraindications_json,source_task_refs_json,outcome_refs_json,evidence_refs_json,confidence,utility_score,success_count,failure_count,degraded_count,state,supersedes_id,content_hash,created_at,updated_at)
        SELECT id,scope,kind,strategy,applicability_json,contraindications_json,source_task_refs_json,outcome_refs_json,evidence_refs_json,confidence,utility_score,success_count,failure_count,degraded_count,state,supersedes_id,content_hash,created_at,updated_at FROM mnemora_reasoning_memories_v42;
        INSERT INTO mnemora_reasoning_memory_events(id,scope,memory_id,from_state,to_state,action,reason_code,evidence_refs_json,created_at)
        SELECT id,scope,memory_id,from_state,to_state,action,reason_code,evidence_refs_json,created_at FROM mnemora_reasoning_memory_events_v42;
        DROP TABLE mnemora_reasoning_memory_events_v42; DROP TABLE mnemora_reasoning_memories_v42;
        CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_memories_scope_state ON mnemora_reasoning_memories(scope,state,updated_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS idx_mnemora_reasoning_memory_events_scope_created ON mnemora_reasoning_memory_events(scope,created_at DESC,id DESC);`);
      this.db.exec(cognitionReasoningGovernanceSchemaSql);
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    finally { this.db.exec("PRAGMA foreign_keys=ON"); }
  }

  /** v3.4.1 keeps historical candidates readable while preserving full future authority. */
  private migrateCognitionIntegrityV38(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set((this.db.prepare("PRAGMA table_info(mnemora_cognition_candidates)").all() as Array<{ name: string }>).map(row => row.name));
      if (!columns.has("authority_detail")) this.db.exec("ALTER TABLE mnemora_cognition_candidates ADD COLUMN authority_detail TEXT NOT NULL DEFAULT 'unknown'");
      this.db.exec("UPDATE mnemora_cognition_candidates SET authority_detail=authority WHERE authority_detail='unknown' AND authority IN ('manual_operator','assistant_inference','external_source')");
      this.db.exec(cognitionIntegritySchemaSql);
      this.db.exec("INSERT OR IGNORE INTO mnemora_cognition_change_sets(id,scope,origin,authority,candidate_id,created_at) SELECT DISTINCT change_set_id,scope,'legacy','unknown',candidate_id,created_at FROM mnemora_belief_transitions");
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  private migrateEpisodesV30(): void { this.db.exec(episodeSchemaSql); }
  private migrateProviderAuditV31(): void { this.db.exec(providerMigrationSchemaSql); }
  private migrateConsolidationV32(): void { this.db.exec(consolidationSchemaSql); }

  /** Additive safety migration. Historical ambiguous context is retained but never auto-injected. */
  private migrateContextInjectionSafetyV36(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const eventColumns = new Set((this.db.prepare("PRAGMA table_info(mnemora_conversation_events)").all() as Array<{ name: string }>).map(row => row.name));
      if (!eventColumns.has("context_domain")) this.db.exec("ALTER TABLE mnemora_conversation_events ADD COLUMN context_domain TEXT NOT NULL DEFAULT 'unknown'");
      this.db.exec("UPDATE mnemora_conversation_events SET context_domain='user_chat' WHERE context_domain='unknown' AND role IN ('user','assistant')");
      this.db.exec("UPDATE mnemora_conversation_events SET context_domain='tool' WHERE context_domain='unknown' AND role='tool'");
      this.db.exec("UPDATE mnemora_conversation_events SET context_domain='system' WHERE context_domain='unknown' AND role='system'");
      const summaryColumns = new Set((this.db.prepare("PRAGMA table_info(mnemora_summary_nodes)").all() as Array<{ name: string }>).map(row => row.name));
      if (!summaryColumns.has("injection_eligible")) this.db.exec("ALTER TABLE mnemora_summary_nodes ADD COLUMN injection_eligible INTEGER NOT NULL DEFAULT 0");
      if (!summaryColumns.has("safety_version")) this.db.exec("ALTER TABLE mnemora_summary_nodes ADD COLUMN safety_version INTEGER NOT NULL DEFAULT 0");
      this.db.exec(`${contextEngineSchemaSql}`);
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  /** Additive profile-audit history; it leaves graph facts and user selections untouched. */
  private migrateProfileHistoryV25(): void { this.db.exec(profileSchemaSql); }

  /** Add lease/retry state and widen the retrospective-audit lifecycle without touching facts. */
  private migrateTrustReliabilityV24(): void {
    const jobColumns = new Set((this.db.prepare("PRAGMA table_info(kg_anchor_verification_jobs)").all() as Array<{ name: string }>).map(row => row.name));
    for (const [name, type] of [["lease_expires_at", "INTEGER"], ["last_heartbeat_at", "INTEGER"], ["retry_not_before", "INTEGER"], ["last_retry_reason", "TEXT"]] as const) {
      if (!jobColumns.has(name)) this.db.exec(`ALTER TABLE kg_anchor_verification_jobs ADD COLUMN ${name} ${type}`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(retrospectiveAuditTableSql("kg_retrospective_audits_v24"));
      this.db.exec(`INSERT INTO kg_retrospective_audits_v24(
        id,verification_id,scope,policy_version,risk_score,risk_signals,status,attempts,scheduled_at,started_at,finished_at,error_code,reviewed_at
      ) SELECT id,verification_id,scope,policy_version,risk_score,risk_signals,
        CASE WHEN status IN ('scheduled','reviewed','canceled') THEN status ELSE 'failed' END,
        0,scheduled_at,NULL,NULL,NULL,reviewed_at FROM kg_retrospective_audits`);
      this.db.exec("DROP TABLE kg_retrospective_audits");
      this.db.exec("ALTER TABLE kg_retrospective_audits_v24 RENAME TO kg_retrospective_audits");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_kg_retrospective_audits_scope_status ON kg_retrospective_audits(scope,status,scheduled_at DESC)");
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original migration failure */ }
      throw error;
    }
  }

  /** Transactional copy/validate/quarantine migration for the v21 core fact tables. */
  private rebuildCoreTablesV21(): void {
    const now = Date.now();
    this.db.exec("PRAGMA foreign_keys=OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(coreTablesV21Sql);
      this.quarantineInvalidCoreRows(now);
      this.db.exec(`INSERT INTO kg_nodes_v21(id,type,name,description,aliases,embedding,importance,deleted_at,created_at,updated_at,embedding_provider,embedding_model,embedding_dimensions,embedding_input_version,embedded_at)
        SELECT id,type,name,description,aliases,embedding,importance,deleted_at,created_at,updated_at,embedding_provider,embedding_model,embedding_dimensions,embedding_input_version,embedded_at
        FROM kg_nodes WHERE typeof(id)='text' AND length(id)>0 AND type IN ('person','company','product','technology','concept','industry','fund','policy','portfolio')
          AND typeof(name)='text' AND length(trim(name))>0 AND json_valid(aliases) AND json_type(aliases)='array'
          AND typeof(importance) IN ('integer','real') AND importance BETWEEN 0 AND 1`);
      this.db.exec(`INSERT INTO kg_edges_v21(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at)
        SELECT e.id,e.source_id,e.target_id,e.type,e.edge_props,e.weight,e.deleted_at,e.created_at,e.updated_at FROM kg_edges e
        WHERE typeof(e.id)='text' AND length(e.id)>0 AND e.type IN ('works_at','invested_in','supplies','supplies_product','supplied_to','competes_with','uses','develops','owns','partners_with','in_portfolio','depends_on','part_of','instance_of','related_to')
          AND json_valid(e.edge_props) AND json_type(e.edge_props)='object' AND typeof(e.weight) IN ('integer','real') AND e.weight BETWEEN 0 AND 1
          AND EXISTS(SELECT 1 FROM kg_nodes_v21 n WHERE n.id=e.source_id) AND EXISTS(SELECT 1 FROM kg_nodes_v21 n WHERE n.id=e.target_id)`);
      this.db.exec(`INSERT INTO kg_observations_v21(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,valid_from,valid_to,temporal_confidence,created_at)
        SELECT o.id,o.edge_id,o.source_entity_id,o.payload,o.source,o.scope,o.quote,o.confidence,o.valid_from,o.valid_to,o.temporal_confidence,o.created_at FROM kg_observations o
        WHERE typeof(o.id)='text' AND length(o.id)>0 AND typeof(o.source)='text' AND length(o.source)>0 AND typeof(o.scope)='text' AND length(o.scope)>0
          AND typeof(o.quote)='text' AND json_valid(o.payload) AND json_type(o.payload)='object' AND typeof(o.confidence) IN ('integer','real') AND o.confidence BETWEEN 0 AND 1
          AND (o.temporal_confidence IS NULL OR (typeof(o.temporal_confidence) IN ('integer','real') AND o.temporal_confidence BETWEEN 0 AND 1))
          AND (o.valid_from IS NULL OR o.valid_to IS NULL OR (typeof(o.valid_from)='integer' AND typeof(o.valid_to)='integer' AND o.valid_from<=o.valid_to))
          AND ((o.edge_id IS NOT NULL AND o.source_entity_id IS NULL AND EXISTS(SELECT 1 FROM kg_edges_v21 e WHERE e.id=o.edge_id))
            OR (o.edge_id IS NULL AND o.source_entity_id IS NOT NULL AND EXISTS(SELECT 1 FROM kg_nodes_v21 n WHERE n.id=o.source_entity_id)))`);
      this.db.exec(`DROP TABLE kg_nodes_fts; DROP TABLE kg_memory_documents_fts; DROP TABLE kg_memory_chunks_fts;
        DROP TABLE kg_observations; DROP TABLE kg_edges; DROP TABLE kg_nodes;
        ALTER TABLE kg_nodes_v21 RENAME TO kg_nodes; ALTER TABLE kg_edges_v21 RENAME TO kg_edges; ALTER TABLE kg_observations_v21 RENAME TO kg_observations;`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(type); CREATE INDEX IF NOT EXISTS idx_kg_nodes_deleted_at ON kg_nodes(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id); CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id); CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(type); CREATE INDEX IF NOT EXISTS idx_kg_edges_deleted_at ON kg_edges(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_kg_observations_edge ON kg_observations(edge_id); CREATE INDEX IF NOT EXISTS idx_kg_observations_source_entity ON kg_observations(source_entity_id); CREATE INDEX IF NOT EXISTS idx_kg_observations_source ON kg_observations(source); CREATE INDEX IF NOT EXISTS idx_kg_observations_scope_subject ON kg_observations(scope,source_entity_id); CREATE INDEX IF NOT EXISTS idx_kg_observations_scope_edge ON kg_observations(scope,edge_id);`);
      this.db.exec(entityIdentityTriggerSql);
      this.entities.rebuild();
      this.rebuildFtsIndexesForTrigramInTransaction();
      this.db.exec("DELETE FROM kg_duplicate_candidates WHERE entity_a NOT IN (SELECT id FROM kg_nodes) OR entity_b NOT IN (SELECT id FROM kg_nodes)");
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may not have begun */ }
      throw error;
    } finally { this.db.exec("PRAGMA foreign_keys=ON"); }
    if (this.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("schema_migration_foreign_key_violation");
  }

  private quarantineInvalidCoreRows(now: number): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO kg_schema_quarantine(id,schema_version,table_name,row_id,reason,record_json,record_hash,truncated,quarantined_at)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    const add = (table: string, id: unknown, reason: string, record: Record<string, unknown>) => {
      const serialized = JSON.stringify(record), hash = createHash("sha256").update(serialized).digest("hex"), cap = 65536;
      insert.run(`quarantine:21:${table}:${String(id)}:${hash.slice(0, 16)}`, 21, table, String(id), reason, serialized.slice(0, cap), hash, serialized.length > cap ? 1 : 0, now);
    };
    for (const row of this.db.prepare("SELECT id,type,name,description,aliases,importance,created_at,updated_at FROM kg_nodes").all() as Array<Record<string, unknown>>) if (!validNodeConstraint(row)) add("kg_nodes", row.id, "invalid_node_constraint", row);
    for (const row of this.db.prepare("SELECT id,source_id,target_id,type,edge_props,weight,created_at,updated_at FROM kg_edges").all() as Array<Record<string, unknown>>) if (!validEdgeConstraint(row, this.db)) add("kg_edges", row.id, "invalid_edge_constraint", row);
    for (const row of this.db.prepare("SELECT id,edge_id,source_entity_id,payload,source,scope,quote,confidence,valid_from,valid_to,temporal_confidence,created_at FROM kg_observations").all() as Array<Record<string, unknown>>) if (!validObservationConstraint(row, this.db)) add("kg_observations", row.id, "invalid_observation_constraint", row);
  }

  private ftsTokenizersNeedMigration(): boolean {
    for (const name of ["kg_nodes_fts", "kg_memory_documents_fts", "kg_memory_chunks_fts"]) {
      const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql?: unknown } | undefined;
      if (typeof row?.sql !== "string" || !/tokenize\s*=\s*'trigram'/i.test(row.sql)) return true;
    }
    return false;
  }

  private rebuildFtsIndexesForTrigram(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.rebuildFtsIndexesForTrigramInTransaction();
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may not have begun */ }
      throw error;
    }
  }

  private rebuildFtsIndexesForTrigramInTransaction(): void {
    this.db.exec(`
        DROP TABLE IF EXISTS kg_nodes_fts;
        DROP TABLE IF EXISTS kg_memory_documents_fts;
        DROP TABLE IF EXISTS kg_memory_chunks_fts;
        CREATE VIRTUAL TABLE kg_nodes_fts USING fts5(
          id UNINDEXED,
          name,
          description,
          aliases,
          tokenize = 'trigram'
        );
        CREATE VIRTUAL TABLE kg_memory_documents_fts USING fts5(
          id UNINDEXED,
          title,
          content,
          tokenize = 'trigram'
        );
        CREATE VIRTUAL TABLE kg_memory_chunks_fts USING fts5(
          id UNINDEXED,
          content,
          tokenize = 'trigram'
        );
        INSERT INTO kg_nodes_fts(id,name,description,aliases)
          SELECT id,name,description,aliases FROM kg_nodes WHERE deleted_at IS NULL;
        INSERT INTO kg_memory_documents_fts(id,title,content)
          SELECT id,title,content FROM kg_memory_documents;
        INSERT INTO kg_memory_chunks_fts(id,content)
          SELECT id,content FROM kg_memory_chunks;
      `);
  }

  putEmbedding(nodeId: string, identity: EmbeddingIdentity, inputVersion: string, vector: number[], embeddedAt = Date.now()): void {
    const encoded = encodeEmbedding(vector);
    if (vector.length !== identity.dimensions) throw new Error("embedding dimensions do not match identity");
    const result = this.db.prepare(`UPDATE kg_nodes SET embedding=?, embedding_provider=?, embedding_model=?, embedding_dimensions=?, embedding_input_version=?, embedded_at=? WHERE id=?`)
      .run(encoded, identity.provider, identity.model, identity.dimensions, inputVersion, embeddedAt, nodeId);
    if (Number(result.changes) !== 1) throw new Error("embedding persistence failed: node not found");
  }

  getEmbedding(nodeId: string): StoredEmbedding | undefined {
    const row = this.db.prepare(`SELECT embedding, embedding_provider, embedding_model, embedding_dimensions, embedding_input_version, embedded_at FROM kg_nodes WHERE id=? AND embedding IS NOT NULL`).get(nodeId) as {
      embedding: Uint8Array; embedding_provider: string | null; embedding_model: string | null;
      embedding_dimensions: number | null; embedding_input_version: string | null; embedded_at: number | null;
    } | undefined;
    if (!row || row.embedding_provider == null || row.embedding_model == null || row.embedding_dimensions == null || row.embedding_input_version == null || row.embedded_at == null) return undefined;
    const dimensions = Number(row.embedding_dimensions);
    return { provider: row.embedding_provider, model: row.embedding_model, dimensions, input_version: row.embedding_input_version, embedded_at: Number(row.embedded_at), vector: decodeEmbedding(row.embedding, dimensions) };
  }

  /** Local authority check for an opaque external vector-index id. */
  hasCurrentEmbedding(nodeId: string, identity: EmbeddingIdentity, inputVersion: string): boolean {
    const row = this.db.prepare(`SELECT 1 AS present FROM kg_nodes
      WHERE id=? AND deleted_at IS NULL AND embedding IS NOT NULL AND embedding_provider=? AND embedding_model=?
        AND embedding_dimensions=? AND embedding_input_version=? LIMIT 1`)
      .get(nodeId, identity.provider, identity.model, identity.dimensions, inputVersion) as { present?: number } | undefined;
    return row?.present === 1;
  }

  listEmbeddingCandidates(identity: EmbeddingIdentity, inputVersion: string, limit: number, nodeType?: string, afterId = ""): Array<{ node: KgNode; vector: number[] }> {
    const rows = this.db.prepare(`SELECT * FROM kg_nodes WHERE deleted_at IS NULL AND embedding IS NOT NULL AND embedding_provider=? AND embedding_model=? AND embedding_dimensions=? AND embedding_input_version=? AND (? IS NULL OR type=?) AND id>? ORDER BY id LIMIT ?`)
      .all(identity.provider, identity.model, identity.dimensions, inputVersion, nodeType ?? null, nodeType ?? null, afterId, Math.max(0, Math.trunc(limit))) as Array<NodeRow & { embedding: Uint8Array }>;
    const valid: Array<{ node: KgNode; vector: number[] }> = [];
    for (const row of rows) {
      try { valid.push({ node: mapNode(row), vector: decodeEmbedding(row.embedding, identity.dimensions) }); }
      catch { /* isolate corrupt rows */ }
    }
    return valid;
  }

  listStaleEmbeddingNodes(identity: Omit<EmbeddingIdentity, "dimensions">, inputVersion: string, afterId = "", limit = 100): KgNode[] {
    const rows = this.db.prepare(`SELECT * FROM kg_nodes WHERE deleted_at IS NULL AND id>? AND (embedding IS NULL OR embedding_provider IS NOT ? OR embedding_model IS NOT ? OR embedding_input_version IS NOT ? OR embedded_at IS NULL OR embedded_at < updated_at) ORDER BY id LIMIT ?`)
      .all(afterId, identity.provider, identity.model, inputVersion, Math.max(0, Math.trunc(limit))) as NodeRow[];
    return rows.map(mapNode);
  }

  ingest(entities: ExtractedEntity[], relations: ExtractedRelation[], source = "manual", minConfidenceToStore = 0, quality: RelationshipQualityPolicy = { edgeMinConfidence: 0, relatedToMinConfidence: .8, edgeTypeMinConfidence: {} }, scope = "default"): IngestResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.ingestInTransaction(entities, relations, source, minConfidenceToStore, quality, scope);
      if (result.observations.length) this.bumpGraphRevision();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ingestOnce(entities: ExtractedEntity[], relations: ExtractedRelation[], source: string, minConfidenceToStore = 0, scope = "default"): IngestResult & { skipped: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.hasObservationSource(source, scope)) {
        this.db.exec("COMMIT");
        return { entities: [], relations: [], observations: [], skipped_relations: [], skipped: true };
      }
      const result = this.ingestInTransaction(entities, relations, source, minConfidenceToStore, { edgeMinConfidence: 0, relatedToMinConfidence: .8, edgeTypeMinConfidence: {} }, scope);
      if (result.observations.length) this.bumpGraphRevision();
      this.db.exec("COMMIT");
      return { ...result, skipped: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getCompletedIngestion(inputFingerprint: string, scope = "default"): { fingerprint: string; source: string } | undefined {
    return this.db.prepare("SELECT fingerprint,source FROM kg_ingestion_records WHERE input_fingerprint=? AND scope=? AND status='completed' ORDER BY completed_at DESC LIMIT 1").get(inputFingerprint, normalizeScope(scope)) as { fingerprint: string; source: string } | undefined;
  }

  ingestWithCompletedRecord(entities: ExtractedEntity[], relations: ExtractedRelation[], source: string, fingerprint: string, inputFingerprint: string, fingerprintVersion: string, minConfidenceToStore = 0, quality: RelationshipQualityPolicy = { edgeMinConfidence: 0, relatedToMinConfidence: .8, edgeTypeMinConfidence: {} }, scope = "default"): IngestResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const normalizedScope = normalizeScope(scope);
      const result = this.ingestInTransaction(entities, relations, source, minConfidenceToStore, quality, normalizedScope);
      if (result.observations.length) this.bumpGraphRevision();
      const now = Date.now();
      this.db.prepare("INSERT INTO kg_ingestion_records (fingerprint,input_fingerprint,fingerprint_version,source,scope,status,error_category,error_summary,created_at,completed_at) VALUES (?,?,?,?,?,'completed',NULL,NULL,?,?) ON CONFLICT(fingerprint) DO UPDATE SET input_fingerprint=excluded.input_fingerprint,source=excluded.source,scope=excluded.scope,status='completed',completed_at=excluded.completed_at").run(fingerprint, inputFingerprint, fingerprintVersion, source, normalizedScope, now, now);
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  claimAutoRun(turnKey: string, now = Date.now(), staleAfterMs = 60000): AutoRunClaim {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.pruneAutoRunsInTransaction(now);
      const row = this.db.prepare("SELECT status, started_at, attempts FROM kg_auto_runs WHERE turn_key = ?").get(turnKey) as { status: string; started_at: number; attempts: number } | undefined;
      if (!row) {
        const count = Number((this.db.prepare("SELECT COUNT(*) AS n FROM kg_auto_runs").get() as { n: number }).n);
        if (count >= 10_000) {
          this.db.exec("COMMIT");
          return { status: "busy" };
        }
        const feature = turnKey.split(":", 1)[0] || "unknown";
        this.db.prepare("INSERT INTO kg_auto_runs (turn_key, feature, status, started_at) VALUES (?, ?, 'running', ?)").run(turnKey, feature, now);
        this.db.exec("COMMIT");
        return { status: "claimed", attempt: 1 };
      }
      if (row.status === "succeeded") {
        this.db.exec("COMMIT");
        return { status: "succeeded" };
      }
      if (row.status === "running" && now - Number(row.started_at) <= staleAfterMs) {
        this.db.exec("COMMIT");
        return { status: "busy" };
      }
      this.db.prepare("UPDATE kg_auto_runs SET status='running', attempts=attempts+1, last_error=NULL, started_at=?, finished_at=NULL WHERE turn_key=?").run(now, turnKey);
      this.db.exec("COMMIT");
      return { status: "claimed", attempt: Number(row.attempts) + 1 };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishAutoRun(turnKey: string, attempt: number, status: AutoRunFinishStatus, finishedAt = Date.now(), lastError?: string): boolean {
    const sanitizedError = lastError == null ? null : String(lastError).slice(0, 500);
    const result = this.db.prepare("UPDATE kg_auto_runs SET status=?, finished_at=?, last_error=? WHERE turn_key=? AND status='running' AND attempts=?").run(status, finishedAt, sanitizedError, turnKey, attempt);
    return Number(result.changes) === 1;
  }

  hasObservationSource(source: string, scope?: string): boolean {
    return scope == null
      ? this.db.prepare("SELECT 1 FROM kg_observations WHERE source=? LIMIT 1").get(source) != null
      : this.db.prepare("SELECT 1 FROM kg_observations WHERE source=? AND scope=? LIMIT 1").get(source, normalizeScope(scope)) != null;
  }

  scanDuplicateCandidates(afterId?: string, limit = 100, options: { persistCursor?: boolean } = {}): DuplicateScanResult {
    const bounded = Math.min(500, Math.max(1, Math.trunc(limit)));
    const savedCursor = options.persistCursor
      ? (this.db.prepare("SELECT value FROM kg_maintenance_state WHERE key='duplicate_scan_cursor'").get() as { value: string } | undefined)?.value
      : undefined;
    const cursor = afterId ?? savedCursor ?? "";
    const rows = this.db.prepare("SELECT * FROM kg_nodes WHERE deleted_at IS NULL AND id>? ORDER BY id LIMIT ?").all(cursor, bounded) as NodeRow[];
    const now = Date.now();
    const outcome = this.persistDuplicateCandidates(rows.map(mapNode), this.listActiveNodes().map(mapNode), false, now);
    const next = rows.at(-1)?.id;
    const complete = rows.length < bounded || !next || this.db.prepare("SELECT 1 FROM kg_nodes WHERE deleted_at IS NULL AND id>? LIMIT 1").get(next) == null;
    if (options.persistCursor) {
      this.db.prepare("INSERT INTO kg_maintenance_state(key,value,updated_at) VALUES('duplicate_scan_cursor',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .run(complete ? "" : next, now);
      if (complete) this.db.prepare("INSERT INTO kg_maintenance_state(key,value,updated_at) VALUES('duplicate_scan_completed_at',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .run(String(now), now);
    }
    return { processed: rows.length, created: outcome.created, updated: outcome.updated, ...(complete || !next ? {} : { next_after_id: next }), complete };
  }

  /**
   * Incremental duplicate discovery for newly ingested node IDs. It builds one
   * normalized term index for the active graph, then compares only matching
   * name/alias neighbourhoods. This avoids the former rows × whole-graph scan
   * and cannot skip a fresh node merely because it sorts after unrelated rows.
   */
  scanDuplicateCandidatesForIds(ids: readonly string[]): { processed: number; created: number; updated: number } {
    const requested = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, 50);
    if (!requested.length) return { processed: 0, created: 0, updated: 0 };
    const rows = this.db.prepare(`SELECT * FROM kg_nodes WHERE deleted_at IS NULL AND id IN (${requested.map(() => "?").join(",")}) ORDER BY id`).all(...requested) as NodeRow[];
    const outcome = this.persistDuplicateCandidates(rows.map(mapNode), this.listActiveNodes().map(mapNode), true, Date.now());
    return { processed: rows.length, ...outcome };
  }

  private persistDuplicateCandidates(nodes: readonly KgNode[], peers: readonly KgNode[], includeEarlierPeers: boolean, now: number): { created: number; updated: number } {
    const byTerm = new Map<string, KgNode[]>();
    for (const peer of peers) for (const term of duplicateLookupTerms(peer)) {
      const values = byTerm.get(term) ?? [];
      values.push(peer);
      byTerm.set(term, values);
    }
    let created = 0;
    let updated = 0;
    const seenPairs = new Set<string>();
    for (const node of nodes) {
      const candidates = new Map<string, KgNode>();
      for (const term of duplicateLookupTerms(node)) for (const peer of byTerm.get(term) ?? []) candidates.set(peer.id, peer);
      for (const peer of candidates.values()) {
        if (peer.id === node.id || (!includeEarlierPeers && peer.id <= node.id)) continue;
        const pairKey = duplicatePairKey(node.id, peer.id);
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        const scored = scoreDuplicatePair(node, peer);
        if (!scored) continue;
        const existing = this.db.prepare("SELECT id,status,fingerprint_a,fingerprint_b,reviewed_at FROM kg_duplicate_candidates WHERE pair_key=?").get(pairKey) as Pick<DuplicateCandidate, "id" | "status" | "fingerprint_a" | "fingerprint_b" | "reviewed_at"> | undefined;
        const fingerprintA = entityFingerprint(node, this.evidenceForNode(node.id, 20));
        const fingerprintB = entityFingerprint(peer, this.evidenceForNode(peer.id, 20));
        if (existing) {
          const changed = existing.fingerprint_a !== fingerprintA || existing.fingerprint_b !== fingerprintB;
          const reopen = changed && (existing.status === "ignored" || existing.status === "rejected");
          this.db.prepare("UPDATE kg_duplicate_candidates SET signals=?, reasons=?, score=?, fingerprint_a=?, fingerprint_b=?, status=?, reviewed_at=?, updated_at=? WHERE pair_key=?")
            .run(JSON.stringify(scored.signals), JSON.stringify(scored.reasons), scored.score, fingerprintA, fingerprintB, reopen ? "pending" : existing.status, reopen ? null : existing.reviewed_at, now, pairKey);
          updated++;
        } else {
          this.db.prepare(`INSERT INTO kg_duplicate_candidates
            (id,pair_key,entity_a,entity_b,signals,reasons,score,fingerprint_a,fingerprint_b,status,discovered_at,updated_at,reviewed_at)
            VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,NULL)`)
            .run(`candidate:${createHash("sha256").update(pairKey).digest("hex")}`, pairKey, node.id, peer.id, JSON.stringify(scored.signals), JSON.stringify(scored.reasons), scored.score, fingerprintA, fingerprintB, now, now);
          created++;
        }
      }
    }
    return { created, updated };
  }

  reviewCandidates(options: { status?: DuplicateCandidateStatus; limit?: number } = {}): { items: DuplicateCandidate[] } {
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 20)));
    const rows = this.db.prepare("SELECT * FROM kg_duplicate_candidates WHERE (? IS NULL OR status=?) ORDER BY score DESC, updated_at DESC LIMIT ?")
      .all(options.status ?? null, options.status ?? null, limit) as CandidateRow[];
    return { items: rows.map(row => ({ ...row, signals: JSON.parse(row.signals), reasons: JSON.parse(row.reasons) })) };
  }

  auditLegacyIdentities(afterId = "", limit = 20): LegacyIdentityAuditResult {
    const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
    const scanLimit = Math.min(1000, Math.max(bounded, bounded * 20));
    const rows = this.db.prepare(`SELECT * FROM kg_nodes
      WHERE deleted_at IS NULL AND id>? AND typeof(id)='text' AND length(id)<=200
        AND typeof(name)='text' AND length(name)>0 AND length(name)<=10000
      ORDER BY id LIMIT ?`).all(afterId, scanLimit + 1) as NodeRow[];
    const items: LegacyIdentityAuditResult["items"] = [];
    let scanned = 0;
    for (const row of rows.slice(0, scanLimit)) {
      scanned++;
      if (!(insightNodeTypes as readonly string[]).includes(row.type)) continue;
      const type = row.type as NodeType;
      const legacyId = legacyNormalizeSlug(row.name, type);
      const expectedId = normalizeSlug(row.name, type);
      if (row.id !== legacyId || row.id === expectedId) continue;
      const truncatedName = row.name.length > 200;
      items.push({
        entity_id: row.id,
        type,
        name: truncatedName ? row.name.slice(0, 200) : row.name,
        ...(truncatedName ? { name_truncated: true as const } : {}),
        legacy_id: legacyId,
        expected_id: expectedId,
        reason: "legacy_id_matches_pre_v1_0_1_algorithm"
      });
      if (items.length === bounded) return { items, scanned, next_after_id: row.id, truncated: true };
    }
    const hasMore = rows.length > scanLimit;
    return { items, scanned, next_after_id: hasMore && scanned ? rows[scanned - 1].id : null, truncated: hasMore };
  }

  decideCandidate(id: string, decision: "ignored" | "rejected"): DuplicateCandidate {
    const now = Date.now();
    const changed = this.db.prepare("UPDATE kg_duplicate_candidates SET status=?, reviewed_at=?, updated_at=? WHERE id=? AND status='pending'").run(decision, now, now, id).changes;
    if (Number(changed) !== 1) throw new Error(`Pending duplicate candidate not found: ${id}`);
    const row = this.db.prepare("SELECT * FROM kg_duplicate_candidates WHERE id=?").get(id) as CandidateRow;
    return { ...row, signals: JSON.parse(row.signals), reasons: JSON.parse(row.reasons) };
  }

  scanConflictCandidates(types: RelationshipType[], groups?: Array<{ source_id: string; type: RelationshipType }>): { scanned: number; created: number; updated: number; invalidated: number; truncated?: true } {
    const eligible = [...new Set([
      ...types,
      ...(Object.values(relationshipDefinitions).filter(definition => definition.singleValued).map(definition => definition.type))
    ])].filter((type): type is RelationshipType => type in relationshipDefinitions).sort();
    if (eligible.length === 0) return { scanned: 0, created: 0, updated: 0, invalidated: 0 };
    const affectedGroups = groups == null ? undefined : [...new Map(groups.filter(group => eligible.includes(group.type)).map(group => [`${group.source_id}\0${group.type}`, group])).values()];
    if (affectedGroups?.length === 0) return { scanned: 0, created: 0, updated: 0, invalidated: 0 };
    const placeholders = eligible.map(() => "?").join(",");
    const groupClause = affectedGroups ? ` AND (${affectedGroups.map(() => "(e.source_id=? AND e.type=?)").join(" OR ")})` : "";
    const groupParams = affectedGroups?.flatMap(group => [group.source_id, group.type]) ?? [];
    const observationRows = this.db.prepare(`SELECT e.id AS edge_id,o.id AS observation_id,e.source_id,e.target_id,o.scope,o.confidence,o.valid_from,o.valid_to,
      (SELECT COUNT(DISTINCT x.source) FROM kg_observations x WHERE x.edge_id=e.id) AS source_count,e.type
      FROM kg_edges e JOIN kg_observations o ON o.edge_id=e.id
      WHERE e.deleted_at IS NULL AND e.type IN (${placeholders})${groupClause} ORDER BY e.source_id,e.type,e.target_id,o.confidence DESC,o.id LIMIT 10001`).all(...eligible, ...groupParams) as Array<ConflictFact & { type: RelationshipType }>;
    const truncated = observationRows.length > 10000;
    const rows = observationRows.slice(0, 10000);
    const scopes = [...new Set(rows.map(row => normalizeScope(row.scope)))].sort();
    const generated = scopes.flatMap(scope => eligible.flatMap(type => detectConflictPairs({ relationshipType: type, singleValued: true, scope, facts: rows.filter(row => row.type === type && normalizeScope(row.scope) === scope) })));
    const now = Date.now();
    let created = 0, updated = 0, invalidated = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const pair of generated) {
        // pair_key is the stable uniqueness boundary across schema generations;
        // use it for an in-place refresh even if a legacy candidate id was
        // generated by an older scoped-conflict implementation.
        const existing = this.db.prepare("SELECT id,status,fingerprint_a,fingerprint_b,reviewed_at FROM kg_conflict_candidates WHERE pair_key=?").get(pair.pair_key) as (Pick<ConflictCandidate, "id" | "status" | "fingerprint_a" | "fingerprint_b" | "reviewed_at">) | undefined;
        if (!existing) {
          const scope = pair.pair_key.split("|", 1)[0];
          this.db.prepare(`INSERT INTO kg_conflict_candidates(id,scope,pair_key,edge_a,edge_b,observation_a,observation_b,category,overlap_from,overlap_to,confidence_a,confidence_b,source_count_a,source_count_b,fingerprint_a,fingerprint_b,preview_hash,status,discovered_at,updated_at,reviewed_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?,NULL)`).run(pair.id,scope,pair.pair_key,pair.edge_a,pair.edge_b,pair.observation_a,pair.observation_b,pair.category,pair.overlap_from,pair.overlap_to,pair.confidence_a,pair.confidence_b,pair.source_count_a,pair.source_count_b,pair.fingerprint_a,pair.fingerprint_b,pair.preview_hash,now,now);
          created++;
        } else {
          const changed = existing.fingerprint_a !== pair.fingerprint_a || existing.fingerprint_b !== pair.fingerprint_b;
          const reopen = changed && (existing.status === "ignored" || existing.status === "rejected" || existing.status === "invalid");
          this.db.prepare(`UPDATE kg_conflict_candidates SET overlap_from=?,overlap_to=?,confidence_a=?,confidence_b=?,source_count_a=?,source_count_b=?,fingerprint_a=?,fingerprint_b=?,preview_hash=?,status=?,reviewed_at=?,updated_at=? WHERE id=?`)
            .run(pair.overlap_from,pair.overlap_to,pair.confidence_a,pair.confidence_b,pair.source_count_a,pair.source_count_b,pair.fingerprint_a,pair.fingerprint_b,pair.preview_hash,reopen ? "pending" : existing.status,reopen ? null : existing.reviewed_at,now,existing.id);
          updated++;
        }
      }
      if (!truncated) for (const scope of scopes) {
        const activeIds = new Set(generated.filter(pair => pair.pair_key.startsWith(`${scope}|`)).map(pair => pair.id));
        const candidates = this.db.prepare(`SELECT c.id FROM kg_conflict_candidates c LEFT JOIN kg_edges e ON e.id=c.edge_a WHERE c.scope=? AND e.type IN (${placeholders})${groupClause} AND c.status!='invalid'`).all(scope, ...eligible, ...groupParams) as Array<{ id: string }>;
        for (const candidate of candidates) if (!activeIds.has(candidate.id)) {
          this.db.prepare("UPDATE kg_conflict_candidates SET status='invalid',reviewed_at=NULL,updated_at=? WHERE id=?").run(now, candidate.id);
          invalidated++;
        }
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { scanned: rows.length, created, updated, invalidated, ...(truncated ? { truncated: true } : {}) };
  }

  reviewConflictCandidates(options: { status?: ConflictCandidateStatus; limit?: number; scope?: string } = {}): { items: ConflictCandidate[] } {
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 20)));
    const scope = normalizeScope(options.scope);
    return { items: this.db.prepare("SELECT * FROM kg_conflict_candidates WHERE scope=? AND (? IS NULL OR status=?) ORDER BY updated_at DESC,id LIMIT ?").all(scope, options.status ?? null, options.status ?? null, limit) as unknown as ConflictCandidate[] };
  }

  getConflictCandidate(id: string, scope?: string): ConflictCandidate | undefined {
    const value = typeof id === "string" && id.length > 0 && id.length <= 200 ? id : "";
    if (!value) return undefined;
    return this.db.prepare("SELECT * FROM kg_conflict_candidates WHERE id=? AND scope=?").get(value, normalizeScope(scope)) as ConflictCandidate | undefined;
  }

  decideConflictCandidate(id: string, decision: "ignored" | "rejected", scope?: string): ConflictCandidate {
    const now = Date.now();
    const normalizedScope = normalizeScope(scope);
    const changed = this.db.prepare("UPDATE kg_conflict_candidates SET status=?,reviewed_at=?,updated_at=? WHERE id=? AND scope=? AND status='pending'").run(decision, now, now, id, normalizedScope);
    if (Number(changed.changes) !== 1) throw new Error(`Pending conflict candidate not found: ${id}`);
    return this.db.prepare("SELECT * FROM kg_conflict_candidates WHERE id=? AND scope=?").get(id, normalizedScope) as unknown as ConflictCandidate;
  }

  reviewAnomalies(options: { limit?: number } = {}): { items: RelationshipAnomaly[] } {
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 20)));
    const rows = this.db.prepare("SELECT * FROM kg_edges WHERE deleted_at IS NULL ORDER BY id LIMIT ?").all(limit * 4) as EdgeRow[];
    const items: RelationshipAnomaly[] = [];
    for (const row of rows) {
      const edge = mapEdge(row);
      const source = this.getNodeById(edge.source_id);
      const target = this.getNodeById(edge.target_id);
      if (!source || !target) continue;
      const admission = validateRelationship(source, target, edge.type, 1, 0);
      if (!admission.accepted && admission.reason !== "below_edge_confidence") {
        items.push({ edge, reason: admission.reason, evidence: this.evidenceForEdge(edge.id, 3) });
        if (items.length === limit) break;
      }
    }
    return { items };
  }

  reviewSchemaDrift(scope: string, limit = 20): { items: SchemaDriftCandidate[] } {
    return { items: this.schemaDrift.list(scope, limit) };
  }

  reviewSemanticPatterns(scope: string, limit = 20): { items: SemanticPatternCandidate[] } {
    return { items: this.semanticPatterns.list(scope, limit) };
  }

  /** Reviewing a frequent semantic pattern never changes a domain dictionary
   * or promotes an edge into topology. It creates an auditable operator
   * decision only, which a future dictionary change may cite. */
  previewSemanticPatternReview(candidateId: string, decision: "accepted" | "rejected", scope = "default"): SemanticPatternReviewResult {
    const normalizedScope = normalizeScope(scope), candidate = this.semanticPatterns.get(candidateId, normalizedScope);
    const basic = { confirmed: false, candidate_id: candidateId, decision } as const;
    if (!candidate) return { ...basic, preview_hash: "", eligible: false, reason: "missing_candidate" };
    const existing = this.semanticPatterns.review(candidateId, normalizedScope);
    if (existing) return { ...basic, preview_hash: existing.preview_hash, eligible: false, reason: "already_reviewed", audit_id: existing.audit_id };
    const snapshot = { candidate_id: candidate.id, scope: normalizedScope, domain: candidate.domain, source_type: candidate.source_type, predicate: candidate.predicate, target_type: candidate.target_type, occurrence_count: candidate.occurrence_count, updated_at: candidate.updated_at, decision };
    return { ...basic, preview_hash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), eligible: true };
  }

  confirmSemanticPatternReview(candidateId: string, decision: "accepted" | "rejected", expectedPreviewHash: string, scope = "default"): SemanticPatternReviewResult {
    const normalizedScope = normalizeScope(scope), preview = this.previewSemanticPatternReview(candidateId, decision, normalizedScope);
    if (!preview.eligible) return preview;
    if (!expectedPreviewHash || expectedPreviewHash !== preview.preview_hash) throw new Error("stale_semantic_pattern_review_preview");
    const now = Date.now(), auditId = `semantic-pattern-review:${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.semanticPatterns.get(candidateId, normalizedScope);
      const existing = this.semanticPatterns.review(candidateId, normalizedScope);
      if (!candidate || existing) { this.db.exec("COMMIT"); return this.previewSemanticPatternReview(candidateId, decision, normalizedScope); }
      const current = this.previewSemanticPatternReview(candidateId, decision, normalizedScope);
      if (!current.eligible || current.preview_hash !== expectedPreviewHash) throw new Error("stale_semantic_pattern_review_preview");
      const updated = this.db.prepare("UPDATE kg_semantic_pattern_candidates SET status=?,reviewed_at=? WHERE id=? AND scope=? AND status='pending'").run(decision, now, candidateId, normalizedScope) as { changes?: number };
      if (Number(updated.changes) !== 1) throw new Error("stale_semantic_pattern_review_preview");
      this.db.prepare("INSERT INTO kg_quality_audits(id,action,snapshot_version,snapshot,created_at) VALUES(?,?,1,?,?)")
        .run(auditId, "confirm_semantic_pattern_review", JSON.stringify({ candidate_id: candidateId, scope: normalizedScope, decision, preview_hash: expectedPreviewHash, occurrence_count: candidate.occurrence_count }), now);
      this.db.prepare("INSERT INTO kg_semantic_pattern_reviews(candidate_id,scope,decision,preview_hash,audit_id,created_at) VALUES(?,?,?,?,?,?)")
        .run(candidateId, normalizedScope, decision, expectedPreviewHash, auditId, now);
      this.db.exec("COMMIT");
      return { confirmed: true, candidate_id: candidateId, decision, preview_hash: expectedPreviewHash, eligible: true, audit_id: auditId };
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  /**
   * Find legacy active edges that no longer pass the current endpoint policy.
   * This is an audit-only, cursor-bounded projection: it never changes an
   * edge, observation, confidence, or relationship definition.
   */
  scanLegacySchemaDrift(scope: string, afterEdgeId?: string, limit = 20): SchemaDriftScanResult {
    const normalizedScope = normalizeScope(scope), take = Math.min(100, Math.max(1, Math.trunc(limit)));
    const after = typeof afterEdgeId === "string" && afterEdgeId.length > 0 && afterEdgeId.length <= 200 ? afterEdgeId : "";
    const rows = this.db.prepare("SELECT * FROM kg_edges WHERE deleted_at IS NULL AND id>? ORDER BY id LIMIT ?").all(after, take) as EdgeRow[];
    let candidates_created = 0, candidates_updated = 0;
    for (const row of rows) {
      const edge = mapEdge(row), source = this.getNodeById(edge.source_id), target = this.getNodeById(edge.target_id);
      if (!source || !target) continue;
      const admission = validateRelationship(source, target, edge.type, 1, 0);
      if (!admission.accepted || admission.endpoint_match) continue;
      const evidence = this.evidenceForEdge(edge.id, 1, normalizedScope)[0];
      if (!evidence) continue;
      const existing = this.db.prepare("SELECT 1 AS present FROM kg_schema_drift_candidates WHERE scope=? AND source_entity_id=? AND target_entity_id=? AND relationship_type=? AND legacy_edge_id=?").get(normalizedScope, source.id, target.id, edge.type, edge.id) as { present?: number } | undefined;
      this.schemaDrift.recordLegacy({
        scope: normalizedScope, source, target, legacyEdgeId: edge.id,
        definition: semanticVocabularyRecommendation(edge.type, source.type, target.type).definition,
        relation: { source: source.name, target: target.name, type: edge.type, confidence: clamp01(evidence.confidence), evidence_span: evidence.quote.slice(0, 2000), valid_from: evidence.valid_from, valid_to: evidence.valid_to, temporal_confidence: evidence.temporal_confidence }
      });
      if (existing?.present) candidates_updated++; else candidates_created++;
    }
    return { scanned: rows.length, candidates_created, candidates_updated, ...(rows.length === take ? { next_edge_id: rows[rows.length - 1]!.id } : {}) };
  }

  /** Preview then explicitly admit a conservative structural replacement for
   * an observed endpoint mismatch.  The original extractor relation remains
   * non-admitted; this creates a separate, down-weighted audited fact only
   * when both endpoints have same-scope evidence. */
  previewSchemaDriftRepair(candidateId: string, replacementType: "depends_on" | "part_of" | "instance_of" | "related_to", scope = "default"): SchemaDriftRepairResult {
    const normalizedScope = normalizeScope(scope), candidate = this.schemaDrift.get(candidateId, normalizedScope);
    const basic = { confirmed: false, candidate_id: candidateId, replacement_type: replacementType } as const;
    if (!candidate) return { ...basic, preview_hash: "", eligible: false, reason: "missing_candidate" };
    const existing = this.schemaDrift.repair(candidateId, normalizedScope);
    if (existing) return { ...basic, preview_hash: existing.preview_hash, eligible: false, reason: "already_repaired", edge_id: existing.edge_id, observation_id: existing.observation_id, audit_id: existing.audit_id, ...(existing.retired_edge_id ? { retired_edge_id: existing.retired_edge_id } : {}) };
    const source = this.getNodeById(candidate.source_entity_id), target = this.getNodeById(candidate.target_entity_id);
    if (!source || source.deleted_at != null || !target || target.deleted_at != null) return { ...basic, preview_hash: "", eligible: false, reason: "missing_endpoint" };
    if (!this.hasNodeEvidenceInScope(source.id, normalizedScope) || !this.hasNodeEvidenceInScope(target.id, normalizedScope)) return { ...basic, preview_hash: "", eligible: false, reason: "missing_scope_evidence" };
    const legacy = candidate.legacy_edge_id ? this.activeLegacySchemaDriftEdge(candidate, normalizedScope) : undefined;
    if (candidate.legacy_edge_id && !legacy) return { ...basic, preview_hash: "", eligible: false, reason: "legacy_edge_changed" };
    const relation = this.schemaDrift.relation(candidateId, normalizedScope);
    if (!relation || relation.type !== candidate.relationship_type) return { ...basic, preview_hash: "", eligible: false, reason: "invalid_payload" };
    const snapshot = { candidate_id: candidate.id, scope: normalizedScope, replacement_type: replacementType, original_type: candidate.relationship_type, source_id: source.id, target_id: target.id, occurrence_count: candidate.occurrence_count, relation_confidence: clamp01(relation.confidence), legacy_edge: legacy ? { id: legacy.id, updated_at: legacy.updated_at } : null, graph_revision: this.graphRevision() };
    const previewHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    return { ...basic, preview_hash: previewHash, eligible: true };
  }

  confirmSchemaDriftRepair(candidateId: string, replacementType: "depends_on" | "part_of" | "instance_of" | "related_to", expectedPreviewHash: string, scope = "default"): SchemaDriftRepairResult {
    const normalizedScope = normalizeScope(scope), preview = this.previewSchemaDriftRepair(candidateId, replacementType, normalizedScope);
    if (!preview.eligible) return preview;
    if (!expectedPreviewHash || expectedPreviewHash !== preview.preview_hash) throw new Error("stale_schema_drift_repair_preview");
    const candidate = this.schemaDrift.get(candidateId, normalizedScope)!;
    const relation = this.schemaDrift.relation(candidateId, normalizedScope)!;
    const now = Date.now(), auditId = `schema-drift-repair:${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Recheck inside the write transaction: a second operator must not turn
      // the same candidate into duplicate evidence after a stale preview.
      const prior = this.schemaDrift.repair(candidateId, normalizedScope);
      if (prior) { this.db.exec("COMMIT"); return { confirmed: true, candidate_id: candidateId, replacement_type: replacementType, preview_hash: prior.preview_hash, eligible: false, reason: "already_repaired", edge_id: prior.edge_id, observation_id: prior.observation_id, audit_id: prior.audit_id, ...(prior.retired_edge_id ? { retired_edge_id: prior.retired_edge_id } : {}) }; }
      const source = this.getNodeById(candidate.source_entity_id), target = this.getNodeById(candidate.target_entity_id);
      if (!source || source.deleted_at != null || !target || target.deleted_at != null || !this.hasNodeEvidenceInScope(source.id, normalizedScope) || !this.hasNodeEvidenceInScope(target.id, normalizedScope)) throw new Error("schema_drift_repair_no_longer_eligible");
      const legacy = candidate.legacy_edge_id ? this.activeLegacySchemaDriftEdge(candidate, normalizedScope) : undefined;
      if (candidate.legacy_edge_id && !legacy) throw new Error("schema_drift_legacy_edge_changed");
      const edge = this.upsertEdge(source.id, target.id, replacementType, { schema_drift_repair: true, candidate_id: candidateId, original_type: candidate.relationship_type });
      const observation = this.insertObservation({ edgeId: edge.id, source: `schema-drift-repair:${candidateId}`, scope: normalizedScope, quote: relation.evidence_span.slice(0, 2000), confidence: clamp01(relation.confidence * .8), payload: { schema_drift_candidate_id: candidateId, original_type: candidate.relationship_type, replacement_type: replacementType, repaired: true }, temporal: relation });
      if (legacy && Number(this.db.prepare("UPDATE kg_edges SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(now, now, legacy.id).changes) !== 1) throw new Error("schema_drift_legacy_edge_changed");
      this.refreshEdgeWeight(edge.id); this.refreshNodeImportance(source.id); this.refreshNodeImportance(target.id);
      this.db.prepare("INSERT INTO kg_quality_audits(id,action,snapshot_version,snapshot,created_at) VALUES(?,?,1,?,?)").run(auditId, "confirm_schema_drift_repair", JSON.stringify({ candidate_id: candidateId, scope: normalizedScope, original_type: candidate.relationship_type, replacement_type: replacementType, preview_hash: preview.preview_hash, edge_id: edge.id, observation_id: observation.id, ...(legacy ? { retired_edge_id: legacy.id } : {}) }), now);
      this.db.prepare("INSERT INTO kg_schema_drift_repairs(candidate_id,scope,replacement_type,preview_hash,edge_id,observation_id,audit_id,retired_edge_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(candidateId, normalizedScope, replacementType, preview.preview_hash, edge.id, observation.id, auditId, legacy?.id ?? null, now);
      this.bumpGraphRevision();
      this.db.exec("COMMIT");
      return { confirmed: true, candidate_id: candidateId, replacement_type: replacementType, preview_hash: preview.preview_hash, eligible: true, edge_id: edge.id, observation_id: observation.id, audit_id: auditId, ...(legacy ? { retired_edge_id: legacy.id } : {}) };
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  cleanupAnomalies(edgeIds: string[], confirm = false, expectedPreviewHash?: string): QualityCleanupResult {
    const ids = [...new Set(edgeIds)].sort();
    const anomalies = new Map(this.reviewAnomalies({ limit: 100 }).items.map(item => [item.edge.id, item]));
    const selected = ids.map(id => anomalies.get(id)).filter((item): item is RelationshipAnomaly => item != null);
    if (selected.length !== ids.length) throw new Error("cleanup requires active relationship anomaly ids");
    const snapshot = selected.map(item => ({
      edge: item.edge,
      reason: item.reason,
      observations: this.db.prepare("SELECT * FROM kg_observations WHERE edge_id=? ORDER BY id").all(item.edge.id)
    }));
    const previewHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    if (!confirm) return { confirmed: false, preview_hash: previewHash, cleaned: 0, edge_ids: ids };
    if (!expectedPreviewHash || expectedPreviewHash !== previewHash) throw new Error("stale anomaly cleanup preview");
    const auditId = `quality:${randomUUID()}`;
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO kg_quality_audits(id,action,snapshot_version,snapshot,created_at) VALUES(?,?,1,?,?)")
        .run(auditId, "cleanup_relationship_anomalies", JSON.stringify(snapshot), now);
      let cleaned = 0;
      for (const id of ids) cleaned += Number(this.db.prepare("UPDATE kg_edges SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(now, now, id).changes);
      this.invalidateDetachedConflictCandidates(now);
      if (cleaned > 0) this.bumpGraphRevision();
      this.db.exec("COMMIT");
      return { confirmed: true, preview_hash: previewHash, cleaned, edge_ids: ids, audit_id: auditId };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  merge(canonicalId: string, duplicateId: string, confirm = false, expectedPreviewHash?: string): MergeResult {
    if (canonicalId === duplicateId) throw new Error("cannot merge an entity into itself");
    const canonical = this.getNodeById(canonicalId);
    const duplicate = this.getNodeById(duplicateId);
    if (!canonical || !duplicate) throw new Error("merge requires two active entities");
    if (canonical.type !== duplicate.type) throw new Error("merge requires compatible entity types");
    const movedObservations = Number((this.db.prepare("SELECT COUNT(*) count FROM kg_observations WHERE source_entity_id=?").get(duplicateId) as { count: number }).count);
    const affectedEdges = this.db.prepare("SELECT * FROM kg_edges WHERE source_id IN (?,?) OR target_id IN (?,?) ORDER BY id").all(canonicalId, duplicateId, canonicalId, duplicateId) as EdgeRow[];
    const affectedEdgeIds = affectedEdges.map(edge => edge.id);
    const affectedEdgeObservations = affectedEdgeIds.length
      ? this.db.prepare(`SELECT * FROM kg_observations WHERE edge_id IN (${affectedEdgeIds.map(() => "?").join(",")}) ORDER BY id`).all(...affectedEdgeIds)
      : [];
    const snapshot = {
      version: 1,
      canonical,
      duplicate,
      canonical_observations: this.db.prepare("SELECT * FROM kg_observations WHERE source_entity_id=? ORDER BY id").all(canonicalId),
      duplicate_observations: this.db.prepare("SELECT * FROM kg_observations WHERE source_entity_id=? ORDER BY id").all(duplicateId),
      affected_edges: affectedEdges,
      affected_edge_observations: affectedEdgeObservations,
      affected_candidates: this.db.prepare("SELECT * FROM kg_duplicate_candidates WHERE entity_a IN (?,?) OR entity_b IN (?,?) ORDER BY id").all(canonicalId, duplicateId, canonicalId, duplicateId),
      affected_conflict_candidates: affectedEdgeIds.length
        ? this.db.prepare(`SELECT * FROM kg_conflict_candidates WHERE edge_a IN (${affectedEdgeIds.map(() => "?").join(",")}) OR edge_b IN (${affectedEdgeIds.map(() => "?").join(",")}) ORDER BY id`).all(...affectedEdgeIds, ...affectedEdgeIds)
        : []
    };
    const duplicateEdges = (snapshot.affected_edges as EdgeRow[]).map(mapEdge).filter(edge => edge.source_id === duplicateId || edge.target_id === duplicateId);
    let deduplicatedEdges = 0;
    let removedSelfLoops = 0;
    for (const edge of duplicateEdges) {
      const sourceId = edge.source_id === duplicateId ? canonicalId : edge.source_id;
      const targetId = edge.target_id === duplicateId ? canonicalId : edge.target_id;
      if (sourceId === targetId) removedSelfLoops++;
      else if (this.db.prepare("SELECT 1 FROM kg_edges WHERE source_id=? AND target_id=? AND type=? AND id<>? AND deleted_at IS NULL").get(sourceId, targetId, edge.type, edge.id)) deduplicatedEdges++;
    }
    const previewHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const base = { confirmed: false, preview_hash: previewHash, canonical_entity_id: canonicalId, duplicate_entity_id: duplicateId, moved_observations: movedObservations, rewired_edges: duplicateEdges.length, deduplicated_edges: deduplicatedEdges, removed_self_loops: removedSelfLoops };
    if (!confirm) return base;
    if (!expectedPreviewHash || expectedPreviewHash !== previewHash) throw new Error("stale merge preview");
    const auditId = `merge:${randomUUID()}`;
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO kg_merge_audits(id,canonical_id,duplicate_id,status,snapshot_version,snapshot,preview_hash,created_at) VALUES(?,?,?,'merged',1,?,?,?)")
        .run(auditId, canonicalId, duplicateId, JSON.stringify(snapshot), previewHash, now);
      this.db.prepare("UPDATE kg_observations SET source_entity_id=? WHERE source_entity_id=?").run(canonicalId, duplicateId);
      const refreshEdges = new Set<string>();
      for (const edge of duplicateEdges) {
        const sourceId = edge.source_id === duplicateId ? canonicalId : edge.source_id;
        const targetId = edge.target_id === duplicateId ? canonicalId : edge.target_id;
        if (sourceId === targetId) {
          this.db.prepare("UPDATE kg_edges SET deleted_at=?,updated_at=? WHERE id=?").run(now, now, edge.id);
          continue;
        }
        const survivor = this.db.prepare("SELECT id FROM kg_edges WHERE source_id=? AND target_id=? AND type=? AND id<>? AND deleted_at IS NULL").get(sourceId, targetId, edge.type, edge.id) as { id: string } | undefined;
        if (survivor) {
          this.db.prepare("UPDATE kg_observations SET edge_id=? WHERE edge_id=?").run(survivor.id, edge.id);
          this.db.prepare("UPDATE kg_edges SET deleted_at=?,updated_at=? WHERE id=?").run(now, now, edge.id);
          refreshEdges.add(survivor.id);
          continue;
        }
        const newId = edgeId(sourceId, targetId, edge.type);
        this.db.prepare(`INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,NULL,?,?)`).run(newId, sourceId, targetId, edge.type, JSON.stringify(edge.edge_props), edge.weight, edge.created_at, now);
        this.db.prepare("UPDATE kg_observations SET edge_id=? WHERE edge_id=?").run(newId, edge.id);
        this.db.prepare("DELETE FROM kg_edges WHERE id=?").run(edge.id);
        refreshEdges.add(newId);
      }
      const aliases = uniqueStrings([...canonical.aliases, duplicate.name, ...duplicate.aliases]);
      this.db.prepare(`UPDATE kg_nodes SET aliases=?,embedding=NULL,embedding_provider=NULL,embedding_model=NULL,embedding_dimensions=NULL,
        embedding_input_version=NULL,embedded_at=NULL,updated_at=? WHERE id=?`).run(JSON.stringify(aliases), now, canonicalId);
      this.db.prepare("UPDATE kg_nodes SET deleted_at=?,updated_at=? WHERE id=?").run(now, now, duplicateId);
      this.db.prepare("INSERT INTO kg_entity_redirects(retired_id,canonical_id,audit_id,created_at) VALUES(?,?,?,?)").run(duplicateId, canonicalId, auditId, now);
      this.db.prepare("UPDATE kg_duplicate_candidates SET status='merged',reviewed_at=?,updated_at=? WHERE (entity_a=? OR entity_b=?) AND status='pending'")
        .run(now, now, duplicateId, duplicateId);
      this.db.prepare("DELETE FROM kg_nodes_fts WHERE id IN (?,?)").run(canonicalId, duplicateId);
      this.upsertFts(canonicalId);
      this.refreshNodeImportance(canonicalId);
      for (const edgeId of refreshEdges) this.refreshEdgeWeight(edgeId);
      this.invalidateDetachedConflictCandidates(now);
      this.bumpGraphRevision();
      this.db.exec("COMMIT");
      return { ...base, confirmed: true, audit_id: auditId };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  undoMerge(auditId: string, confirm = false, expectedPreviewHash?: string): MergeUndoResult {
    const audit = this.db.prepare("SELECT * FROM kg_merge_audits WHERE id=?").get(auditId) as { status: string; snapshot: string; canonical_id: string; duplicate_id: string } | undefined;
    if (!audit || audit.status !== "merged") throw new Error(`Active merge audit not found: ${auditId}`);
    const snapshot = JSON.parse(audit.snapshot) as {
      canonical: KgNode;
      duplicate: KgNode;
      canonical_observations: Array<{ id: string }>;
      duplicate_observations: Array<{ id: string }>;
      affected_edges: EdgeRow[];
      affected_edge_observations?: Array<{ id: string; edge_id: string; source_entity_id: string | null; payload: string; source: string; scope?: string; quote: string; confidence: number; valid_from: number | null; valid_to: number | null; temporal_confidence: number | null; created_at: number }>;
      affected_candidates?: CandidateRow[];
      affected_conflict_candidates?: ConflictCandidate[];
    };
    const currentCanonical = this.getNodeById(audit.canonical_id, true);
    const currentDuplicate = this.getNodeById(audit.duplicate_id, true);
    const conflicts: MergeUndoResult["conflicts"] = [];
    if (!currentCanonical) conflicts.push({ kind: "node", id: audit.canonical_id, reason: "canonical_missing" });
    if (!currentDuplicate?.deleted_at) conflicts.push({ kind: "node", id: audit.duplicate_id, reason: "duplicate_not_retired" });
    const expectedObservationIds = new Set([...snapshot.canonical_observations, ...snapshot.duplicate_observations].map(item => item.id));
    const currentObservations = this.db.prepare("SELECT id FROM kg_observations WHERE source_entity_id=? ORDER BY id").all(audit.canonical_id) as Array<{ id: string }>;
    for (const observation of currentObservations) {
      if (!expectedObservationIds.has(observation.id)) conflicts.push({ kind: "observation", id: observation.id, reason: "new_node_observation" });
    }
    const expectedEdgeIds = new Set<string>();
    for (const edgeRow of snapshot.affected_edges) {
      const edge = mapEdge(edgeRow);
      const sourceId = edge.source_id === audit.duplicate_id ? audit.canonical_id : edge.source_id;
      const targetId = edge.target_id === audit.duplicate_id ? audit.canonical_id : edge.target_id;
      if (sourceId !== targetId && edge.deleted_at == null) expectedEdgeIds.add(edgeId(sourceId, targetId, edge.type));
    }
    const currentEdges = this.db.prepare("SELECT id FROM kg_edges WHERE deleted_at IS NULL AND (source_id IN (?,?) OR target_id IN (?,?)) ORDER BY id")
      .all(audit.canonical_id, audit.duplicate_id, audit.canonical_id, audit.duplicate_id) as Array<{ id: string }>;
    for (const edge of currentEdges) {
      if (!expectedEdgeIds.has(edge.id)) conflicts.push({ kind: "edge", id: edge.id, reason: "new_edge" });
    }
    const expectedEdgeObservationIds = new Set((snapshot.affected_edge_observations ?? []).map(item => item.id));
    const currentEdgeObservations = this.db.prepare(`SELECT o.id FROM kg_observations o JOIN kg_edges e ON e.id=o.edge_id
      WHERE e.deleted_at IS NULL AND (e.source_id IN (?,?) OR e.target_id IN (?,?)) ORDER BY o.id`)
      .all(audit.canonical_id, audit.duplicate_id, audit.canonical_id, audit.duplicate_id) as Array<{ id: string }>;
    for (const observation of currentEdgeObservations) {
      if (!expectedEdgeObservationIds.has(observation.id)) conflicts.push({ kind: "observation", id: observation.id, reason: "new_edge_observation" });
    }
    const previewHash = createHash("sha256").update(JSON.stringify({ auditId, snapshot, currentCanonical, currentDuplicate, conflicts })).digest("hex");
    const base = { confirmed: false, preview_hash: previewHash, audit_id: auditId, conflicts, restored_nodes: 0, restored_edges: 0, restored_observations: 0 };
    if (!confirm) return base;
    if (conflicts.length) throw new Error("merge undo has conflicts");
    if (!expectedPreviewHash || expectedPreviewHash !== previewHash) throw new Error("stale merge undo preview");
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const node of [snapshot.canonical, snapshot.duplicate]) {
        this.db.prepare(`UPDATE kg_nodes SET type=?,name=?,description=?,aliases=?,importance=?,deleted_at=?,embedding=NULL,
          embedding_provider=NULL,embedding_model=NULL,embedding_dimensions=NULL,embedding_input_version=NULL,embedded_at=NULL,updated_at=? WHERE id=?`)
          .run(node.type, node.name, node.description, JSON.stringify(node.aliases), node.importance, node.deleted_at, now, node.id);
      }
      for (const observation of snapshot.canonical_observations) this.db.prepare("UPDATE kg_observations SET source_entity_id=? WHERE id=?").run(snapshot.canonical.id, observation.id);
      for (const observation of snapshot.duplicate_observations) this.db.prepare("UPDATE kg_observations SET source_entity_id=? WHERE id=?").run(snapshot.duplicate.id, observation.id);
      const edgeObservations = snapshot.affected_edge_observations ?? [];
      for (const observation of edgeObservations) this.db.prepare("DELETE FROM kg_observations WHERE id=?").run(observation.id);
      this.db.prepare("DELETE FROM kg_edges WHERE source_id IN (?,?) OR target_id IN (?,?)").run(snapshot.canonical.id, snapshot.duplicate.id, snapshot.canonical.id, snapshot.duplicate.id);
      for (const edge of snapshot.affected_edges) {
        this.db.prepare(`INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(edge.id, edge.source_id, edge.target_id, edge.type, edge.edge_props, edge.weight, edge.deleted_at, edge.created_at, edge.updated_at);
      }
      for (const observation of edgeObservations) {
        this.db.prepare(`INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,valid_from,valid_to,temporal_confidence,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(observation.id, observation.edge_id, observation.source_entity_id, observation.payload, observation.source, observation.scope ?? "default", observation.quote, observation.confidence, observation.valid_from, observation.valid_to, observation.temporal_confidence, observation.created_at);
      }
      for (const candidate of snapshot.affected_candidates ?? []) {
        this.db.prepare(`UPDATE kg_duplicate_candidates SET pair_key=?,entity_a=?,entity_b=?,signals=?,reasons=?,score=?,fingerprint_a=?,fingerprint_b=?,status=?,discovered_at=?,updated_at=?,reviewed_at=? WHERE id=?`)
          .run(candidate.pair_key, candidate.entity_a, candidate.entity_b, candidate.signals, candidate.reasons, candidate.score, candidate.fingerprint_a, candidate.fingerprint_b, candidate.status, candidate.discovered_at, candidate.updated_at, candidate.reviewed_at, candidate.id);
      }
      for (const candidate of snapshot.affected_conflict_candidates ?? []) {
        this.db.prepare(`INSERT OR REPLACE INTO kg_conflict_candidates(id,pair_key,edge_a,edge_b,observation_a,observation_b,category,overlap_from,overlap_to,confidence_a,confidence_b,source_count_a,source_count_b,fingerprint_a,fingerprint_b,preview_hash,status,discovered_at,updated_at,reviewed_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(candidate.id,candidate.pair_key,candidate.edge_a,candidate.edge_b,candidate.observation_a,candidate.observation_b,candidate.category,candidate.overlap_from,candidate.overlap_to,candidate.confidence_a,candidate.confidence_b,candidate.source_count_a,candidate.source_count_b,candidate.fingerprint_a,candidate.fingerprint_b,candidate.preview_hash,candidate.status,candidate.discovered_at,candidate.updated_at,candidate.reviewed_at);
      }
      this.db.prepare("DELETE FROM kg_entity_redirects WHERE retired_id=? AND audit_id=?").run(snapshot.duplicate.id, auditId);
      this.db.prepare("UPDATE kg_merge_audits SET status='undone',undone_at=? WHERE id=? AND status='merged'").run(now, auditId);
      this.db.prepare("DELETE FROM kg_nodes_fts WHERE id IN (?,?)").run(snapshot.canonical.id, snapshot.duplicate.id);
      this.upsertFts(snapshot.canonical.id);
      this.upsertFts(snapshot.duplicate.id);
      this.refreshNodeImportance(snapshot.canonical.id);
      this.refreshNodeImportance(snapshot.duplicate.id);
      for (const edge of snapshot.affected_edges) if (edge.deleted_at == null) this.refreshEdgeWeight(edge.id);
      this.bumpGraphRevision();
      this.db.exec("COMMIT");
      return { ...base, confirmed: true, restored_nodes: 2, restored_edges: snapshot.affected_edges.length, restored_observations: snapshot.canonical_observations.length + snapshot.duplicate_observations.length + edgeObservations.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ingestInTransaction(entities: ExtractedEntity[], relations: ExtractedRelation[], source: string, minConfidenceToStore: number, quality: RelationshipQualityPolicy, scope = "default"): IngestResult {
    const normalizedScope = normalizeScope(scope);
    this.touchScope(normalizedScope);
    const entityResults: IngestEntityResult[] = [];
    const relationResults: IngestRelationResult[] = [];
    const observations: KgObservation[] = [];
    const skipped_relations: SkippedRelation[] = [];
    const byName = new Map<string, KgNode>();
    for (const entity of entities) {
      if (!validConfidence(entity.confidence) || entity.confidence < minConfidenceToStore) continue;
      const { node, created } = this.upsertNode(entity);
      const observation = this.insertObservation({ sourceEntityId: node.id, source, scope: normalizedScope, quote: entity.evidence_span, confidence: entity.confidence, payload: { ...entity }, temporal: entity });
      this.refreshNodeImportance(node.id);
      // FTS5 cannot efficiently delete by its UNINDEXED external id.  A newly
      // allocated node has no prior FTS row, so skip the replace path here;
      // this keeps bulk ingestion linear instead of repeatedly scanning FTS.
      this.upsertFts(node.id, !created);
      const refreshed = this.getNodeById(node.id) ?? node;
      entityResults.push({ node: refreshed, observation });
      observations.push(observation);
      byName.set(entity.name, refreshed);
      byName.set(normalizeLookup(entity.name), refreshed);
    }
    for (const relation of relations) {
      if (!validConfidence(relation.confidence) || relation.confidence < minConfidenceToStore) continue;
      const sourceNode = this.resolveRelationEndpoint(relation.source, byName);
      const targetNode = this.resolveRelationEndpoint(relation.target, byName);
      if (!sourceNode || !targetNode || !relationshipDefinitions[relation.type]) continue;
      const admission = validateRelationship(sourceNode, targetNode, relation.type, relation.confidence, relationshipMinimum(relation.type, quality));
      if (!admission.accepted) {
        skipped_relations.push({ relation, reason: admission.reason });
        continue;
      }
      const recommendation = isSemanticRelationship(relation.type)
        ? semanticVocabularyRecommendation(relation.type, sourceNode.type, targetNode.type)
        : undefined;
      const edge = this.upsertEdge(sourceNode.id, targetNode.id, relation.type, {
        ...(relation.edge_props ?? {}),
        ...(recommendation ? { semantics: { version: 1, layer: "semantic", predicate: relation.type, domain: recommendation.domain, endpoint_match: recommendation.endpoint_match } } : {})
      });
      const observation = this.insertObservation({ edgeId: edge.id, source, scope: normalizedScope, quote: relation.evidence_span, confidence: relation.confidence, payload: { ...relation }, temporal: relation });
      this.refreshEdgeWeight(edge.id);
      relationResults.push({ edge: this.getEdgeById(edge.id) ?? edge, observation });
      observations.push(observation);
      if (recommendation) {
        this.semanticPatterns.record({ scope: normalizedScope, domain: recommendation.domain, sourceType: sourceNode.type, predicate: relation.type, targetType: targetNode.type });
        if (!recommendation.endpoint_match) this.schemaDrift.record({ scope: normalizedScope, source: sourceNode, target: targetNode, relation, definition: recommendation.definition });
      }
    }
    return { entities: entityResults, relations: relationResults, observations, skipped_relations };
  }

  lexicalCandidates(query: string, nodeType?: string, limit = 10, scope?: string): RankedNode[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const scopePredicate = "(? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.source_entity_id=kg_nodes.id AND so.scope=?))";
    const candidates = new Map<string, RankedNode>();
    const add = (node: KgNode, score: number) => {
      const prev = candidates.get(node.id);
      if (!prev || score > prev.score) candidates.set(node.id, { node, score });
    };

    const exactRows = this.db.prepare(`SELECT * FROM kg_nodes WHERE deleted_at IS NULL AND (? IS NULL OR type = ?) AND ${scopePredicate} AND (lower(name)=lower(?) OR lower(id)=lower(?)) LIMIT ?`).all(nodeType ?? null, nodeType ?? null, normalizedScope ?? null, normalizedScope ?? null, trimmed, trimmed, limit) as NodeRow[];
    for (const row of exactRows) add(mapNode(row), 1);

    const aliasRows = this.db.prepare(`SELECT DISTINCT n.* FROM kg_nodes n
      JOIN json_each(CASE WHEN json_valid(n.aliases) THEN n.aliases ELSE '[]' END) a
      WHERE n.deleted_at IS NULL AND (? IS NULL OR n.type=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.source_entity_id=n.id AND so.scope=?)) AND lower(CAST(a.value AS TEXT))=lower(?) LIMIT ?`)
      .all(nodeType ?? null, nodeType ?? null, normalizedScope ?? null, normalizedScope ?? null, trimmed, limit) as NodeRow[];
    for (const row of aliasRows) add(mapNode(row), .95);

    try {
      const ftsQuery = toFtsQuery(trimmed);
      if (ftsQuery) {
        const rows = this.db.prepare(`SELECT n.*, bm25(kg_nodes_fts) AS rank FROM kg_nodes_fts f JOIN kg_nodes n ON n.id=f.id WHERE kg_nodes_fts MATCH ? AND n.deleted_at IS NULL AND (? IS NULL OR n.type=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.source_entity_id=n.id AND so.scope=?)) ORDER BY rank LIMIT ?`).all(ftsQuery, nodeType ?? null, nodeType ?? null, normalizedScope ?? null, normalizedScope ?? null, limit) as Array<NodeRow & { rank: number }>;
        const ranks = rows.map(row => Number(row.rank ?? 0));
        const best = Math.min(...ranks), worst = Math.max(...ranks);
        rows.forEach((row, index) => add(mapNode(row), best === worst ? 1 : (worst - ranks[index]) / (worst - best)));
      }
    } catch {}

    const like = `%${escapeLike(trimmed)}%`;
    const likeRows = this.db.prepare(`SELECT * FROM kg_nodes WHERE deleted_at IS NULL AND (? IS NULL OR type = ?) AND ${scopePredicate} AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\') LIMIT ?`).all(nodeType ?? null, nodeType ?? null, normalizedScope ?? null, normalizedScope ?? null, like, like, like, like, limit) as NodeRow[];
    for (const row of likeRows) add(mapNode(row), .5);

    return [...candidates.values()]
      .sort((a, b) => b.score - a.score || b.node.importance - a.node.importance)
      .slice(0, limit)
  }

  search(query: string, nodeType?: string, limit = 10, scope?: string): KgSearchResult[] {
    return this.lexicalCandidates(query, nodeType, limit, scope).map(({ node, score }) => ({ node, score, evidence: this.evidenceForNode(node.id, 3, scope) }));
  }

  semanticCandidates(queryVector: number[], identity: EmbeddingIdentity, inputVersion: string, nodeType?: string, limit = 10, minimum = .35, maxScanNodes = 10000, scope?: string): RankedNode[] {
    const budget = Math.min(Math.max(0, Math.trunc(maxScanNodes)), Math.max(limit * 8, 64));
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const valid: Array<{ node: KgNode; vector: number[] }> = []; let afterId = ""; let scanned = 0;
    while (valid.length < budget && scanned < maxScanNodes) {
      const pageSize = Math.min(64, maxScanNodes - scanned);
      const rows = this.db.prepare(`SELECT * FROM kg_nodes WHERE deleted_at IS NULL AND embedding IS NOT NULL AND embedding_provider=? AND embedding_model=? AND embedding_dimensions=? AND embedding_input_version=? AND (? IS NULL OR type=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.source_entity_id=kg_nodes.id AND so.scope=?)) AND id>? ORDER BY id LIMIT ?`).all(identity.provider, identity.model, identity.dimensions, inputVersion, nodeType ?? null, nodeType ?? null, normalizedScope ?? null, normalizedScope ?? null, afterId, pageSize) as Array<NodeRow & { embedding: Uint8Array }>;
      if (!rows.length) break;
      scanned += rows.length; afterId = rows.at(-1)!.id;
      for (const row of rows) try { valid.push({ node: mapNode(row), vector: decodeEmbedding(row.embedding, identity.dimensions) }); } catch { /* isolate corruption */ }
    }
    return valid
      .map(({ node, vector }) => ({ node, score: (cosineSimilarity(queryVector, vector) + 1) / 2 }))
      .filter(({ score }) => score >= minimum)
      .sort((a, b) => b.score - a.score || b.node.importance - a.node.importance)
      .slice(0, limit);
  }

  embeddingCandidateCount(identity: EmbeddingIdentity, inputVersion: string, scope?: string): number {
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const row = this.db.prepare(`SELECT count(*) AS count FROM kg_nodes WHERE deleted_at IS NULL AND embedding IS NOT NULL AND embedding_provider=? AND embedding_model=? AND embedding_dimensions=? AND embedding_input_version=? AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.source_entity_id=kg_nodes.id AND so.scope=?))`).get(identity.provider, identity.model, identity.dimensions, inputVersion, normalizedScope ?? null, normalizedScope ?? null) as { count: number };
    return Number(row.count);
  }

  rankHybrid(input: { lexical: RankedNode[]; semantic: RankedNode[]; limit: number; now: number; weights?: { semantic: number; lexical: number; confidence: number; freshness: number }; scope?: string }): KgSearchResult[] {
    const weights = input.weights ?? { semantic: .45, lexical: .25, confidence: .20, freshness: .10 };
    const merged = new Map<string, { node: KgNode; lexical: number; semantic: number }>();
    for (const item of input.lexical) merged.set(item.node.id, { node: item.node, lexical: item.score, semantic: 0 });
    for (const item of input.semantic) {
      const current = merged.get(item.node.id);
      if (current) current.semantic = item.score; else merged.set(item.node.id, { node: item.node, lexical: 0, semantic: item.score });
    }
    return [...merged.values()].map(item => {
      const evidence = this.evidenceForNode(item.node.id, 3, input.scope);
      const confidence = evidence.length ? evidence.reduce((sum, e) => sum + e.confidence, 0) / evidence.length : 0;
      const freshness = Math.exp(-Math.log(2) * Math.max(0, input.now - item.node.updated_at) / 86400000 / 180);
      const score_components = { semantic: item.semantic, lexical: item.lexical, confidence, freshness };
      const score = weights.semantic * item.semantic + weights.lexical * item.lexical + weights.confidence * confidence + weights.freshness * freshness;
      return { node: item.node, evidence, score, score_components };
    }).sort((a, b) => b.score - a.score || b.node.importance - a.node.importance).slice(0, input.limit);
  }

  related(entity: string, depth = 1, edgeTypes?: RelationshipType[], direction?: Direction, scope?: string): KgRelatedResult {
    const root = this.resolveEntity(entity);
    if (!root) throw new Error(`Entity not found: ${entity}`);
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    // Nodes have global identities so the same company can accumulate evidence
    // from more than one collection.  A scoped traversal must still behave as
    // if the other collections do not exist: otherwise resolving the root by
    // name would reveal that a node is present elsewhere.
    if (normalizedScope && !this.hasGraphPresence(root.id, normalizedScope)) throw new Error(`Entity not found: ${entity}`);
    const maxDepth = Math.max(0, Math.min(depth, 5));
    // Semantic labels may be requested by their exact predicate, but never
    // participate in multi-hop topology traversal.  Omitting a predicate is
    // intentionally structural-only to prevent domain-label noise.
    const requested = edgeTypes?.length ? edgeTypes : undefined;
    const allowed = new Set((requested ?? structuralRelationshipTypes).filter(isStructuralRelationship));
    const requestedSemantic = new Set((requested ?? []).filter(isSemanticRelationship));
    const nodes = new Map<string, KgNode>([[root.id, root]]);
    const edgeResults = new Map<string, KgRelatedResult["edges"][number]>();
    const visitedAt = new Map<string, number>([[root.id, 0]]);
    const queue: Array<{ node: KgNode; depth: number }> = [{ node: root, depth: 0 }];

    const maxNodes = 200, maxEdges = 500;
    while (queue.length && nodes.size < maxNodes && edgeResults.size < maxEdges) {
      const current = queue.shift();
      if (!current || current.depth >= maxDepth) continue;
      for (const edge of this.edgesForNode(current.node.id, allowed, direction, normalizedScope).slice(0, maxEdges - edgeResults.size)) {
        const traversalDirection = edge.source_id === current.node.id ? "out" : "in";
        const nextId = traversalDirection === "out" ? edge.target_id : edge.source_id;
        const nextNode = this.getNodeById(nextId);
        const sourceNode = this.getNodeById(edge.source_id);
        const targetNode = this.getNodeById(edge.target_id);
        if (!nextNode || !sourceNode || !targetNode) continue;
        if (!nodes.has(nextNode.id) && nodes.size >= maxNodes) continue;
        nodes.set(nextNode.id, nextNode);
        edgeResults.set(`${edge.id}:${current.node.id}:${traversalDirection}`, { edge, source: sourceNode, target: targetNode, traversal_direction: traversalDirection, evidence: this.evidenceForEdge(edge.id, 3, normalizedScope) });
        const nextDepth = current.depth + 1;
        const prevDepth = visitedAt.get(nextNode.id);
        if (prevDepth == null || nextDepth < prevDepth) {
          visitedAt.set(nextNode.id, nextDepth);
          queue.push({ node: nextNode, depth: nextDepth });
        }
      }
    }
    const semantic_labels = requestedSemantic.size
      ? this.semanticLabelsForNode(root.id, requestedSemantic, normalizedScope, 100, direction)
      : [];
    for (const label of semantic_labels) {
      nodes.set(label.source.id, label.source);
      nodes.set(label.target.id, label.target);
    }
    semantic_labels.sort((a, b) => b.score - a.score || a.predicate.localeCompare(b.predicate) || a.id.localeCompare(b.id));
    return { root, nodes: [...nodes.values()].sort((a,b) => b.importance - a.importance || a.name.localeCompare(b.name)), edges: [...edgeResults.values()].sort((a,b) => b.edge.weight - a.edge.weight || a.edge.type.localeCompare(b.edge.type)), semantic_labels };
  }

  context(query: string, options: { maxNodes?: number; maxDepth?: number; confidenceThreshold?: number; tokenBudget?: number; scope?: string } = {}): KgContextResult {
    const maxNodes = clampInt(options.maxNodes ?? 5, 1, 20);
    return this.contextFromSeeds(query, this.search(query, undefined, maxNodes, options.scope), options);
  }

  contextFromSeeds(query: string, nodes: KgSearchResult[], options: { maxDepth?: number; confidenceThreshold?: number; tokenBudget?: number; scope?: string; memories?: KgMemorySearchResult[] } = {}): KgContextResult {
    const maxDepth = clampInt(options.maxDepth ?? 1, 0, 5);
    const confidenceThreshold = clamp01(options.confidenceThreshold ?? 0);
    const tokenBudget = clampInt(options.tokenBudget ?? 800, 100, 8000);
    const edges = new Map<string, KgRelatedResult["edges"][number]>();
    const semanticLabels = new Map<string, RelatedSemanticLabelResult>();
    const sourceNames = new Set<string>();
    const requestedSemantic = semanticPredicatesForQuery(query);

    const boundedNodes = nodes.slice(0, 50);
    let projectionTruncated = nodes.length > boundedNodes.length;
      for (const result of boundedNodes) {
      for (const evidence of result.evidence) sourceNames.add(evidence.source);
      const related = this.related(result.node.id, maxDepth, undefined, undefined, options.scope);
      for (const edge of related.edges) {
        const filteredEvidence = edge.evidence.filter((evidence) => evidence.confidence >= confidenceThreshold);
        if (filteredEvidence.length === 0) continue;
        for (const evidence of filteredEvidence) sourceNames.add(evidence.source);
        if (!edges.has(edge.edge.id) && edges.size >= 500) { projectionTruncated = true; continue; }
        edges.set(edge.edge.id, { ...edge, evidence: filteredEvidence });
      }
      if (requestedSemantic.size) for (const label of this.semanticLabelsForNode(result.node.id, requestedSemantic, options.scope, 20)) {
        const evidence = label.evidence.filter(item => item.confidence >= confidenceThreshold);
        if (!evidence.length) continue;
        for (const item of evidence) sourceNames.add(item.source);
        semanticLabels.set(label.id, { ...label, evidence });
      }
    }

    const rankedEdges = [...edges.values()].sort((a, b) =>
      contextEdgeScore(b.edge) - contextEdgeScore(a.edge)
      || b.evidence[0].confidence - a.evidence[0].confidence
      || a.edge.type.localeCompare(b.edge.type));
    const sources = this.sources({ sources: [...sourceNames], scope: options.scope });
    const memories = options.memories ?? [];
    const labels = [...semanticLabels.values()].sort((a, b) => b.score - a.score || a.predicate.localeCompare(b.predicate) || a.id.localeCompare(b.id)).slice(0, 50);
    const rendered = renderContext({ query, nodes, edges: rankedEdges, semanticLabels: labels, sources, memories, tokenBudget });
    return { query, context: rendered.context, nodes: boundedNodes, edges: rankedEdges, semantic_labels: labels, sources, ...(memories.length ? { memories } : {}), truncated: rendered.truncated || projectionTruncated };
  }

  sources(options: { sources?: string[]; limit?: number; scope?: string } = {}): KgSourceSummary[] {
    const limit = clampInt(options.limit ?? 20, 1, 100);
    const scope = options.scope == null ? undefined : normalizeScope(options.scope);
    if (options.sources?.length) {
      const sourceSet = new Set(options.sources.filter((source) => source.trim().length > 0));
      if (sourceSet.size === 0) return [];
      return [...sourceSet]
        .flatMap((source) => this.sourceSummary(source, scope))
        .sort((a, b) => b.last_seen_at - a.last_seen_at || b.average_confidence - a.average_confidence)
        .slice(0, limit);
    }
    const rows = this.db.prepare(`
      SELECT source, COUNT(*) AS observations, AVG(confidence) AS average_confidence, MIN(created_at) AS first_seen_at, MAX(created_at) AS last_seen_at
      FROM kg_observations WHERE (? IS NULL OR scope=?)
      GROUP BY source
      ORDER BY last_seen_at DESC, average_confidence DESC
      LIMIT ?
    `).all(scope ?? null, scope ?? null, limit) as Array<{ source: string; observations: number; average_confidence: number; first_seen_at: number; last_seen_at: number }>;
    return rows.map(mapSourceSummary);
  }

  upsertMemoryDocument(input: { content: string; title?: string; source?: string; scope?: string; metadata?: Record<string, string | number | boolean | null> }): KgMemoryDocument {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const document = this.writeMemoryDocument(input);
      this.db.exec("COMMIT");
      return document;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  listMemoryDocumentsForExchange(scope: string, limit: number): KgMemoryDocument[] {
    const rows = this.db.prepare("SELECT * FROM kg_memory_documents WHERE scope=? ORDER BY id LIMIT ?")
      .all(normalizeScope(scope), Math.max(0, Math.trunc(limit))) as Array<Record<string, unknown>>;
    return rows.map(mapMemoryDocument);
  }

  memoryScopeUpdatedAt(scope: string): number {
    const row = this.db.prepare("SELECT updated_at FROM kg_scopes WHERE id=?").get(normalizeScope(scope)) as { updated_at?: number } | undefined;
    return Number(row?.updated_at ?? 0);
  }

  saveMemoryImportPreview(input: { preview_hash: string; scope: string; scope_updated_at: number; summary: string; payload_hash: string }): void {
    this.db.prepare(`INSERT OR REPLACE INTO kg_memory_import_previews(preview_hash,scope,scope_updated_at,summary,payload_hash,created_at)
      VALUES(?,?,?,?,?,?)`).run(input.preview_hash, normalizeScope(input.scope), input.scope_updated_at, input.summary, input.payload_hash, Date.now());
  }

  getMemoryImportPreview(previewHash: string): { scope: string; scope_updated_at: number; payload_hash: string } | undefined {
    const row = this.db.prepare("SELECT scope,scope_updated_at,payload_hash FROM kg_memory_import_previews WHERE preview_hash=?").get(previewHash) as { scope: string; scope_updated_at: number; payload_hash: string } | undefined;
    return row ? { scope: String(row.scope), scope_updated_at: Number(row.scope_updated_at), payload_hash: String(row.payload_hash) } : undefined;
  }

  deleteMemoryImportPreview(previewHash: string): void { this.db.prepare("DELETE FROM kg_memory_import_previews WHERE preview_hash=?").run(previewHash); }

  importMemoryDocuments(input: { scope: string; payload_hash: string; documents: Array<{ title: string; content: string; source: string; metadata: Record<string, string | number | boolean | null>; lifecycle_state: "active" | "archived" }> }): { audit_id: string; imported: number; archived: number } {
    const scope = normalizeScope(input.scope);
    if (!input.documents.length || input.documents.length > 1000) throw new Error("invalid_memory_import");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let archived = 0;
      for (const document of input.documents) {
        const stored = this.writeMemoryDocument({ ...document, scope });
        if (document.lifecycle_state === "archived") {
          this.db.prepare("UPDATE kg_memory_documents SET lifecycle_state='archived',archived_at=COALESCE(archived_at,?),updated_at=? WHERE id=? AND scope=?")
            .run(Date.now(), Date.now(), stored.id, scope);
          archived++;
        }
      }
      const auditId = `memory-import:${randomUUID()}`;
      const now = Date.now();
      this.db.prepare("INSERT INTO kg_memory_import_audits(id,scope,payload_hash,imported_count,archived_count,created_at) VALUES(?,?,?,?,?,?)")
        .run(auditId, scope, input.payload_hash, input.documents.length, archived, now);
      this.db.exec("COMMIT");
      return { audit_id: auditId, imported: input.documents.length, archived };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private writeMemoryDocument(input: { content: string; title?: string; source?: string; scope?: string; metadata?: Record<string, string | number | boolean | null> }): KgMemoryDocument {
    const content = typeof input.content === "string" ? input.content.trim() : "";
    if (!content || content.length > 100000) throw new Error("invalid_memory_document");
    const scope = normalizeScope(input.scope);
    const source = canonicalizeIngestionSource(typeof input.source === "string" ? input.source : undefined, "memory:manual");
    const title = (typeof input.title === "string" && input.title.trim() ? input.title.trim() : content.replace(/\s+/g, " ").slice(0, 160)).slice(0, 200);
    const metadata = Object.fromEntries(Object.entries(input.metadata ?? {}).filter(([, value]) => value == null || ["string", "number", "boolean"].includes(typeof value))) as Record<string, string | number | boolean | null>;
    const contentHash = createHash("sha256").update(content).digest("hex");
    const id = `memory:${createHash("sha256").update(`${scope}\0${source}\0${contentHash}`).digest("hex").slice(0, 24)}`;
    const now = Date.now();
    this.touchScope(scope);
    this.db.prepare(`INSERT INTO kg_memory_documents(id,scope,title,content,source,metadata,content_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,metadata=excluded.metadata,updated_at=excluded.updated_at`)
      .run(id, scope, title, content, source, JSON.stringify(metadata), contentHash, now, now);
    this.db.prepare("DELETE FROM kg_memory_documents_fts WHERE id=?").run(id);
    this.db.prepare("INSERT INTO kg_memory_documents_fts(id,title,content) VALUES(?,?,?)").run(id, title, content);
    this.ensureMemoryChunksForDocument({ id, scope, content, content_hash: contentHash }, now);
    const row = this.db.prepare("SELECT * FROM kg_memory_documents WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("memory_document_persistence_failed");
    return mapMemoryDocument(row);
  }

  previewMemoryLifecycle(input: { action: MemoryLifecycleAction; document_id: string; scope?: string }): KgMemoryLifecyclePreview {
    const snapshot = this.memoryLifecycleSnapshot(input.action, input.document_id, input.scope);
    return { confirmed: false, action: input.action, preview_hash: snapshot.preview_hash, document: snapshot.document, affected_chunks: snapshot.affected_chunks };
  }

  confirmMemoryLifecycle(input: { action: MemoryLifecycleAction; document_id: string; scope?: string; preview_hash: string }): KgMemoryLifecycleConfirm {
    if (!/^[a-f0-9]{64}$/.test(input.preview_hash)) throw new Error("invalid_memory_lifecycle_preview");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const snapshot = this.memoryLifecycleSnapshot(input.action, input.document_id, input.scope);
      if (snapshot.preview_hash !== input.preview_hash) throw new Error("stale_memory_lifecycle_preview");
      const now = Date.now();
      const toState = input.action === "archive" ? "archived" : input.action === "recover" ? "active" : "deleted";
      if (input.action === "archive") {
        const changed = this.db.prepare("UPDATE kg_memory_documents SET lifecycle_state='archived',archived_at=?,updated_at=? WHERE id=? AND scope=? AND lifecycle_state='active'")
          .run(now, now, snapshot.document.id, snapshot.document.scope);
        if (Number(changed.changes) !== 1) throw new Error("stale_memory_lifecycle_preview");
      } else if (input.action === "recover") {
        const changed = this.db.prepare("UPDATE kg_memory_documents SET lifecycle_state='active',archived_at=NULL,updated_at=? WHERE id=? AND scope=? AND lifecycle_state='archived'")
          .run(now, snapshot.document.id, snapshot.document.scope);
        if (Number(changed.changes) !== 1) throw new Error("stale_memory_lifecycle_preview");
      } else {
        const chunkRows = this.db.prepare("SELECT id FROM kg_memory_chunks WHERE document_id=? ORDER BY id").all(snapshot.document.id) as Array<{ id: string }>;
        this.db.prepare("DELETE FROM kg_memory_documents_fts WHERE id=?").run(snapshot.document.id);
        for (const chunk of chunkRows) this.db.prepare("DELETE FROM kg_memory_chunks_fts WHERE id=?").run(chunk.id);
        const changed = this.db.prepare("DELETE FROM kg_memory_documents WHERE id=? AND scope=?").run(snapshot.document.id, snapshot.document.scope);
        if (Number(changed.changes) !== 1) throw new Error("stale_memory_lifecycle_preview");
      }
      const auditId = `memory-lifecycle:${randomUUID()}`;
      this.db.prepare(`INSERT INTO kg_memory_lifecycle_audits(id,document_id,scope,action,from_state,to_state,content_hash,source_hash,document_updated_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(auditId, snapshot.document.id, snapshot.document.scope, input.action, snapshot.document.lifecycle_state, toState, snapshot.document.content_hash, snapshot.source_hash, snapshot.document.updated_at, now);
      this.touchScope(snapshot.document.scope);
      this.db.exec("COMMIT");
      return { confirmed: true, action: input.action, document_id: snapshot.document.id, scope: snapshot.document.scope, audit_id: auditId };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  reviewMemoryExpiry(input: { scope?: string; older_than_days?: number; limit?: number; after_id?: string } = {}): KgMemoryExpiryReview {
    const scope = normalizeScope(input.scope);
    const olderThanDays = clampInt(input.older_than_days ?? 90, 1, 36500);
    const limit = clampInt(input.limit ?? 20, 1, 100);
    const afterId = typeof input.after_id === "string" ? input.after_id : "";
    const now = Date.now();
    const threshold = now - olderThanDays * 86_400_000;
    const rows = this.db.prepare(`SELECT id,scope,title,updated_at FROM kg_memory_documents
      WHERE scope=? AND lifecycle_state='active' AND updated_at<=? AND id>? ORDER BY id LIMIT ?`)
      .all(scope, threshold, afterId, limit + 1) as Array<{ id: string; scope: string; title: string; updated_at: number }>;
    const truncated = rows.length > limit;
    const items = rows.slice(0, limit).map(row => ({ id: String(row.id), scope: String(row.scope), title: String(row.title).slice(0, 200), updated_at: Number(row.updated_at), age_days: Math.max(0, Math.floor((now - Number(row.updated_at)) / 86_400_000)) }));
    return { items, next_after_id: truncated ? items.at(-1)?.id ?? null : null, truncated };
  }

  listMemoryLifecycleAudits(input: { scope?: string; limit?: number } = {}): KgMemoryLifecycleAudit[] {
    const scope = normalizeScope(input.scope);
    const limit = clampInt(input.limit ?? 20, 1, 100);
    const rows = this.db.prepare(`SELECT id,document_id,scope,action,from_state,to_state,content_hash,created_at
      FROM kg_memory_lifecycle_audits WHERE scope=? ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(scope, limit) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: String(row.id), document_id: String(row.document_id), scope: String(row.scope), action: String(row.action) as MemoryLifecycleAction, from_state: String(row.from_state) as "active" | "archived", to_state: String(row.to_state) as "active" | "archived" | "deleted", content_hash: String(row.content_hash), created_at: Number(row.created_at) }));
  }

  private memoryLifecycleSnapshot(action: MemoryLifecycleAction, documentId: string, scope?: string): { preview_hash: string; document: KgMemoryLifecyclePreview["document"]; affected_chunks: number; source_hash: string } {
    if (action !== "archive" && action !== "recover" && action !== "delete") throw new Error("invalid_memory_lifecycle_action");
    const id = typeof documentId === "string" ? documentId.trim() : "";
    if (!/^memory:[a-f0-9]{24}$/.test(id)) throw new Error("invalid_memory_document_id");
    const normalizedScope = normalizeScope(scope);
    const row = this.db.prepare(`SELECT d.*,COUNT(c.id) AS affected_chunks FROM kg_memory_documents d
      LEFT JOIN kg_memory_chunks c ON c.document_id=d.id WHERE d.id=? AND d.scope=? GROUP BY d.id`).get(id, normalizedScope) as Record<string, unknown> | undefined;
    if (!row) throw new Error("memory_document_not_found");
    const mapped = mapMemoryDocument(row);
    if (action === "archive" && mapped.lifecycle_state !== "active") throw new Error("memory_document_not_active");
    if (action === "recover" && mapped.lifecycle_state !== "archived") throw new Error("memory_document_not_archived");
    const document: KgMemoryLifecyclePreview["document"] = { id: mapped.id, scope: mapped.scope, title: mapped.title.slice(0, 200), lifecycle_state: mapped.lifecycle_state, content_hash: mapped.content_hash, updated_at: mapped.updated_at };
    const affected_chunks = Number(row.affected_chunks ?? 0);
    const source_hash = createHash("sha256").update(mapped.source).digest("hex");
    const preview_hash = createHash("sha256").update(JSON.stringify({ version: 1, action, document, affected_chunks, source_hash })).digest("hex");
    return { preview_hash, document, affected_chunks, source_hash };
  }

  searchMemoryDocuments(query: string, scope = "default", limit = 3, tags: readonly string[] = []): KgMemorySearchResult[] {
    const normalizedScope = normalizeScope(scope);
    const bounded = clampInt(limit, 1, 10);
    const trimmed = query.trim();
    const normalizedTags = [...new Set(tags.map(tag => tag.trim().toLocaleLowerCase()).filter(Boolean))].slice(0, 4);
    if (!trimmed && !normalizedTags.length) return [];
    const found = new Map<string, { row: Record<string, unknown>; excerpt: string; score: number }>();
    const add = (row: Record<string, unknown>, excerpt: string, score: number) => {
      const id = String(row.id);
      const previous = found.get(id);
      if (!previous || score > previous.score) found.set(id, { row, excerpt, score });
    };
    try {
      const ftsQuery = trimmed ? toFtsQuery(trimmed) : "";
      if (ftsQuery) {
        const tagPredicate = this.memoryDocumentTagPredicate(normalizedTags, "d");
        const rows = this.db.prepare(`SELECT d.*,c.content AS chunk_content,bm25(kg_memory_chunks_fts) AS rank FROM kg_memory_chunks_fts f
          JOIN kg_memory_chunks c ON c.id=f.id JOIN kg_memory_documents d ON d.id=c.document_id
          WHERE kg_memory_chunks_fts MATCH ? AND d.scope=? AND d.lifecycle_state='active'${tagPredicate.sql} ORDER BY rank LIMIT ?`)
          .all(ftsQuery, normalizedScope, ...tagPredicate.parameters, bounded * (normalizedTags.length ? 32 : 4)) as Array<Record<string, unknown> & { rank: number }>;
        const ranks = rows.map(row => Number(row.rank ?? 0));
        const best = Math.min(...ranks), worst = Math.max(...ranks);
        rows.forEach((row, index) => add(row, String(row.chunk_content ?? row.content), best === worst ? 1 : (worst - ranks[index]) / (worst - best)));
      }
    } catch { /* FTS can reject punctuation-only input; LIKE remains a safe fallback. */ }
    const like = `%${escapeLike(trimmed)}%`;
    const tagPredicate = this.memoryDocumentTagPredicate(normalizedTags, "d");
    const fallback = this.db.prepare(`SELECT d.*,c.content AS chunk_content FROM kg_memory_documents d
      JOIN kg_memory_chunks c ON c.document_id=d.id
      WHERE d.scope=? AND d.lifecycle_state='active' AND (?='' OR d.title LIKE ? ESCAPE '\\' OR c.content LIKE ? ESCAPE '\\')${tagPredicate.sql} ORDER BY d.updated_at DESC,d.id,c.ordinal LIMIT ?`)
      .all(normalizedScope, trimmed, like, like, ...tagPredicate.parameters, bounded * (normalizedTags.length ? 32 : 4)) as Array<Record<string, unknown>>;
    for (const row of fallback) add(row, String(row.chunk_content ?? row.content), .5);
    return [...found.values()].sort((a, b) => b.score - a.score || Number(b.row.updated_at) - Number(a.row.updated_at) || String(a.row.id).localeCompare(String(b.row.id)))
      .map(({ row, excerpt, score }) => memorySearchResult(mapMemoryDocument(row), score, trimmed, excerpt, { lexical: score, semantic: 0 }))
      .filter(item => memoryMatchesTags(item.metadata, normalizedTags)).slice(0, bounded);
  }

  /** Metadata tags are scalar by contract. Apply their documented token
   * matching semantics before each SQL recency/rank limit, then keep the
   * JavaScript matcher above as the final contract check. */
  private memoryDocumentTagPredicate(tags: readonly string[], alias: string): { sql: string; parameters: string[] } {
    if (!tags.length) return { sql: "", parameters: [] };
    const clauses = tags.map(() => `EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(${alias}.metadata) THEN ${alias}.metadata ELSE '{}' END) AS metadata_field
      WHERE metadata_field.key IN ('tag','tags','category')
        AND instr(
          ' ' || replace(replace(replace(replace(replace(replace(lower(CAST(metadata_field.value AS TEXT)), ',', ' '), ';', ' '), '|', ' '), char(9), ' '), char(10), ' '), char(13), ' ') || ' ',
          ' ' || ? || ' '
        ) > 0
    )`).join(" AND ");
    return { sql: ` AND ${clauses}`, parameters: [...tags] };
  }

  listStaleMemoryChunks(identity: Omit<EmbeddingIdentity, "dimensions">, inputVersion: string, afterId = "", limit = 100, scope?: string): KgMemoryChunk[] {
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const rows = this.db.prepare(`SELECT c.*,d.title AS document_title FROM kg_memory_chunks c JOIN kg_memory_documents d ON d.id=c.document_id WHERE c.id>? AND d.lifecycle_state='active' AND (? IS NULL OR c.scope=?) AND (c.embedding IS NULL OR c.embedding_provider IS NOT ? OR c.embedding_model IS NOT ? OR c.embedding_input_version IS NOT ? OR c.embedded_at IS NULL OR c.embedded_at < c.updated_at) ORDER BY c.id LIMIT ?`)
      .all(afterId, normalizedScope ?? null, normalizedScope ?? null, identity.provider, identity.model, inputVersion, Math.max(0, Math.trunc(limit))) as Array<Record<string, unknown>>;
    return rows.map(mapMemoryChunk);
  }

  putMemoryChunkEmbedding(chunkId: string, identity: EmbeddingIdentity, inputVersion: string, vector: number[], embeddedAt = Date.now()): void {
    const encoded = encodeEmbedding(vector);
    if (vector.length !== identity.dimensions) throw new Error("embedding dimensions do not match identity");
    const result = this.db.prepare(`UPDATE kg_memory_chunks SET embedding=?,embedding_provider=?,embedding_model=?,embedding_dimensions=?,embedding_input_version=?,embedded_at=? WHERE id=?`)
      .run(encoded, identity.provider, identity.model, identity.dimensions, inputVersion, embeddedAt, chunkId);
    if (Number(result.changes) !== 1) throw new Error("memory embedding persistence failed: chunk not found");
  }

  memoryEmbeddingCandidateCount(identity: EmbeddingIdentity, inputVersion: string, scope: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM kg_memory_chunks c JOIN kg_memory_documents d ON d.id=c.document_id WHERE c.scope=? AND d.lifecycle_state='active' AND c.embedding IS NOT NULL AND c.embedding_provider=? AND c.embedding_model=? AND c.embedding_dimensions=? AND c.embedding_input_version=?`)
      .get(normalizeScope(scope), identity.provider, identity.model, identity.dimensions, inputVersion) as { count: number };
    return Number(row.count);
  }

  semanticMemorySearch(queryVector: number[], identity: EmbeddingIdentity, inputVersion: string, scope: string, limit = 3, minimum = .35, maxScanChunks = 10000): KgMemorySearchResult[] {
    const normalizedScope = normalizeScope(scope);
    const bounded = clampInt(limit, 1, 10);
    const scanLimit = Math.min(Math.max(0, Math.trunc(maxScanChunks)), Math.max(bounded * 8, 64));
    const valid: Array<{ document: KgMemoryDocument; chunk: KgMemoryChunk; vector: number[] }> = [];
    let afterId = "", scanned = 0;
    while (valid.length < scanLimit && scanned < maxScanChunks) {
      const pageSize = Math.min(64, maxScanChunks - scanned);
      const rows = this.db.prepare(`SELECT d.*,c.id AS chunk_id,c.ordinal AS chunk_ordinal,c.content AS chunk_content,c.content_hash AS chunk_content_hash,c.embedding AS chunk_embedding,c.embedding_dimensions AS chunk_embedding_dimensions
        FROM kg_memory_chunks c JOIN kg_memory_documents d ON d.id=c.document_id
        WHERE c.scope=? AND d.lifecycle_state='active' AND c.embedding IS NOT NULL AND c.embedding_provider=? AND c.embedding_model=? AND c.embedding_dimensions=? AND c.embedding_input_version=? AND c.id>?
        ORDER BY c.id LIMIT ?`).all(normalizedScope, identity.provider, identity.model, identity.dimensions, inputVersion, afterId, pageSize) as Array<Record<string, unknown>>;
      if (!rows.length) break;
      scanned += rows.length; afterId = String(rows.at(-1)!.chunk_id);
      for (const row of rows) {
        try {
          valid.push({ document: mapMemoryDocument(row), chunk: mapMemoryChunkFromDocumentRow(row), vector: decodeEmbedding(row.chunk_embedding as Uint8Array, Number(row.chunk_embedding_dimensions)) });
        } catch { /* A corrupt chunk must not block local lexical recall. */ }
      }
    }
    const found = new Map<string, { document: KgMemoryDocument; chunk: KgMemoryChunk; score: number }>();
    for (const item of valid) {
      const score = (cosineSimilarity(queryVector, item.vector) + 1) / 2;
      if (score < minimum) continue;
      const previous = found.get(item.document.id);
      if (!previous || score > previous.score) found.set(item.document.id, { ...item, score });
    }
    return [...found.values()].sort((a, b) => b.score - a.score || b.document.updated_at - a.document.updated_at || a.document.id.localeCompare(b.document.id))
      .slice(0, bounded).map(({ document, chunk, score }) => memorySearchResult(document, score, "", chunk.content, { lexical: 0, semantic: score }));
  }

  listScopes(limit = 50): KgScopeSummary[] {
    const bounded = clampInt(limit, 1, 100);
    const rows = this.db.prepare(`SELECT s.id,
      (SELECT COUNT(*) FROM kg_observations o WHERE o.scope=s.id) AS observations,
      (SELECT COUNT(*) FROM kg_memory_documents d WHERE d.scope=s.id AND d.lifecycle_state='active') AS memory_documents,
      MAX(s.updated_at,COALESCE((SELECT MAX(created_at) FROM kg_observations o WHERE o.scope=s.id),0),COALESCE((SELECT MAX(updated_at) FROM kg_memory_documents d WHERE d.scope=s.id AND d.lifecycle_state='active'),0)) AS updated_at
      FROM kg_scopes s ORDER BY updated_at DESC,s.id LIMIT ?`).all(bounded) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: String(row.id), observations: Number(row.observations), memory_documents: Number(row.memory_documents), updated_at: Number(row.updated_at) }));
  }

  stats(): KgStatsResult {
    const nodeRows = this.db.prepare("SELECT type, COUNT(*) AS count FROM kg_nodes WHERE deleted_at IS NULL GROUP BY type").all() as Array<{ type: string; count: number }>;
    const edgeRows = this.db.prepare("SELECT type, COUNT(*) AS count FROM kg_edges WHERE deleted_at IS NULL GROUP BY type").all() as Array<{ type: string; count: number }>;
    const observations = this.db.prepare("SELECT COUNT(*) AS count FROM kg_observations").get() as { count: number };
    const updated = this.db.prepare(`SELECT MAX(updated_at) AS updated_at FROM (SELECT updated_at FROM kg_nodes UNION ALL SELECT updated_at FROM kg_edges)`).get() as { updated_at: number | null };
    const byTypeNodes = Object.fromEntries(nodeRows.map((row) => [row.type, Number(row.count)]));
    const byTypeEdges = Object.fromEntries(edgeRows.map((row) => [row.type, Number(row.count)]));
    const nodeTotal = nodeRows.reduce((sum, row) => sum + Number(row.count), 0);
    const edgeTotal = edgeRows.reduce((sum, row) => sum + Number(row.count), 0);
    const structuralEdges = edgeRows.reduce((sum, row) => sum + (row.type in relationshipDefinitions && isStructuralRelationship(row.type as RelationshipType) ? Number(row.count) : 0), 0);
    return {
      nodes: { total: nodeTotal, by_type: byTypeNodes },
      edges: { total: edgeTotal, by_type: byTypeEdges, by_layer: { structural: structuralEdges, semantic: edgeTotal - structuralEdges } },
      observations: { total: Number(observations.count) },
      density: nodeTotal > 1 ? structuralEdges / (nodeTotal * (nodeTotal - 1)) : 0,
      updated_at: updated.updated_at
    };
  }
  recordAutoMetric(feature: "extract" | "recall", outcome: "succeeded" | "failed", at = Date.now()): void {
    const day = Math.floor(at / 86400000);
    this.db.prepare("INSERT INTO kg_auto_metrics(day,feature,outcome,count) VALUES(?,?,?,1) ON CONFLICT(day,feature,outcome) DO UPDATE SET count=count+1").run(day, feature, outcome);
  }

  sourceTrustRevision(): number {
    const row = this.db.prepare("SELECT revision FROM kg_source_trust_state WHERE id=1").get() as { revision: number } | undefined;
    return inspectorCount(row?.revision);
  }

  previewSourceTrust(source: string, weight: number, limit: number): { affected: { nodes: number; edges: number; observations: number }; rank_deltas: Array<{ id: string; delta: number }>; truncated: boolean } {
    const bounded = Math.min(100, Math.max(0, Math.trunc(limit)));
    const previous = this.db.prepare("SELECT weight FROM kg_source_trust WHERE source=?").get(source) as { weight: number } | undefined;
    const oldWeight = Number(previous?.weight ?? 1), deltaFactor = weight - oldWeight;
    const countRow = this.db.prepare(`SELECT COUNT(*) AS observations,
      COUNT(DISTINCT CASE WHEN o.source_entity_id IS NOT NULL THEN o.source_entity_id END) AS direct_nodes,
      COUNT(DISTINCT o.edge_id) AS edges
      FROM kg_observations o WHERE o.source=?`).get(source) as { observations: number; direct_nodes: number; edges: number };
    const nodeCount = this.db.prepare(`SELECT COUNT(DISTINCT id) AS nodes FROM (
      SELECT o.source_entity_id AS id FROM kg_observations o WHERE o.source=? AND o.source_entity_id IS NOT NULL
      UNION SELECT e.source_id FROM kg_observations o JOIN kg_edges e ON e.id=o.edge_id WHERE o.source=?
      UNION SELECT e.target_id FROM kg_observations o JOIN kg_edges e ON e.id=o.edge_id WHERE o.source=?)`).get(source, source, source) as { nodes: number };
    const rows = this.db.prepare(`SELECT id,AVG(confidence) AS confidence FROM (
      SELECT o.source_entity_id AS id,o.confidence FROM kg_observations o WHERE o.source=? AND o.source_entity_id IS NOT NULL
      UNION ALL SELECT e.source_id,o.confidence FROM kg_observations o JOIN kg_edges e ON e.id=o.edge_id WHERE o.source=?
      UNION ALL SELECT e.target_id,o.confidence FROM kg_observations o JOIN kg_edges e ON e.id=o.edge_id WHERE o.source=?
    ) GROUP BY id ORDER BY id LIMIT ?`).all(source, source, source, bounded + 1) as Array<{ id: string; confidence: number }>;
    return { affected: { nodes: inspectorCount(nodeCount.nodes), edges: inspectorCount(countRow.edges), observations: inspectorCount(countRow.observations) }, rank_deltas: rows.slice(0, bounded).map(row => ({ id: row.id, delta: clamp01(Number(row.confidence)) * deltaFactor * .15 })), truncated: rows.length > bounded };
  }

  confirmSourceTrust(input: { source: string; source_hash: string; weight: number; graph_revision: number; config_revision: number; audit_id: string }): { graph_revision: number; config_revision: number; affected: { nodes: number; edges: number; observations: number } } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.graphRevision() !== input.graph_revision || this.sourceTrustRevision() !== input.config_revision) throw new Error("stale_preview");
      const previous = this.db.prepare("SELECT weight FROM kg_source_trust WHERE source=?").get(input.source) as { weight: number } | undefined;
      const affected = this.previewSourceTrust(input.source, input.weight, 0).affected, now = Date.now(), nextRevision = input.config_revision + 1;
      this.db.prepare("INSERT INTO kg_source_trust(source,weight,updated_at) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET weight=excluded.weight,updated_at=excluded.updated_at").run(input.source, input.weight, now);
      this.db.prepare("UPDATE kg_source_trust_state SET revision=?,updated_at=? WHERE id=1 AND revision=?").run(nextRevision, now, input.config_revision);
      this.db.prepare("INSERT INTO kg_source_trust_audits(id,source_hash,previous_weight,new_weight,graph_revision,config_revision,created_at) VALUES(?,?,?,?,?,?,?)").run(input.audit_id, input.source_hash, Number(previous?.weight ?? 1), input.weight, input.graph_revision, nextRevision, now);
      this.db.prepare("DELETE FROM kg_insight_snapshots").run();
      this.db.exec("COMMIT");
      return { graph_revision: input.graph_revision, config_revision: nextRevision, affected };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Aggregate-only inspector overview; no row bodies cross this boundary. */
  inspectorOverviewProjection(check?: () => void): { graph_revision: number; nodes: number; edges: number; observations: number } {
    check?.();
    const row = this.db.prepare(`SELECT
      (SELECT value FROM kg_graph_state WHERE key='content_revision') AS graph_revision,
      (SELECT COUNT(*) FROM kg_nodes WHERE deleted_at IS NULL) AS nodes,
      (SELECT COUNT(*) FROM kg_edges WHERE deleted_at IS NULL) AS edges,
      (SELECT COUNT(*) FROM kg_observations) AS observations`).get() as Record<string, unknown>;
    check?.();
    return { graph_revision: inspectorCount(row.graph_revision), nodes: inspectorCount(row.nodes), edges: inspectorCount(row.edges), observations: inspectorCount(row.observations) };
  }

  /** Bounded health counts, deliberately excluding audit snapshots and bodies. */
  inspectorHealthProjection(check?: () => void): { graph_revision: number; orphans: number; conflicts: number; duplicate_candidates: number } {
    check?.();
    const row = this.db.prepare(`SELECT
      (SELECT value FROM kg_graph_state WHERE key='content_revision') AS graph_revision,
      (SELECT COUNT(*) FROM kg_nodes n WHERE n.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM kg_edges e WHERE e.deleted_at IS NULL AND e.source_id=n.id)
        AND NOT EXISTS (SELECT 1 FROM kg_edges e WHERE e.deleted_at IS NULL AND e.target_id=n.id)) AS orphans,
      (SELECT COUNT(*) FROM kg_conflict_candidates WHERE status='pending') AS conflicts,
      (SELECT COUNT(*) FROM kg_duplicate_candidates WHERE status='pending') AS duplicate_candidates`).get() as Record<string, unknown>;
    check?.();
    return { graph_revision: inspectorCount(row.graph_revision), orphans: inspectorCount(row.orphans), conflicts: inspectorCount(row.conflicts), duplicate_candidates: inspectorCount(row.duplicate_candidates) };
  }

  /**
   * Inspector graph projection: every database read is limited before rows are
   * materialized, and only aggregate/evidence metadata is selected.
   */
  inspectorGraphProjection(input: { position?: { phase: "edge" | "node"; id: string } | null; after_id?: string | null; maxNodes: number; maxEdges: number; maxResponseBytes: number; asOf: number; scope?: string; filters?: GraphFilters; check?: () => void }): {
    graph_revision: number;
    nodes: Array<{ id: string; name: string; type: NodeType }>;
    edges: Array<{ id: string; source_id: string; target_id: string; type: string; confidence: number; evidence: Array<{ source: string; confidence: number; valid_from: number | null; valid_to: number | null; relationship_type: string }> }>;
    phase: "edge" | "node";
    next: { phase: "edge" | "node"; id: string } | null;
    skipped_unrepresentable: boolean;
    truncated: boolean;
  } {
    input.check?.();
    const maxNodes = Math.min(5000, Math.max(0, Math.trunc(input.maxNodes)));
    const maxEdges = Math.min(20000, Math.max(0, Math.trunc(input.maxEdges)));
    const responseBytes = Math.min(4 * 1024 * 1024, Math.max(1, Math.trunc(input.maxResponseBytes)));
    const position = input.position?.phase === "node" || input.position?.phase === "edge" ? input.position : { phase: "edge" as const, id: typeof input.after_id === "string" ? input.after_id : "" };
    const asOf = Number.isFinite(input.asOf) ? Math.trunc(input.asOf) : Date.now();
    const filters = input.filters ?? {};
    const scope = input.scope == null ? undefined : normalizeScope(input.scope);
    const observationClauses = ["typeof(o.source)='text' AND length(o.source)<=200", "(o.valid_from IS NULL OR (typeof(o.valid_from)='integer' AND o.valid_from<=?))", "(o.valid_to IS NULL OR (typeof(o.valid_to)='integer' AND o.valid_to>=?))", "(o.valid_from IS NULL OR o.valid_to IS NULL OR o.valid_from<=o.valid_to)", "typeof(o.confidence) IN ('integer','real') AND o.confidence BETWEEN 0 AND 1", "typeof(o.created_at)='integer'"];
    const observationParams: unknown[] = [asOf, asOf];
    if (filters.confidence_min !== undefined) { observationClauses.push("o.confidence>=?"); observationParams.push(filters.confidence_min); }
    if (filters.valid_from !== undefined) { observationClauses.push("(o.valid_to IS NULL OR o.valid_to>=?)"); observationParams.push(filters.valid_from); }
    if (filters.valid_to !== undefined) { observationClauses.push("(o.valid_from IS NULL OR o.valid_from<=?)"); observationParams.push(filters.valid_to); }
    if (filters.sources?.length) { observationClauses.push(`o.source IN (${filters.sources.map(() => "?").join(",")})`); observationParams.push(...filters.sources); }
    if (scope) { observationClauses.push("o.scope=?"); observationParams.push(scope); }
    const clauses = ["e.deleted_at IS NULL", "e.source_id<>e.target_id", "length(e.id)<=200", "length(e.source_id)<=200", "length(e.target_id)<=200", "length(e.type)<=100", `(${insightRelationshipPredicate})`, ...observationClauses];
    const params: unknown[] = [...observationParams];
    if (position.phase === "edge" && position.id) { clauses.push("e.id>?"); params.push(position.id); }
    if (filters.node_types?.length) { clauses.push(`sn.type IN (${filters.node_types.map(() => "?").join(",")}) AND tn.type IN (${filters.node_types.map(() => "?").join(",")})`); params.push(...filters.node_types, ...filters.node_types); }
    if (filters.ids?.length) { clauses.push(`(e.source_id IN (${filters.ids.map(() => "?").join(",")}) OR e.target_id IN (${filters.ids.map(() => "?").join(",")}))`); params.push(...filters.ids, ...filters.ids); }
    const where = clauses.join(" AND ");
    const edgeRows = position.phase === "edge" ? this.db.prepare(`SELECT e.id,e.source_id,e.target_id,e.type,AVG(o.confidence) AS confidence
      FROM kg_edges e JOIN kg_nodes sn ON sn.id=e.source_id AND sn.deleted_at IS NULL AND sn.type IN (${insightNodeTypeSql})
      JOIN kg_nodes tn ON tn.id=e.target_id AND tn.deleted_at IS NULL AND tn.type IN (${insightNodeTypeSql})
      JOIN kg_observations o ON o.edge_id=e.id
      WHERE ${where}
      GROUP BY e.id,e.source_id,e.target_id,e.type ORDER BY e.id LIMIT ?`).all(...params, maxEdges + 1) as Array<{ id: string; source_id: string; target_id: string; type: string; confidence: number }> : [];
    input.check?.();
    const selected: Array<{ id: string; source_id: string; target_id: string; type: string; confidence: number }> = [];
    const endpointIds = new Set<string>();
    let skippedUnrepresentable = false, stoppedForNodes = false;
    for (const row of edgeRows) {
      input.check?.();
      if (typeof row.id !== "string" || typeof row.source_id !== "string" || typeof row.target_id !== "string" || typeof row.type !== "string" || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1) { skippedUnrepresentable = true; continue; }
      const needed = (endpointIds.has(row.source_id) ? 0 : 1) + (endpointIds.has(row.target_id) ? 0 : 1);
      if (selected.length >= maxEdges || endpointIds.size + needed > maxNodes) {
        if (!selected.length && endpointIds.size + needed > maxNodes) { skippedUnrepresentable = true; continue; }
        stoppedForNodes = true;
        break;
      }
      selected.push(row); endpointIds.add(row.source_id); endpointIds.add(row.target_id);
    }
    const endpointList = [...endpointIds].sort();
    const nodes = endpointList.length ? (this.db.prepare(`SELECT id,name,type FROM kg_nodes WHERE deleted_at IS NULL AND length(id)<=200 AND length(name)<=200 AND id IN (${endpointList.map(() => "?").join(",")}) ORDER BY id LIMIT ?`).all(...endpointList, maxNodes) as Array<{ id: string; name: string; type: NodeType }>)
      .filter(row => typeof row.id === "string" && typeof row.name === "string" && (insightNodeTypes as readonly string[]).includes(row.type)) : [];
    if (position.phase === "node" || (!edgeRows.length && !filters.sources?.length)) {
      const nodeClauses = ["n.deleted_at IS NULL", `n.type IN (${insightNodeTypeSql})`, "typeof(n.id)='text'", "typeof(n.name)='text'", "length(n.id)<=200", "length(n.name)<=200", "NOT EXISTS (SELECT 1 FROM kg_edges e WHERE e.deleted_at IS NULL AND (e.source_id=n.id OR e.target_id=n.id))"];
      const nodeParams: unknown[] = [];
      if (scope) {
        nodeClauses.push(`(EXISTS (SELECT 1 FROM kg_observations o WHERE o.scope=? AND o.source_entity_id=n.id)
          OR (?='default' AND NOT EXISTS (SELECT 1 FROM kg_observations o WHERE o.source_entity_id=n.id)))`);
        nodeParams.push(scope, scope);
      }
      if (position.id) { nodeClauses.push("n.id>?"); nodeParams.push(position.id); }
      if (filters.node_types?.length) { nodeClauses.push(`n.type IN (${filters.node_types.map(() => "?").join(",")})`); nodeParams.push(...filters.node_types); }
      if (filters.ids?.length) { nodeClauses.push(`n.id IN (${filters.ids.map(() => "?").join(",")})`); nodeParams.push(...filters.ids); }
      const extras = this.db.prepare(`SELECT n.id,n.name,n.type FROM kg_nodes n WHERE ${nodeClauses.join(" AND ")} ORDER BY n.id LIMIT ?`)
        .all(...nodeParams, maxNodes + 1) as Array<{ id: string; name: string; type: NodeType }>;
      input.check?.();
      const pageNodes = extras.slice(0, maxNodes).filter(node => typeof node.id === "string" && typeof node.name === "string" && (insightNodeTypes as readonly string[]).includes(node.type));
      return { graph_revision: this.graphRevision(), phase: "node", nodes: pageNodes, edges: [], next: extras.length > maxNodes ? { phase: "node", id: pageNodes.at(-1)?.id ?? position.id } : null, skipped_unrepresentable: false, truncated: extras.length > maxNodes };
    }
    const nodeIds = new Set(nodes.map(node => node.id));
    const coherent = selected.filter(row => nodeIds.has(row.source_id) && nodeIds.has(row.target_id));
    const edgeIds = coherent.map(row => row.id);
    const evidence = new Map<string, Array<{ source: string; confidence: number; valid_from: number | null; valid_to: number | null; relationship_type: string }>>();
    // Reserve a conservative serialized budget per edge. The public contract
    // allows twenty evidence summaries, but a maximal edge page cannot carry
    // twenty for every edge within the four MiB response ceiling.
    const evidencePerEdge = Math.min(20, Math.max(0, Math.floor(responseBytes / Math.max(1, edgeIds.length) / 300)));
    if (edgeIds.length && evidencePerEdge) {
      const evidenceRows = this.db.prepare(`SELECT edge_id,source,confidence,valid_from,valid_to,relationship_type FROM (
          SELECT o.edge_id,o.source,o.confidence,o.valid_from,o.valid_to,e.type AS relationship_type,
            ROW_NUMBER() OVER (PARTITION BY o.edge_id ORDER BY o.created_at,o.id) AS evidence_rank
          FROM kg_observations o JOIN kg_edges e ON e.id=o.edge_id
          WHERE o.edge_id IN (${edgeIds.map(() => "?").join(",")}) AND e.deleted_at IS NULL AND ${observationClauses.join(" AND ")}
        ) WHERE evidence_rank<=? ORDER BY edge_id,evidence_rank LIMIT ?`).all(...edgeIds, ...observationParams, evidencePerEdge, edgeIds.length * evidencePerEdge + 1) as Array<{ edge_id: string; source: string; confidence: number; valid_from: number | null; valid_to: number | null; relationship_type: string }>;
      for (const row of evidenceRows) {
        input.check?.();
        if (typeof row.edge_id !== "string" || typeof row.source !== "string" || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1 || row.valid_from !== null && !Number.isSafeInteger(row.valid_from) || row.valid_to !== null && !Number.isSafeInteger(row.valid_to)) continue;
        const items = evidence.get(row.edge_id) ?? [];
        if (items.length < evidencePerEdge) items.push({ source: row.source, confidence: row.confidence, valid_from: row.valid_from, valid_to: row.valid_to, relationship_type: row.relationship_type });
        evidence.set(row.edge_id, items);
      }
    }
    return {
      graph_revision: this.graphRevision(), nodes,
      edges: coherent.map(row => ({ ...row, evidence: evidence.get(row.id) ?? [] })),
      phase: "edge",
      next: stoppedForNodes || edgeRows.length > selected.length
        ? selected.length ? { phase: "edge", id: selected.at(-1)!.id } : edgeRows.length ? { phase: "edge", id: edgeRows.at(-1)!.id } : null
        : filters.sources?.length ? null : { phase: "node", id: "" },
      skipped_unrepresentable: skippedUnrepresentable,
      truncated: stoppedForNodes || edgeRows.length > selected.length || selected.length !== coherent.length || skippedUnrepresentable
    };
  }

  inspectorEntityProjection(input: string, section: EntityDetailSection | "all", limit: number, asOf: number, after: { sort: number; id: string } | null = null, check?: () => void, requestedScope?: string): { graph_revision: number; entity?: { id: string; name: string; type: NodeType; aliases: string[]; importance: number }; evidence: Array<{ source: string; confidence: number; valid_from: number | null; valid_to: number | null; relationship_type: string }>; relationships: Array<{ id: string; direction: "in" | "out"; type: string; other_id: string; other_name: string; other_type: NodeType; confidence: number }>; timeline: TimelineProjectionRow[]; ranking_factors: { importance: number; evidence_confidence: number; source_count: number; degree: number; unresolved_conflict: boolean }; next: { sort: number; id: string } | null; truncated: boolean } {
    check?.();
    const bounded = Math.min(50, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 1));
    const text = input.trim();
    const scope = requestedScope == null ? undefined : normalizeScope(requestedScope);
    const exactRows = text ? this.db.prepare(`SELECT id,name,type,aliases,importance FROM kg_nodes WHERE id=? AND deleted_at IS NULL
      AND typeof(id)='text' AND typeof(name)='text' AND length(id)<=200 AND length(name)<=200 AND type IN (${insightNodeTypeSql})
      AND typeof(aliases)='text' AND length(aliases)<=16384 AND json_valid(aliases) AND json_type(aliases)='array'
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
        WHERE o.scope=? AND (o.source_entity_id=kg_nodes.id OR e.source_id=kg_nodes.id OR e.target_id=kg_nodes.id)
      ) OR (?='default' AND NOT EXISTS (
        SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
        WHERE o.source_entity_id=kg_nodes.id OR e.source_id=kg_nodes.id OR e.target_id=kg_nodes.id
      ))) LIMIT 1`).all(text, scope ?? null, scope ?? null, scope ?? null) as Array<{ id: string; name: string; type: NodeType; aliases: string; importance: number }> : [];
    const rows = exactRows.length ? exactRows : this.db.prepare(`SELECT id,name,type,aliases,importance FROM kg_nodes WHERE deleted_at IS NULL
      AND typeof(id)='text' AND typeof(name)='text' AND length(id)<=200 AND length(name)<=200 AND type IN (${insightNodeTypeSql})
      AND typeof(aliases)='text' AND length(aliases)<=16384 AND json_valid(aliases) AND json_type(aliases)='array'
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
        WHERE o.scope=? AND (o.source_entity_id=kg_nodes.id OR e.source_id=kg_nodes.id OR e.target_id=kg_nodes.id)
      ) OR (?='default' AND NOT EXISTS (
        SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
        WHERE o.source_entity_id=kg_nodes.id OR e.source_id=kg_nodes.id OR e.target_id=kg_nodes.id
      )))
      AND (lower(id)=lower(?) OR lower(name)=lower(?) OR EXISTS (SELECT 1 FROM json_each(aliases) WHERE typeof(value)='text' AND lower(value)=lower(?)))
      ORDER BY id LIMIT 2`).all(scope ?? null, scope ?? null, scope ?? null, text, text, text) as Array<{ id: string; name: string; type: NodeType; aliases: string; importance: number }>;
    check?.();
    if (rows.length !== 1) return { graph_revision: this.graphRevision(), evidence: [], relationships: [], timeline: [], ranking_factors: { importance: 0, evidence_confidence: 0, source_count: 0, degree: 0, unresolved_conflict: false }, next: null, truncated: false };
    const row = rows[0];
    const aliasesRows = (section === "aliases" || section === "relationships" || section === "all") ? this.db.prepare(`SELECT value AS alias FROM json_each(?)
      WHERE typeof(value)='text' AND length(value)<=200 AND (? IS NULL OR value>?) ORDER BY value LIMIT ?`).all(row.aliases, after?.id ?? null, after?.id ?? "", bounded + 1) as Array<{ alias: string }> : [];
    check?.();
    const evidenceRows = (section === "evidence" || section === "relationships" || section === "all") ? this.db.prepare(`WITH subject_edges AS (
        SELECT id FROM kg_edges WHERE deleted_at IS NULL AND source_id=?
        UNION SELECT id FROM kg_edges WHERE deleted_at IS NULL AND target_id=?
      ), relevant AS (
        SELECT o.id,o.source,o.confidence,o.valid_from,o.valid_to,COALESCE(e.type,'entity') AS relationship_type
        FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
        WHERE o.source_entity_id=? AND (? IS NULL OR o.scope=?)
        UNION
        SELECT o.id,o.source,o.confidence,o.valid_from,o.valid_to,e.type AS relationship_type
        FROM subject_edges subject JOIN kg_edges e ON e.id=subject.id JOIN kg_observations o ON o.edge_id=e.id
        WHERE (? IS NULL OR o.scope=?)
      ) SELECT id,source,confidence,valid_from,valid_to,relationship_type FROM relevant
      WHERE typeof(id)='text' AND length(id)<=200 AND typeof(source)='text' AND length(source)<=200 AND typeof(relationship_type)='text' AND length(relationship_type)<=100
        AND typeof(confidence) IN ('integer','real') AND confidence BETWEEN 0 AND 1
        AND (valid_from IS NULL OR typeof(valid_from)='integer') AND (valid_to IS NULL OR typeof(valid_to)='integer')
        AND (valid_from IS NULL OR valid_to IS NULL OR valid_from<=valid_to)
        AND (? IS NULL OR id>?) ORDER BY id LIMIT ?`).all(row.id, row.id, row.id, scope ?? null, scope ?? null, scope ?? null, scope ?? null, after?.id ?? null, after?.id ?? "", bounded + 1) as Array<{ id: string; source: string; confidence: number; valid_from: number | null; valid_to: number | null; relationship_type: string }> : [];
    check?.();
    const relationshipRows = (section === "relationships" || section === "all") ? this.db.prepare(`WITH subject_edges AS (
        SELECT id,source_id,target_id,type FROM kg_edges WHERE deleted_at IS NULL AND source_id=? AND typeof(id)='text' AND length(id)<=200 AND typeof(type)='text' AND length(type)<=100
        UNION SELECT id,source_id,target_id,type FROM kg_edges WHERE deleted_at IS NULL AND target_id=? AND typeof(id)='text' AND length(id)<=200 AND typeof(type)='text' AND length(type)<=100
      ), page AS (
        SELECT * FROM subject_edges WHERE (? IS NULL OR id>?)
          AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations scoped WHERE scoped.edge_id=subject_edges.id AND scoped.scope=?))
        ORDER BY id LIMIT ?
      ) SELECT page.id,page.type,
        CASE WHEN page.source_id=? THEN 'out' ELSE 'in' END AS direction,
        CASE WHEN page.source_id=? THEN page.target_id ELSE page.source_id END AS other_id,
        CASE WHEN page.source_id=? THEN target.name ELSE source.name END AS other_name,
        CASE WHEN page.source_id=? THEN target.type ELSE source.type END AS other_type,
        AVG(o.confidence) AS confidence
      FROM page JOIN kg_nodes source ON source.id=page.source_id AND source.deleted_at IS NULL
        JOIN kg_nodes target ON target.id=page.target_id AND target.deleted_at IS NULL
        JOIN kg_observations o ON o.edge_id=page.id AND typeof(o.confidence) IN ('integer','real') AND o.confidence BETWEEN 0 AND 1
      WHERE typeof(source.name)='text' AND length(source.name)<=200 AND typeof(target.name)='text' AND length(target.name)<=200
        AND (? IS NULL OR o.scope=?)
      GROUP BY page.id,page.type,page.source_id,page.target_id,source.name,source.type,target.name,target.type
      ORDER BY page.id LIMIT ?`).all(row.id, row.id, after?.id ?? null, after?.id ?? "", scope ?? null, scope ?? null, bounded + 1, row.id, row.id, row.id, row.id, scope ?? null, scope ?? null, bounded + 1) as Array<{ id: string; direction: "in" | "out"; type: string; other_id: string; other_name: string; other_type: NodeType; confidence: number }> : [];
    check?.();
    const timeline = (section === "timeline" || section === "relationships" || section === "all") ? this.inspectorTimelineProjection(row.id, bounded, section === "timeline" ? after : null, check, scope) : { rows: [], next: null, truncated: false };
    check?.();
    const quality = this.db.prepare(`WITH subject_edges AS (
        SELECT id FROM kg_edges WHERE deleted_at IS NULL AND source_id=?
        UNION SELECT id FROM kg_edges WHERE deleted_at IS NULL AND target_id=?
      ), relevant AS (
        SELECT o.id,o.source,o.confidence,o.valid_from,o.valid_to FROM kg_observations o WHERE o.source_entity_id=? AND (? IS NULL OR o.scope=?)
        UNION SELECT o.id,o.source,o.confidence,o.valid_from,o.valid_to FROM subject_edges subject JOIN kg_observations o ON o.edge_id=subject.id WHERE (? IS NULL OR o.scope=?)
      ) SELECT AVG(confidence) AS confidence,COUNT(DISTINCT CASE WHEN typeof(source)='text' AND length(source)<=200 THEN source END) AS source_count FROM relevant
      WHERE typeof(confidence) IN ('integer','real') AND confidence BETWEEN 0 AND 1
        AND (valid_from IS NULL OR valid_from<=?) AND (valid_to IS NULL OR valid_to>=?)`).get(row.id, row.id, row.id, scope ?? null, scope ?? null, scope ?? null, scope ?? null, asOf, asOf) as { confidence: number | null; source_count: number };
    const degree = this.db.prepare(`SELECT COUNT(*) AS count FROM kg_edges e WHERE e.deleted_at IS NULL AND (e.source_id=? OR e.target_id=?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations o WHERE o.edge_id=e.id AND o.scope=?))`).get(row.id, row.id, scope ?? null, scope ?? null) as { count: number };
    const unresolved = this.db.prepare(`SELECT 1 FROM kg_conflict_candidates c JOIN kg_edges a ON a.id=c.edge_a JOIN kg_edges b ON b.id=c.edge_b
      WHERE c.status='pending' AND (a.source_id=? OR a.target_id=? OR b.source_id=? OR b.target_id=?) LIMIT 1`).get(row.id, row.id, row.id, row.id) != null;
    check?.();
    const aliases = aliasesRows.slice(0, bounded).map(item => item.alias);
    const next = section === "aliases" && aliasesRows.length > bounded ? { sort: 0, id: aliases.at(-1)! }
      : section === "evidence" && evidenceRows.length > bounded ? { sort: 0, id: evidenceRows[bounded - 1]!.id }
      : section === "relationships" && relationshipRows.length > bounded ? { sort: 0, id: relationshipRows[bounded - 1]!.id }
      : section === "timeline" ? timeline.next : null;
    return { graph_revision: this.graphRevision(), entity: { id: row.id, name: row.name, type: row.type, aliases, importance: Number(row.importance) }, evidence: evidenceRows.slice(0, bounded), relationships: relationshipRows.slice(0, bounded), timeline: timeline.rows, ranking_factors: { importance: Number(row.importance), evidence_confidence: clamp01(Number(quality.confidence ?? 0)), source_count: inspectorCount(quality.source_count), degree: inspectorCount(degree.count), unresolved_conflict: unresolved }, next, truncated: aliasesRows.length > bounded || evidenceRows.length > bounded || relationshipRows.length > bounded || timeline.truncated };
  }

  /** Inspector-only timeline avoids unbounded GROUP_CONCAT materialization. */
  private inspectorTimelineProjection(subjectId: string, limit: number, after: { sort: number; id: string } | null, check?: () => void, requestedScope?: string): { rows: TimelineProjectionRow[]; next: { sort: number; id: string } | null; truncated: boolean } {
    check?.();
    const scope = requestedScope == null ? undefined : normalizeScope(requestedScope);
    const groups = this.db.prepare(`WITH relevant AS (
      SELECT o.id AS observation_id,o.edge_id,o.source,o.created_at,o.valid_from,o.valid_to FROM kg_observations o
      LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
      WHERE (o.source_entity_id=? OR e.source_id=? OR e.target_id=?) AND typeof(o.id)='text' AND length(o.id)<=200
        AND (? IS NULL OR o.scope=?)
        AND typeof(o.created_at)='integer' AND (o.valid_from IS NULL OR typeof(o.valid_from)='integer')
        AND (o.valid_to IS NULL OR typeof(o.valid_to)='integer') AND (o.valid_from IS NULL OR o.valid_to IS NULL OR o.valid_from<=o.valid_to)
    ), events AS (
      SELECT created_at AS timestamp,'observed' AS kind,observation_id,edge_id,source FROM relevant
      UNION ALL SELECT valid_from,'became_valid',observation_id,edge_id,source FROM relevant WHERE valid_from IS NOT NULL
      UNION ALL SELECT valid_to,'became_invalid',observation_id,edge_id,source FROM relevant WHERE valid_to IS NOT NULL
    ) SELECT timestamp,kind,COUNT(DISTINCT observation_id) AS evidence_count,COUNT(DISTINCT CASE WHEN typeof(source)='text' AND length(source)<=200 THEN source END) AS source_count
      FROM events WHERE timestamp>=0 AND (? IS NULL OR timestamp>? OR (timestamp=? AND kind>?))
      GROUP BY timestamp,kind ORDER BY timestamp,kind LIMIT ?`).all(subjectId, subjectId, subjectId, scope ?? null, scope ?? null, after?.sort ?? null, after?.sort ?? 0, after?.sort ?? 0, after?.id ?? "", limit + 1) as Array<{ timestamp: number; kind: TimelineProjectionRow["kind"]; evidence_count: number; source_count: number }>;
    const rows: TimelineProjectionRow[] = [];
    for (const group of groups.slice(0, limit)) {
      check?.();
      const relationshipRows = this.db.prepare(`WITH relevant AS (
        SELECT o.edge_id,o.created_at,o.valid_from,o.valid_to FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
        WHERE (o.source_entity_id=? OR e.source_id=? OR e.target_id=?) AND (? IS NULL OR o.scope=?)
      ), events AS (SELECT created_at AS timestamp,'observed' AS kind,edge_id FROM relevant UNION ALL SELECT valid_from,'became_valid',edge_id FROM relevant WHERE valid_from IS NOT NULL UNION ALL SELECT valid_to,'became_invalid',edge_id FROM relevant WHERE valid_to IS NOT NULL)
        SELECT DISTINCT edge_id FROM events WHERE timestamp=? AND kind=? AND typeof(edge_id)='text' AND length(edge_id)<=200 ORDER BY edge_id LIMIT 51`).all(subjectId, subjectId, subjectId, scope ?? null, scope ?? null, group.timestamp, group.kind) as Array<{ edge_id: string }>;
      rows.push({ timestamp: inspectorCount(group.timestamp), kind: group.kind, observationIds: [], relationshipIds: relationshipRows.slice(0, 50).map(item => item.edge_id), evidenceCount: inspectorCount(group.evidence_count), sourceCount: inspectorCount(group.source_count) });
    }
    const last = rows.at(-1);
    return { rows, next: groups.length > limit && last ? { sort: last.timestamp, id: last.kind } : null, truncated: groups.length > limit || rows.some(row => row.relationshipIds.length >= 50) };
  }

  inspectorResearchRevision(): string {
    // `total_changes()` changes for inserts, updates, and deletes even when a
    // caller reuses a timestamp. The nonce prevents cross-process cursor reuse
    // without placing any table contents in the opaque cursor.
    const changes = this.db.prepare("SELECT total_changes() AS changes").get() as { changes: number };
    const dataVersion = this.db.prepare("PRAGMA data_version").get() as { data_version: number };
    return createHash("sha256").update(JSON.stringify({ n: this.inspectorSessionNonce, c: nonNegativeInteger(Number(changes.changes)), d: nonNegativeInteger(Number(dataVersion.data_version)) })).digest("base64url");
  }

  inspectorResearchProjection(section: "insights" | "watches" | "history" | "digests", after: { sort: number; id: string } | null, limit: number, check?: () => void, requestedScope?: string): { items: Array<Record<string, unknown>>; next: { sort: number; id: string } | null; truncated: boolean; insights_state?: "current" | "missing" | "stale" | "malformed" } {
    check?.();
    const bounded = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 1));
    const scope = requestedScope == null ? undefined : normalizeScope(requestedScope);
    let rows: Array<Record<string, unknown>>;
    if (section === "watches") rows = this.db.prepare(`SELECT id,CASE WHEN enabled=1 THEN 'enabled' ELSE 'disabled' END AS status,name,schedule_hint,enabled,updated_at AS sort FROM kg_watches
      WHERE (? IS NULL OR scope=?) AND length(id)<=200 AND length(name)<=200 AND length(schedule_hint)<=100 AND (? IS NULL OR updated_at<? OR (updated_at=? AND id<?)) ORDER BY updated_at DESC,id DESC LIMIT ?`).all(scope ?? null, scope ?? null, after?.sort ?? null, after?.sort ?? 0, after?.sort ?? 0, after?.id ?? "", bounded + 1) as Array<Record<string, unknown>>;
    else if (section === "history") rows = this.db.prepare(`SELECT id,status,graph_revision,result_count,duration_ms,created_at,created_at AS sort FROM kg_query_runs
      WHERE (? IS NULL OR scope=?) AND length(id)<=200 AND length(status)<=100 AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`).all(scope ?? null, scope ?? null, after?.sort ?? null, after?.sort ?? 0, after?.sort ?? 0, after?.id ?? "", bounded + 1) as Array<Record<string, unknown>>;
    else if (section === "digests") rows = this.db.prepare(`SELECT idempotency_key AS id,status,started_at,finished_at,started_at AS sort FROM kg_digest_runs
      WHERE (? IS NULL OR scope=?) AND length(idempotency_key)<=200 AND length(status)<=100 AND (? IS NULL OR started_at<? OR (started_at=? AND idempotency_key<?)) ORDER BY started_at DESC,idempotency_key DESC LIMIT ?`).all(scope ?? null, scope ?? null, after?.sort ?? null, after?.sort ?? 0, after?.sort ?? 0, after?.id ?? "", bounded + 1) as Array<Record<string, unknown>>;
    else {
      const currentRevision = this.graphRevision();
      // Select one bounded snapshot, but never trust its table metadata alone:
      // the canonical JSON revision must agree with the current graph revision.
      const snapshot = this.db.prepare("SELECT CASE WHEN length(snapshot)<=1048576 THEN snapshot ELSE NULL END AS snapshot,length(snapshot) AS snapshot_bytes,graph_revision,created_at FROM kg_insight_snapshots WHERE (? IS NULL OR scope=?) ORDER BY CASE WHEN graph_revision=? THEN 0 ELSE 1 END,created_at DESC,cache_key DESC LIMIT 1").get(scope ?? null, scope ?? null, currentRevision) as { snapshot: string | null; snapshot_bytes: number; graph_revision: number; created_at: number } | undefined;
      let insightState: "current" | "missing" | "stale" | "malformed" = snapshot ? "current" : "missing";
      let insights: Array<Record<string, unknown>> = [];
      if (snapshot) {
        try {
          const parsed = snapshot.snapshot == null ? undefined : canonicalizeInsightSnapshot(JSON.parse(snapshot.snapshot));
          if (!parsed || snapshot.snapshot_bytes > 1048576) insightState = "malformed";
          else if (snapshot.graph_revision !== currentRevision || parsed.graphRevision !== currentRevision) insightState = "stale";
          else insights = parsed.insights.slice(0, 1001).map(item => ({ id: item.id, status: "available", kind: item.kind, score: item.score, sort: Math.floor(item.score * 1_000_000), created_at: snapshot.created_at }));
        } catch { insightState = "malformed"; }
      }
      rows = insights.filter(item => after == null || Number(item.sort) < after.sort || Number(item.sort) === after.sort && String(item.id) < after.id).sort((a,b) => Number(b.sort)-Number(a.sort) || String(b.id).localeCompare(String(a.id))).slice(0, bounded + 1);
      const items = rows.slice(0, bounded).filter(row => { check?.(); return typeof row.id === "string" && row.id.length > 0 && row.id.length <= 200 && typeof row.status === "string" && row.status.length > 0 && row.status.length <= 100; });
      const last = items.at(-1);
      return { items, next: rows.length > bounded && last ? { sort: Number(last.sort), id: String(last.id) } : null, truncated: rows.length > bounded || insights.length >= 1001, insights_state: insightState };
    }
    check?.();
    const items = rows.slice(0, bounded).filter(row => { check?.(); return typeof row.id === "string" && row.id.length > 0 && row.id.length <= 200 && typeof row.status === "string" && row.status.length > 0 && row.status.length <= 100; });
    const last = items.at(-1);
    return { items, next: rows.length > bounded && last ? { sort: Number(last.sort), id: String(last.id) } : null, truncated: rows.length > bounded };
  }

  forget(entityId: string, hard = false, confirm = false): KgForgetResult {
    if (!entityId.includes(":")) throw new Error("kg_forget requires a canonical entity_id slug");
    if (hard && !confirm) throw new Error("hard delete requires confirm=true");
    if (!this.getNodeById(entityId, true)) throw new Error(`Entity not found: ${entityId}`);
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let deleted_observations = 0;
      let deleted_edges = 0;
      let deleted_nodes = 0;
      if (hard) {
        const edgeIds = this.db.prepare("SELECT id FROM kg_edges WHERE source_id = ? OR target_id = ?").all(entityId, entityId) as Array<{ id: string }>;
        // Schema-drift rows are review-only references, not graph facts. A
        // confirmed hard forget must remove those references before deleting
        // their endpoint, otherwise their foreign keys make deletion fail.
        this.db.prepare("DELETE FROM kg_schema_drift_candidates WHERE source_entity_id = ? OR target_entity_id = ?").run(entityId, entityId);
        for (const edge of edgeIds) deleted_observations += this.db.prepare("DELETE FROM kg_observations WHERE edge_id = ?").run(edge.id).changes;
        deleted_observations += this.db.prepare("DELETE FROM kg_observations WHERE source_entity_id = ?").run(entityId).changes;
        deleted_edges += this.db.prepare("DELETE FROM kg_edges WHERE source_id = ? OR target_id = ?").run(entityId, entityId).changes;
        this.db.prepare("DELETE FROM kg_nodes_fts WHERE id = ?").run(entityId);
        deleted_nodes += this.db.prepare("DELETE FROM kg_nodes WHERE id = ?").run(entityId).changes;
      } else {
        deleted_nodes += this.db.prepare("UPDATE kg_nodes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, now, entityId).changes;
        deleted_edges += this.db.prepare("UPDATE kg_edges SET deleted_at = ?, updated_at = ? WHERE (source_id = ? OR target_id = ?) AND deleted_at IS NULL").run(now, now, entityId, entityId).changes;
        this.db.prepare("DELETE FROM kg_nodes_fts WHERE id = ?").run(entityId);
      }
      this.invalidateDetachedConflictCandidates(now);
      if (deleted_nodes || deleted_edges || deleted_observations) this.bumpGraphRevision();
      this.db.exec("COMMIT");
      return { entity_id: entityId, hard, deleted_nodes, deleted_edges, deleted_observations };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  resolveEntity(input: string): KgNode | null {
    const exact = this.getNodeById(input);
    if (exact) return exact;
    const redirect = this.db.prepare("SELECT canonical_id FROM kg_entity_redirects WHERE retired_id=?").get(input) as { canonical_id: string } | undefined;
    if (redirect) return this.getNodeById(redirect.canonical_id);
    return this.search(input, undefined, 1)[0]?.node ?? null;
  }

  getNodeById(id: string, includeDeleted = false): KgNode | null {
    const row = this.db.prepare(`SELECT * FROM kg_nodes WHERE id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`).get(id) as NodeRow | undefined;
    return row ? mapNode(row) : null;
  }

  getEdgeById(id: string, includeDeleted = false): KgEdge | null {
    const row = this.db.prepare(`SELECT * FROM kg_edges WHERE id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`).get(id) as EdgeRow | undefined;
    return row ? mapEdge(row) : null;
  }

  private upsertNode(entity: ExtractedEntity): { node: KgNode; created: boolean } {
    const existing = this.findExistingNode(entity.name, entity.type, entity.aliases ?? []);
    const now = Date.now();
    const id = existing?.id ?? this.allocateNodeId(entity.name, entity.type);
    const aliases = uniqueStrings([...(entity.aliases ?? []), ...(existing?.aliases ?? [])]);
    const description = entity.description?.trim() || existing?.description || "";
    this.db.prepare(`INSERT INTO kg_nodes (id,type,name,description,aliases,importance,deleted_at,created_at,updated_at)
      VALUES (?,?,?,?,?,0,NULL,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=CASE WHEN excluded.description != '' THEN excluded.description ELSE kg_nodes.description END, aliases=excluded.aliases, deleted_at=NULL, updated_at=excluded.updated_at`
    ).run(id, entity.type, entity.name.trim(), description, JSON.stringify(aliases), now, now);
    const node = this.getNodeById(id);
    if (!node) throw new Error(`Failed to upsert node: ${id}`);
    return { node, created: !existing };
  }

  private findExistingNode(name: string, type: NodeType, aliases: string[]): KgNode | null {
    const id = this.entities.findExisting(type, [name, ...aliases]);
    return id ? this.getNodeById(id) : null;
  }

  /** Scope-safe reauthorization for optional vector-index hits. */
  hasNodeEvidenceInScope(nodeId: string, scope: string): boolean {
    const row = this.db.prepare("SELECT 1 AS present FROM kg_observations WHERE source_entity_id=? AND scope=? LIMIT 1").get(nodeId, normalizeScope(scope)) as { present?: number } | undefined;
    return row?.present === 1;
  }

  /** Recheck the exact historic edge selected by a scan. A repair must never
   * retire a different, already-fixed, or newly-admitted relationship. */
  private activeLegacySchemaDriftEdge(candidate: SchemaDriftCandidate, scope: string): KgEdge | undefined {
    if (!candidate.legacy_edge_id) return undefined;
    const row = this.db.prepare("SELECT * FROM kg_edges WHERE id=? AND deleted_at IS NULL").get(candidate.legacy_edge_id) as EdgeRow | undefined;
    if (!row) return undefined;
    const edge = mapEdge(row);
    if (edge.source_id !== candidate.source_entity_id || edge.target_id !== candidate.target_entity_id || edge.type !== candidate.relationship_type) return undefined;
    const source = this.getNodeById(edge.source_id), target = this.getNodeById(edge.target_id);
    if (!source || !target) return undefined;
    const admission = validateRelationship(source, target, edge.type, 1, 0);
    if (!admission.accepted || admission.endpoint_match) return undefined;
    return this.evidenceForEdge(edge.id, 1, scope).length ? edge : undefined;
  }

  private allocateNodeId(name: string, type: NodeType): string {
    const preferred = normalizeSlug(name, type);
    const occupied = this.getNodeById(preferred, true);
    if (!occupied) return preferred;
    if (occupied.type === type && normalizeLookup(occupied.name) === normalizeLookup(name)) return preferred;
    // A legacy id or an astronomically unlikely truncated-digest collision must
    // never overwrite a different identity. The full digest is deterministic.
    return `${preferred}-${identityHash(name, type).slice(32)}`;
  }

  private resolveRelationEndpoint(name: string, seen: Map<string, KgNode>): KgNode | null {
    return seen.get(name) ?? seen.get(normalizeLookup(name)) ?? this.resolveEntity(name);
  }

  qualityEvidenceSummaries(nodeIds: string[], now = Date.now(), projection?: { nodes: string[]; arcs: PprArc[] }): { items: Record<string, QualityEvidenceSummary>; degree_p95: number } {
    const ids = [...new Set(nodeIds)].filter(Boolean).slice(0, 200);
    const projectedNeighbors = new Map<string, Set<string>>();
    for (const arc of projection?.arcs ?? []) {
      if (!projectedNeighbors.has(arc.from)) projectedNeighbors.set(arc.from, new Set());
      projectedNeighbors.get(arc.from)!.add(arc.to);
    }
    const degreeFor = (id: string) => projection
      ? (projectedNeighbors.get(id)?.size ?? 0)
      : Number((this.db.prepare("SELECT COUNT(*) count FROM kg_edges WHERE deleted_at IS NULL AND (source_id=? OR target_id=?)").get(id, id) as { count: number }).count);
    const degreePopulation = projection?.nodes ?? ids;
    const degrees = degreePopulation.map(degreeFor).sort((a, b) => a - b);
    const degree_p95 = degrees.length ? degrees[Math.max(0, Math.ceil(degrees.length * .95) - 1)] : 0;
    const items: Record<string, QualityEvidenceSummary> = {};
    for (const id of ids) {
      const evidence = this.db.prepare(`SELECT o.source,o.confidence,o.valid_from,o.valid_to,o.created_at FROM kg_observations o
        LEFT JOIN kg_edges e ON e.id=o.edge_id
        WHERE o.source_entity_id=? OR (e.deleted_at IS NULL AND (e.source_id=? OR e.target_id=?))`).all(id, id, id) as Array<{ source: string; confidence: number; valid_from: number | null; valid_to: number | null; created_at: number }>;
      const applicable = evidence.filter(row => (row.valid_from == null || row.valid_from <= now) && (row.valid_to == null || row.valid_to >= now));
      const confidence = applicable.length ? applicable.reduce((sum, row) => sum + clamp01(Number(row.confidence)), 0) / applicable.length : 0;
      const referenceTimes = applicable.map(row => row.valid_from ?? row.created_at).filter(Number.isFinite);
      const degree = degreeFor(id);
      const unresolved = this.db.prepare(`SELECT 1 FROM kg_conflict_candidates c JOIN kg_edges a ON a.id=c.edge_a JOIN kg_edges b ON b.id=c.edge_b
        WHERE c.status='pending' AND (a.source_id=? OR a.target_id=? OR b.source_id=? OR b.target_id=?) LIMIT 1`).get(id, id, id, id) != null;
      items[id] = { source_count: new Set(applicable.map(row => row.source)).size, confidence, reference_time: referenceTimes.length ? Math.max(...referenceTimes) : null, unresolved_conflict: unresolved, degree };
    }
    return { items, degree_p95 };
  }

  insightGraphProjection(options: { maxNodes: number; maxEdges: number; confidenceFloor: number; asOf: number; scope?: string }): GraphProjection {
    const boundedLimit = (value: number) => Number.isFinite(value)
      ? Math.min(Number.MAX_SAFE_INTEGER - 1, Math.max(0, Math.trunc(value)))
      : 0;
    const maxNodes = Math.min(10000, boundedLimit(Number(options.maxNodes)));
    const maxEdges = Math.min(50000, boundedLimit(Number(options.maxEdges)));
    const confidenceFloor = clamp01(Number.isFinite(options.confidenceFloor) ? Number(options.confidenceFloor) : 0);
    const asOf = Number.isFinite(options.asOf) ? Number(options.asOf) : Date.now();
    const scope = options.scope == null ? undefined : normalizeScope(options.scope);

    // The edge read is intentionally aggregate-only. Evidence bodies, payloads,
    // and source-document text never cross the projection boundary.
    const edgeRows = this.db.prepare(`
      SELECT e.id AS id, e.source_id AS source, e.target_id AS target, e.type AS type,
        sn.name AS source_name, sn.type AS source_type,
        tn.name AS target_name, tn.type AS target_type,
        AVG(MIN(1,o.confidence*COALESCE(st.weight,1))) AS confidence,
        COUNT(o.id) AS evidence_count,
        COUNT(DISTINCT o.source) AS source_count,
        MIN(o.created_at) AS first_seen_at,
        MAX(o.created_at) AS last_seen_at
      FROM kg_edges e
      JOIN kg_nodes sn ON sn.id=e.source_id AND sn.deleted_at IS NULL AND sn.type IN (${insightNodeTypeSql})
      JOIN kg_nodes tn ON tn.id=e.target_id AND tn.deleted_at IS NULL AND tn.type IN (${insightNodeTypeSql})
      JOIN kg_observations o ON o.edge_id=e.id
        AND (? IS NULL OR o.scope=?)
        AND (o.valid_from IS NULL OR o.valid_from<=?)
        AND (o.valid_to IS NULL OR o.valid_to>=?)
        AND (o.valid_from IS NULL OR typeof(o.valid_from)='integer')
        AND (o.valid_to IS NULL OR typeof(o.valid_to)='integer')
        AND (o.valid_from IS NULL OR o.valid_to IS NULL OR o.valid_from<=o.valid_to)
        AND typeof(o.confidence) IN ('integer','real')
        AND o.confidence>=0 AND o.confidence<=1
        AND typeof(o.created_at)='integer'
      LEFT JOIN kg_source_trust st ON st.source=o.source
      WHERE e.deleted_at IS NULL AND e.source_id<>e.target_id
        AND (${insightRelationshipPredicate})
      GROUP BY e.id, e.source_id, e.target_id, e.type,
        sn.name, sn.type, tn.name, tn.type
      HAVING AVG(o.confidence)>=?
      ORDER BY e.id
      LIMIT ?
    `).all(scope ?? null, scope ?? null, asOf, asOf, confidenceFloor, maxEdges + 1) as Array<{
      id: string;
      source: string;
      target: string;
      type: RelationshipType;
      source_name: string;
      source_type: NodeType;
      target_name: string;
      target_type: NodeType;
      confidence: number;
      evidence_count: number;
      source_count: number;
      first_seen_at: number;
      last_seen_at: number;
    }>;

    const finiteEdgeRows = edgeRows.filter(row => Number.isFinite(Number(row.confidence))
      && Number.isFinite(Number(row.evidence_count))
      && Number.isFinite(Number(row.source_count))
      && Number.isFinite(Number(row.first_seen_at))
      && Number.isFinite(Number(row.last_seen_at)));
    const edgeTruncated = finiteEdgeRows.length > maxEdges;
    const selectedEdgeRows = finiteEdgeRows.slice(0, maxEdges);

    // Read active nodes in one bounded query. Endpoint rows above provide names
    // and types for selected edges; this read supplies isolated nodes without
    // issuing one query per endpoint.
    const activeRows = this.db.prepare(`
      SELECT id, name, type
      FROM kg_nodes
      WHERE deleted_at IS NULL AND type IN (${insightNodeTypeSql})
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
          WHERE o.scope=? AND (o.source_entity_id=kg_nodes.id OR e.source_id=kg_nodes.id OR e.target_id=kg_nodes.id)
        ) OR (?='default' AND NOT EXISTS (
          SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
          WHERE o.source_entity_id=kg_nodes.id OR e.source_id=kg_nodes.id OR e.target_id=kg_nodes.id
        )))
      ORDER BY id
      LIMIT ?
    `).all(scope ?? null, scope ?? null, scope ?? null, maxNodes + 1) as Array<{ id: string; name: string; type: NodeType }>;

    const nodeCandidates = new Map<string, { id: string; name: string; type: NodeType }>();
    for (const row of selectedEdgeRows) {
      nodeCandidates.set(row.source, { id: row.source, name: row.source_name, type: row.source_type });
      nodeCandidates.set(row.target, { id: row.target, name: row.target_name, type: row.target_type });
    }
    for (const row of activeRows) nodeCandidates.set(row.id, { id: row.id, name: row.name, type: row.type });

    const sortedCandidates = [...nodeCandidates.values()].sort((a, b) => a.id.localeCompare(b.id));
    const nodeTruncated = sortedCandidates.length > maxNodes;
    const nodes = sortedCandidates.slice(0, maxNodes);
    const includedNodeIds = new Set(nodes.map(node => node.id));
    const edges = selectedEdgeRows
      .filter(row => includedNodeIds.has(row.source) && includedNodeIds.has(row.target))
      .map(row => {
        const evidenceCount = Number(row.evidence_count);
        const sourceCount = Number(row.source_count);
        const confidence = clamp01(Number(row.confidence));
        const evidenceFactor = Math.min(1, Math.log2(1 + Math.max(0, evidenceCount)) / 3);
        const diversityFactor = Math.min(1, Math.max(0, sourceCount) / 3);
        const genericFactor = row.type === "related_to" ? .35 : 1;
        const weight = clamp01(confidence * (.6 + .2 * evidenceFactor + .2 * diversityFactor) * genericFactor);
        return {
          id: row.id,
          source: row.source,
          target: row.target,
          type: row.type,
          weight,
          confidence,
          evidenceCount,
          sourceCount,
          firstSeenAt: Number(row.first_seen_at),
          lastSeenAt: Number(row.last_seen_at)
        };
      });

    return {
      nodes,
      edges,
      truncated: edgeTruncated || nodeTruncated,
      graphRevision: this.graphRevision(),
      asOf
    };
  }

  queryGraphProjection(options: { maxNodes: number; maxEdges: number; asOf: number; scope?: string }): QueryGraphProjection {
    const bounded = (value: number, hard: number) => Number.isFinite(value) ? Math.min(hard, Math.max(0, Math.trunc(value))) : 0;
    const maxNodes = bounded(options.maxNodes, 10000);
    const maxEdges = bounded(options.maxEdges, 50000);
    const asOf = Number.isFinite(options.asOf) ? options.asOf : Date.now();
    const scope = options.scope == null ? undefined : normalizeScope(options.scope);
    const nodeRows = this.db.prepare(`SELECT id,name,type,aliases,created_at,updated_at FROM kg_nodes
      WHERE deleted_at IS NULL AND typeof(id)='text' AND typeof(name)='text' AND type IN (${insightNodeTypeSql})
        AND typeof(aliases)='text' AND json_valid(aliases) AND json_type(aliases)='array'
        AND typeof(created_at)='integer' AND typeof(updated_at)='integer'
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
          WHERE o.scope=? AND (o.source_entity_id=kg_nodes.id OR e.source_id=kg_nodes.id OR e.target_id=kg_nodes.id)
        ) OR (?='default' AND NOT EXISTS (
          SELECT 1 FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
          WHERE o.source_entity_id=kg_nodes.id OR e.source_id=kg_nodes.id OR e.target_id=kg_nodes.id
        )))
      ORDER BY id LIMIT ?`).all(scope ?? null, scope ?? null, scope ?? null, maxNodes + 1) as Array<{ id: string; name: string; type: NodeType; aliases: string; created_at: number; updated_at: number }>;
    const nodes = nodeRows.slice(0, maxNodes).flatMap(row => {
      const aliases = parseJsonArray(row.aliases);
      const validNodeTypes = new Set<NodeType>(["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"]);
      return validNodeTypes.has(row.type) ? [{ id: row.id, name: row.name, type: row.type, aliases, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }] : [];
    });
    const ids = new Set(nodes.map(node => node.id));
    const edgeRows = this.db.prepare(`SELECT e.id,e.source_id AS source,e.target_id AS target,e.type,
        AVG(o.confidence) AS confidence,COUNT(*) AS evidence_count,COUNT(DISTINCT o.source) AS source_count,
        MIN(o.created_at) AS first_seen_at,MAX(o.created_at) AS last_seen_at,
        MIN(o.valid_from) AS valid_from,MAX(o.valid_to) AS valid_to
      FROM kg_edges e JOIN kg_nodes sn ON sn.id=e.source_id AND sn.deleted_at IS NULL AND sn.type IN (${insightNodeTypeSql})
      JOIN kg_nodes tn ON tn.id=e.target_id AND tn.deleted_at IS NULL AND tn.type IN (${insightNodeTypeSql})
      JOIN kg_observations o ON o.edge_id=e.id
        AND (? IS NULL OR o.scope=?)
        AND (o.valid_from IS NULL OR (typeof(o.valid_from)='integer' AND o.valid_from<=?))
        AND (o.valid_to IS NULL OR (typeof(o.valid_to)='integer' AND o.valid_to>=?))
        AND (o.valid_from IS NULL OR o.valid_to IS NULL OR o.valid_from<=o.valid_to)
        AND typeof(o.confidence) IN ('integer','real') AND o.confidence BETWEEN 0 AND 1
        AND typeof(o.created_at)='integer'
      WHERE e.deleted_at IS NULL AND e.source_id<>e.target_id AND (${insightRelationshipPredicate})
      GROUP BY e.id,e.source_id,e.target_id,e.type ORDER BY e.id LIMIT ?`).all(scope ?? null, scope ?? null, asOf, asOf, maxEdges + 1) as Array<{
        id: string; source: string; target: string; type: RelationshipType; confidence: number; evidence_count: number; source_count: number;
        first_seen_at: number; last_seen_at: number; valid_from: number | null; valid_to: number | null;
      }>;
    const validTypes = new Set(Object.keys(relationshipDefinitions));
    const edges = edgeRows.slice(0, maxEdges).filter(row => typeof row.id === "string" && ids.has(row.source) && ids.has(row.target)
      && validTypes.has(row.type) && [row.confidence, row.evidence_count, row.source_count, row.first_seen_at, row.last_seen_at].every(Number.isFinite))
      .map(row => ({ id: row.id, source: row.source, target: row.target, type: row.type, confidence: Number(row.confidence), evidenceCount: Number(row.evidence_count), sourceCount: Number(row.source_count), firstSeenAt: Number(row.first_seen_at), lastSeenAt: Number(row.last_seen_at), validFrom: row.valid_from == null ? null : Number(row.valid_from), validTo: row.valid_to == null ? null : Number(row.valid_to) }));
    return { graphRevision: this.graphRevision(), nodes, edges, truncated: nodeRows.length > maxNodes || edgeRows.length > maxEdges };
  }

  timelineProjection(subjectId: string, options: { from: number; to: number; limit: number; scope?: string }): { rows: TimelineProjectionRow[]; truncated: boolean; graphRevision: number } {
    const limit = Math.min(50, Math.max(0, Math.trunc(options.limit)));
    const from = Math.min(options.from, options.to), to = Math.max(options.from, options.to);
    const scope = options.scope == null ? undefined : normalizeScope(options.scope);
    const rows = this.db.prepare(`WITH relevant AS (
        SELECT o.id AS observation_id,o.edge_id,o.source,o.created_at,o.valid_from,o.valid_to
        FROM kg_observations o LEFT JOIN kg_edges e ON e.id=o.edge_id AND e.deleted_at IS NULL
        WHERE (o.source_entity_id=? OR e.source_id=? OR e.target_id=?)
          AND (? IS NULL OR o.scope=?)
          AND typeof(o.id)='text' AND typeof(o.created_at)='integer'
          AND (o.valid_from IS NULL OR typeof(o.valid_from)='integer')
          AND (o.valid_to IS NULL OR typeof(o.valid_to)='integer')
          AND (o.valid_from IS NULL OR o.valid_to IS NULL OR o.valid_from<=o.valid_to)
      ), events AS (
        SELECT created_at AS timestamp,'observed' AS kind,observation_id,edge_id,source FROM relevant
        UNION ALL SELECT valid_from,'became_valid',observation_id,edge_id,source FROM relevant WHERE valid_from IS NOT NULL
        UNION ALL SELECT valid_to,'became_invalid',observation_id,edge_id,source FROM relevant WHERE valid_to IS NOT NULL
      ) SELECT timestamp,kind,GROUP_CONCAT(DISTINCT observation_id) AS observation_ids,
          GROUP_CONCAT(DISTINCT edge_id) AS relationship_ids,COUNT(DISTINCT observation_id) AS evidence_count,
          COUNT(DISTINCT source) AS source_count
        FROM events WHERE timestamp BETWEEN ? AND ? GROUP BY timestamp,kind ORDER BY timestamp,kind LIMIT ?`)
      .all(subjectId, subjectId, subjectId, scope ?? null, scope ?? null, from, to, limit + 1) as Array<{ timestamp: number; kind: TimelineProjectionRow["kind"]; observation_ids: string; relationship_ids: string | null; evidence_count: number; source_count: number }>;
    return { rows: rows.slice(0, limit).map(row => ({ timestamp: Number(row.timestamp), kind: row.kind, observationIds: [...new Set(String(row.observation_ids).split(","))].sort(), relationshipIds: row.relationship_ids == null ? [] : [...new Set(String(row.relationship_ids).split(","))].sort(), evidenceCount: Number(row.evidence_count), sourceCount: Number(row.source_count) })), truncated: rows.length > limit, graphRevision: this.graphRevision() };
  }

  qualityGraphSnapshot(seedIds: string[], limits: { maxNodes: number; maxArcs: number }, now = Date.now()): { nodes: string[]; arcs: PprArc[] } {
    const maxNodes = Math.max(0, Math.trunc(limits.maxNodes));
    const maxArcs = Math.max(0, Math.trunc(limits.maxArcs));
    const seeds = [...new Set(seedIds)].sort().filter(id => this.getNodeById(id) != null);
    if (seeds.length > maxNodes) throw new PprUnavailableError("scale_limit", "node limit exceeded");
    const nodes = new Set(seeds);
    const queue = [...seeds];
    const processedEdges = new Set<string>();
    const arcs: PprArc[] = [];
    while (queue.length) {
      const nodeId = queue.shift()!;
      const edges = this.db.prepare("SELECT * FROM kg_edges WHERE deleted_at IS NULL AND source_id<>target_id AND (source_id=? OR target_id=?) ORDER BY id").all(nodeId, nodeId) as EdgeRow[];
      for (const row of edges) {
        if (processedEdges.has(row.id)) continue;
        processedEdges.add(row.id);
        const edge = mapEdge(row);
        // Vocabulary labels are evidence-bearing but never influence graph
        // propagation. This also classifies historic rows at read time
        // without a destructive historic-edge rewrite.
        if (!isStructuralRelationship(edge.type)) continue;
        if (!this.getNodeById(edge.source_id) || !this.getNodeById(edge.target_id)) continue;
        const evidence = this.db.prepare(`SELECT source,confidence FROM kg_observations WHERE edge_id=?
          AND (valid_from IS NULL OR valid_from<=?) AND (valid_to IS NULL OR valid_to>=?) ORDER BY id`).all(edge.id, now, now) as Array<{ source: string; confidence: number }>;
        if (!evidence.length) continue;
        const confidence = evidence.reduce((sum, item) => sum + clamp01(Number(item.confidence)), 0) / evidence.length;
        const diversity = sourceDiversityScore(new Set(evidence.map(item => item.source)).size);
        const scale = confidence * diversity;
        const projected = edge.type === "related_to"
          ? [{ from: edge.source_id, to: edge.target_id, weight: .35 * scale }, { from: edge.target_id, to: edge.source_id, weight: .35 * scale }]
          : [{ from: edge.source_id, to: edge.target_id, weight: scale }, { from: edge.target_id, to: edge.source_id, weight: .5 * scale }];
        for (const id of [edge.source_id, edge.target_id]) if (!nodes.has(id)) {
          if (nodes.size >= maxNodes) throw new PprUnavailableError("scale_limit", "node limit exceeded");
          nodes.add(id); queue.push(id);
        }
        if (arcs.length + projected.length > maxArcs) throw new PprUnavailableError("scale_limit", "arc limit exceeded");
        arcs.push(...projected);
      }
    }
    return { nodes: [...nodes].sort(), arcs: arcs.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.weight - b.weight) };
  }

  private invalidateDetachedConflictCandidates(now = Date.now()): number {
    const result = this.db.prepare(`UPDATE kg_conflict_candidates SET status='invalid',reviewed_at=NULL,updated_at=?
      WHERE status!='invalid' AND (
        NOT EXISTS (SELECT 1 FROM kg_edges e WHERE e.id=edge_a AND e.deleted_at IS NULL) OR
        NOT EXISTS (SELECT 1 FROM kg_edges e WHERE e.id=edge_b AND e.deleted_at IS NULL) OR
        NOT EXISTS (SELECT 1 FROM kg_observations o WHERE o.id=observation_a AND o.edge_id=edge_a) OR
        NOT EXISTS (SELECT 1 FROM kg_observations o WHERE o.id=observation_b AND o.edge_id=edge_b)
      )`).run(now);
    return Number(result.changes);
  }

  private upsertEdge(sourceId: string, targetId: string, type: RelationshipType, edgeProps: Record<string, unknown>): KgEdge {
    const now = Date.now();
    const id = edgeId(sourceId, targetId, type);
    const existing = this.getEdgeById(id, true);
    const props = { ...(existing?.edge_props ?? {}), ...edgeProps };
    this.db.prepare(`INSERT INTO kg_edges (id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at)
      VALUES (?,?,?,?,?,0,NULL,?,?)
      ON CONFLICT(source_id,target_id,type) DO UPDATE SET edge_props=excluded.edge_props, deleted_at=NULL, updated_at=excluded.updated_at`
    ).run(id, sourceId, targetId, type, JSON.stringify(props), now, now);
    const edge = this.getEdgeById(id);
    if (!edge) throw new Error(`Failed to upsert edge: ${id}`);
    return edge;
  }

  private insertObservation(input: { edgeId?: string; sourceEntityId?: string; source: string; scope: string; quote: string; confidence: number; payload: Record<string, unknown>; temporal?: { valid_from?: string | number | null; valid_to?: string | number | null; temporal_confidence?: number | null } }): KgObservation {
    const temporal = normalizeTemporalEvidence(input.temporal ?? {}) ?? { valid_from: null, valid_to: null, temporal_confidence: null };
    const observation: KgObservation = {
      id: `obs:${randomUUID()}`,
      edge_id: input.edgeId ?? null,
      source_entity_id: input.sourceEntityId ?? null,
      payload: input.payload,
      source: input.source || "manual",
      scope: normalizeScope(input.scope),
      quote: input.quote || "",
      confidence: clamp01(input.confidence),
      ...temporal,
      created_at: Date.now()
    };
    this.db.prepare(`INSERT INTO kg_observations (id,edge_id,source_entity_id,payload,source,scope,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      observation.id, observation.edge_id, observation.source_entity_id, JSON.stringify(observation.payload), observation.source, observation.scope, observation.quote, observation.confidence, observation.valid_from, observation.valid_to, observation.temporal_confidence, observation.created_at
    );
    return observation;
  }

  private refreshEdgeWeight(edgeId: string): void {
    const row = this.db.prepare("SELECT COUNT(*) AS count, AVG(confidence) AS avg_confidence FROM kg_observations WHERE edge_id = ?").get(edgeId) as { count: number; avg_confidence: number | null };
    this.db.prepare("UPDATE kg_edges SET weight = ?, updated_at = ? WHERE id = ?").run(edgeWeight(Number(row.count), Number(row.avg_confidence ?? 0)), Date.now(), edgeId);
  }

  private touchScope(scope: string): void {
    const now = Date.now();
    this.db.prepare("INSERT INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at")
      .run(normalizeScope(scope), now, now);
  }

  private ensureMemoryChunks(): void {
    const rows = this.db.prepare(`SELECT d.id,d.scope,d.content,d.content_hash FROM kg_memory_documents d
      WHERE NOT EXISTS (SELECT 1 FROM kg_memory_chunks c WHERE c.document_id=d.id) ORDER BY d.id`)
      .all() as Array<{ id: string; scope: string; content: string; content_hash: string }>;
    const now = Date.now();
    for (const row of rows) this.ensureMemoryChunksForDocument(row, now);
  }

  private ensureMemoryChunksForDocument(document: { id: string; scope: string; content: string; content_hash: string }, now: number): void {
    const existing = this.db.prepare("SELECT 1 FROM kg_memory_chunks WHERE document_id=? LIMIT 1").get(document.id);
    if (existing) return;
    for (const chunk of chunkMemoryDocument(document.id, document.content)) {
      this.db.prepare(`INSERT INTO kg_memory_chunks(id,document_id,scope,ordinal,content,content_hash,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(chunk.id, chunk.document_id, normalizeScope(document.scope), chunk.ordinal, chunk.content, chunk.content_hash, now, now);
      this.db.prepare("INSERT INTO kg_memory_chunks_fts(id,content) VALUES(?,?)").run(chunk.id, chunk.content);
    }
  }

  private refreshNodeImportance(nodeId: string): void {
    const evidence = this.db.prepare("SELECT COUNT(*) AS count,AVG(confidence) AS average_confidence,COUNT(DISTINCT source) AS source_count FROM kg_observations WHERE source_entity_id = ?").get(nodeId) as { count: number; average_confidence: number | null; source_count: number };
    const degree = this.db.prepare("SELECT COUNT(*) AS count FROM kg_edges WHERE deleted_at IS NULL AND (source_id=? OR target_id=?)").get(nodeId, nodeId) as { count: number };
    this.db.prepare("UPDATE kg_nodes SET importance = ?, updated_at = ? WHERE id = ?").run(nodeImportance(Number(evidence.count), Number(evidence.average_confidence ?? 0), Number(evidence.source_count), Number(degree.count)), Date.now(), nodeId);
  }

  /** Terminal automatic-run receipts are durable idempotency evidence, but not
   * permanent memory. Keep recent outcomes for diagnostics while bounding the
   * table even after an unattended, high-volume host has run for years. */
  pruneAutoRuns(now = Date.now()): number {
    this.db.exec("BEGIN IMMEDIATE");
    try { const removed = this.pruneAutoRunsInTransaction(now); this.db.exec("COMMIT"); return removed; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  private pruneAutoRunsInTransaction(now: number): number {
    const cutoff = now - 30 * 86_400_000;
    let removed = Number((this.db.prepare("DELETE FROM kg_auto_runs WHERE status<>'running' AND finished_at IS NOT NULL AND finished_at<?").run(cutoff) as { changes?: number }).changes ?? 0);
    const count = Number((this.db.prepare("SELECT COUNT(*) AS n FROM kg_auto_runs").get() as { n: number }).n);
    const excess = Math.max(0, count - 10_000);
    if (!excess) return removed;
    // Never evict an active lease solely to satisfy retention. A stale running
    // entry is eligible: it has already exceeded the maximum crash-reclaim
    // horizon and will otherwise block its own idempotency key indefinitely.
    const stale = now - 2 * 86_400_000;
    const rows = this.db.prepare("SELECT turn_key FROM kg_auto_runs WHERE status<>'running' OR started_at<? ORDER BY CASE WHEN status='running' THEN 1 ELSE 0 END,COALESCE(finished_at,started_at),turn_key LIMIT ?").all(stale, excess) as Array<{ turn_key: string }>;
    const drop = this.db.prepare("DELETE FROM kg_auto_runs WHERE turn_key=?");
    for (const row of rows) removed += Number((drop.run(row.turn_key) as { changes?: number }).changes ?? 0);
    return removed;
  }

  private upsertFts(nodeId: string, replace = true): void {
    const node = this.getNodeById(nodeId);
    if (!node) return;
    if (replace) this.db.prepare("DELETE FROM kg_nodes_fts WHERE id = ?").run(node.id);
    this.db.prepare("INSERT INTO kg_nodes_fts (id,name,description,aliases) VALUES (?,?,?,?)").run(node.id, node.name, node.description, node.aliases.join(" "));
  }

  private listActiveNodes(nodeType?: string): NodeRow[] {
    return this.db.prepare(`SELECT * FROM kg_nodes WHERE deleted_at IS NULL ${nodeType ? "AND type = ?" : ""}`).all(...(nodeType ? [nodeType] : [])) as NodeRow[];
  }

  private evidenceForNode(nodeId: string, limit: number, scope?: string): EvidenceSummary[] {
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    return this.db.prepare("SELECT id AS observation_id,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at FROM kg_observations WHERE source_entity_id = ? AND (? IS NULL OR scope=?) ORDER BY confidence DESC,created_at DESC,id LIMIT ?").all(nodeId, normalizedScope ?? null, normalizedScope ?? null, limit) as EvidenceSummary[];
  }

  private hasGraphPresence(nodeId: string, scope: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1
      FROM kg_observations o
      LEFT JOIN kg_edges e ON e.id=o.edge_id
      WHERE o.scope=? AND (o.source_entity_id=? OR e.source_id=? OR e.target_id=?)
      LIMIT 1`).get(scope, nodeId, nodeId, nodeId));
  }

  private evidenceForEdge(edgeId: string, limit: number, scope?: string): EvidenceSummary[] {
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    return this.db.prepare("SELECT id AS observation_id,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at FROM kg_observations WHERE edge_id = ? AND (? IS NULL OR scope=?) ORDER BY confidence DESC,created_at DESC,id LIMIT ?").all(edgeId, normalizedScope ?? null, normalizedScope ?? null, limit) as EvidenceSummary[];
  }

  private sourceSummary(source: string, scope?: string): KgSourceSummary[] {
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const row = this.db.prepare(`
      SELECT source, COUNT(*) AS observations, AVG(confidence) AS average_confidence, MIN(created_at) AS first_seen_at, MAX(created_at) AS last_seen_at
      FROM kg_observations
      WHERE source = ? AND (? IS NULL OR scope=?)
      GROUP BY source
    `).get(source, normalizedScope ?? null, normalizedScope ?? null) as { source: string; observations: number; average_confidence: number; first_seen_at: number; last_seen_at: number } | undefined;
    return row ? [mapSourceSummary(row)] : [];
  }

  /** Project old and new domain assertions as labels.  The underlying edge is
   * retained for evidence compatibility, but this projection never lets a
   * label become a recursive graph arc. */
  private semanticLabelsForNode(nodeId: string, predicates: ReadonlySet<RelationshipType>, scope?: string, limit = 100, direction?: Direction): RelatedSemanticLabelResult[] {
    if (!predicates.size) return [];
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const statement = this.db.prepare("SELECT * FROM kg_edges WHERE deleted_at IS NULL AND type=? AND (source_id=? OR target_id=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.edge_id=kg_edges.id AND so.scope=?)) ORDER BY id LIMIT ?");
    const labels: RelatedSemanticLabelResult[] = [];
    for (const predicate of [...predicates].filter(isSemanticRelationship).sort()) {
      for (const row of statement.all(predicate, nodeId, nodeId, normalizedScope ?? null, normalizedScope ?? null, Math.min(100, Math.max(1, Math.trunc(limit)))) as EdgeRow[]) {
        const edge = mapEdge(row), source = this.getNodeById(edge.source_id), target = this.getNodeById(edge.target_id);
        if (!source || !target) continue;
        const requestedDirection = effectiveDirection(edge.type, direction);
        if (requestedDirection === "out" && edge.source_id !== nodeId) continue;
        if (requestedDirection === "in" && edge.target_id !== nodeId) continue;
        const recommendation = semanticVocabularyRecommendation(edge.type, source.type, target.type);
        const stored = edge.edge_props.semantics;
        const metadata = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, unknown> : undefined;
        const domain = metadata?.domain === "investment" || metadata?.domain === "code" ? metadata.domain : recommendation.domain;
        const endpoint_match = typeof metadata?.endpoint_match === "boolean" ? metadata.endpoint_match : recommendation.endpoint_match;
        const evidence = this.evidenceForEdge(edge.id, 3, normalizedScope);
        if (!evidence.length) continue;
        const confidence = evidence.reduce((total, item) => total + item.confidence, 0) / evidence.length;
        // A soft dictionary mismatch is still displayed with its original
        // evidence but ranks below an otherwise equal dictionary match.
        const score = confidence * (endpoint_match ? 1 : .75);
        labels.push({ id: edge.id, predicate: edge.type, domain, source, target, evidence, legacy: metadata?.layer !== "semantic", endpoint_match, score });
        if (labels.length >= limit) return labels;
      }
    }
    return labels;
  }

  private edgesForNode(nodeId: string, allowed: Set<RelationshipType> | null, direction?: Direction, scope?: string): KgEdge[] {
    const normalizedScope = scope == null ? undefined : normalizeScope(scope);
    const stmt = this.db.prepare("SELECT * FROM kg_edges WHERE deleted_at IS NULL AND type = ? AND (source_id = ? OR target_id = ?) AND (? IS NULL OR EXISTS (SELECT 1 FROM kg_observations so WHERE so.edge_id=kg_edges.id AND so.scope=?))");
    const result: KgEdge[] = [];
    for (const type of Object.keys(relationshipDefinitions) as RelationshipType[]) {
      if (allowed && !allowed.has(type)) continue;
      const requested = effectiveDirection(type, direction);
      for (const row of stmt.all(type, nodeId, nodeId, normalizedScope ?? null, normalizedScope ?? null) as EdgeRow[]) {
        const edge = mapEdge(row);
        if (requested === "out" && edge.source_id !== nodeId) continue;
        if (requested === "in" && edge.target_id !== nodeId) continue;
        result.push(edge);
      }
    }
    return result;
  }
}

const semanticQueryAliases: Partial<Record<RelationshipType, readonly string[]>> = {
  works_at: ["works_at", "works at", "工作于", "任职"],
  invested_in: ["invested_in", "invested in", "投资"],
  supplies: ["supplies", "supply", "供应"],
  supplies_product: ["supplies_product", "supplies product", "供应产品"],
  supplied_to: ["supplied_to", "供货给"],
  competes_with: ["competes_with", "competes with", "竞争"],
  uses: ["uses", "using", "使用"],
  develops: ["develops", "developed", "开发"],
  owns: ["owns", "owned", "拥有"],
  partners_with: ["partners_with", "partners with", "合作"],
  in_portfolio: ["in_portfolio", "portfolio", "投资组合"]
};

/** Label recall is exact-predicate only. A bare entity lookup must not turn
 * every historical domain assertion into automatic context noise. */
function semanticPredicatesForQuery(query: string): Set<RelationshipType> {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  const selected = new Set<RelationshipType>();
  for (const predicate of semanticRelationshipTypes) {
    const aliases = semanticQueryAliases[predicate] ?? [predicate];
    if (aliases.some(alias => /[a-z_]/i.test(alias)
      ? new RegExp(`(?:^|[^a-z0-9_])${escapeRegex(alias.toLocaleLowerCase())}(?:$|[^a-z0-9_])`, "i").test(normalized)
      : normalized.includes(alias))) selected.add(predicate);
  }
  // Bare "supplies" is a broad predicate. A following object is enough to
  // request the more specific product label (for example, "supplies MLCC"),
  // but a bare query such as "Acme supplies" must not add it as noise.
  if (selected.has("supplies") && hasSupplyObject(normalized)) selected.add("supplies_product");
  return selected;
}

function hasSupplyObject(query: string): boolean {
  return /\b(?:supplies|supply)\s+(?:(?:the|a|an)\s+)?(?!to\b)[\p{L}\p{N}_-]+/iu.test(query)
    || /供应\s*[\p{L}\p{N}_-]/u.test(query);
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function expandPath(path: string): string {
  if (path === ":memory:") return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

const insightKinds = new Set<InsightKind>(["knowledge_gap", "emerging_topic", "cross_community_path"]);
const insightReasons = new Set<KgInsight["reason"]>(["isolated", "weak_evidence", "source_concentration", "rapid_growth", "bridge_path"]);
const insightNodeTypes = ["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"] as const;
const insightNodeTypeSql = insightNodeTypes.map(type => `'${type}'`).join(",");
const insightRelationshipPredicate = Object.entries(relationshipDefinitions).map(([type, definition]) => {
  const accepts = (value: string, alias: string) => value === "*"
    ? "1=1"
    : `${alias}.type IN (${value.split("|").map(item => `'${item}'`).join(",")})`;
  return `(e.type='${type}' AND ${accepts(definition.source, "sn")} AND ${accepts(definition.target, "tn")})`;
}).join(" OR ");

function canonicalizeInsightSnapshot(value: unknown): InsightSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const { graphRevision, algorithmVersion, createdAt, truncated } = value;
  if (!isNonNegativeSafeInteger(graphRevision) || typeof algorithmVersion !== "string" || !algorithmVersion || !isFiniteNumber(createdAt) || typeof truncated !== "boolean") return undefined;
  const communities = canonicalizeArray(value.communities, canonicalizeCommunitySummary);
  const insights = canonicalizeArray(value.insights, canonicalizeInsight);
  const warnings = canonicalizeArray(value.warnings, canonicalizeInsightWarning);
  if (!communities || !insights || !warnings) return undefined;
  return { graphRevision, algorithmVersion, createdAt, truncated, communities, insights, warnings };
}

function canonicalizeCommunitySummary(value: unknown): CommunitySummary | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const entity_ids = canonicalizeStringArray(value.entity_ids);
  const { size, internal_edge_count, density, average_confidence, evidence_coverage, source_concentration, recent_growth, bridge_score } = value;
  if (!entity_ids || !isFiniteNumber(size) || !isFiniteNumber(internal_edge_count) || !isFiniteNumber(density) || !isFiniteNumber(average_confidence) || !isFiniteNumber(evidence_coverage) || !isFiniteNumber(source_concentration) || !isFiniteNumber(recent_growth) || !isFiniteNumber(bridge_score)) return undefined;
  return {
    id: value.id, entity_ids, size, internal_edge_count, density,
    average_confidence, evidence_coverage, source_concentration, recent_growth, bridge_score
  };
}

function canonicalizeInsight(value: unknown): KgInsight | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.kind !== "string" || !insightKinds.has(value.kind as InsightKind) || !isFiniteNumber(value.score) || typeof value.reason !== "string" || !insightReasons.has(value.reason as KgInsight["reason"])) return undefined;
  const community_ids = canonicalizeStringArray(value.community_ids);
  const entity_ids = canonicalizeStringArray(value.entity_ids);
  const relationship_ids = canonicalizeStringArray(value.relationship_ids);
  const signals = canonicalizeSignals(value.signals);
  if (!community_ids || !entity_ids || !relationship_ids || !signals) return undefined;
  const path = value.path === undefined ? undefined : canonicalizeInsightPath(value.path);
  if (value.path !== undefined && !path) return undefined;
  return { id: value.id, kind: value.kind as InsightKind, score: value.score, community_ids, entity_ids, relationship_ids, reason: value.reason as KgInsight["reason"], signals, ...(path ? { path } : {}) };
}

function canonicalizeInsightPath(value: unknown): KgInsight["path"] | undefined {
  if (!isRecord(value)) return undefined;
  const entity_ids = canonicalizeStringArray(value.entity_ids);
  const edge_ids = canonicalizeStringArray(value.edge_ids);
  if (!entity_ids || !edge_ids || entity_ids.length > 5 || edge_ids.length > 4 || entity_ids.length !== edge_ids.length + 1) return undefined;
  return { entity_ids, edge_ids };
}

function canonicalizeInsightWarning(value: unknown): { category: string; detector?: InsightKind } | undefined {
  if (!isRecord(value) || typeof value.category !== "string") return undefined;
  if (value.detector === undefined) return { category: value.category };
  return typeof value.detector === "string" && insightKinds.has(value.detector as InsightKind)
    ? { category: value.category, detector: value.detector as InsightKind }
    : undefined;
}

function canonicalizeArray<T>(value: unknown, canonicalize: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: T[] = [];
  for (const item of value) {
    const canonical = canonicalize(item);
    if (canonical === undefined) return undefined;
    items.push(canonical);
  }
  return items;
}

function canonicalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === "string") ? [...value] : undefined;
}

function canonicalizeSignals(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const signals: Record<string, number> = {};
  for (const [name, signal] of Object.entries(value)) {
    if (!isFiniteNumber(signal)) return undefined;
    signals[name] = signal;
  }
  return signals;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function canonicalQueryPlan(plan: QueryPlanV1): QueryPlanV1 {
  return { version: 1, steps: plan.steps.map(step => {
    if (step.op === "lookup") return { op: "lookup", query: step.query, ...(step.node_types === undefined ? {} : { node_types: [...step.node_types] }), ...(step.mode === undefined ? {} : { mode: step.mode }) };
    if (step.op === "traverse") return { op: "traverse", from: [...step.from], ...(step.edge_types === undefined ? {} : { edge_types: [...step.edge_types] }), direction: step.direction, depth: step.depth };
    if (step.op === "filter") return { op: "filter", ...(step.node_types === undefined ? {} : { node_types: [...step.node_types] }), ...(step.confidence_min === undefined ? {} : { confidence_min: step.confidence_min }), ...(step.valid_from === undefined ? {} : { valid_from: step.valid_from }), ...(step.valid_to === undefined ? {} : { valid_to: step.valid_to }) };
    if (step.op === "aggregate") return { op: "aggregate", by: step.by, metric: step.metric };
    throw new Error("invalid query audit plan");
  }), order_by: plan.order_by, limit: plan.limit };
}

function safeAuditQueryPlan(plan: QueryPlanV1): QueryAuditPlanV1 {
  return { kind: "query_audit_plan", version: 1, steps: plan.steps.map(step => {
    if (step.op === "lookup") return { op: "lookup", query_redacted: true, ...(step.node_types === undefined ? {} : { node_types: [...step.node_types] }), ...(step.mode === undefined ? {} : { mode: step.mode }) };
    if (step.op === "traverse") return { op: "traverse", from_previous: step.from.includes("$previous"), explicit_entity_count: step.from.filter(value => value !== "$previous").length, ...(step.edge_types === undefined ? {} : { edge_types: [...step.edge_types] }), direction: step.direction, depth: step.depth };
    if (step.op === "filter") return { op: "filter", ...(step.node_types === undefined ? {} : { node_types: [...step.node_types] }), ...(step.confidence_min === undefined ? {} : { confidence_min: step.confidence_min }), ...(step.valid_from === undefined ? {} : { valid_from: step.valid_from }), ...(step.valid_to === undefined ? {} : { valid_to: step.valid_to }) };
    if (step.op === "aggregate") return { op: "aggregate", by: step.by, metric: step.metric };
    throw new Error("invalid query audit plan");
  }), order_by: plan.order_by, limit: plan.limit };
}

function nonNegativeInteger(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0; }
function inspectorCount(value: unknown): number { return typeof value === "number" ? nonNegativeInteger(value) : 0; }

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function mapNode(row: NodeRow): KgNode {
  return { ...row, aliases: parseJsonArray(row.aliases), importance: Number(row.importance), deleted_at: row.deleted_at == null ? null : Number(row.deleted_at), created_at: Number(row.created_at), updated_at: Number(row.updated_at) };
}

function mapWatch(row: Record<string, unknown>): KgWatch {
  return { id: String(row.id), name: String(row.name), plan: normalizeQueryPlan(JSON.parse(String(row.normalized_plan))), plan_hash: String(row.plan_hash), scope: normalizeScope(row.scope, "default"), schedule_hint: row.schedule_hint as WatchScheduleHint, cursor: row.cursor == null ? null : Number(row.cursor), enabled: Number(row.enabled) === 1, created_at: Number(row.created_at), updated_at: Number(row.updated_at) };
}

function mapEdge(row: EdgeRow): KgEdge {
  return { ...row, type: row.type as RelationshipType, edge_props: parseJsonObject(row.edge_props), weight: Number(row.weight), deleted_at: row.deleted_at == null ? null : Number(row.deleted_at), created_at: Number(row.created_at), updated_at: Number(row.updated_at) };
}

function mapSourceSummary(row: { source: string; observations: number; average_confidence: number; first_seen_at: number; last_seen_at: number }): KgSourceSummary {
  return {
    source: row.source,
    observations: Number(row.observations),
    average_confidence: Number(row.average_confidence ?? 0),
    first_seen_at: Number(row.first_seen_at),
    last_seen_at: Number(row.last_seen_at)
  };
}

function mapMemoryDocument(row: Record<string, unknown>): KgMemoryDocument {
  const metadata = parseJsonObject(String(row.metadata ?? "{}"));
  const scalarMetadata = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value == null || ["string", "number", "boolean"].includes(typeof value))) as KgMemoryDocument["metadata"];
  return {
    id: String(row.id), scope: String(row.scope), title: String(row.title), content: String(row.content), source: String(row.source),
    metadata: scalarMetadata, content_hash: String(row.content_hash), lifecycle_state: row.lifecycle_state === "archived" ? "archived" : "active",
    archived_at: row.archived_at == null ? null : Number(row.archived_at), created_at: Number(row.created_at), updated_at: Number(row.updated_at)
  };
}

function mapMemoryChunk(row: Record<string, unknown>): KgMemoryChunk {
  return {
    id: String(row.id), document_id: String(row.document_id), ...(typeof row.document_title === "string" ? { document_title: row.document_title } : {}), scope: String(row.scope), ordinal: Number(row.ordinal),
    content: String(row.content), content_hash: String(row.content_hash), created_at: Number(row.created_at), updated_at: Number(row.updated_at)
  };
}

function mapMemoryChunkFromDocumentRow(row: Record<string, unknown>): KgMemoryChunk {
  return {
    id: String(row.chunk_id), document_id: String(row.id), ...(typeof row.title === "string" ? { document_title: row.title } : {}), scope: String(row.scope), ordinal: Number(row.chunk_ordinal),
    content: String(row.chunk_content), content_hash: String(row.chunk_content_hash), created_at: Number(row.created_at), updated_at: Number(row.updated_at)
  };
}

function memorySearchResult(document: KgMemoryDocument, score: number, query: string, excerptContent = document.content, scoreComponents?: { lexical: number; semantic: number }): KgMemorySearchResult {
  const normalized = query.trim().toLowerCase();
  const content = excerptContent.replace(/\s+/g, " ").trim();
  const index = normalized ? content.toLowerCase().indexOf(normalized) : -1;
  const start = index < 0 ? 0 : Math.max(0, index - 120);
  const end = Math.min(content.length, start + 480);
  const excerpt = `${start ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
  return { id: document.id, scope: document.scope, title: document.title, excerpt, source: document.source, metadata: document.metadata, score: round(score), ...(scoreComponents ? { score_components: { lexical: round(scoreComponents.lexical), semantic: round(scoreComponents.semantic) } } : {}), created_at: document.created_at, updated_at: document.updated_at };
}


function parseJsonArray(value: string): string[] { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []; } catch { return []; } }
function parseJsonObject(value: string): Record<string, unknown> { try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function edgeId(sourceId: string, targetId: string, type: RelationshipType): string { return `edge:${createHash("sha256").update(`${sourceId}\0${targetId}\0${type}`).digest("hex").slice(0, 24)}`; }
function normalizeLookup(value: string): string { return value.trim().toLowerCase(); }
function uniqueStrings(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
const constrainedNodeTypes = new Set(["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"]);
const constrainedEdgeTypes = new Set(["works_at", "invested_in", "supplies", "supplies_product", "supplied_to", "competes_with", "uses", "develops", "owns", "partners_with", "in_portfolio", "depends_on", "part_of", "instance_of", "related_to"]);
function validNodeConstraint(row: Record<string, unknown>): boolean {
  return validText(row.id) && typeof row.name === "string" && row.name.trim().length > 0 && constrainedNodeTypes.has(String(row.type))
    && jsonKind(row.aliases, "array") && unitNumber(row.importance) && safeTimestamp(row.created_at) && safeTimestamp(row.updated_at);
}
function validEdgeConstraint(row: Record<string, unknown>, db: DatabaseSyncInstance): boolean {
  return validText(row.id) && validText(row.source_id) && validText(row.target_id) && constrainedEdgeTypes.has(String(row.type))
    && jsonKind(row.edge_props, "object") && unitNumber(row.weight) && safeTimestamp(row.created_at) && safeTimestamp(row.updated_at)
    && Boolean(db.prepare("SELECT 1 FROM kg_nodes WHERE id=?").get(row.source_id)) && Boolean(db.prepare("SELECT 1 FROM kg_nodes WHERE id=?").get(row.target_id));
}
function validObservationConstraint(row: Record<string, unknown>, db: DatabaseSyncInstance): boolean {
  const edge = validText(row.edge_id), entity = validText(row.source_entity_id);
  const target = edge !== entity && (edge ? Boolean(db.prepare("SELECT 1 FROM kg_edges WHERE id=?").get(row.edge_id)) : Boolean(db.prepare("SELECT 1 FROM kg_nodes WHERE id=?").get(row.source_entity_id)));
  const temporal = row.temporal_confidence == null || unitNumber(row.temporal_confidence);
  const ordered = row.valid_from == null || row.valid_to == null || safeTimestamp(row.valid_from) && safeTimestamp(row.valid_to) && Number(row.valid_from) <= Number(row.valid_to);
  return validText(row.id) && target && jsonKind(row.payload, "object") && validText(row.source) && validText(row.scope) && typeof row.quote === "string"
    && unitNumber(row.confidence) && temporal && ordered && safeTimestamp(row.created_at);
}
function validText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1_000_000; }
function safeTimestamp(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0; }
function unitNumber(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function jsonKind(value: unknown, kind: "array" | "object"): boolean {
  if (typeof value !== "string") return false;
  try { const parsed = JSON.parse(value); return kind === "array" ? Array.isArray(parsed) : parsed != null && typeof parsed === "object" && !Array.isArray(parsed); }
  catch { return false; }
}
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function clampInt(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : min;
}
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function contextEdgeScore(edge: KgEdge): number { return edge.weight * (edge.type === "related_to" ? .75 : 1); }
function validConfidence(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 1; }
function toFtsQuery(query: string): string { return (query.match(/[\p{L}\p{N}_-]+/gu) ?? []).map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR "); }
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, (char) => `\\${char}`); }
