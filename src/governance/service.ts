import { GovernanceRepository, governanceRequestHash } from "./repository.js";
import { governanceActions, type GovernanceAction, type GovernanceAuthorization, type GovernanceConfig } from "./types.js";

/** Policy layer over the durable governance ledger; it never owns graph data. */
export class GovernanceService {
  private readonly enabled: boolean;
  private readonly approvalTtlMs: number;
  private readonly approvalActions: ReadonlySet<GovernanceAction>;
  constructor(readonly repository: GovernanceRepository, config: GovernanceConfig = {}) {
    this.enabled = config.enabled === true;
    this.approvalTtlMs = clamp(config.approvalTtlMs, 60_000, 86_400_000, 900_000);
    this.approvalActions = new Set((config.requireApprovalFor ?? ["conflict.resolve"]).filter((action): action is GovernanceAction => (governanceActions as readonly string[]).includes(action)));
  }
  get active(): boolean { return this.enabled; }
  requestHash = governanceRequestHash;
  requestApproval(input: { actor_id: string; action: GovernanceAction; scope: string; resource_id: string; request_hash: string }) {
    return this.repository.requestApproval({ action: input.action, scope: input.scope, resource_id: input.resource_id, request_hash: input.request_hash, requested_by: input.actor_id, ttl_ms: this.approvalTtlMs });
  }
  approve(input: { approval_id: string; actor_id: string; approve: boolean }) { return this.repository.resolveApproval(input); }
  authorize(input: { actor_id?: string; action: GovernanceAction; scope: string; resource_id: string; request_hash: string; approval_id?: string }): GovernanceAuthorization {
    if (!this.enabled) return { allowed: true, reason: "disabled" };
    return this.repository.authorize({ ...input, requires_approval: this.approvalActions.has(input.action) });
  }
}

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number { return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value as number))) : fallback; }
