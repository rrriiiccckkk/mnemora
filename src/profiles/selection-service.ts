import { createHash } from "node:crypto";
import { normalizeScope } from "../scope.js";
import type { RelationshipType } from "../relationships.js";
import { ProfileProjectionRepository } from "./repository.js";
import { ProfileSelectionRepository, type StoredProfileSelection } from "./selection-repository.js";
import type { ProfileProjectionStatus, ProfileSubject } from "./types.js";

type ProfileSelectionAction = "set" | "clear";

export type ProfileSelectionInput = {
  action: ProfileSelectionAction;
  subject: string;
  field_key: RelationshipType;
  target_id?: string;
  scope?: string;
  preview_hash?: string;
  confirm?: boolean;
  /** Host-governed callers may supply a one-use approval; the service ignores it. */
  approval_id?: string;
};

export interface ProfileSelectionResult {
  status: "ready" | "not_found" | "ambiguous" | "invalid_target" | "stale_preview" | "confirmed";
  action: ProfileSelectionAction;
  scope: string;
  subject?: ProfileSubject;
  field_key: RelationshipType;
  current_selection?: StoredProfileSelection;
  proposed_selection?: { entity: ProfileSubject; locked: true };
  preview_hash?: string;
  audit_id?: string;
}

/** Preview-first user preference service; it can select a sourced candidate but never edit the source claim. */
export class ProfileSelectionService {
  constructor(
    private readonly profiles: ProfileProjectionRepository,
    private readonly selections: ProfileSelectionRepository,
    private readonly now: () => number = Date.now
  ) {}

  manage(input: ProfileSelectionInput): ProfileSelectionResult {
    const proposal = this.preview(input);
    if (input.confirm !== true || proposal.status !== "ready") return proposal;
    if (!sameHash(input.preview_hash, proposal.preview_hash)) return { ...proposal, status: "stale_preview" };
    const subject = proposal.subject!;
    const write = this.selections.replace({
      scope: proposal.scope, subject_id: subject.id, field_key: input.field_key,
      target_id: proposal.proposed_selection?.entity.id, revisions: this.profiles.revisions(), now: this.now()
    });
    return { ...proposal, status: "confirmed", preview_hash: undefined, audit_id: write.audit_id, ...(write.selection ? { proposed_selection: { entity: write.selection.entity, locked: true } } : {}) };
  }

  private preview(input: ProfileSelectionInput): ProfileSelectionResult {
    const scope = normalizeScope(input.scope, "default"), action = input.action;
    const subject = this.profiles.resolveSubject(input.subject, scope);
    if (subject === "not_found" || subject === "ambiguous") return { status: subject, action, scope, field_key: input.field_key };
    const current = this.selections.current(scope, subject.id, input.field_key);
    const target = action === "set" ? this.proposedTarget(subject.id, input.field_key, input.target_id, scope) : undefined;
    if (action === "set" && !target) return { status: "invalid_target", action, scope, subject, field_key: input.field_key, ...(current ? { current_selection: current } : {}) };
    const snapshot = {
      version: "profile-selection-v1", action, scope, subject_id: subject.id, field_key: input.field_key,
      current_target_id: current?.entity.id ?? null, target_id: target?.id ?? null, ...this.profiles.revisions()
    };
    return {
      status: "ready", action, scope, subject, field_key: input.field_key,
      ...(current ? { current_selection: current } : {}),
      ...(target ? { proposed_selection: { entity: target, locked: true as const } } : {}),
      preview_hash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")
    };
  }

  private proposedTarget(subjectId: string, fieldKey: RelationshipType, targetId: unknown, scope: string): ProfileSubject | undefined {
    const id = typeof targetId === "string" && targetId.length > 0 && targetId.length <= 200 ? targetId : "";
    if (!id) return undefined;
    const edge = this.profiles.fieldEdges(subjectId, scope, 240).find(value => value.key === fieldKey && value.entity.id === id);
    return edge?.entity;
  }
}

function sameHash(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" && left.length === 64 && right.length === 64 && left === right;
}
