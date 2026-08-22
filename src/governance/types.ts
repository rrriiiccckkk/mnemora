/** Stable action names for scoped multi-agent trust governance. */
export const governanceActions = ["verification.transition", "conflict.resolve", "profile.selection"] as const;
export type GovernanceAction = typeof governanceActions[number];
export type GovernancePrincipalKind = "human" | "agent" | "system";
export type GovernancePrincipalStatus = "active" | "revoked";
export type GovernanceApprovalStatus = "pending" | "approved" | "rejected" | "consumed" | "expired";

export interface GovernancePrincipal {
  id: string;
  kind: GovernancePrincipalKind;
  status: GovernancePrincipalStatus;
  created_at: number;
  updated_at: number;
}
export interface GovernanceGrant {
  id: string;
  principal_id: string;
  scope: string;
  action: GovernanceAction;
  status: "active" | "revoked" | "expired";
  issued_by: string;
  expires_at: number | null;
  created_at: number;
  revoked_at: number | null;
}
/** Contains hashes and internal identifiers only; no evidence, source, or prompt text. */
export interface GovernanceApproval {
  id: string;
  action: GovernanceAction;
  scope: string;
  resource_id: string;
  request_hash: string;
  requested_by: string;
  status: GovernanceApprovalStatus;
  approved_by: string | null;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
}
export interface GovernanceAuthorization {
  allowed: boolean;
  reason: "disabled" | "missing_actor" | "unknown_actor" | "revoked_actor" | "missing_grant" | "approval_required" | "approved";
  grant_id?: string;
  approval_id?: string;
}
/** Bounded, redacted audit record for host/operator provenance views. */
export interface GovernanceEvent {
  id: string;
  principal_id: string | null;
  action: GovernanceAction;
  scope: string;
  resource_id: string;
  outcome: "allowed" | "denied";
  reason: Exclude<GovernanceAuthorization["reason"], "disabled">;
  grant_id: string | null;
  approval_id: string | null;
  created_at: number;
}

export interface GovernanceConfig {
  enabled?: boolean;
  approvalTtlMs?: number;
  requireApprovalFor?: GovernanceAction[];
}
