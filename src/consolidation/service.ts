import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import { authorizeMnemoraContextRef, createMnemoraContextRef } from "../context/context-ref.js";

export type ConsolidationJobKind = "duplicate" | "conflict" | "stale" | "digest";
export type ConsolidationProposalKind = "duplicate_episode" | "conflict_review" | "staleness_review" | "session_digest";
export type ConsolidationProposalStatus = "proposed" | "approved" | "rejected" | "expired";
export interface ConsolidationProposal { id:string; scope:string; kind:ConsolidationProposalKind; sourceRefs:string[]; metadata:{ candidate_count:number; task:string }; score:number; status:ConsolidationProposalStatus; expiresAt:number; createdAt:number; reviewedAt?:number; }
export interface ConsolidationMetrics { jobs:Record<string,number>; proposals:Record<string,number>; unsafe_promotions:0; }
export type ConsolidationAdoptionAction = "archive_duplicate_episodes" | "archive_stale_episode";
export interface ConsolidationAdoptionPreview { version:"consolidation-adoption-v1"; scope:string; proposalId:string; action:ConsolidationAdoptionAction; retainedRefs:string[]; archivedRefs:string[]; previewHash:string; confirmationRequired:true; }
export interface ConsolidationAdoptionReceipt extends Omit<ConsolidationAdoptionPreview,"confirmationRequired"> { adoptionId:string; adoptedAt:number; }

const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const jobKinds=new Set<ConsolidationJobKind>(["duplicate","conflict","stale","digest"]);

/** Local, deterministic shadow organizer. It writes only jobs/proposals, never graph, profile, recall, or evidence rows. */
export class ConsolidationService {
  constructor(private readonly db:DatabaseSyncInstance, private readonly now:()=>number=Date.now) {}
  schedule(scope:string): { scheduled:number; existing:number } {
    const safe=normalizeScope(scope), now=this.now(), revision=Number((this.db.prepare("SELECT value FROM kg_graph_state WHERE key='content_revision'").get() as {value?:unknown})?.value??0);
    const signals:Record<ConsolidationJobKind,string>={
      duplicate:this.signal(safe,"duplicate","SELECT id FROM mnemora_episodes WHERE scope=? AND status='active' AND deleted_at IS NULL ORDER BY id LIMIT 200",revision),
      conflict:this.signal(safe,"conflict","SELECT id FROM kg_conflict_candidates WHERE scope=? AND status='pending' ORDER BY id LIMIT 200",revision),
      stale:this.signal(safe,"stale","SELECT id FROM mnemora_episodes WHERE scope=? AND status='active' AND deleted_at IS NULL ORDER BY recorded_at,id LIMIT 200",revision),
      digest:this.signal(safe,"digest","SELECT id FROM mnemora_conversation_events WHERE scope=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 50",revision)
    };
    let scheduled=0,existing=0; this.db.exec("BEGIN IMMEDIATE");
    try { this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(safe,now,now); const insert=this.db.prepare("INSERT OR IGNORE INTO mnemora_consolidation_jobs(id,scope,kind,input_hash,status,created_at,updated_at) VALUES(?,?,?,?, 'queued',?,?)"); for(const kind of Object.keys(signals) as ConsolidationJobKind[]){const result=insert.run(randomUUID(),safe,kind,signals[kind],now,now) as {changes?:unknown};if(Number(result.changes)===1)scheduled++;else existing++;}this.db.exec("COMMIT"); } catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
    return {scheduled,existing};
  }
  run(input:{scope:string;maxJobs?:number;leaseMs?:number;proposalTtlDays?:number;staleAfterDays?:number;signal?:AbortSignal}): { claimed:number; proposed:number; empty:number; reclaimed:number } {
    const scope=normalizeScope(input.scope), max=Math.min(20,Math.max(1,Math.trunc(input.maxJobs??4))), lease=Math.min(300000,Math.max(5000,Math.trunc(input.leaseMs??45000))), ttl=Math.min(90,Math.max(1,Math.trunc(input.proposalTtlDays??14)))*86400000, stale=Math.min(3650,Math.max(1,Math.trunc(input.staleAfterDays??90)))*86400000; let claimed=0,proposed=0,empty=0,reclaimed=0;
    for(let index=0;index<max;index++){ if(input.signal?.aborted)throw input.signal.reason??new Error("aborted"); const claimedJob=this.claim(scope,lease); if(!claimedJob)break; claimed++; reclaimed+=claimedJob.reclaimed?1:0; try { const count=this.propose(scope,claimedJob.kind,ttl,stale); proposed+=count; if(!count)empty++; this.finish(claimedJob.id,"succeeded"); } catch { this.finish(claimedJob.id,"failed","operation_failed"); } }
    return {claimed,proposed,empty,reclaimed};
  }
  proposals(scope:string, status?:ConsolidationProposalStatus, limit=50): ConsolidationProposal[] { const safe=normalizeScope(scope), take=Math.min(100,Math.max(1,Math.trunc(limit))); const rows=this.db.prepare(`SELECT * FROM mnemora_consolidation_proposals WHERE scope=? ${status?"AND status=?":""} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...(status?[safe,status,take]:[safe,take])) as Array<Record<string,unknown>>;return rows.map(row=>this.proposal(row)); }
  review(scope:string,id:string,status:"approved"|"rejected"): ConsolidationProposal { const safe=normalizeScope(scope), now=this.now(); const result=this.db.prepare("UPDATE mnemora_consolidation_proposals SET status=?,reviewed_at=? WHERE id=? AND scope=? AND status='proposed'").run(status,now,id,safe) as {changes?:unknown};if(Number(result.changes)!==1)throw new Error("invalid_consolidation_review");const proposal=this.db.prepare("SELECT * FROM mnemora_consolidation_proposals WHERE id=? AND scope=?").get(id,safe) as Record<string,unknown>|undefined;if(!proposal)throw new Error("invalid_consolidation_review");return this.proposal(proposal); }
  /** Preview a narrow, reversible lifecycle action. Evidence rows and episode
   * source edges are retained; conflict and digest proposals intentionally
   * have no adoption action. */
  previewAdoption(scope:string,id:string): ConsolidationAdoptionPreview { return this.adoptionPreview(normalizeScope(scope),id); }
  adopt(input:{scope:string;id:string;previewHash:string}): ConsolidationAdoptionReceipt {
    const scope=normalizeScope(input.scope), now=this.now(); this.db.exec("BEGIN IMMEDIATE");
    try {
      const preview=this.adoptionPreview(scope,input.id);
      if (input.previewHash !== preview.previewHash) throw new Error("stale_consolidation_preview");
      const proposal=this.proposalRow(scope,input.id);
      const targetIds=preview.archivedRefs.map(value=>authorizeMnemoraContextRef(value,{scope,kinds:["episode"]}).id);
      const changed=targetIds.length ? this.db.prepare(`UPDATE mnemora_episodes SET status='archived',archived_at=?,superseded_by=NULL WHERE scope=? AND status='active' AND deleted_at IS NULL AND id IN (${targetIds.map(()=>"?").join(",")})`).run(now,scope,...targetIds) as {changes?:unknown} : {changes:0};
      if (Number(changed.changes)!==targetIds.length) throw new Error("stale_consolidation_preview");
      const reviewed=this.db.prepare("UPDATE mnemora_consolidation_proposals SET status='approved',reviewed_at=? WHERE id=? AND scope=? AND status='proposed'").run(now,input.id,scope) as {changes?:unknown};
      if (Number(reviewed.changes)!==1) throw new Error("stale_consolidation_preview");
      const adoptionId=randomUUID();
      this.db.prepare("INSERT INTO mnemora_consolidation_adoptions(id,scope,proposal_id,action,retained_refs,archived_refs,preview_hash,adopted_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(adoptionId,scope,input.id,preview.action,JSON.stringify(preview.retainedRefs),JSON.stringify(preview.archivedRefs),preview.previewHash,now);
      this.db.exec("COMMIT");
      return { ...preview, adoptionId, adoptedAt:now };
    } catch(error) { try{this.db.exec("ROLLBACK");}catch{}throw error; }
  }
  expire(scope:string): number { const result=this.db.prepare("UPDATE mnemora_consolidation_proposals SET status='expired' WHERE scope=? AND status='proposed' AND expires_at<=?").run(normalizeScope(scope),this.now()) as {changes?:unknown};return Number(result.changes??0); }
  reclaimStale(scope:string): number { const now=this.now(),result=this.db.prepare("UPDATE mnemora_consolidation_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,error_code='stale_lease',updated_at=? WHERE scope=? AND status='running' AND lease_expires_at<=?").run(now,normalizeScope(scope),now) as {changes?:unknown};return Number(result.changes??0); }
  metrics(scope:string): ConsolidationMetrics { const safe=normalizeScope(scope), counts=(table:string,column:string)=>Object.fromEntries((this.db.prepare(`SELECT ${column} AS key,COUNT(*) AS count FROM ${table} WHERE scope=? GROUP BY ${column}`).all(safe) as Array<{key:string;count:number}>).map(row=>[row.key,Number(row.count)]));return {jobs:counts("mnemora_consolidation_jobs","status"),proposals:counts("mnemora_consolidation_proposals","status"),unsafe_promotions:0}; }
  private signal(scope:string,kind:ConsolidationJobKind,sql:string,revision:number):string { const rows=this.db.prepare(sql).all(scope) as Array<{id:string}>;return hash({scope,kind,revision,ids:rows.map(row=>row.id),day:Math.floor(this.now()/86400000)}); }
  private claim(scope:string,leaseMs:number): {id:string;kind:ConsolidationJobKind;reclaimed:boolean}|undefined { const now=this.now(),owner=randomUUID();this.db.exec("BEGIN IMMEDIATE");try { const row=this.db.prepare("SELECT id,kind,status FROM mnemora_consolidation_jobs WHERE scope=? AND (status='queued' OR (status='running' AND lease_expires_at<=?)) ORDER BY created_at,id LIMIT 1").get(scope,now) as {id:string;kind:ConsolidationJobKind;status:string}|undefined;if(!row){this.db.exec("COMMIT");return;}this.db.prepare("UPDATE mnemora_consolidation_jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_expires_at=?,updated_at=?,error_code=NULL WHERE id=?").run(owner,now+leaseMs,now,row.id);this.db.exec("COMMIT");return {id:row.id,kind:row.kind,reclaimed:row.status==='running'};}catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;} }
  private finish(id:string,status:"succeeded"|"failed",error?:string):void { const now=this.now();this.db.prepare("UPDATE mnemora_consolidation_jobs SET status=?,lease_owner=NULL,lease_expires_at=NULL,error_code=?,updated_at=?,finished_at=? WHERE id=? AND status='running'").run(status,error??null,now,now,id); }
  private propose(scope:string,kind:ConsolidationJobKind,ttl:number,staleMs:number):number { const now=this.now();let proposals:Array<{kind:ConsolidationProposalKind;refs:string[];score:number;count:number;staleBefore?:number}>=[];
    if(kind==='duplicate'){const rows=this.db.prepare("SELECT group_concat(id) AS ids,COUNT(*) AS count FROM mnemora_episodes WHERE scope=? AND status='active' AND deleted_at IS NULL GROUP BY lower(trim(summary)) HAVING COUNT(*)>1 ORDER BY count DESC LIMIT 10").all(scope) as Array<{ids:string;count:number}>;proposals=rows.map(row=>({kind:"duplicate_episode",refs:row.ids.split(",").slice(0,5).map(id=>createMnemoraContextRef({scope,kind:"episode",id})),score:Math.min(1,Number(row.count)/5),count:Number(row.count)}));}
    if(kind==='conflict'){const rows=this.db.prepare("SELECT id FROM kg_conflict_candidates WHERE scope=? AND status='pending' ORDER BY updated_at DESC,id LIMIT 20").all(scope) as Array<{id:string}>;proposals=rows.map(row=>({kind:"conflict_review",refs:[`conflict:${row.id}`],score:.7,count:1}));}
    if(kind==='stale'){const staleBefore=now-staleMs, rows=this.db.prepare("SELECT id FROM mnemora_episodes WHERE scope=? AND status='active' AND deleted_at IS NULL AND recorded_at<=? ORDER BY recorded_at,id LIMIT 20").all(scope,staleBefore) as Array<{id:string}>;proposals=rows.map(row=>({kind:"staleness_review",refs:[createMnemoraContextRef({scope,kind:"episode",id:row.id})],score:.5,count:1,staleBefore}));}
    if(kind==='digest'){const rows=this.db.prepare("SELECT id FROM mnemora_conversation_events WHERE scope=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 5").all(scope) as Array<{id:string}>;if(rows.length)proposals=[{kind:"session_digest",refs:rows.map(row=>createMnemoraContextRef({scope,kind:"conversation-event",id:row.id})),score:.25,count:rows.length}];}
    const insert=this.db.prepare("INSERT OR IGNORE INTO mnemora_consolidation_proposals(id,scope,kind,proposal_hash,source_refs,metadata,score,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,'proposed',?,?)");let count=0;for(const proposal of proposals){const proposalHash=hash({scope,kind:proposal.kind,refs:[...proposal.refs].sort(),staleBefore:proposal.staleBefore??null});const result=insert.run(randomUUID(),scope,proposal.kind,proposalHash,JSON.stringify(proposal.refs),JSON.stringify({candidate_count:proposal.count,task:kind,...(proposal.staleBefore===undefined?{}:{stale_before:proposal.staleBefore})}),proposal.score,now+ttl,now) as {changes?:unknown};count+=Number(result.changes??0);}return count; }
  private proposal(row:Record<string,unknown>):ConsolidationProposal { const refs=parseStrings(row.source_refs),metadata=row.metadata&&typeof row.metadata==='string'?JSON.parse(row.metadata) as {candidate_count?:unknown;task?:unknown}:{};return {id:String(row.id),scope:String(row.scope),kind:row.kind as ConsolidationProposalKind,sourceRefs:refs,metadata:{candidate_count:Number(metadata.candidate_count??0),task:typeof metadata.task==='string'?metadata.task:"unknown"},score:Number(row.score),status:row.status as ConsolidationProposalStatus,expiresAt:Number(row.expires_at),createdAt:Number(row.created_at),...(row.reviewed_at?{reviewedAt:Number(row.reviewed_at)}:{})}; }
  private proposalRow(scope:string,id:string): Record<string,unknown> {
    const row=this.db.prepare("SELECT * FROM mnemora_consolidation_proposals WHERE id=? AND scope=? AND status='proposed' AND expires_at>?").get(id,scope,this.now()) as Record<string,unknown>|undefined;
    if (!row) throw new Error("invalid_consolidation_adoption");
    return row;
  }
  private adoptionPreview(scope:string,id:string): ConsolidationAdoptionPreview {
    const row=this.proposalRow(scope,id), proposal=this.proposal(row), episodeRefs=proposal.sourceRefs.flatMap(value=>{
      try { const parsed=authorizeMnemoraContextRef(value,{scope,kinds:["episode"]}); return [parsed]; } catch { return []; }
    });
    if (episodeRefs.length !== proposal.sourceRefs.length) throw new Error("unsupported_consolidation_adoption");
    const rows=episodeRefs.map(reference=>this.db.prepare("SELECT id,recorded_at FROM mnemora_episodes WHERE id=? AND scope=? AND status='active' AND deleted_at IS NULL").get(reference.id,scope) as {id:string;recorded_at:number}|undefined);
    if (rows.some(row=>!row)) throw new Error("stale_consolidation_preview");
    const episodes=rows as Array<{id:string;recorded_at:number}>;
    let action:ConsolidationAdoptionAction, retainedRefs:string[], archivedRefs:string[];
    if (proposal.kind==='duplicate_episode') {
      if (episodes.length<2) throw new Error("unsupported_consolidation_adoption");
      const ordered=episodes.sort((a,b)=>b.recorded_at-a.recorded_at||a.id.localeCompare(b.id));
      retainedRefs=[createMnemoraContextRef({scope,kind:"episode",id:ordered[0].id})]; archivedRefs=ordered.slice(1).map(item=>createMnemoraContextRef({scope,kind:"episode",id:item.id})); action="archive_duplicate_episodes";
    } else if (proposal.kind==='staleness_review') {
      const metadata=parseMetadata(row.metadata), staleBefore=metadata.stale_before;
      if (episodes.length!==1 || typeof staleBefore!=="number" || !Number.isSafeInteger(staleBefore) || episodes[0].recorded_at>staleBefore) throw new Error("stale_consolidation_preview");
      retainedRefs=[]; archivedRefs=[episodeRefs[0].canonical]; action="archive_stale_episode";
    } else throw new Error("unsupported_consolidation_adoption");
    const previewHash=hash({version:"consolidation-adoption-v1",scope,id,proposalHash:String(row.proposal_hash),action,retainedRefs,archivedRefs,expiresAt:proposal.expiresAt});
    return {version:"consolidation-adoption-v1",scope,proposalId:id,action,retainedRefs,archivedRefs,previewHash,confirmationRequired:true};
  }
}
function parseStrings(value:unknown):string[]{try{const parsed=typeof value==='string'?JSON.parse(value):[];return Array.isArray(parsed)?parsed.filter(item=>typeof item==='string').slice(0,20):[];}catch{return[];}}
function parseMetadata(value:unknown):{stale_before?:number}{try{const parsed=typeof value==='string'?JSON.parse(value):{};return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as {stale_before?:number}:{};}catch{return{};}}
