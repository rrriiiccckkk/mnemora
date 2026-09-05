import Graph from "graphology";
import Sigma from "sigma";

type Page = { nodes: Array<{ id: string; name: string; type: string; community_color: string | null }>; edges: Array<{ id: string; source_id: string; target_id: string; confidence: number }>; next_cursor: string | null };

let renderer: Sigma | undefined;

export function renderGraph(container: HTMLElement, page: Page): void {
  renderer?.kill();
  const graph = new Graph();
  for (const [index, node] of page.nodes.entries()) graph.addNode(node.id, {
    label: node.name,
    size: 5,
    color: node.community_color ?? "#72e5bb",
    x: Math.cos(index * 2.399) * Math.sqrt(index + 1),
    y: Math.sin(index * 2.399) * Math.sqrt(index + 1),
    kind: node.type
  });
  for (const edge of page.edges) if (graph.hasNode(edge.source_id) && graph.hasNode(edge.target_id) && !graph.hasEdge(edge.id)) {
    graph.addEdgeWithKey(edge.id, edge.source_id, edge.target_id, { size: Math.max(.5, edge.confidence * 2), color: "#385c53" });
  }
  for (const node of page.nodes) graph.setNodeAttribute(node.id, "size", 5 + Math.min(8, graph.degree(node.id)));
  renderer = new Sigma(graph, container, { renderEdgeLabels: false });
}
