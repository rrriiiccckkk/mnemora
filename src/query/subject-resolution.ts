import type { GraphologyStore, QueryGraphProjection } from "../store.js";
import { detectCommunities } from "../insights/community.js";
import { ResearchOperationError } from "./errors.js";
import type { CompareCandidate, CompareSearch, ResolvedSubject } from "./types.js";

const SEARCH_LIMIT = 8;
const CANDIDATE_LIMIT = 5;
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const rank: Record<CompareCandidate["match_reason"], number> = {
  id_exact: 0, name_exact: 1, alias_exact: 2, prefix: 3, lexical: 4, semantic: 5
};

function projection(store: GraphologyStore, asOf: number, scope?: string): QueryGraphProjection {
  return store.queryGraphProjection({ maxNodes: 10_000, maxEdges: 50_000, asOf, scope });
}

function communitySubject(value: string, graph: QueryGraphProjection): ResolvedSubject | undefined {
  if (!value.startsWith("community:")) return undefined;
  const partition = detectCommunities({
    nodes: graph.nodes.map(node => ({ id: node.id, name: node.name, type: node.type })),
    edges: graph.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type, weight: edge.confidence, confidence: edge.confidence, evidenceCount: edge.evidenceCount, sourceCount: edge.sourceCount, firstSeenAt: edge.firstSeenAt, lastSeenAt: edge.lastSeenAt })),
    truncated: graph.truncated,
    graphRevision: graph.graphRevision,
    asOf: 0
  });
  const community = partition.communities.find(item => item.id === value);
  return community ? { id: community.id, name: community.id, type: "community", members: [...community.node_ids].sort(cmp) } : undefined;
}

function normalized(value: string): string { return value.normalize("NFKC").trim().toLocaleLowerCase("en-US"); }

function reasonFor(node: QueryGraphProjection["nodes"][number], raw: string, query: string): CompareCandidate["match_reason"] | undefined {
  if (node.id === raw) return "id_exact";
  if (normalized(node.name) === query) return "name_exact";
  if (node.aliases.some(alias => normalized(alias) === query)) return "alias_exact";
  if ([node.id, node.name, ...node.aliases].some(value => normalized(value).startsWith(query))) return "prefix";
  return undefined;
}

function candidate(node: QueryGraphProjection["nodes"][number], match_reason: CompareCandidate["match_reason"]): CompareCandidate {
  return { id: node.id, name: node.name, type: node.type, aliases: node.aliases.filter(alias => typeof alias === "string").slice(0, 10), match_reason };
}

function addCandidate(candidates: Map<string, CompareCandidate>, value: CompareCandidate): void {
  const current = candidates.get(value.id);
  if (!current || rank[value.match_reason] < rank[current.match_reason]) candidates.set(value.id, value);
}

function sortedCandidates(candidates: Iterable<CompareCandidate>): CompareCandidate[] {
  return [...candidates].sort((left, right) => rank[left.match_reason] - rank[right.match_reason]
    || cmp(normalized(left.name), normalized(right.name)) || cmp(left.type, right.type) || cmp(left.id, right.id));
}

function ambiguous(side: "left" | "right", candidates: CompareCandidate[], truncated: boolean): ResearchOperationError {
  return new ResearchOperationError({ error_code: "COMPARE_SUBJECT_AMBIGUOUS", retryable: true, details: { side, candidates, truncated } });
}

function notFound(side: "left" | "right"): ResearchOperationError {
  return new ResearchOperationError({ error_code: "COMPARE_SUBJECT_NOT_FOUND", retryable: true, details: { side, candidates: [], truncated: false } });
}

export async function resolveCompareSubject(store: GraphologyStore, search: CompareSearch, input: string, side: "left" | "right", asOf: number, scope?: string): Promise<ResolvedSubject> {
  const raw = typeof input === "string" ? input.trim() : "";
  const graph = projection(store, Number.isFinite(asOf) ? Math.trunc(asOf) : Date.now(), scope);
  const community = communitySubject(raw, graph);
  if (community) return community;
  if (raw.startsWith("community:")) throw notFound(side);

  const query = normalized(raw);
  if (!query) throw notFound(side);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const candidates = new Map<string, CompareCandidate>();
  for (const node of graph.nodes) {
    const matchReason = reasonFor(node, raw, query);
    if (matchReason) addCandidate(candidates, candidate(node, matchReason));
  }
  const canonical = sortedCandidates([...candidates.values()].filter(item => item.match_reason === "id_exact"));
  if (canonical.length === 1) {
    const selected = canonical[0];
    return { id: selected.id, name: selected.name, type: selected.type, members: [selected.id] };
  }
  const exact = sortedCandidates([...candidates.values()].filter(item => item.match_reason === "name_exact" || item.match_reason === "alias_exact"));
  if (exact.length === 1) {
    const selected = exact[0];
    return { id: selected.id, name: selected.name, type: selected.type, members: [selected.id] };
  }
  if (exact.length > 1) throw ambiguous(side, exact.slice(0, CANDIDATE_LIMIT), exact.length > CANDIDATE_LIMIT);

  let searched: ReadonlyArray<Pick<import("../types.js").KgSearchResult, "node" | "score_components">> = [];
  try { searched = (await search(raw)).slice(0, SEARCH_LIMIT); } catch { /* bounded lexical fallback below */ }
  if (searched.length) for (const result of searched) {
    const node = nodes.get(result.node.id);
    if (!node) continue;
    const components = result.score_components;
    const matchReason = components?.semantic && !components.lexical ? "semantic" : "lexical";
    addCandidate(candidates, candidate(node, matchReason));
  }
  else for (const result of store.lexicalCandidates(raw, undefined, SEARCH_LIMIT, scope)) {
    const node = nodes.get(result.node.id);
    if (node) addCandidate(candidates, candidate(node, "lexical"));
  }

  const ordered = sortedCandidates(candidates.values());
  if (ordered.length === 0) throw notFound(side);
  throw ambiguous(side, ordered.slice(0, CANDIDATE_LIMIT), ordered.length > CANDIDATE_LIMIT);
}
