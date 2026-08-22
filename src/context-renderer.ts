import type { EvidenceSummary, KgMemorySearchResult, KgRelatedResult, KgSearchResult, KgSourceSummary } from "./types.js";

/** Shared bounded text rendering for manual and policy-filtered recall context. */
export function renderContext(input: { query: string; nodes: KgSearchResult[]; edges: KgRelatedResult["edges"]; semanticLabels?: KgRelatedResult["semantic_labels"]; sources: KgSourceSummary[]; memories: KgMemorySearchResult[]; tokenBudget: number }): { context: string; truncated: boolean } {
  const lines = [`Knowledge graph context for: ${input.query}`];
  if (input.nodes.length === 0) lines.push("No matching graph entities found.");
  if (input.nodes.length) {
    lines.push("", "Entities:");
    for (const result of input.nodes) {
      const node = result.node;
      lines.push(`- ${node.name} [${node.type}] id=${node.id} score=${round(result.score)}`);
      if (node.description) lines.push(`  description: ${node.description}`);
      for (const evidence of result.evidence.slice(0, 2)) lines.push(`  evidence: ${formatEvidence(evidence)}`);
    }
  }
  if (input.edges.length) {
    lines.push("", "Relationships:");
    for (const edge of input.edges) {
      lines.push(`- ${edge.source.name} --${edge.edge.type}-> ${edge.target.name} weight=${round(edge.edge.weight)}`);
      for (const evidence of edge.evidence.slice(0, 2)) lines.push(`  evidence: ${formatEvidence(evidence)}`);
    }
  }
  if (input.semanticLabels?.length) {
    lines.push("", "Semantic labels (not graph topology):");
    for (const label of input.semanticLabels) {
      lines.push(`- ${label.source.name} --${label.predicate}[${label.domain}]-> ${label.target.name} score=${round(label.score)}${label.endpoint_match ? "" : " [dictionary-drift]"}`);
      for (const evidence of label.evidence.slice(0, 2)) lines.push(`  evidence: ${formatEvidence(evidence)}`);
    }
  }
  if (input.sources.length) {
    lines.push("", "Sources:");
    for (const source of input.sources.slice(0, 8)) lines.push(`- ${source.source}: observations=${source.observations}, avg_confidence=${round(source.average_confidence)}`);
  }
  if (input.memories.length) {
    lines.push("", "Memory documents:");
    for (const memory of input.memories) lines.push(`- ${memory.title} source=${memory.source} score=${round(memory.score)}\n  ${memory.excerpt}`);
  }
  const budgetChars = Math.max(100, Math.trunc(input.tokenBudget)) * 4;
  const full = lines.join("\n");
  return full.length <= budgetChars
    ? { context: full, truncated: false }
    : { context: `${full.slice(0, Math.max(0, budgetChars - 32)).trimEnd()}\n[truncated]`, truncated: true };
}

function formatEvidence(evidence: EvidenceSummary): string {
  const quote = evidence.quote ? `"${evidence.quote.replace(/\s+/g, " ").trim()}"` : "(no quote)";
  return `${quote} source=${evidence.source} confidence=${round(evidence.confidence)}`;
}
function round(value: number): number { return Math.round(value * 1000) / 1000; }
