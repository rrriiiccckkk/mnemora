import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { AdmissionDecision, FormationAuthority } from "./admission.js";

const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const compact=(value:string)=>value.trim().replace(/\s+/g," ").slice(0,512);
type BeliefAction="CREATE"|"CORROBORATE"|"REFINE"|"CORRECT"|"NO_CHANGE";
export interface BeliefLifecycleOptions { enabled?:boolean; autoCorroborate?:boolean; }
export interface BeliefFormationInput { scope:string;candidateId:string;authority:FormationAuthority;decision:AdmissionDecision;content?:string;priorBeliefId?:string;changeSetId?:string; }

/** Canonical personal-model mutations. Callers may only reach it through FormationService. */
export class BeliefLifecycleService {
 constructor(private readonly db:DatabaseSyncInstance,private readonly now:()=>number=Date.now,private readonly options:BeliefLifecycleOptions={}){}
 apply(input:BeliefFormationInput):{action:BeliefAction;beliefId?:string}{
  this.db.exec("BEGIN IMMEDIATE");try{const result=this.applyInTransaction(input);this.db.exec("COMMIT");return result;}catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
 }
 /** The FormationService owns the surrounding transaction for a complete cognition change. */
 applyInTransaction(input:BeliefFormationInput):{action:BeliefAction;beliefId?:string}{
  if(!this.options.enabled||input.decision.outcome!=="accept"||input.decision.durability!=="persistent")return {action:"NO_CHANGE"};
  if(input.authority!=="user_explicit_preference"&&input.authority!=="user_correction")return {action:"NO_CHANGE"};
  const scope=normalizeScope(input.scope),text=compact(input.content??"");if(!text)return {action:"NO_CHANGE"};
  const kind=input.decision.memoryShape==="correction"?"correction":"preference",valueHash=hash(text),now=this.now(),changeSetId=input.changeSetId??`cognition-change:${input.candidateId.slice(-24)}`;
  const prior=input.priorBeliefId?this.db.prepare("SELECT id,scope,state FROM mnemora_beliefs WHERE id=? AND scope=?").get(input.priorBeliefId,scope) as {id:string;scope:string;state:string}|undefined:undefined;
  if(input.priorBeliefId&&!prior)return {action:"NO_CHANGE"};
  const existing=this.db.prepare("SELECT id,support_count,state FROM mnemora_beliefs WHERE scope=? AND value_hash=? AND state IN ('supported','strong','emerging') ORDER BY created_at DESC LIMIT 1").get(scope,valueHash) as {id:string;support_count:number;state:string}|undefined;
  if(existing&&this.options.autoCorroborate){const support=Math.min(1000,Number(existing.support_count)+1),state=support>=2?"strong":"supported";this.db.prepare("UPDATE mnemora_beliefs SET support_count=?,state=?,epistemic_confidence=?,updated_at=? WHERE id=?").run(support,state,state==="strong"?.95:.9,now,existing.id);this.transition(scope,existing.id,existing.state,state,"CORROBORATE",input.candidateId,"corroborated",changeSetId,now);this.evidence(existing.id,input.candidateId,input.authority,now);return {action:"CORROBORATE",beliefId:existing.id};}
  if(existing)return {action:"NO_CHANGE",beliefId:existing.id};
  if(input.authority==="user_correction"&&!prior)return {action:"NO_CHANGE"};
  const id=`belief:${hash(`${scope}\0${valueHash}\0${input.candidateId}`).slice(0,40)}`,action:BeliefAction=prior?(input.authority==="user_correction"?"CORRECT":"REFINE"):"CREATE",value=JSON.stringify({text}),state="supported";
  if(prior){this.db.prepare("UPDATE mnemora_beliefs SET state='superseded',superseded_at=?,updated_at=? WHERE id=? AND scope=?").run(now,now,prior.id,scope);this.transition(scope,prior.id,prior.state,"superseded",action,input.candidateId,"explicit_prior_reference",changeSetId,now);}
  this.db.prepare("INSERT INTO mnemora_beliefs(id,scope,type,subject_ref,predicate,value_json,value_hash,state,epistemic_confidence,support_count,contradiction_count,recorded_at,previous_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,.9,1,0,?,?,?,?)").run(id,scope,kind,"user",kind,value,valueHash,state,now,prior?.id??null,now,now);
  this.evidence(id,input.candidateId,input.authority,now);this.transition(scope,id,null,state,action,input.candidateId,action==="CREATE"?"explicit_user_statement":"explicit_prior_reference",changeSetId,now);return {action,beliefId:id};
 }
 private evidence(beliefId:string,candidateId:string,authority:string,now:number){this.db.prepare("INSERT OR IGNORE INTO mnemora_belief_evidence(belief_id,source_ref,relation,authority,created_at) VALUES(?,?, 'supports',?,?)").run(beliefId,candidateId,authority,now);}
 private transition(scope:string,beliefId:string,from:string|null,to:string,action:BeliefAction,candidateId:string,reason:string,changeSetId:string,now:number){const id=`belief-transition:${hash(`${beliefId}\0${candidateId}\0${action}\0${to}`).slice(0,40)}`;this.db.prepare("INSERT OR IGNORE INTO mnemora_belief_transitions(id,scope,belief_id,from_state,to_state,action,candidate_id,reason_codes_json,change_set_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,scope,beliefId,from,to,action,candidateId,JSON.stringify([reason]),changeSetId,now);}
 status(scope:string){const safe=normalizeScope(scope),counts=(table:string,column:string)=>Object.fromEntries((this.db.prepare(`SELECT ${column} AS key,COUNT(*) AS value FROM ${table} WHERE scope=? GROUP BY ${column}`).all(safe) as Array<{key:string;value:number}>).map(row=>[row.key,Number(row.value)]));return {beliefs:counts("mnemora_beliefs","state"),transitions:counts("mnemora_belief_transitions","action")};}
}
