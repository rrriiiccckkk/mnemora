import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import { governanceActions, type GovernanceAction, type GovernanceApproval, type GovernanceApprovalStatus, type GovernanceAuthorization, type GovernanceEvent, type GovernanceGrant, type GovernancePrincipal, type GovernancePrincipalKind } from "./types.js";

const actions = new Set<GovernanceAction>(governanceActions);

/** Durable authority/approval ledger. It owns no graph, evidence, or verification rows. */
export class GovernanceRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  registerPrincipal(input: { id: string; kind: GovernancePrincipalKind }): GovernancePrincipal {
    const id = principalId(input.id), kind = principalKind(input.kind);
    if (!id || !kind) throw new Error("invalid_governance_principal");
    const existing = this.principal(id);
    if (existing && existing.kind !== kind) throw new Error("invalid_governance_principal");
    if (existing) return existing;
    const now = this.now();
    this.db.prepare("INSERT INTO kg_governance_principals(id,kind,status,created_at,updated_at) VALUES(?,?, 'active',?,?)").run(id, kind, now, now);
    return this.principal(id)!;
  }

  principal(id: string): GovernancePrincipal | undefined {
    const row = this.db.prepare("SELECT id,kind,status,created_at,updated_at FROM kg_governance_principals WHERE id=?").get(principalId(id)) as Record<string, unknown> | undefined;
    return row ? principal(row) : undefined;
  }

  principals(limit = 20): GovernancePrincipal[] {
    const rows = this.db.prepare("SELECT id,kind,status,created_at,updated_at FROM kg_governance_principals ORDER BY id LIMIT ?").all(clamp(limit, 1, 100, 20)) as Array<Record<string, unknown>>;
    return rows.flatMap(row => { const value = principal(row); return value ? [value] : []; });
  }

  revokePrincipal(id: string): boolean {
    const value = principalId(id); if (!value) return false;
    return Number(this.db.prepare("UPDATE kg_governance_principals SET status='revoked',updated_at=? WHERE id=? AND status='active'").run(this.now(), value).changes) === 1;
  }

  grant(input: { principal_id: string; scope: string; action: GovernanceAction; issued_by: string; expires_at?: number }): GovernanceGrant {
    const principalIdValue = principalId(input.principal_id), issuer = this.principal(input.issued_by), action = governanceAction(input.action);
    if (!principalIdValue || !issuer || issuer.status !== "active" || issuer.kind !== "human" || !action) throw new Error("invalid_governance_grant");
    const target = this.principal(principalIdValue);
    if (!target || target.status !== "active") throw new Error("invalid_governance_grant");
    const scope = normalizeScope(input.scope), now = this.now(), expiresAt = expiration(input.expires_at, now);
    this.expireGrants(now);
    const existing = this.db.prepare("SELECT id FROM kg_governance_grants WHERE principal_id=? AND scope=? AND action=? AND status='active'").get(principalIdValue, scope, action) as { id: string } | undefined;
    if (existing) this.db.prepare("UPDATE kg_governance_grants SET expires_at=? WHERE id=?").run(expiresAt, existing.id);
    else this.db.prepare("INSERT INTO kg_governance_grants(id,principal_id,scope,action,status,issued_by,expires_at,created_at,revoked_at) VALUES(?,?,?,?, 'active',?,?,?,NULL)")
      .run(`governance-grant:${randomUUID()}`, principalIdValue, scope, action, issuer.id, expiresAt, now);
    const row = this.db.prepare("SELECT * FROM kg_governance_grants WHERE principal_id=? AND scope=? AND action=? AND status='active'").get(principalIdValue, scope, action) as Record<string, unknown> | undefined;
    const value = row && grant(row); if (!value) throw new Error("governance_persistence_failed"); return value;
  }

  revokeGrant(id: string, issuerId: string): boolean {
    const issuer = this.principal(issuerId), grantId = boundedId(id);
    if (!issuer || issuer.status !== "active" || issuer.kind !== "human" || !grantId) return false;
    return Number(this.db.prepare("UPDATE kg_governance_grants SET status='revoked',revoked_at=? WHERE id=? AND status='active'").run(this.now(), grantId).changes) === 1;
  }

  grants(scope?: string, limit = 20): GovernanceGrant[] {
    const normalizedScope = scope == null ? null : normalizeScope(scope);
    const rows = this.db.prepare(`SELECT * FROM kg_governance_grants WHERE (? IS NULL OR scope=?) ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(normalizedScope, normalizedScope, clamp(limit, 1, 100, 20)) as Array<Record<string, unknown>>;
    return rows.flatMap(row => { const value = grant(row); return value ? [value] : []; });
  }

  approvals(scope?: string, limit = 20): GovernanceApproval[] {
    const normalizedScope = scope == null ? null : normalizeScope(scope);
    this.expireApprovals(this.now());
    const rows = this.db.prepare(`SELECT * FROM kg_governance_approvals WHERE (? IS NULL OR scope=?) ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(normalizedScope, normalizedScope, clamp(limit, 1, 100, 20)) as Array<Record<string, unknown>>;
    return rows.flatMap(row => { const value = approval(row); return value ? [value] : []; });
  }

  /** Redacted operator provenance; it intentionally excludes any request body. */
  events(scope: string, limit = 20): GovernanceEvent[] {
    const rows = this.db.prepare(`SELECT id,principal_id,action,scope,resource_id,outcome,reason,grant_id,approval_id,created_at
      FROM kg_governance_events WHERE scope=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(normalizeScope(scope), clamp(limit, 1, 100, 20)) as Array<Record<string, unknown>>;
    return rows.flatMap(event);
  }

  requestApproval(input: { action: GovernanceAction; scope: string; resource_id: string; request_hash: string; requested_by: string; ttl_ms: number }): GovernanceApproval {
    const action = governanceAction(input.action), requestedBy = this.principal(input.requested_by), resourceId = boundedId(input.resource_id), hash = sha256(input.request_hash);
    if (!action || !requestedBy || requestedBy.status !== "active" || !resourceId || !hash) throw new Error("invalid_governance_approval");
    const now = this.now(), scope = normalizeScope(input.scope), ttl = clamp(input.ttl_ms, 60_000, 86_400_000, 900_000);
    this.expireApprovals(now);
    const current = this.db.prepare(`SELECT * FROM kg_governance_approvals WHERE action=? AND scope=? AND resource_id=? AND request_hash=? AND requested_by=? AND status='pending' ORDER BY created_at DESC LIMIT 1`)
      .get(action, scope, resourceId, hash, requestedBy.id) as Record<string, unknown> | undefined;
    if (current) return approval(current)!;
    const id = `governance-approval:${randomUUID()}`;
    this.db.prepare(`INSERT INTO kg_governance_approvals(id,action,scope,resource_id,request_hash,requested_by,status,approved_by,created_at,expires_at,resolved_at)
      VALUES(?,?,?,?,?,?,'pending',NULL,?,?,NULL)`).run(id, action, scope, resourceId, hash, requestedBy.id, now, now + ttl);
    return approval(this.db.prepare("SELECT * FROM kg_governance_approvals WHERE id=?").get(id) as Record<string, unknown>)!;
  }

  resolveApproval(input: { approval_id: string; actor_id: string; approve: boolean }): GovernanceApproval {
    const actor = this.principal(input.actor_id), id = boundedId(input.approval_id);
    if (!actor || actor.status !== "active" || actor.kind !== "human" || !id) throw new Error("invalid_governance_approval");
    this.expireApprovals(this.now());
    const current = this.db.prepare("SELECT * FROM kg_governance_approvals WHERE id=?").get(id) as Record<string, unknown> | undefined;
    const parsed = current && approval(current);
    if (!parsed || parsed.status !== "pending" || parsed.requested_by === actor.id) throw new Error("invalid_governance_approval");
    const now = this.now(), status = input.approve === true ? "approved" : "rejected";
    this.db.prepare("UPDATE kg_governance_approvals SET status=?,approved_by=?,resolved_at=? WHERE id=? AND status='pending'").run(status, actor.id, now, id);
    return approval(this.db.prepare("SELECT * FROM kg_governance_approvals WHERE id=?").get(id) as Record<string, unknown>)!;
  }

  authorize(input: { actor_id?: string; action: GovernanceAction; scope: string; resource_id: string; request_hash: string; requires_approval: boolean; approval_id?: string }): GovernanceAuthorization {
    const action = governanceAction(input.action), scope = normalizeScope(input.scope), resourceId = boundedId(input.resource_id), requestHash = sha256(input.request_hash), now = this.now();
    this.expireGrants(now); this.expireApprovals(now);
    const actorId = principalId(input.actor_id);
    if (!action || !resourceId || !requestHash) return this.record({ actorId, action: input.action, scope, resourceId: resourceId || "invalid", authorization: { allowed: false, reason: "missing_actor" } });
    if (!actorId) return this.record({ actorId: undefined, action, scope, resourceId, authorization: { allowed: false, reason: "missing_actor" } });
    const actor = this.principal(actorId);
    if (!actor) return this.record({ actorId, action, scope, resourceId, authorization: { allowed: false, reason: "unknown_actor" } });
    if (actor.status !== "active") return this.record({ actorId, action, scope, resourceId, authorization: { allowed: false, reason: "revoked_actor" } });
    const grantRow = this.db.prepare(`SELECT * FROM kg_governance_grants WHERE principal_id=? AND scope=? AND action=? AND status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC LIMIT 1`)
      .get(actorId, scope, action, now) as Record<string, unknown> | undefined;
    const grantValue = grantRow && grant(grantRow);
    if (!grantValue) return this.record({ actorId, action, scope, resourceId, authorization: { allowed: false, reason: "missing_grant" } });
    if (!input.requires_approval) return this.record({ actorId, action, scope, resourceId, authorization: { allowed: true, reason: "approved", grant_id: grantValue.id } });
    const approvalId = boundedId(input.approval_id);
    const approvalRow = approvalId && this.db.prepare(`SELECT * FROM kg_governance_approvals WHERE id=? AND action=? AND scope=? AND resource_id=? AND request_hash=? AND requested_by=? AND status='approved' AND expires_at>?`)
      .get(approvalId, action, scope, resourceId, requestHash, actorId, now) as Record<string, unknown> | undefined;
    const approvalValue = approvalRow && approval(approvalRow);
    if (!approvalValue) return this.record({ actorId, action, scope, resourceId, authorization: { allowed: false, reason: "approval_required", grant_id: grantValue.id } });
    // Consume before the governed write: if that write later fails, this is a
    // deliberate fail-closed retry rather than a reusable approval token.
    this.db.prepare("UPDATE kg_governance_approvals SET status='consumed',resolved_at=? WHERE id=? AND status='approved'").run(now, approvalValue.id);
    return this.record({ actorId, action, scope, resourceId, authorization: { allowed: true, reason: "approved", grant_id: grantValue.id, approval_id: approvalValue.id } });
  }

  private record(input: { actorId?: string; action: GovernanceAction; scope: string; resourceId: string; authorization: GovernanceAuthorization }): GovernanceAuthorization {
    const now = this.now(), value = input.authorization;
    this.db.prepare(`INSERT INTO kg_governance_events(id,principal_id,action,scope,resource_id,outcome,reason,grant_id,approval_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(`governance-event:${randomUUID()}`, input.actorId ?? null, input.action, input.scope, input.resourceId, value.allowed ? "allowed" : "denied", value.reason, value.grant_id ?? null, value.approval_id ?? null, now);
    return value;
  }
  private expireGrants(now: number): void { this.db.prepare("UPDATE kg_governance_grants SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=?").run(now); }
  private expireApprovals(now: number): void { this.db.prepare("UPDATE kg_governance_approvals SET status='expired',resolved_at=? WHERE status IN ('pending','approved') AND expires_at<=?").run(now, now); }
}

export function governanceRequestHash(input: { action: GovernanceAction; scope: string; resource_id: string; details?: Record<string, string | number | boolean | null | undefined> }): string {
  const action = governanceAction(input.action), resourceId = boundedId(input.resource_id);
  if (!action || !resourceId) throw new Error("invalid_governance_request");
  const details = Object.fromEntries(Object.entries(input.details ?? {}).filter(([key, value]) => /^[a-z][a-z0-9_]{0,39}$/.test(key) && (value == null || typeof value === "boolean" || Number.isFinite(value) || typeof value === "string" && value.length <= 120 && !/[\u0000-\u001f]/.test(value))).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify({ action, scope: normalizeScope(input.scope), resource_id: resourceId, details })).digest("hex");
}

function principal(value: Record<string, unknown>): GovernancePrincipal | undefined { const id = principalId(value.id), kind = principalKind(value.kind), status = value.status === "active" || value.status === "revoked" ? value.status : undefined; return id && kind && status && integer(value.created_at) != null && integer(value.updated_at) != null ? { id, kind, status, created_at: integer(value.created_at)!, updated_at: integer(value.updated_at)! } : undefined; }
function grant(value: Record<string, unknown>): GovernanceGrant | undefined { const id = boundedId(value.id), principalIdValue = principalId(value.principal_id), action = governanceAction(value.action), status = value.status === "active" || value.status === "revoked" || value.status === "expired" ? value.status : undefined, issuer = principalId(value.issued_by); return id && principalIdValue && action && status && issuer && typeof value.scope === "string" && integer(value.created_at) != null ? { id, principal_id: principalIdValue, scope: normalizeScope(value.scope), action, status, issued_by: issuer, expires_at: integerOrNull(value.expires_at), created_at: integer(value.created_at)!, revoked_at: integerOrNull(value.revoked_at) } : undefined; }
function approval(value: Record<string, unknown>): GovernanceApproval | undefined { const id = boundedId(value.id), action = governanceAction(value.action), resource = boundedId(value.resource_id), requested = principalId(value.requested_by), status = ["pending", "approved", "rejected", "consumed", "expired"].includes(String(value.status)) ? value.status as GovernanceApprovalStatus : undefined; return id && action && resource && requested && status && typeof value.scope === "string" && sha256(value.request_hash) && integer(value.created_at) != null && integer(value.expires_at) != null ? { id, action, scope: normalizeScope(value.scope), resource_id: resource, request_hash: String(value.request_hash), requested_by: requested, status, approved_by: principalId(value.approved_by) || null, created_at: integer(value.created_at)!, expires_at: integer(value.expires_at)!, resolved_at: integerOrNull(value.resolved_at) } : undefined; }
function event(value: Record<string, unknown>): GovernanceEvent[] { const id = boundedId(value.id), action = governanceAction(value.action), resource = boundedId(value.resource_id), outcome = value.outcome === "allowed" || value.outcome === "denied" ? value.outcome : undefined, reason = ["missing_actor", "unknown_actor", "revoked_actor", "missing_grant", "approval_required", "approved"].includes(String(value.reason)) ? value.reason as GovernanceEvent["reason"] : undefined; return id && action && resource && outcome && reason && typeof value.scope === "string" && integer(value.created_at) != null ? [{ id, principal_id: principalId(value.principal_id) ?? null, action, scope: normalizeScope(value.scope), resource_id: resource, outcome, reason, grant_id: boundedId(value.grant_id) ?? null, approval_id: boundedId(value.approval_id) ?? null, created_at: integer(value.created_at)! }] : []; }
function governanceAction(value: unknown): GovernanceAction | undefined { return typeof value === "string" && actions.has(value as GovernanceAction) ? value as GovernanceAction : undefined; }
function principalKind(value: unknown): GovernancePrincipalKind | undefined { return value === "human" || value === "agent" || value === "system" ? value : undefined; }
function principalId(value: unknown): string | undefined { return typeof value === "string" && /^[a-z][a-z0-9:_-]{0,119}$/.test(value) ? value : undefined; }
function boundedId(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value) ? value : undefined; }
function sha256(value: unknown): string | undefined { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined; }
function integer(value: unknown): number | undefined { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined; }
function integerOrNull(value: unknown): number | null { return integer(value) ?? null; }
function expiration(value: unknown, now: number): number | null { return Number.isSafeInteger(value) && Number(value) > now && Number(value) <= now + 366 * 86_400_000 ? Number(value) : null; }
function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number { return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value as number))) : fallback; }
