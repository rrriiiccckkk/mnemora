import { Type, type TSchema } from "typebox";
import { relationshipDefinitions, type Direction, type RelationshipType } from "./relationships.js";
import { toResearchError } from "./query/errors.js";
import type { ToolSurface } from "./index.js";
import type { Mnemora } from "./tools.js";

export interface OpenClawToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

type Operation = (graph: Mnemora, params: Record<string, unknown>) => unknown | Promise<unknown>;

/** The everyday set intentionally excludes destructive, maintenance, and provider administration tools. */
export const CORE_TOOL_NAMES = [
  "kg_context", "kg_ingest", "kg_memory", "kg_profile", "kg_recall_explain", "kg_related", "kg_scopes", "kg_search", "kg_sources", "kg_stats"
] as const;
/** Research adds analysis and saved-query workflows without exposing operational mutation tools. */
export const RESEARCH_TOOL_NAMES = [
  ...CORE_TOOL_NAMES, "kg_compare", "kg_digest", "kg_insights", "kg_query", "kg_timeline", "kg_watch"
] as const;

const enabledNames = (surface: ToolSurface): ReadonlySet<string> | undefined => surface === "full"
  ? undefined
  : new Set(surface === "core" ? CORE_TOOL_NAMES : RESEARCH_TOOL_NAMES);

export interface ToolSurfaceSummary {
  surface: ToolSurface;
  tool_count: number;
  tool_names: string[];
  schema_bytes: number;
  baseline: { surface: "full"; tool_count: number; schema_bytes: number };
  reduction: { tool_count: number; schema_bytes: number; schema_percent: number };
}

/** Static, content-free tool-surface measurement for operators and release tests. */
export function evaluateToolSurface(surface: ToolSurface = "full"): ToolSurfaceSummary {
  const unavailable = () => { throw new Error("tool surface evaluation never opens a graph"); };
  const full = createOpenClawToolDefinitions(unavailable, "full");
  const selected = surface === "full" ? full : createOpenClawToolDefinitions(unavailable, surface);
  const bytes = (definitions: OpenClawToolDefinition[]) => new TextEncoder().encode(JSON.stringify(definitions.map(({ name, description, parameters }) => ({ name, description, parameters })))).byteLength;
  const fullBytes = bytes(full);
  const selectedBytes = bytes(selected);
  return {
    surface,
    tool_count: selected.length,
    tool_names: selected.map(tool => tool.name),
    schema_bytes: selectedBytes,
    baseline: { surface: "full", tool_count: full.length, schema_bytes: fullBytes },
    reduction: {
      tool_count: full.length - selected.length,
      schema_bytes: fullBytes - selectedBytes,
      schema_percent: fullBytes === 0 ? 0 : Number((((fullBytes - selectedBytes) / fullBytes) * 100).toFixed(2))
    }
  };
}

export function createOpenClawToolDefinitions(openGraph: () => Mnemora, surface: ToolSurface = "full"): OpenClawToolDefinition[] {
  const scoped = (description: string) => `${description} When scope is omitted, scope.default is used; omission never means all scopes.`;
  const descriptor = (name: string, label: string, description: string, parameters: TSchema, operation: Operation, sanitizeErrors = false): OpenClawToolDefinition => ({
    name, label, description, parameters,
    async execute(_toolCallId, params) {
      if (!sanitizeErrors) {
        const graph = openGraph();
        try {
          const value = await operation(graph, params);
          return { content: [{ type: "text", text: JSON.stringify(value) }] };
        } finally {
          graph.close();
        }
      }

      let graph: Mnemora;
      try { graph = openGraph(); }
      catch (error) { return researchFailure(name, error); }

      let response: { content: Array<{ type: "text"; text: string }> };
      let operationFailed = false;
      try {
        const value = await operation(graph, params);
        response = { content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (error) {
        operationFailed = true;
        response = researchFailure(name, error);
      }
      try { await graph.close(); }
      catch (error) { if (!operationFailed) response = researchFailure(name, error); }
      return response;
    }
  });
  const definitions = [
    descriptor("kg_ingest", "KG Ingest", scoped("Extract explicit entities and relationships into one isolated scope with evidence."), Type.Object({ text: Type.String({ description: "Source text to extract into the graph." }), source: Type.Optional(Type.String({ description: "Source label attached to stored evidence." })), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }),
      (graph, p) => graph.kg_ingest(String(p.text ?? ""), optionalString(p.source) ?? "manual", undefined, optionalString(p.scope))),
    descriptor("kg_ingest_batch", "KG Ingest Batch", scoped("Safely ingest a bounded, resumable batch of text items into isolated scopes."), Type.Object({ items: Type.Array(Type.Object({ text: Type.String(), source: Type.Optional(Type.String()), scope: Type.Optional(scopeSchema), force: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), { maxItems: 50 }), cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
      (graph, p) => graph.kg_ingest_batch(Array.isArray(p.items) ? p.items as never[] : [], optionalNumber(p.cursor) ?? 0, optionalNumber(p.limit))),
    descriptor("kg_ingest_file", "KG Ingest File", scoped("Safely ingest one explicit UTF-8 text or Markdown file."), Type.Object({ path: Type.String(), source: Type.Optional(Type.String()), scope: Type.Optional(scopeSchema), force: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      (graph, p) => graph.kg_ingest_file(String(p.path ?? ""), optionalString(p.source), p.force === true, optionalString(p.scope))),
    descriptor("kg_ingest_url", "KG Ingest URL", scoped("Safely fetch and ingest one public HTTP(S) text or HTML resource."), Type.Object({ url: Type.String(), scope: Type.Optional(scopeSchema), force: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      (graph, p) => graph.kg_ingest_url(String(p.url ?? ""), p.force === true, optionalString(p.scope))),
    descriptor("kg_insights", "KG Insights", scoped("Return deterministic structural analysis and supporting data within one scope, not instructions or newly established facts."), Type.Object({ kind: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("knowledge_gap"), Type.Literal("emerging_topic"), Type.Literal("cross_community_path")])), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), communityId: Type.Optional(Type.String()), explain: Type.Optional(Type.Union([Type.Literal("auto"), Type.Boolean()])), refresh: Type.Optional(Type.Boolean()), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }),
      (graph, p) => graph.kg_insights(p)),
    descriptor("kg_embed_backfill", "KG Embed Backfill", "Embed stale graph nodes in stable node id order.", Type.Object({ limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })), after_id: Type.Optional(Type.String()) }, { additionalProperties: false }),
      (graph, p) => graph.kg_embed_backfill(optionalNumber(p.limit), optionalString(p.after_id))),
    descriptor("kg_search", "KG Search", scoped("Search local knowledge graph entities within one scope by lexical or semantic similarity. Use kg_scopes before retrying an unexpectedly empty search in another project."), Type.Object({ query: Type.String({ description: "Entity search query." }), node_type: Type.Optional(Type.String({ description: "Optional node type filter." })), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Number({ description: "Maximum result count." })), mode: Type.Optional(Type.Union([Type.Literal("lexical"), Type.Literal("semantic"), Type.Literal("hybrid")])) }, { additionalProperties: false }),
      (graph, p) => graph.kg_search(String(p.query ?? ""), optionalString(p.node_type), optionalNumber(p.limit) ?? 10, optionalSearchMode(p.mode), undefined, optionalString(p.scope))),
    descriptor("kg_related", "KG Related", scoped("Traverse stable graph topology from an entity with scope-filtered evidence. Request a domain predicate such as uses explicitly to receive matching semantic labels; labels never expand traversal."), Type.Object({ entity: Type.String({ description: "Entity id, slug, alias, or search text." }), depth: Type.Optional(Type.Number({ description: "Traversal depth." })), edge_types: Type.Optional(Type.Array(Type.String({ description: "Structural relationship filter, or exact semantic-label predicate." }))), direction: Type.Optional(Type.Union([Type.Literal("out"), Type.Literal("in"), Type.Literal("both")])), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }),
      (graph, p) => graph.kg_related(String(p.entity ?? ""), optionalNumber(p.depth) ?? 1, optionalStringArray(p.edge_types), optionalDirection(p.direction), optionalString(p.scope))),
    descriptor("kg_stats", "KG Stats", "Return local knowledge graph node, edge, and observation statistics.", Type.Object({}, { additionalProperties: false }), (graph) => graph.kg_stats()),
    descriptor("kg_profile", "KG Profile", scoped("Rebuild a read-only entity profile from scoped relationships, source/claim provenance, freshness, and pending conflict candidates. It never changes graph evidence, verification state, or user preferences."), Type.Object({ subject: Type.String({ minLength: 1, maxLength: 160 }), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }), (graph, p) => graph.kg_profile(String(p.subject ?? ""), optionalString(p.scope), optionalNumber(p.limit))),
    descriptor("kg_profile_lock", "KG Profile Lock", scoped("Preview then explicitly lock or clear one user-selected sourced profile value, including a stale retained selection. It never edits graph evidence, claims, or verification state."), profileSelectionSchema, (graph, p) => graph.kg_profile_lock(p as never)),
    descriptor("kg_scopes", "KG Scopes", "Discover the normalized default scope and bounded aggregate counts for available scopes. It exposes no entity, evidence, source, or memory text.", Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }), (graph, p) => graph.kg_scopes(optionalNumber(p.limit) ?? 50)),
    descriptor("kg_context", "KG Context", scoped("Build compact evidence-backed graph and memory context for a question within one scope. Context and automatic recall never cross scope boundaries."), Type.Object({ query: Type.String({ description: "Question or topic to ground with graph evidence." }), scope: Type.Optional(scopeSchema), max_nodes: Type.Optional(Type.Number({ description: "Maximum seed entities to include." })), max_depth: Type.Optional(Type.Number({ description: "Relationship traversal depth." })), confidence_threshold: Type.Optional(Type.Number({ description: "Minimum evidence confidence for relationships." })), token_budget: Type.Optional(Type.Number({ description: "Approximate context token budget." })), mode: Type.Optional(Type.Union([Type.Literal("lexical"), Type.Literal("semantic"), Type.Literal("hybrid")])) }, { additionalProperties: false }),
      (graph, p) => graph.kg_context(String(p.query ?? ""), optionalNumber(p.max_nodes), optionalNumber(p.max_depth), optionalNumber(p.confidence_threshold), optionalNumber(p.token_budget), optionalSearchMode(p.mode), undefined, optionalString(p.scope))),
    descriptor("kg_recall_explain", "KG Recall Explain", scoped("Explain, without changing local state, why automatic recall would include or exclude bounded graph and memory candidates. The trace is redacted: it excludes the query text, evidence quotes, source labels, external IDs, snapshots, and provider payloads."), Type.Object({ query: Type.String({ minLength: 1, maxLength: 4000, description: "Question or topic to explain under the configured automatic-recall policy." }), scope: Type.Optional(scopeSchema), max_nodes: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), max_depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })), confidence_threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), token_budget: Type.Optional(Type.Integer({ minimum: 100, maximum: 8000 })), mode: Type.Optional(Type.Union([Type.Literal("lexical"), Type.Literal("semantic"), Type.Literal("hybrid")])) }, { additionalProperties: false }),
      (graph, p) => graph.kg_recall_explain({ query: String(p.query ?? ""), scope: optionalString(p.scope), max_nodes: optionalNumber(p.max_nodes), max_depth: optionalNumber(p.max_depth), confidence_threshold: optionalNumber(p.confidence_threshold), token_budget: optionalNumber(p.token_budget), mode: optionalSearchMode(p.mode) }), true),
    descriptor("kg_sources", "KG Sources", scoped("List scope-filtered evidence sources with observation counts and confidence summaries."), Type.Object({ scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Number({ description: "Maximum source count." })) }, { additionalProperties: false }), (graph, p) => graph.kg_sources(optionalNumber(p.limit) ?? 20, optionalString(p.scope))),
    descriptor("kg_memory", "KG Memory", scoped(surface === "full"
      ? "Store, retrieve, or locally embed memory documents; lifecycle changes are preview-first and scope-isolated."
      : "Store or retrieve scope-isolated memory documents."), surface === "full" ? memorySchema : coreMemorySchema, (graph, p) => graph.kg_memory(p as never)),
    descriptor("kg_forget", "KG Forget", "Soft-delete an entity and its relationship edges by canonical entity_id; hard delete requires confirm=true.", Type.Object({ entity_id: Type.String({ description: "Canonical entity id to forget." }), hard: Type.Optional(Type.Boolean({ description: "Physically delete instead of soft-deleting." })), confirm: Type.Optional(Type.Boolean({ description: "Required true for hard delete." })) }, { additionalProperties: false }),
      (graph, p) => graph.kg_forget(String(p.entity_id ?? ""), p.hard === true, p.confirm === true)),
    descriptor("kg_review", "KG Review", scoped("Review duplicate candidates, relationship anomalies, schema-drift audits, or aggregate semantic-pattern proposals. Semantic-pattern acceptance is preview/confirm only and never alters graph topology."), Type.Object({ kind: Type.Optional(Type.Union([Type.Literal("duplicates"), Type.Literal("anomalies"), Type.Literal("identity"), Type.Literal("schema_drift"), Type.Literal("semantic_patterns")])), status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("ignored"), Type.Literal("rejected"), Type.Literal("merged")])), scan: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })), after_id: Type.Optional(Type.String()), candidate_id: Type.Optional(Type.String()), decision: Type.Optional(Type.Union([Type.Literal("ignored"), Type.Literal("rejected"), Type.Literal("accepted")])), repair_type: Type.Optional(Type.Union([Type.Literal("depends_on"), Type.Literal("part_of"), Type.Literal("instance_of"), Type.Literal("related_to")])), preview_hash: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })), confirm: Type.Optional(Type.Boolean()), scope: Type.Optional(scopeSchema), approval_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false }),
      (graph, p) => {
        const candidateId = optionalString(p.candidate_id);
        const decision = p.decision === "ignored" || p.decision === "rejected" || p.decision === "accepted" ? p.decision : undefined;
        const kind = optionalReviewKind(p.kind), status = optionalCandidateStatus(p.status), scan = p.scan === true, limit = optionalNumber(p.limit) ?? 20, afterId = optionalString(p.after_id), scope = optionalString(p.scope), approvalId = optionalString(p.approval_id);
        const repairType = p.repair_type === "depends_on" || p.repair_type === "part_of" || p.repair_type === "instance_of" || p.repair_type === "related_to" ? p.repair_type : undefined;
        const previewHash = optionalString(p.preview_hash);
        if (candidateId || decision || repairType) return graph.kg_review(kind, status, scan, limit, afterId, candidateId, decision, scope, approvalId, repairType, previewHash, p.confirm === true);
        return scope ? graph.kg_review(kind, status, scan, limit, afterId, undefined, undefined, scope) : graph.kg_review(kind, status, scan, limit, afterId);
      }),
    descriptor("kg_merge", "KG Merge", "Preview or explicitly confirm an audited entity merge.", Type.Object({ canonical_entity_id: Type.String(), duplicate_entity_id: Type.String(), preview_hash: Type.Optional(Type.String()), confirm: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      (graph, p) => graph.kg_merge(String(p.canonical_entity_id ?? ""), String(p.duplicate_entity_id ?? ""), p.confirm === true, optionalString(p.preview_hash))),
    descriptor("kg_merge_undo", "KG Merge Undo", "Preview or explicitly confirm conflict-safe restoration of a merge audit.", Type.Object({ audit_id: Type.String(), preview_hash: Type.Optional(Type.String()), confirm: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      (graph, p) => graph.kg_merge_undo(String(p.audit_id ?? ""), p.confirm === true, optionalString(p.preview_hash))),
    descriptor("kg_query", "KG Query", scoped("Execute a bounded, evidence-backed natural-language or explicit graph query plan within one scope."), Type.Object({ question: Type.Optional(Type.String({ maxLength: 4000 })), plan: Type.Optional(queryPlanSchema), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }), (graph, p) => graph.kg_query(p), true),
    descriptor("kg_verify", "KG Verify", scoped("Inspect redacted source lifecycle state, or queue, run, retry, reclaim, or cancel bounded Mnemora-owned verification and retrospective-audit jobs; never writes to external providers."), verificationSchema, (graph, p) => graph.kg_verify(p as never), true),
    descriptor("kg_recall_metrics", "KG Recall Metrics", scoped("List bounded, redacted adaptive-recall shadow metrics for one scope. It never changes retrieval or injected context."), Type.Object({ scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }), (graph, p) => graph.kg_recall_metrics({ scope: optionalString(p.scope), limit: optionalNumber(p.limit) }), true),
    descriptor("kg_recall_canary", "KG Recall Canary", scoped("Evaluate redacted shadow metrics, create a model-specific calibration, or explicitly enable/roll back one adaptive-recall canary. Injection needs configuration, a ready calibration, and confirmed scope activation; rollback is one confirmed call."), recallCanarySchema, (graph, p) => graph.kg_recall_canary(p as never), true),
    descriptor("kg_timeline", "KG Timeline", scoped("Return bounded observation and validity changes for one graph subject within one scope."), Type.Object({ subject: Type.String({ minLength: 1, maxLength: 160 }), from: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), to: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }), (graph, p) => graph.kg_timeline(p as never), true),
    descriptor("kg_compare", "KG Compare", scoped("Compare two entities or communities using bounded topology, temporal, and evidence signals within one scope."), Type.Object({ left: Type.String({ minLength: 1, maxLength: 160 }), right: Type.String({ minLength: 1, maxLength: 160 }), max_depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })), confidence_min: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), valid_from: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), valid_to: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), as_of: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), max_response_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1048576 })), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }), (graph, p) => graph.kg_compare(p as never), true),
    descriptor("kg_watch", "KG Watch", scoped("Create, list, inspect, update, enable, disable, or delete bounded saved query watches."), watchSchema, (graph, p) => graph.kg_watch(p as never), true),
    descriptor("kg_digest", "KG Digest", scoped("Run a bounded idempotent digest over selected enabled watches in one scope."), Type.Object({ idempotency_key: Type.String({ minLength: 1, maxLength: 300 }), watch_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 1000 })), since: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }), (graph, p) => graph.kg_digest(p as never), true),
    descriptor("kg_export", "KG Export", "Export bounded graph data as lossless JSONL or lossy CSV/GraphML.", Type.Object({ format: Type.Union([Type.Literal("jsonl"), Type.Literal("csv"), Type.Literal("graphml")]), max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10485760 })), max_records: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }, { additionalProperties: false }), (graph, p) => graph.kg_export(p as never), true),
    descriptor("kg_import", "KG Import", "Preview or explicitly confirm bounded JSONL graph data; filesystem paths are never accepted.", Type.Object({ format: Type.Literal("jsonl"), data: Type.String({ maxLength: 10485760 }), preview_hash: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), confirm: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), (graph, p) => graph.kg_import(p as never), true),
    descriptor("kg_query_history", "KG Query History", scoped("Return bounded redacted query execution audit metadata for one scope."), Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }), (graph, p) => graph.kg_query_history(p), true),
    descriptor("kg_integrations", "KG Integrations", "Probe, migrate, search, or ingest through opt-in public provider CLIs only. Migration is preview-first and uses public capabilities only; no provider table or database directory is read directly.", integrationSchema, (graph, p) => graph.kg_integrations(p as never), true)
  ];
  const names = enabledNames(surface);
  return names ? definitions.filter(tool => names.has(tool.name)) : definitions;
}

function researchFailure(name: string, error: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(toResearchError(name, error)) }] };
}

const enumOf = <T extends readonly string[]>(values: T) => Type.Union(values.map(value => Type.Literal(value)));
const scopeSchema = Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-z0-9][a-z0-9._:-]{0,79}$", description: "Optional isolated scope. When omitted, the configured scope.default is used; it never means all scopes." });
const memoryMetadataSchema = Type.Object({}, { additionalProperties: Type.Union([Type.String({ maxLength: 1000 }), Type.Number(), Type.Boolean(), Type.Null()]) });
const memorySchema = Type.Union([
  Type.Object({ operation: Type.Literal("store"), content: Type.String({ minLength: 1, maxLength: 100000 }), title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), source: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), scope: Type.Optional(scopeSchema), metadata: Type.Optional(memoryMetadataSchema) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("search"), query: Type.String({ minLength: 1, maxLength: 4000 }), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })), mode: Type.Optional(Type.Union([Type.Literal("lexical"), Type.Literal("semantic"), Type.Literal("hybrid")])) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("artifact_read"), artifact_id: Type.String({ minLength: 1, maxLength: 160, description: "Exact opaque artifact ID from a prior scope-local result." }), scope: Type.Optional(scopeSchema), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 2097152 })), max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384, description: "Bounded bytes to return; defaults to 16384." })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("corpus_status"), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("corpus_sync"), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("corpus_search"), query: Type.String({ minLength: 1, maxLength: 512 }), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), sync: Type.Optional(Type.Boolean({ description: "Explicitly refresh the configured local corpus before searching." })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("embed_backfill"), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), after_id: Type.Optional(Type.String({ minLength: 0, maxLength: 160 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("list_scopes"), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("expiry_review"), scope: Type.Optional(scopeSchema), older_than_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 36500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), after_id: Type.Optional(Type.String({ minLength: 0, maxLength: 160 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("tier_review"), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("tier"), document_id: Type.String({ minLength: 1, maxLength: 160 }), tier: Type.Union([Type.Literal("core"), Type.Literal("working"), Type.Literal("peripheral")]), scope: Type.Optional(scopeSchema), preview_hash: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })), confirm: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("recall_decay_review"), scope: Type.Optional(scopeSchema), min_age_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 36500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("lifecycle"), action: Type.Union([Type.Literal("archive"), Type.Literal("recover"), Type.Literal("delete")]), document_id: Type.String({ minLength: 1, maxLength: 160 }), scope: Type.Optional(scopeSchema), preview_hash: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), confirm: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("lifecycle_audit"), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("export"), scope: Type.Optional(scopeSchema), max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10485760 })), max_records: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("import"), data: Type.String({ maxLength: 10485760 }), scope: Type.Optional(scopeSchema), preview_hash: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), confirm: Type.Optional(Type.Boolean()), max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10485760 })), max_records: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }, { additionalProperties: false })
]);
/** Core surfaces retain routine memory store/search while removing maintenance and lifecycle mutation schemas. */
const coreMemorySchema = Type.Union([
  Type.Object({ operation: Type.Literal("store"), content: Type.String({ minLength: 1, maxLength: 100000 }), title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), source: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), scope: Type.Optional(scopeSchema), metadata: Type.Optional(memoryMetadataSchema) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("search"), query: Type.String({ minLength: 1, maxLength: 4000 }), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })), mode: Type.Optional(Type.Union([Type.Literal("lexical"), Type.Literal("semantic"), Type.Literal("hybrid")])) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("artifact_read"), artifact_id: Type.String({ minLength: 1, maxLength: 160, description: "Exact opaque artifact ID from a prior scope-local result." }), scope: Type.Optional(scopeSchema), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 2097152 })), max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384, description: "Bounded bytes to return; defaults to 16384." })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("corpus_status"), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("corpus_search"), query: Type.String({ minLength: 1, maxLength: 512 }), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), sync: Type.Optional(Type.Boolean({ description: "Explicitly refresh the configured local corpus before searching." })) }, { additionalProperties: false })
]);
const nodeTypeSchema = enumOf(["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"] as const);
const relationshipTypeSchema = enumOf(Object.keys(relationshipDefinitions) as RelationshipType[]);
const queryStepSchema = Type.Union([
  Type.Object({ op: Type.Literal("lookup"), query: Type.String({ minLength: 1, maxLength: 4000 }), node_types: Type.Optional(Type.Array(nodeTypeSchema, { maxItems: 9 })), mode: Type.Optional(Type.Literal("lexical")) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("traverse"), from: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 50 }), edge_types: Type.Optional(Type.Array(relationshipTypeSchema, { maxItems: 12 })), direction: enumOf(["out", "in", "both"] as const), depth: Type.Integer({ minimum: 0, maximum: 4 }) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("filter"), node_types: Type.Optional(Type.Array(nodeTypeSchema, { maxItems: 9 })), confidence_min: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), valid_from: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), valid_to: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("aggregate"), by: enumOf(["node_type", "relationship_type", "source"] as const), metric: enumOf(["count", "entities", "relationships"] as const) }, { additionalProperties: false })
]);
const queryPlanSchema = Type.Object({ version: Type.Literal(1), steps: Type.Array(queryStepSchema, { minItems: 1, maxItems: 8 }), order_by: Type.Optional(enumOf(["relevance", "confidence", "recency", "name"] as const)), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false });
const losslessExternalRefSchema = Type.Object({
  provider: Type.Literal("lossless-claw"), externalId: Type.String({ minLength: 1, maxLength: 200 }),
  externalVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), conversationId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  messageId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })), summaryId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 }))
}, { additionalProperties: false });
const memoryLanceDbQuerySchema = Type.String({ minLength: 1, maxLength: 1000 });
const providerScopeSchema = Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-z0-9][a-z0-9._:-]{0,79}$" });
const integrationSchema = Type.Union([
  Type.Object({ operation: Type.Literal("status"), provider: Type.Optional(Type.Union([Type.Literal("lossless-claw"), Type.Literal("memory-lancedb-pro")])) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("probe"), provider: Type.Union([Type.Literal("lossless-claw"), Type.Literal("memory-lancedb-pro")]) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("ingest"), provider: Type.Literal("lossless-claw"), external_ref: losslessExternalRefSchema, scope: Type.Optional(scopeSchema) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("search"), provider: Type.Literal("memory-lancedb-pro"), query: memoryLanceDbQuerySchema, provider_scope: Type.Optional(providerScopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("ingest"), provider: Type.Literal("memory-lancedb-pro"), query: memoryLanceDbQuerySchema, external_id: Type.String({ minLength: 1, maxLength: 160 }), provider_scope: Type.Optional(providerScopeSchema), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("migration_preview"), provider: Type.Union([Type.Literal("lossless-claw"), Type.Literal("memory-lancedb-pro")]), scope: Type.Optional(scopeSchema), query: Type.Optional(memoryLanceDbQuerySchema), provider_scope: Type.Optional(providerScopeSchema), external_refs: Type.Optional(Type.Array(losslessExternalRefSchema, { maxItems: 10 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Union([Type.Literal("migration_apply"), Type.Literal("migration_resume"), Type.Literal("migration_verify"), Type.Literal("migration_rollback")]), provider: Type.Union([Type.Literal("lossless-claw"), Type.Literal("memory-lancedb-pro")]), run_id: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false })
]);
const verificationStatusSchema = enumOf(["pending", "verified", "flagged", "rejected", "unverifiable", "contradicted", "stale", "superseded"] as const);
const recallCalibrationCriteriaSchema = Type.Object({
  minimum_runs: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  max_empty_rate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  min_overlap_rate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 }))
}, { additionalProperties: false });
const recallCanarySchema = Type.Union([
  Type.Object({ operation: Type.Literal("status"), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("calibrations"), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("evaluate"), scope: Type.Optional(scopeSchema), criteria: Type.Optional(recallCalibrationCriteriaSchema) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("calibrate"), scope: Type.Optional(scopeSchema), criteria: Type.Optional(recallCalibrationCriteriaSchema), preview_hash: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })), confirm: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("enable"), scope: Type.Optional(scopeSchema), calibration_id: Type.String({ minLength: 1, maxLength: 200 }), preview_hash: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })), confirm: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("rollback"), scope: Type.Optional(scopeSchema), confirm: Type.Optional(Type.Boolean()) }, { additionalProperties: false })
]);
const profileSelectionSchema = Type.Union([
  Type.Object({ action: Type.Literal("set"), subject: Type.String({ minLength: 1, maxLength: 160 }), field_key: relationshipTypeSchema, target_id: Type.String({ minLength: 1, maxLength: 200 }), scope: Type.Optional(scopeSchema), preview_hash: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })), approval_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), confirm: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("clear"), subject: Type.String({ minLength: 1, maxLength: 160 }), field_key: relationshipTypeSchema, scope: Type.Optional(scopeSchema), preview_hash: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })), approval_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), confirm: Type.Optional(Type.Boolean()) }, { additionalProperties: false })
]);
const verificationSchema = Type.Union([
  Type.Object({ operation: Type.Literal("list"), scope: Type.Optional(scopeSchema), status: Type.Optional(verificationStatusSchema), after_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("sources"), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), freshness_after_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("transition"), verification_id: Type.String({ minLength: 1, maxLength: 200 }), status: verificationStatusSchema, support_type: Type.Optional(enumOf(["direct", "inferred", "contradicted", "none"] as const)), verification_confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), source_quality: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), verifier_kind: Type.Optional(enumOf(["rule", "model", "human"] as const)), reason_code: Type.Optional(enumOf(["manual_review", "direct_support", "indirect_support", "insufficient_source", "source_changed", "source_deleted", "conflict"] as const)), approval_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), confirm: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("queue"), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("run"), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("jobs"), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("audit_schedule"), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("audit_run"), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("audits"), scope: Type.Optional(scopeSchema), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("audit_cancel"), audit_id: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("audit_requeue"), audit_id: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("audit_review"), audit_id: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("audit_reclaim_stale"), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("cancel"), job_id: Type.String({ minLength: 1, maxLength: 160 }) }, { additionalProperties: false })
]);
const watchIdSchema = Type.String({ minLength: 1, maxLength: 160 });
const watchSchema = Type.Union([
  Type.Object({ operation: Type.Literal("create"), id: Type.Optional(watchIdSchema), name: Type.String({ minLength: 1, maxLength: 200 }), question: Type.Optional(Type.String({ maxLength: 4000 })), plan: queryPlanSchema, scope: Type.Optional(scopeSchema), schedule_hint: enumOf(["manual", "daily", "weekly"] as const), enabled: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("list"), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), scope: Type.Optional(scopeSchema) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("inspect"), id: watchIdSchema }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("enable"), id: watchIdSchema }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("disable"), id: watchIdSchema }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("delete"), id: watchIdSchema }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("update"), id: watchIdSchema, name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), plan: Type.Optional(queryPlanSchema), scope: Type.Optional(scopeSchema), schedule_hint: Type.Optional(enumOf(["manual", "daily", "weekly"] as const)), enabled: Type.Optional(Type.Boolean()) }, { additionalProperties: false })
]);

const optionalString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const optionalNumber = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : undefined;
const optionalStringArray = (value: unknown): RelationshipType[] | undefined => Array.isArray(value)
  ? value.filter((item): item is RelationshipType => typeof item === "string" && item in relationshipDefinitions)
  : undefined;
const optionalDirection = (value: unknown): Direction | undefined => value === "out" || value === "in" || value === "both" ? value : undefined;
const optionalSearchMode = (value: unknown): import("./index.js").SearchMode | undefined => value === "lexical" || value === "semantic" || value === "hybrid" ? value : undefined;
const optionalReviewKind = (value: unknown): "duplicates" | "anomalies" | "identity" | "schema_drift" | "semantic_patterns" => value === "anomalies" || value === "identity" || value === "schema_drift" || value === "semantic_patterns" ? value : "duplicates";
const optionalCandidateStatus = (value: unknown): import("./types.js").DuplicateCandidateStatus => value === "ignored" || value === "rejected" || value === "merged" ? value : "pending";
