import type { CommunitySummary, InsightKind, KgInsight, NodeType } from "../types.js";
import type { RelationshipType } from "../relationships.js";

export interface GraphProjectionNode {
  id: string;
  name: string;
  type: NodeType;
}

export interface GraphProjectionEdge {
  id: string;
  source: string;
  target: string;
  type: RelationshipType;
  weight: number;
  confidence: number;
  evidenceCount: number;
  sourceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface GraphProjection {
  nodes: GraphProjectionNode[];
  edges: GraphProjectionEdge[];
  truncated: boolean;
  graphRevision: number;
  asOf: number;
}

export interface InsightSnapshot {
  graphRevision: number;
  algorithmVersion: string;
  createdAt: number;
  truncated: boolean;
  communities: CommunitySummary[];
  insights: KgInsight[];
  warnings: Array<{ category: string; detector?: InsightKind }>;
}
