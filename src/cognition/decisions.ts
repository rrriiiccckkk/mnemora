import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { authorizeMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";
import { CognitionReferenceRepository } from "./reference-repository.js";

export type DecisionMaker = "user" | "assistant" | "joint" | "tool" | "external";
export type DecisionStatus = "active" | "needs_review" | "superseded" | "invalidated" | "archived";
type EvidenceRelation = "supports" | "constraint" | "rationale_source" | "outcome_source" | "derived_from";
const makers = new Set<DecisionMaker>(["user", "assistant", "joint", "tool", "external"]);
const relations = new Set<EvidenceRelation>(["supports", "constraint", "rationale_source", "outcome_source", "derived_from"]);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown, max: number): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const strings = (value: unknown, maxItems: number, maxChars: number): string[] => Array.isArray(value) ? [...new Set(value.flatMap(item => text(item, maxChars) ?? []))].slice(0, maxItems) : [];

export interface DecisionInput {
  scope: string; objective: string; scenario?: string; alternatives?: string[]; chosenAction?: string; outcome?: string; rationale?: string; constraints?: string[];
  confidence?: number; decisionMaker?: DecisionMaker; decidedAt?: number; validFrom?: number; validUntil?: number; evidence?: Array<{ sourceRef: string; relation?: EvidenceRelation }>; episodeIds?: string[]; previousDecisionId?: string;
}
export interface DecisionMemory {
  id: string; scope: string; objective: string; scenario?: string; alternatives: string[]; chosenAction?: string; outcome?: string; rationale?: string; constraints: string[]; confidence?: number; decisionMaker: DecisionMaker; decidedAt?: number; validFrom?: number; validUntil?: number; recordedAt: number; supersededAt?: number; invalidatedAt?: number; previousVersionId?: string; status: DecisionStatus; evidence: Array<{ sourceRef: string; relation: EvidenceRelation }>; episodeIds: string[];
}

/** Canonical, explicit decision records. It has no extraction or prompt-injection path. */
export class DecisionMemoryService {
  private readonly references: CognitionReferenceRepository;
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) { this.references = new CognitionReferenceRepository(db); }

  preview(input: DecisionInput): { status: "preview"; preview_hash: string; decision: Omit<DecisionMemory, "id" | "recordedAt" | "status" | "evidence" | "episodeIds"> & { evidence_count: number; episode_count: number } } {
    const value = this.normalize(input);
    return { status: "preview", preview_hash: hash({ version: "decision-preview-v1", ...value }), decision: { ...value, evidence_count: value.evidence.length, episode_count: value.episodeIds.length } };
  }

  confirm(input: DecisionInput, previewHash: string): DecisionMemory {
    const value = this.normalize(input), expected = hash({ version: "decision-preview-v1", ...value });
    if (!previewHash || previewHash !== expected) throw new Error("invalid_decision_preview");
    const now = this.now(), contentHash = hash({ scope: value.scope, objective: value.objective, scenario: value.scenario, alternatives: value.alternatives, chosenAction: value.chosenAction, outcome: value.outcome, rationale: value.rationale, constraints: value.constraints, confidence: value.confidence, decisionMaker: value.decisionMaker, decidedAt: value.decidedAt, validFrom: value.validFrom, validUntil: value.validUntil, evidence: value.evidence, episodeIds: value.episodeIds, previousDecisionId: value.previousDecisionId });
    const id = `decision:${contentHash.slice(0, 40)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(value.scope, now, now);
      const existing = this.db.prepare("SELECT id FROM mnemora_decisions WHERE scope=? AND content_hash=?").get(value.scope, contentHash) as { id: string } | undefined;
      if (existing) { this.db.exec("COMMIT"); return this.get(existing.id, value.scope)!; }
      if (value.previousDecisionId) {
        const prior = this.db.prepare("SELECT id,status FROM mnemora_decisions WHERE id=? AND scope=?").get(value.previousDecisionId, value.scope) as { id: string; status: DecisionStatus } | undefined;
        if (!prior || prior.status !== "active") throw new Error("invalid_previous_decision");
        this.db.prepare("UPDATE mnemora_decisions SET status='superseded',superseded_at=?,updated_at=? WHERE id=? AND scope=?").run(now, now, prior.id, value.scope);
      }
      this.db.prepare("INSERT INTO mnemora_decisions(id,scope,objective,scenario,alternatives_json,chosen_action,outcome,rationale,constraints_json,confidence,decision_maker,decided_at,valid_from,valid_until,recorded_at,previous_version_id,status,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active',?,?,?)").run(id,value.scope,value.objective,value.scenario??null,json(value.alternatives)??null,value.chosenAction??null,value.outcome??null,value.rationale??null,json(value.constraints)??null,value.confidence??null,value.decisionMaker,value.decidedAt??null,value.validFrom??null,value.validUntil??null,now,value.previousDecisionId??null,contentHash,now,now);
      if (value.previousDecisionId) this.recordTransition(value.scope, value.previousDecisionId, "active", "superseded", "SUPERSEDE", "explicit_successor", id, now);
      const evidence = this.db.prepare("INSERT INTO mnemora_decision_evidence(decision_id,source_ref,relation,created_at) VALUES(?,?,?,?)"); for (const item of value.evidence) evidence.run(id,item.sourceRef,item.relation,now);
      const episodes = this.db.prepare("INSERT INTO mnemora_decision_episodes(decision_id,episode_id) VALUES(?,?)"); for (const episodeId of value.episodeIds) episodes.run(id,episodeId);
      this.recordTransition(value.scope, id, null, "active", "CREATE", "operator_confirmed", value.previousDecisionId, now);
      this.db.exec("COMMIT"); return this.get(id, value.scope)!;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  changeStatus(input: { id: string; scope: string; action: "invalidate" | "archive" }): DecisionMemory {
    const scope = normalizeScope(input.scope), current = this.get(input.id, scope); if (!current || (current.status !== "active" && current.status !== "needs_review")) throw new Error("invalid_decision_transition");
    const now = this.now(), status: DecisionStatus = input.action === "invalidate" ? "invalidated" : "archived", action = input.action === "invalidate" ? "INVALIDATE" : "ARCHIVE";
    this.db.exec("BEGIN IMMEDIATE"); try { this.db.prepare("UPDATE mnemora_decisions SET status=?,invalidated_at=?,updated_at=? WHERE id=? AND scope=?").run(status, input.action === "invalidate" ? now : null, now, current.id, scope); this.db.prepare("UPDATE mnemora_decision_evidence_reviews SET status=?,updated_at=? WHERE decision_id=? AND scope=? AND status='needs_review'").run(input.action === "invalidate" ? "invalidated" : "resolved", now, current.id, scope); this.recordTransition(scope,current.id,current.status,status,action,"operator_confirmed",undefined,now); this.db.exec("COMMIT"); return this.get(current.id,scope)!; } catch(error){try{this.db.exec("ROLLBACK")}catch{}throw error;}
  }

  /** Called by a privacy/forget operation; it never changes a decision automatically. */
  markEvidenceNeedsReview(input: { scope: string; decisionIds: string[]; sourceRefs: string[]; reasonCode?: "evidence_forgotten" | "evidence_unavailable" }): number {
    const scope = normalizeScope(input.scope), ids = [...new Set(input.decisionIds)].filter(Boolean).slice(0, 100), refs = [...new Set(input.sourceRefs)].filter(Boolean).slice(0, 100);
    if (!ids.length || !refs.length) return 0;
    const now = this.now(), statement = this.db.prepare("INSERT INTO mnemora_decision_evidence_reviews(decision_id,scope,status,reason_code,source_refs_json,created_at,updated_at) SELECT id,?,'needs_review',?,?,?,? FROM mnemora_decisions WHERE id=? AND scope=? AND status='active' ON CONFLICT(decision_id) DO UPDATE SET status='needs_review',reason_code=excluded.reason_code,source_refs_json=excluded.source_refs_json,updated_at=excluded.updated_at");
    let changed = 0; for (const id of ids) changed += Number((statement.run(scope, input.reasonCode ?? "evidence_forgotten", JSON.stringify(refs), now, now, id, scope) as { changes?: unknown }).changes ?? 0);
    return changed;
  }

  get(id: string, scope: string): DecisionMemory | undefined { const safe=normalizeScope(scope),row=this.db.prepare("SELECT * FROM mnemora_decisions WHERE id=? AND scope=?").get(id,safe) as Record<string,unknown>|undefined; if(!row)return; const evidence=(this.db.prepare("SELECT source_ref,relation FROM mnemora_decision_evidence WHERE decision_id=? ORDER BY source_ref,relation").all(id) as Array<{source_ref:string;relation:EvidenceRelation}>).map(item=>({sourceRef:item.source_ref,relation:item.relation})),episodeIds=(this.db.prepare("SELECT episode_id FROM mnemora_decision_episodes WHERE decision_id=? ORDER BY episode_id").all(id) as Array<{episode_id:string}>).map(item=>item.episode_id),review=this.db.prepare("SELECT 1 FROM mnemora_decision_evidence_reviews WHERE decision_id=? AND scope=? AND status='needs_review'").get(id,safe); return {id:String(row.id),scope:String(row.scope),objective:String(row.objective),...(row.scenario?{scenario:String(row.scenario)}:{}),alternatives:array(row.alternatives_json),...(row.chosen_action?{chosenAction:String(row.chosen_action)}:{}),...(row.outcome?{outcome:String(row.outcome)}:{}),...(row.rationale?{rationale:String(row.rationale)}:{}),constraints:array(row.constraints_json),...(row.confidence!==null?{confidence:Number(row.confidence)}:{}),decisionMaker:row.decision_maker as DecisionMaker,...(row.decided_at?{decidedAt:Number(row.decided_at)}:{}),...(row.valid_from?{validFrom:Number(row.valid_from)}:{}),...(row.valid_until?{validUntil:Number(row.valid_until)}:{}),recordedAt:Number(row.recorded_at),...(row.superseded_at?{supersededAt:Number(row.superseded_at)}:{}),...(row.invalidated_at?{invalidatedAt:Number(row.invalidated_at)}:{}),...(row.previous_version_id?{previousVersionId:String(row.previous_version_id)}:{}),status:review && row.status === "active" ? "needs_review" : row.status as DecisionStatus,evidence,episodeIds}; }
  list(scope: string, limit=20): DecisionMemory[] { const safe=normalizeScope(scope), rows=this.db.prepare("SELECT id FROM mnemora_decisions WHERE scope=? ORDER BY recorded_at DESC,id DESC LIMIT ?").all(safe,bound(limit)) as Array<{id:string}>; return rows.flatMap(row=>{const decision=this.get(row.id,safe);return decision?[decision]:[]}); }
  find(scope: string, query: string, limit=20): DecisionMemory[] { const safe=normalizeScope(scope),q=query.trim().slice(0,512).toLowerCase();if(!q)return[];const rows=this.db.prepare("SELECT d.id FROM mnemora_decisions d WHERE d.scope=? AND d.status='active' AND NOT EXISTS (SELECT 1 FROM mnemora_decision_evidence_reviews r WHERE r.decision_id=d.id AND r.scope=d.scope AND r.status='needs_review') AND (instr(lower(d.objective),?)>0 OR instr(lower(COALESCE(d.scenario,'')),?)>0 OR instr(lower(COALESCE(d.chosen_action,'')),?)>0) ORDER BY d.recorded_at DESC,d.id DESC LIMIT ?").all(safe,q,q,q,bound(limit)) as Array<{id:string}>;return rows.flatMap(row=>{const decision=this.get(row.id,safe);return decision?[decision]:[]}); }
  status(scope: string) { const safe=normalizeScope(scope), rows=this.db.prepare("SELECT status,COUNT(*) AS value FROM mnemora_decisions WHERE scope=? GROUP BY status").all(safe) as Array<{status:string;value:number}>, review=Number((this.db.prepare("SELECT COUNT(*) AS value FROM mnemora_decision_evidence_reviews WHERE scope=? AND status='needs_review'").get(safe) as {value:number}).value); const decisions=Object.fromEntries(rows.map(row=>[row.status,Number(row.value)]));if(review){decisions.active=Math.max(0,Number(decisions.active??0)-review);decisions.needs_review=review;}return {scope:safe,decisions}; }

  private normalize(input: DecisionInput) { const scope=normalizeScope(input.scope),objective=text(input.objective,1024); if(!objective)throw new Error("invalid_decision"); const alternatives=strings(input.alternatives,20,256),constraints=strings(input.constraints,20,256),confidence=input.confidence===undefined?undefined:Number(input.confidence),decisionMaker=input.decisionMaker??"user",decidedAt=time(input.decidedAt),validFrom=time(input.validFrom),validUntil=time(input.validUntil);if(!makers.has(decisionMaker)||confidence!==undefined&&(!Number.isFinite(confidence)||confidence<0||confidence>1)||validFrom!==undefined&&validUntil!==undefined&&validUntil<validFrom)throw new Error("invalid_decision");const evidence=(Array.isArray(input.evidence)?input.evidence:[]).slice(0,50).map(item=>{const reference=authorizeMnemoraContextRef(item.sourceRef,{scope,kinds:["conversation-event","artifact","episode","claim","memory-candidate","belief"]});this.references.requireActive(reference);const relation=relations.has(item.relation??"supports")?item.relation??"supports":undefined;if(!relation)throw new Error("invalid_decision_evidence");return {sourceRef:reference.canonical,relation};});const episodeIds=strings(input.episodeIds,20,256);for(const episodeId of episodeIds)if(!this.db.prepare("SELECT 1 FROM mnemora_episodes WHERE id=? AND scope=? AND deleted_at IS NULL").get(episodeId,scope))throw new Error("invalid_decision_episode");const previousDecisionId=text(input.previousDecisionId,256);return {scope,objective,scenario:text(input.scenario,2048),alternatives,chosenAction:text(input.chosenAction,2048),outcome:text(input.outcome,2048),rationale:text(input.rationale,4096),constraints,confidence,decisionMaker,decidedAt,validFrom,validUntil,evidence:[...new Map(evidence.map(item=>[`${item.sourceRef}\0${item.relation}`,item])).values()],episodeIds,previousDecisionId}; }
  private recordTransition(scope:string,id:string,from:DecisionStatus|null,to:DecisionStatus,action:"CREATE"|"SUPERSEDE"|"INVALIDATE"|"ARCHIVE",reason:string,previous:string|undefined,now:number){const transitionId=`decision-transition:${hash({scope,id,from,to,action,previous}).slice(0,40)}`;this.db.prepare("INSERT OR IGNORE INTO mnemora_decision_transitions(id,scope,decision_id,from_status,to_status,action,reason_code,previous_version_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(transitionId,scope,id,from,to,action,reason,previous??null,now);}
}
function json(value:string[]):string|undefined{return value.length?JSON.stringify(value):undefined;}function array(value:unknown):string[]{try{return Array.isArray(JSON.parse(String(value??"[]")))?JSON.parse(String(value??"[]")):[]}catch{return[];}}function time(value:unknown):number|undefined{if(value===undefined)return;const number=Number(value);if(!Number.isSafeInteger(number)||number<0)throw new Error("invalid_decision");return number;}function bound(value:number):number{return Math.min(100,Math.max(1,Math.trunc(value)));}
