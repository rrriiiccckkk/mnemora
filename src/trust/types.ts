export type SourceAnchorStatus = "available" | "missing" | "deleted" | "changed" | "legacy";
export type VerificationStatus = "pending" | "verified" | "flagged" | "rejected" | "unverifiable" | "contradicted" | "stale" | "superseded";
export type ExternalReferenceObjectType = "source" | "memory" | "message" | "summary" | "document" | "chunk";

/** Contract reserved for public Provider Adapters in later phases. */
export interface ExternalSourceRef {
  provider: string;
  externalId: string;
  externalVersion?: string;
  conversationId?: string;
  messageId?: string;
  summaryId?: string;
}

export interface SourceAnchorClaim {
  id: string;
  quote: string;
  extractionConfidence: number;
}

export interface CreateSourceAnchorsInput {
  scope: string;
  source: string;
  text: string;
  claims: readonly SourceAnchorClaim[];
  snapshotMaxBytes: number;
  capturedAt: number;
  externalRef?: ExternalSourceRef;
}

export interface SourceAnchorWriteResult {
  anchors: number;
  verifications: number;
  externalRefs: number;
}

export interface InspectorSourceAnchorRow {
  id: string;
  source: string;
  source_status: SourceAnchorStatus;
  verification_status: VerificationStatus;
  snapshot_truncated: boolean;
  claim_count: number;
  captured_at: number;
}

export interface SourceAnchorPage {
  items: InspectorSourceAnchorRow[];
  next: { sort: number; id: string } | null;
  truncated: boolean;
}
