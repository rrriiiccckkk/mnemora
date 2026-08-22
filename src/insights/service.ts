import { createHash } from "node:crypto";
import type { MnemoraConfig } from "../index.js";
import type { CommunitySummary, InsightKind, KgInsight, KgInsightsInput, KgInsightsResult } from "../types.js";
import { ALGORITHM_VERSION as COMMUNITY_ALGORITHM_VERSION, detectCommunities, type CommunityPartition } from "./community.js";
import { detectCrossCommunityPaths, detectEmergingTopics, detectKnowledgeGaps } from "./detectors.js";
import { InsightExplainer, type ExplanationInput } from "./explainer.js";
import { calculateCommunityMetrics } from "./metrics.js";
import type { GraphProjection, InsightSnapshot } from "./types.js";
import { normalizeScope } from "../scope.js";

export const INSIGHTS_ALGORITHM_VERSION = "insights-v1";
const DAY_MS = 86_400_000;

interface InsightStore {
  graphRevision(): number;
  sourceTrustRevision?(): number;
  insightGraphProjection(options: { maxNodes: number; maxEdges: number; confidenceFloor: number; asOf: number; scope?: string }): GraphProjection;
  readInsightSnapshot(key: string, scope?: string): InsightSnapshot | undefined;
  writeInsightSnapshot(key: string, snapshot: InsightSnapshot, scope?: string): void;
}

type Detector = (projection: GraphProjection, partition: CommunityPartition, config: NonNullable<MnemoraConfig["insights"]>, collectionLimit?: number) => KgInsight[];

export interface GraphAnalyticsDependencies {
  store: InsightStore;
  config: MnemoraConfig;
  now?: () => number;
  signal?: AbortSignal;
  communityDetector?: typeof detectCommunities;
  metrics?: typeof calculateCommunityMetrics;
  detectors?: Partial<Record<InsightKind, Detector>>;
  explainer?: Pick<InsightExplainer, "available" | "explain">;
  algorithmVersion?: string;
  communityAlgorithmVersion?: string;
}

export class GraphAnalyticsService {
  private readonly now: () => number;
  private readonly communityDetector: typeof detectCommunities;
  private readonly metrics: typeof calculateCommunityMetrics;
  private readonly detectors: Record<InsightKind, Detector>;
  private readonly explainer: Pick<InsightExplainer, "available" | "explain">;
  private readonly algorithmVersion: string;

  constructor(private readonly deps: GraphAnalyticsDependencies) {
    this.now = deps.now ?? Date.now;
    this.communityDetector = deps.communityDetector ?? detectCommunities;
    this.metrics = deps.metrics ?? calculateCommunityMetrics;
    this.detectors = {
      knowledge_gap: deps.detectors?.knowledge_gap ?? detectKnowledgeGaps,
      emerging_topic: deps.detectors?.emerging_topic ?? detectEmergingTopics,
      cross_community_path: deps.detectors?.cross_community_path ?? detectCrossCommunityPaths
    };
    this.explainer = deps.explainer ?? new InsightExplainer(deps.config, fetch, deps.signal);
    this.algorithmVersion = `${deps.algorithmVersion ?? INSIGHTS_ALGORITHM_VERSION}:${deps.communityAlgorithmVersion ?? COMMUNITY_ALGORITHM_VERSION}`;
  }

  async analyze(input: KgInsightsInput = {}): Promise<KgInsightsResult> {
    const now = this.now();
    const scope = normalizeScope(input.scope, this.deps.config.scope?.default ?? "default");
    const config = this.deps.config.insights!;
    const revision = this.deps.store.graphRevision();
    const key = cacheKey(revision, this.deps.store.sourceTrustRevision?.() ?? 0, config, now, this.algorithmVersion, scope);
    const cacheWarnings: KgInsightsResult["warnings"] = [];
    let snapshot: InsightSnapshot | undefined;
    let cacheHit = false;

    if (!input.refresh) {
      try {
        const cached = this.deps.store.readInsightSnapshot(key, scope);
        snapshot = cached?.graphRevision === revision && cached.algorithmVersion === this.algorithmVersion ? cached : undefined;
        cacheHit = snapshot !== undefined;
      }
      catch { cacheWarnings.push({ category: "cache_failed" }); }
    }
    if (!snapshot) {
      const projection = this.deps.store.insightGraphProjection({
        maxNodes: config.maxNodes!, maxEdges: config.maxEdges!, confidenceFloor: config.confidenceFloor!, asOf: now, scope
      });
      if (projection.nodes.length === 0) {
        snapshot = { graphRevision: projection.graphRevision, algorithmVersion: this.algorithmVersion, createdAt: now,
          truncated: projection.truncated, communities: [], insights: [], warnings: projection.truncated ? [{ category: "projection_truncated" }] : [] };
        try { this.deps.store.writeInsightSnapshot(key, snapshot, scope); } catch { cacheWarnings.push({ category: "cache_failed" }); }
      }
      let partition: CommunityPartition;
      try { partition = snapshot ? { membership: {}, communities: [], modularity: 0, passes: 0 } : this.communityDetector(projection); }
      catch { return result("unavailable", revision, this.algorithmVersion, false, projection.truncated, [], [], cacheWarnings); }

      if (!snapshot) {
      const warnings: InsightSnapshot["warnings"] = projection.truncated ? [{ category: "projection_truncated" }] : [];
      const insights: KgInsight[] = [];
      // Gap plus emerging candidates are <= 2N. Cross-community candidates
      // are deduplicated pairs discovered from <=64 stable sources, so they are
      // <= min(N*(N-1)/2, 64N). This is independent of public output filters.
      const collectionLimit = boundedCollectionLimit(projection.nodes.length);
      const collectionConfig = { ...config, maxResults: collectionLimit };
      for (const kind of ["knowledge_gap", "emerging_topic", "cross_community_path"] as const) {
        try { insights.push(...this.detectors[kind](projection, partition, collectionConfig, collectionLimit)); }
        catch { warnings.push({ category: "detector_failed", detector: kind }); }
      }
      snapshot = {
        graphRevision: projection.graphRevision,
        algorithmVersion: this.algorithmVersion,
        createdAt: now,
        truncated: projection.truncated,
        communities: this.metrics(projection, partition, config),
        insights: rank(insights), warnings
      };
      try { this.deps.store.writeInsightSnapshot(key, snapshot, scope); }
      catch { cacheWarnings.push({ category: "cache_failed" }); }
      }
    }

    const communities = input.communityId ? snapshot.communities.filter(item => item.id === input.communityId) : snapshot.communities;
    const maximum = boundedLimit(input.limit, Math.min(20, config.maxResults!));
    let insights = snapshot.insights.filter(item => (input.kind == null || input.kind === "all" || item.kind === input.kind)
      && (!input.communityId || item.community_ids.includes(input.communityId))).slice(0, maximum);
    const warnings = boundedWarnings([...snapshot.warnings, ...cacheWarnings]);
    if (shouldExplain(input.explain, this.explainer.available) && insights.length) {
      try {
        const safeProjection = this.deps.store.insightGraphProjection({ maxNodes: config.maxNodes!, maxEdges: config.maxEdges!, confidenceFloor: config.confidenceFloor!, asOf: now, scope });
        if (snapshot.graphRevision !== this.deps.store.graphRevision() || safeProjection.graphRevision !== snapshot.graphRevision) {
          warnings.push({ category: "explanation_stale" });
          return result(snapshot.communities.length === 0 && snapshot.insights.length === 0 ? "empty" : "ok", snapshot.graphRevision, snapshot.algorithmVersion, cacheHit, snapshot.truncated, communities, insights, boundedWarnings(warnings));
        }
        const explanations = await this.explainer.explain(explanationInput(insights.slice(0, config.maxExplanationCandidates!), snapshot.communities,
          safeProjection), { signal: this.deps.signal });
        insights = insights.map(item => explanations[item.id] ? { ...item, explanation: explanations[item.id] } : item);
      } catch { warnings.push({ category: "explanation_failed" }); }
    }
    return result(snapshot.communities.length === 0 && snapshot.insights.length === 0 ? "empty" : "ok", snapshot.graphRevision, snapshot.algorithmVersion, cacheHit, snapshot.truncated, communities, insights, boundedWarnings(warnings));
  }
}

function cacheKey(revision: number, sourceTrustRevision: number, config: NonNullable<MnemoraConfig["insights"]>, now: number, algorithmVersion: string, scope: string): string {
  const relevant = {
    maxNodes: config.maxNodes, maxEdges: config.maxEdges, confidenceFloor: config.confidenceFloor,
    recentWindowDays: config.recentWindowDays, baselineWindowDays: config.baselineWindowDays,
    minEmergingEntities: config.minEmergingEntities, minEmergingGrowth: config.minEmergingGrowth,
    maxPathLength: config.maxPathLength
  };
  const timeBucket = Math.floor(now / DAY_MS);
  return createHash("sha256").update(JSON.stringify({ graphRevision: revision, sourceTrustRevision, algorithmVersions: algorithmVersion, scope, config: relevant, timeBucket })).digest("hex");
}

function explanationInput(insights: KgInsight[], communities: CommunitySummary[], projection: GraphProjection): ExplanationInput {
  const nodes = new Map(projection.nodes.map(node => [node.id, node]));
  const edges = new Map(projection.edges.map(edge => [edge.id, edge]));
  const metrics = new Map(communities.map(item => [item.id, item]));
  return { candidates: insights.map(item => ({
    id: item.id, kind: item.kind, signals: item.signals,
    entity_names: item.entity_ids.flatMap(id => nodes.has(id) ? [nodes.get(id)!.name] : []),
    entity_types: item.entity_ids.flatMap(id => nodes.has(id) ? [nodes.get(id)!.type] : []),
    relationship_types: item.relationship_ids.flatMap(id => edges.has(id) ? [edges.get(id)!.type] : []),
    community_metrics: aggregateMetrics(item.community_ids.flatMap(id => metrics.has(id) ? [metrics.get(id)!] : []))
  })) };
}

function aggregateMetrics(items: CommunitySummary[]): Record<string, number> {
  if (!items.length) return {};
  const keys: Array<keyof Omit<CommunitySummary, "id" | "entity_ids">> = ["size", "internal_edge_count", "density", "average_confidence", "evidence_coverage", "source_concentration", "recent_growth", "bridge_score"];
  return Object.fromEntries(keys.map(key => [key, items.reduce((sum, item) => sum + item[key], 0) / items.length]));
}

function rank(items: KgInsight[]): KgInsight[] { return [...items].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)); }
function boundedLimit(value: number | undefined, fallback: number): number { return Number.isFinite(value) ? Math.max(1, Math.min(fallback, Math.trunc(value!))) : fallback; }
function boundedCollectionLimit(projectedNodes: number): number {
  const nodes = Number.isSafeInteger(projectedNodes) ? Math.max(0, Math.min(10000, projectedNodes)) : 0;
  if (nodes === 0) return 1;
  const crossCommunityMaximum = Math.min(nodes * (nodes - 1) / 2, 64 * nodes);
  return Math.min(660000, 2 * nodes + crossCommunityMaximum);
}
function shouldExplain(value: KgInsightsInput["explain"], available: boolean): boolean { return value === true || value === "auto" && available; }
function boundedWarnings(items: KgInsightsResult["warnings"]): KgInsightsResult["warnings"] { return items.slice(0, 20); }
function result(status: KgInsightsResult["status"], graph_revision: number, algorithm_version: string, cache_hit: boolean, truncated: boolean, communities: CommunitySummary[], insights: KgInsight[], warnings: KgInsightsResult["warnings"]): KgInsightsResult {
  return { status, graph_revision, algorithm_version, cache_hit, truncated, communities, insights, warnings };
}
