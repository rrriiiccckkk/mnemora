import type { GraphologyStore } from "../store.js";
import type { KgTimelineResult, TimelineEventKind } from "./types.js";

export interface TimelineInput { subject: string; from?: number; to?: number; limit?: number; scope?: string }
const cmp = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0;

function resolve(store: GraphologyStore, text: string, scope?: string) {
  const query = String(text ?? "").trim();
  if (!query) throw new Error("subject not found");
  const exact = store.queryGraphProjection({ maxNodes: 10000, maxEdges: 0, asOf: Date.now(), scope }).nodes
    .filter(n => n.id === query || n.name.toLowerCase() === query.toLowerCase() || n.aliases.some(a => a.toLowerCase() === query.toLowerCase()))
    .sort((a,b) => cmp(a.id,b.id));
  if (!exact.length) throw new Error("subject not found");
  if (exact.length > 1) throw new Error("ambiguous subject");
  return exact[0];
}

export function buildTimeline(store: GraphologyStore, input: TimelineInput): KgTimelineResult {
  const subject = resolve(store, input.subject, input.scope);
  const rawFrom = Number.isFinite(input.from) ? Math.trunc(input.from!) : Number.MIN_SAFE_INTEGER;
  const rawTo = Number.isFinite(input.to) ? Math.trunc(input.to!) : Number.MAX_SAFE_INTEGER;
  const from = Math.min(rawFrom, rawTo), to = Math.max(rawFrom, rawTo);
  const limit = Number.isFinite(input.limit) ? Math.min(50, Math.max(1, Math.trunc(input.limit!))) : 50;
  const projection = store.timelineProjection(subject.id, { from, to, limit, scope: input.scope });
  const events = projection.rows.map(row => ({ id: `${row.timestamp}:${row.kind}:${row.relationshipIds[0] ?? row.observationIds[0] ?? "event"}`, timestamp: row.timestamp, kind: row.kind as TimelineEventKind, relationship_ids: row.relationshipIds, observation_ids: row.observationIds, evidence_count: row.evidenceCount, source_count: row.sourceCount }))
    .sort((a,b) => a.timestamp-b.timestamp || cmp(a.kind,b.kind) || cmp(a.id,b.id));
  return { subject: { id: subject.id, name: subject.name, type: subject.type }, range: { from, to, inclusive: true }, events, temporal_note: "Observed time records when evidence entered the graph and is not necessarily real-world event time; validity bounds are reported separately.", graph_revision: projection.graphRevision, truncated: projection.truncated };
}
