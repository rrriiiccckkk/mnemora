import type { NodeType } from "../types.js";
import type { RelationshipType } from "../relationships.js";
import type { VerificationStatus } from "../trust/types.js";

export type ProfileProjectionStatus = "ok" | "not_found" | "ambiguous";
export type ProfileClaimVerification = VerificationStatus | "not_anchored";

export interface ProfileSubject {
  id: string;
  name: string;
  type: NodeType;
}

/** A bounded evidence reference, deliberately excluding quote and payload text. */
export interface ProfileClaimProvenance {
  claim_id: string;
  source: string;
  confidence: number;
  observed_at: number;
  verification: ProfileClaimVerification;
}

export interface ProfileFieldValue {
  entity: ProfileSubject;
  confidence: number;
  freshness: number;
  provenance: ProfileClaimProvenance[];
  conflict_candidate_ids: string[];
}

export interface ProfileField {
  key: RelationshipType;
  values: ProfileFieldValue[];
  /** Explicit user choice, kept separate from and never substituted for source values. */
  selection?: { entity: ProfileSubject; locked: true; updated_at: number };
  conflict: boolean;
  truncated: boolean;
}

/** A retained user choice whose source-backed field is no longer current. */
export interface ProfileStaleSelection {
  key: RelationshipType;
  entity: ProfileSubject;
  locked: true;
  updated_at: number;
  reason: "missing_evidence" | "target_deleted";
}

/**
 * Rebuilt on every read from scoped graph observations and optional local
 * verification rows. No profile value is itself a source of truth.
 */
export interface ProfileProjection {
  projection_version: "profile-projection-v1";
  status: ProfileProjectionStatus;
  scope: string;
  graph_revision: number;
  trust_revision: number;
  subject?: ProfileSubject;
  fields: ProfileField[];
  /** Retained preferences are never injected as source values; clear them with kg_profile_lock when desired. */
  stale_selections?: ProfileStaleSelection[];
}
