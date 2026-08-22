import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { ExternalSourceRef } from "../trust/types.js";
import { BoundedCommandError } from "./command.js";
import { ProviderAdapterRegistry } from "./registry.js";
import type { IntegrationProviderId, ProviderCapabilities, ResolvedSource } from "./types.js";

export interface PublicMigrationItem { externalId: string; contentHash: string; sourceRef: ExternalSourceRef; metadata?: Record<string, string | number | boolean | null>; status: "pending" | "imported" | "skipped_duplicate" | "failed" | "source_changed"; errorCode?: string; }
export interface PublicMigrationRun { id: string; provider: IntegrationProviderId; scope: string; status: "previewed" | "running" | "completed" | "completed_with_failures" | "rollback_requires_restore"; capabilities: ProviderCapabilities; items: PublicMigrationItem[]; inventory?: { offset: number; nextOffset?: number; complete: boolean }; createdAt: number; updatedAt: number; completedAt?: number; }
type Request = { query?: string; providerScope?: string; limit?: number; offset?: number; inventory?: true; complete?: boolean; nextOffset?: number; refs?: ExternalSourceRef[] };
const clean = (value: unknown, maximum: number) => typeof value === "string" && value.trim() && value.length <= maximum && !/[\u0000-\u001f]/.test(value) ? value.trim() : undefined;
const classify = (error: unknown) => error instanceof BoundedCommandError ? error.category : "operation_failed";

/**
 * Resumable migration uses only registered Provider Adapter capabilities. It
 * stores public source references plus hashes, never a provider DB path, table
 * name, or copied source payload. A rollback deliberately delegates to the
 * existing preview-first portable restore path: deleting mixed graph evidence
 * by provider source would be unsafe.
 */
export class PublicProviderMigrationService {
  constructor(private readonly db: DatabaseSyncInstance, private readonly registry: ProviderAdapterRegistry, private readonly ingest: (input: { source: ResolvedSource; scope: string }) => Promise<{ status: "succeeded" | "skipped_duplicate" | "failed" }>, private readonly now: () => number = Date.now) {}

  async preview(input: { provider: IntegrationProviderId; scope: string; query?: string; providerScope?: string; externalRefs?: ExternalSourceRef[]; limit?: number; offset?: number; signal?: AbortSignal }): Promise<PublicMigrationRun> {
    const scope = normalizeScope(input.scope), provider = input.provider, capability = await this.registry.probe(provider, input.signal), inventory = this.registry.supportsPublicInventory(provider), limit = Math.min(inventory ? 100 : 10, Math.max(1, Math.trunc(input.limit ?? (inventory ? 50 : 5)))), offset = Math.max(0, Math.min(1_000_000, Math.trunc(input.offset ?? 0)));
    let sources: ResolvedSource[];
    let request: Request;
    if (inventory) {
      const providerScope = clean(input.providerScope ?? "global", 80);
      if (!providerScope || !Number.isFinite(offset)) throw new Error("migration_inventory_invalid");
      const page = await this.registry.listSources(provider, providerScope, limit, offset, input.signal);
      sources = page.sources;
      request = { inventory: true, providerScope, limit, offset, complete: page.complete, ...(page.nextOffset == null ? {} : { nextOffset: page.nextOffset }) };
      // The list CLI exposes a page, not a private table cursor.  The next
      // page is selected explicitly by the operator with its public offset.
      // It is intentionally not followed automatically behind their back.
    } else if (capability.searchSources) {
      const query = clean(input.query, 4000), providerScope = clean(input.providerScope ?? "global", 80);
      if (!query || !providerScope) throw new Error("migration_query_required");
      sources = await this.registry.searchCandidates(provider, query, providerScope, limit, input.signal);
      request = { query, providerScope, limit };
    } else if (capability.resolveRawSource) {
      const refs = [...new Map((input.externalRefs ?? []).filter(ref => ref?.provider === provider).slice(0, limit).map(ref => [ref.externalId, ref])).values()];
      if (!refs.length) throw new Error("migration_source_ref_required");
      sources = (await Promise.all(refs.map(ref => this.registry.resolveSource(provider, ref, input.signal)))).flatMap(item => item ? [item] : []);
      request = { refs: sources.map(item => item.ref) };
    } else throw new Error("migration_capability_unavailable");
    const id = `migration:${createHash("sha256").update(JSON.stringify({ provider, scope, request, sources: sources.map(item => [item.ref.externalId, item.contentHash]) })).digest("hex").slice(0, 40)}`;
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(scope, now, now);
      this.db.prepare("INSERT OR IGNORE INTO mnemora_provider_migration_runs(id,provider,scope,status,request_json,created_at,updated_at) VALUES(?,?,?,'previewed',?,?,?)").run(id, provider, scope, JSON.stringify(request), now, now);
      // A deterministic preview may be rerun.  Unapplied rows that are no
      // longer in its current source set must not survive and later be
      // imported by surprise; completed audit rows are retained.
      const ids = sources.map(source => source.ref.externalId);
      if (ids.length) this.db.prepare(`DELETE FROM mnemora_provider_migration_items WHERE run_id=? AND status='pending' AND external_id NOT IN (${ids.map(() => "?").join(",")})`).run(id, ...ids);
      else this.db.prepare("DELETE FROM mnemora_provider_migration_items WHERE run_id=? AND status='pending'").run(id);
      const insert = this.db.prepare("INSERT OR IGNORE INTO mnemora_provider_migration_items(run_id,ordinal,external_id,source_ref_json,content_hash,metadata_json,status,updated_at) VALUES(?,?,?,?,?,?,'pending',?)");
      sources.forEach((source, ordinal) => insert.run(id, ordinal, source.ref.externalId, JSON.stringify(source.ref), source.contentHash, JSON.stringify(source.metadata ?? {}), now));
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    return this.read(id, capability)!;
  }

  async apply(input: { id: string; signal?: AbortSignal }): Promise<PublicMigrationRun> {
    const current = this.row(input.id); if (!current) throw new Error("migration_not_found");
    const capabilities = await this.registry.probe(current.provider, input.signal), now = this.now();
    this.db.prepare("UPDATE mnemora_provider_migration_runs SET status='running',updated_at=?,completed_at=NULL WHERE id=?").run(now, current.id);
    const request = parseRequest(current.request_json), items = this.items(current.id).filter(item => item.status === "pending" || item.status === "failed");
    for (const item of items) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("aborted");
      try {
        const resolved = await this.resolve(current.provider, item, request, capabilities, input.signal);
        // Absence from a search result is not evidence that the original
        // source changed.  Preserve the item for a later retry and make the
        // capability gap explicit instead of silently treating it as data
        // drift.
        if (!resolved) { this.updateItem(current.id, item.externalId, "failed", "source_unavailable"); continue; }
        if (resolved.contentHash !== item.contentHash) { this.updateItem(current.id, item.externalId, "source_changed", "source_changed"); continue; }
        // Previewed public metadata is part of the migration record. Exact
        // re-resolution may omit optional metadata, so retain its bounded
        // preview value rather than silently losing public provenance.
        const source = resolved.metadata || !item.metadata ? resolved : { ...resolved, metadata: item.metadata };
        const outcome = await this.ingest({ source, scope: current.scope });
        this.updateItem(current.id, item.externalId, outcome.status === "succeeded" ? "imported" : outcome.status, outcome.status === "failed" ? "ingestion_failed" : undefined);
      } catch (error) { this.updateItem(current.id, item.externalId, "failed", classify(error)); }
    }
    const remaining = this.items(current.id).some(item => item.status === "pending" || item.status === "failed" || item.status === "source_changed"), done = this.now();
    this.db.prepare("UPDATE mnemora_provider_migration_runs SET status=?,updated_at=?,completed_at=? WHERE id=?").run(remaining ? "completed_with_failures" : "completed", done, done, current.id);
    return this.read(current.id, capabilities)!;
  }

  verify(id: string): PublicMigrationRun | undefined { const current = this.row(id); return current ? this.read(id, this.registry.capabilities(current.provider) ?? emptyCapabilities(current.provider)) : undefined; }
  rollback(id: string): PublicMigrationRun | undefined { const current = this.row(id); if (!current) return undefined; const now = this.now(); this.db.prepare("UPDATE mnemora_provider_migration_runs SET status='rollback_requires_restore',updated_at=? WHERE id=?").run(now, id); return this.read(id, this.registry.capabilities(current.provider) ?? emptyCapabilities(current.provider)); }

  private resolve(provider: IntegrationProviderId, item: PublicMigrationItem, request: Request, capabilities: ProviderCapabilities, signal?: AbortSignal): Promise<ResolvedSource | null> {
    // A stable public id must use exact resolution when offered.  Search is a
    // discovery mechanism only and may legitimately have a changing top-N
    // window between preview and apply.
    if (capabilities.resolveRawSource) return this.registry.resolveSource(provider, item.sourceRef, signal);
    if (request.inventory && request.providerScope) return this.registry.listSources(provider, request.providerScope, request.limit ?? 50, request.offset ?? 0, signal).then(page => page.sources.find(source => source.ref.externalId === item.externalId) ?? null);
    if (request.query && request.providerScope) return this.registry.searchCandidates(provider, request.query, request.providerScope, request.limit ?? 10, signal).then(items => items.find(source => source.ref.externalId === item.externalId) ?? null);
    return this.registry.resolveSource(provider, item.sourceRef, signal);
  }
  private updateItem(id: string, externalId: string, status: PublicMigrationItem["status"], errorCode?: string) { this.db.prepare("UPDATE mnemora_provider_migration_items SET status=?,error_code=?,updated_at=? WHERE run_id=? AND external_id=?").run(status, errorCode ?? null, this.now(), id, externalId); }
  private row(id: string): { id: string; provider: IntegrationProviderId; scope: string; status: PublicMigrationRun["status"]; request_json: string; created_at: number; updated_at: number; completed_at: number | null } | undefined { return this.db.prepare("SELECT * FROM mnemora_provider_migration_runs WHERE id=?").get(clean(id, 200) ?? "") as { id: string; provider: IntegrationProviderId; scope: string; status: PublicMigrationRun["status"]; request_json: string; created_at: number; updated_at: number; completed_at: number | null } | undefined; }
  private items(id: string): PublicMigrationItem[] { return (this.db.prepare("SELECT external_id,source_ref_json,content_hash,metadata_json,status,error_code FROM mnemora_provider_migration_items WHERE run_id=? ORDER BY ordinal").all(id) as Array<{ external_id: string; source_ref_json: string; content_hash: string; metadata_json: string; status: PublicMigrationItem["status"]; error_code: string | null }>).flatMap(row => { try { const sourceRef = JSON.parse(row.source_ref_json) as ExternalSourceRef, metadata = parseMetadata(row.metadata_json); return [{ externalId: row.external_id, contentHash: row.content_hash, sourceRef, ...(metadata ? { metadata } : {}), status: row.status, ...(row.error_code ? { errorCode: row.error_code } : {}) }]; } catch { return []; } }); }
  private read(id: string, capabilities: ProviderCapabilities): PublicMigrationRun | undefined { const row = this.row(id); if (!row) return undefined; const request = parseRequest(row.request_json); return { id: row.id, provider: row.provider, scope: row.scope, status: row.status, capabilities, items: this.items(id), ...(request.inventory ? { inventory: { offset: request.offset ?? 0, ...(request.nextOffset == null ? {} : { nextOffset: request.nextOffset }), complete: request.complete === true } } : {}), createdAt: row.created_at, updatedAt: row.updated_at, ...(row.completed_at ? { completedAt: row.completed_at } : {}) }; }
}
function parseRequest(value: string): Request { try { const parsed = JSON.parse(value) as Request; return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; } }
function parseMetadata(value: string): Record<string, string | number | boolean | null> | undefined { try { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined; const metadata = Object.fromEntries(Object.entries(parsed).filter(([, item]) => item == null || typeof item === "string" || typeof item === "number" || typeof item === "boolean")) as Record<string, string | number | boolean | null>; return Object.keys(metadata).length ? metadata : undefined; } catch { return undefined; } }
function emptyCapabilities(provider: IntegrationProviderId): ProviderCapabilities { return { providerId: provider, searchSources: false, resolveRawSource: false, resolveSummaryLineage: false, stableExternalIds: false, returnsContentHash: false, returnsScores: false, supportsAbortSignal: true }; }
