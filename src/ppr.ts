export interface PprArc { from: string; to: string; weight: number }
export interface PprInput { nodes: string[]; arcs: PprArc[]; seeds: Record<string, number> }
export interface PprOptions { damping?: number; maxIterations?: number; tolerance?: number; maxNodes?: number; maxArcs?: number; signal?: AbortSignal }

export class PprUnavailableError extends Error {
  constructor(readonly category: "scale_limit" | "invalid_input" | "aborted", message: string) { super(`PPR unavailable: ${message}`); this.name = "PprUnavailableError"; }
}

export function personalizedPageRank(input: PprInput, options: PprOptions = {}): Record<string, number> {
  const nodes = [...new Set(input.nodes)].sort();
  const maxNodes = integerOption(options.maxNodes, 10000);
  const maxArcs = integerOption(options.maxArcs, 50000);
  if (nodes.length > maxNodes) throw new PprUnavailableError("scale_limit", "node limit exceeded");
  if (input.arcs.length > maxArcs) throw new PprUnavailableError("scale_limit", "arc limit exceeded");
  if (options.signal?.aborted) throw new PprUnavailableError("aborted", "aborted");
  if (!nodes.length) return {};
  const nodeSet = new Set(nodes);
  const arcs = [...input.arcs].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  if (arcs.some(arc => !nodeSet.has(arc.from) || !nodeSet.has(arc.to) || !Number.isFinite(arc.weight) || arc.weight < 0)) throw new PprUnavailableError("invalid_input", "invalid arc");
  const seedTotal = nodes.reduce((sum, id) => sum + validSeed(input.seeds[id]), 0);
  if (!(seedTotal > 0)) throw new PprUnavailableError("invalid_input", "invalid personalization");
  const personalization = new Map(nodes.map(id => [id, validSeed(input.seeds[id]) / seedTotal]));
  const outgoing = new Map<string, PprArc[]>();
  for (const arc of arcs) if (arc.weight > 0) outgoing.set(arc.from, [...(outgoing.get(arc.from) ?? []), arc]);
  const damping = boundedOption(options.damping, .85, 0, 1);
  const iterations = Math.max(1, integerOption(options.maxIterations, 20));
  const tolerance = boundedOption(options.tolerance, 1e-6, 0, 1);
  let ranks = new Map(personalization);
  for (let iteration = 0; iteration < iterations; iteration++) {
    if (options.signal?.aborted) throw new PprUnavailableError("aborted", "aborted");
    let dangling = 0;
    const next = new Map(nodes.map(id => [id, (1 - damping) * personalization.get(id)!]));
    for (const id of nodes) {
      const edges = outgoing.get(id) ?? [];
      const total = edges.reduce((sum, arc) => sum + arc.weight, 0);
      if (!(total > 0)) { dangling += ranks.get(id)!; continue; }
      for (const arc of edges) next.set(arc.to, next.get(arc.to)! + damping * ranks.get(id)! * arc.weight / total);
    }
    for (const id of nodes) next.set(id, next.get(id)! + damping * dangling * personalization.get(id)!);
    if ([...next.values()].some(value => !Number.isFinite(value))) throw new PprUnavailableError("invalid_input", "non-finite result");
    const delta = nodes.reduce((sum, id) => sum + Math.abs(next.get(id)! - ranks.get(id)!), 0);
    ranks = next;
    if (delta <= tolerance) break;
  }
  const total = [...ranks.values()].reduce((sum, value) => sum + value, 0);
  if (!(total > 0) || !Number.isFinite(total)) throw new PprUnavailableError("invalid_input", "non-finite result");
  return Object.fromEntries(nodes.map(id => [id, ranks.get(id)! / total]));
}

function validSeed(value: number | undefined): number { return value == null ? 0 : Number.isFinite(value) && value >= 0 ? value : Number.NaN; }
function integerOption(value: number | undefined, fallback: number): number { return value == null ? fallback : Math.max(0, Math.trunc(value)); }
function boundedOption(value: number | undefined, fallback: number, min: number, max: number): number { return Number.isFinite(value) ? Math.min(max, Math.max(min, value!)) : fallback; }
