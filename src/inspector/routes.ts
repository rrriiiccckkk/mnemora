import type { IncomingMessage, ServerResponse } from "node:http";

export interface InspectorGraphApi {
  overview(): unknown;
  graph(input: unknown): unknown;
  entity(input: unknown): unknown;
  research(input: unknown): unknown;
  sources(input: unknown): unknown;
  trust(input?: unknown): unknown;
  consolidation(input?: unknown): unknown;
  memory(input?: unknown): unknown;
  intelligence(input?: unknown): unknown | Promise<unknown>;
  healthSummary(): unknown;
  capabilities?(): unknown;
  operationPreview?(input: unknown): unknown;
  operationConfirm?(input: unknown): unknown;
}

export type InspectorRoute = (request: IncomingMessage, response: ServerResponse, body?: unknown) => void | Promise<void>;

export function inspectorRoutes(graph: InspectorGraphApi, allowOperations: boolean): Map<string, InspectorRoute> {
  const routes = new Map<string, InspectorRoute>();
  routes.set("GET /api/overview", (_q, r) => json(r, 200, graph.overview()));
  routes.set("POST /api/overview", (_q, r) => json(r, 200, graph.overview()));
  routes.set("POST /api/graph", (_q, r, body) => json(r, 200, graph.graph(body)));
  routes.set("POST /api/entity", (_q, r, body) => json(r, 200, graph.entity(body)));
  routes.set("POST /api/research", (_q, r, body) => json(r, 200, graph.research(body)));
  routes.set("POST /api/sources", (_q, r, body) => json(r, 200, graph.sources(body)));
  routes.set("GET /api/trust", (_q, r) => json(r, 200, graph.trust()));
  routes.set("POST /api/trust", (_q, r, body) => json(r, 200, graph.trust(body)));
  routes.set("GET /api/consolidation", (_q, r) => json(r, 200, graph.consolidation()));
  routes.set("POST /api/consolidation", (_q, r, body) => json(r, 200, graph.consolidation(body)));
  routes.set("GET /api/memory", (_q, r) => json(r, 200, graph.memory()));
  routes.set("POST /api/memory", (_q, r, body) => json(r, 200, graph.memory(body)));
  routes.set("GET /api/intelligence", async (_q, r) => json(r, 200, await graph.intelligence()));
  routes.set("POST /api/intelligence", async (_q, r, body) => json(r, 200, await graph.intelligence(body)));
  routes.set("GET /api/health", (_q, r) => json(r, 200, graph.healthSummary()));
  routes.set("POST /api/health", (_q, r) => json(r, 200, graph.healthSummary()));
  routes.set("GET /api/capabilities", (_q, r) => json(r, 200, graph.capabilities?.() ?? { operations: allowOperations }));
  routes.set("POST /api/capabilities", (_q, r) => json(r, 200, graph.capabilities?.() ?? { operations: allowOperations }));
  if (allowOperations) {
    routes.set("POST /api/operations/preview", async (_q, r, body) => graph.operationPreview ? json(r, 200, await graph.operationPreview(body)) : json(r, 404, { error: "not_found" }));
    routes.set("POST /api/operations/confirm", async (_q, r, body) => graph.operationConfirm ? json(r, 200, await graph.operationConfirm(body)) : json(r, 404, { error: "not_found" }));
  }
  return routes;
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(body);
}
