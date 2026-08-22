import { createHash, randomUUID } from "node:crypto";
import type { MnemoraConfig } from "../index.js";
import type { GraphologyStore } from "../store.js";
import type { QueryPlanV1 } from "./types.js";
import { normalizeQueryPlan } from "./validation.js";
import { normalizeScope } from "../scope.js";

export type WatchScheduleHint = "manual" | "daily" | "weekly";
export interface KgWatch { id: string; name: string; plan: QueryPlanV1; plan_hash: string; scope: string; schedule_hint: WatchScheduleHint; cursor: number | null; enabled: boolean; created_at: number; updated_at: number }
export interface DigestWatchSummary { watch_id: string; status: "succeeded" | "failed" | "timeout"; entity_ids: string[]; relationship_ids: string[]; insight_ids: string[]; counts: { entities: number; relationships: number; insights: number }; warnings: Array<{ category: string }> }
export interface KgDigestResult { idempotency_key: string; status: "running" | "succeeded"; started_at: number; finished_at?: number; selected_count: number; succeeded_count: number; failed_count: number; watches: DigestWatchSummary[]; warnings: Array<{ category: string }> }
export type DigestClaim = { status: "claimed"; startedAt: number; watchIds: string[] } | { status: "running"; startedAt: number; watchIds: string[] } | { status: "succeeded"; result: KgDigestResult };

type Execution = { entities?: Array<{ id?: unknown }>; relationships?: Array<{ id?: unknown }>; insights?: Array<{ id?: unknown }>; warnings?: Array<{ category?: unknown }> };
export interface WatchServiceOptions { store: GraphologyStore; config: Partial<MnemoraConfig>; now?: () => number; timeoutMs?: number; execute: (plan: QueryPlanV1, options: { watchId: string; scope: string; since?: number; signal: AbortSignal }) => Promise<Execution> }

const schedules = new Set<WatchScheduleHint>(["manual", "daily", "weekly"]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const safeId = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._-]{1,128}$/;
const safeWatchId = /^(?:watch:)?[A-Za-z0-9._-]{1,128}$/;
const warningCategories = new Set(["truncated", "projection_truncated", "watch_limit", "failed", "timeout", "skipped", "already_running", "unknown"]);
const boundedIds = (values: unknown, limit = 25): string[] => Array.isArray(values) ? [...new Set(values.filter((x): x is string => typeof x === "string" && x.length <= 160 && safeId.test(x)))].sort().slice(0, limit) : [];
const stableDedupe = (values: string[]): string[] => { const seen = new Set<string>(); return values.filter(value => !seen.has(value) && Boolean(seen.add(value))); };

export class WatchService {
  private readonly now: () => number;
  constructor(private readonly options: WatchServiceOptions) { this.now = options.now ?? Date.now; }

  create(input: unknown): KgWatch {
    if (!record(input) || !closed(input, ["id", "name", "question", "plan", "scope", "schedule_hint", "enabled"]) || typeof input.name !== "string" || !input.name.trim() || !schedules.has(input.schedule_hint as WatchScheduleHint) || (input.id !== undefined && (typeof input.id !== "string" || !safeWatchId.test(input.id.trim()))) || (input.question !== undefined && typeof input.question !== "string") || (input.scope !== undefined && typeof input.scope !== "string") || (input.enabled !== undefined && typeof input.enabled !== "boolean")) throw new Error("invalid watch");
    const scope = normalizeScope(input.scope, this.options.config.scope?.default ?? "default");
    const plan = this.compilePlan(normalizeQueryPlan(input.plan, this.options.config.query));
    return this.options.store.createWatch({ id: typeof input.id === "string" ? input.id.trim() : `watch:${randomUUID()}`, name: input.name.trim().slice(0, 200), plan, scope, schedule_hint: input.schedule_hint as WatchScheduleHint, enabled: input.enabled !== false, now: this.now(), maxWatches: this.options.config.query?.maxWatches ?? 100 });
  }
  list(limit = 100, scope?: string): KgWatch[] { return this.options.store.listWatches(Math.min(100, Math.max(0, Number.isFinite(limit) ? Math.trunc(limit) : 0)), scope == null ? undefined : normalizeScope(scope)); }
  update(id: string, patch: unknown): KgWatch {
    if (typeof id !== "string" || !record(patch) || !closed(patch, ["name", "plan", "scope", "schedule_hint", "enabled"]) || Object.keys(patch).length === 0 || (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim())) || (patch.scope !== undefined && typeof patch.scope !== "string") || (patch.schedule_hint !== undefined && !schedules.has(patch.schedule_hint as WatchScheduleHint)) || (patch.enabled !== undefined && typeof patch.enabled !== "boolean")) throw new Error("invalid watch");
    const existing = this.options.store.getWatch(id); if (!existing) throw new Error("watch not found");
    const scope = patch.scope === undefined ? existing.scope : normalizeScope(patch.scope);
    const plan = patch.plan === undefined ? existing.plan : this.compilePlan(normalizeQueryPlan(patch.plan, this.options.config.query));
    return this.options.store.updateWatch(id, { name: typeof patch.name === "string" ? patch.name.trim().slice(0, 200) : existing.name, plan, scope, schedule_hint: (patch.schedule_hint ?? existing.schedule_hint) as WatchScheduleHint, enabled: patch.enabled === undefined ? existing.enabled : patch.enabled as boolean, now: this.now() });
  }
  remove(id: string): boolean { return typeof id === "string" && this.options.store.removeWatch(id); }

  async digest(input: unknown): Promise<KgDigestResult> {
    if (!record(input) || !closed(input, ["idempotencyKey", "watchIds", "since", "limit", "scope"]) || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 300 || (input.scope !== undefined && typeof input.scope !== "string") || (input.watchIds !== undefined && (!Array.isArray(input.watchIds) || !input.watchIds.every(x => typeof x === "string"))) || (input.since !== undefined && (typeof input.since !== "number" || !Number.isFinite(input.since))) || (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isFinite(input.limit)))) throw new Error("invalid digest");
    const scope = normalizeScope(input.scope, this.options.config.scope?.default ?? "default");
    const limit = Math.min(25, Math.max(1, Math.trunc((input.limit as number | undefined) ?? this.options.config.query?.maxDigestWatches ?? 25)));
    const requested = input.watchIds === undefined ? undefined : stableDedupe(input.watchIds as string[]);
    const available = requested ? requested.slice(0, 1000) : undefined;
    const selected = this.options.store.selectDigestWatches(available, limit, scope);
    const warnings: Array<{ category: string }> = [];
    const enabledRequested = requested ? requested.filter(id => { const watch = this.options.store.getWatch(id); return watch?.enabled && watch.scope === scope; }) : this.options.store.listWatches(100, scope).filter(x => x.enabled).map(x => x.id);
    if (enabledRequested.length > limit) warnings.push({ category: "watch_limit" });
    const startedAt = this.now();
    const claim = this.options.store.claimDigest(input.idempotencyKey.trim(), selected.map(x => x.id), scope, startedAt, 600000);
    if (claim.status === "succeeded") return claim.result;
    if (claim.status === "running") return { idempotency_key: input.idempotencyKey.trim(), status: "running", started_at: claim.startedAt, selected_count: claim.watchIds.length, succeeded_count: 0, failed_count: 0, watches: [], warnings: [{ category: "already_running" }] };
    const claimed = claim.watchIds.map(id => this.options.store.getWatch(id)).filter((x): x is KgWatch => x != null && x.enabled && x.scope === scope);
    const summaries = await runBounded(claimed, 4, watch => this.runWatch(watch, typeof input.since === "number" ? input.since : watch.cursor ?? undefined));
    const finishedAt = this.now();
    const succeeded = summaries.filter(x => x.status === "succeeded");
    const result = byteBounded({ idempotency_key: input.idempotencyKey.trim(), status: "succeeded", started_at: claim.startedAt, finished_at: finishedAt, selected_count: claimed.length, succeeded_count: succeeded.length, failed_count: summaries.length - succeeded.length, watches: summaries, warnings: warnings.slice(0, 20) });
    const cursorUpdates = Object.fromEntries(succeeded.map(item => [item.watch_id, finishedAt]));
    return this.options.store.finishDigest(input.idempotencyKey.trim(), claim.startedAt, result, cursorUpdates);
  }

  private compilePlan(plan: QueryPlanV1): QueryPlanV1 {
    return { ...plan, steps: plan.steps.map(step => {
      if (step.op === "lookup") { const id = this.options.store.resolveExactEntityId(step.query); if (!id) throw new Error("invalid watch"); return { ...step, query: id }; }
      if (step.op === "traverse") return { ...step, from: step.from.map(value => { if (value === "$previous") return value; const id = this.options.store.resolveExactEntityId(value); if (!id) throw new Error("invalid watch"); return id; }) };
      return step;
    }) };
  }

  private async runWatch(watch: KgWatch, since?: number): Promise<{ summary: DigestWatchSummary; reusable: boolean }> {
    const controller = new AbortController(); const timeoutMs = Math.min(60000, Math.max(1, Math.trunc(this.options.timeoutMs ?? this.options.config.query?.timeoutMs ?? 10000)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs); });
      const value = await Promise.race([this.options.execute(watch.plan, { watchId: watch.id, scope: watch.scope, since, signal: controller.signal }), timeout]);
      const entityIds = boundedIds(value.entities?.map(x => x.id)); const relationshipIds = boundedIds(value.relationships?.map(x => x.id)); const insightIds = boundedIds(value.insights?.map(x => x.id));
      const supplied = Array.isArray(value.warnings) ? value.warnings.map(x => x.category) : [];
      const known = [...new Set(supplied.filter((x): x is string => typeof x === "string" && warningCategories.has(x)))].sort();
      if (supplied.some(x => typeof x !== "string" || !warningCategories.has(x))) known.push("unknown");
      const warnings = known.slice(0, 20).map(category => ({ category }));
      return { reusable: true, summary: { watch_id: watch.id, status: "succeeded", entity_ids: entityIds, relationship_ids: relationshipIds, insight_ids: insightIds, counts: { entities: value.entities?.length ?? 0, relationships: value.relationships?.length ?? 0, insights: value.insights?.length ?? 0 }, warnings } };
    } catch (error) {
      const status = error instanceof Error && error.message === "timeout" ? "timeout" : "failed";
      return { reusable: status !== "timeout", summary: failedSummary(watch.id, status) };
    } finally { if (timer) clearTimeout(timer); }
  }
}

async function runBounded(items: KgWatch[], concurrency: number, work: (item: KgWatch) => Promise<{ summary: DigestWatchSummary; reusable: boolean }>): Promise<DigestWatchSummary[]> {
  const output = new Array<DigestWatchSummary>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (true) { const index = next++; if (index >= items.length) return; const result = await work(items[index]); output[index] = result.summary; if (!result.reusable) return; } }));
  for (let index = 0; index < items.length; index++) if (!output[index]) output[index] = failedSummary(items[index].id, "timeout");
  return output;
}

function failedSummary(watchId: string, status: "failed" | "timeout"): DigestWatchSummary { return { watch_id: watchId, status, entity_ids: [], relationship_ids: [], insight_ids: [], counts: { entities: 0, relationships: 0, insights: 0 }, warnings: [{ category: status }] }; }
function byteBounded(result: KgDigestResult): KgDigestResult { while (Buffer.byteLength(JSON.stringify(result)) > 65536) { const target = [...result.watches].reverse().find(item => item.entity_ids.length || item.relationship_ids.length || item.insight_ids.length); if (!target) break; const lists = [target.entity_ids, target.relationship_ids, target.insight_ids].sort((a,b)=>b.length-a.length); lists[0].pop(); } return result; }

export function watchPlanHash(plan: QueryPlanV1): string { return createHash("sha256").update(JSON.stringify(plan)).digest("hex"); }
