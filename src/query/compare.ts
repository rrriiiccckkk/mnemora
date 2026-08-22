import type { GraphologyStore, QueryGraphProjection } from "../store.js";
import type { KgCompareItem, KgCompareResult, ResolvedSubject } from "./types.js";
import { detectCommunities } from "../insights/community.js";
import { ResearchOperationError } from "./errors.js";

export interface CompareInput { left: string; right: string; max_depth?: number; confidence_min?: number; valid_from?: number; valid_to?: number; limit?: number; as_of?: number; max_response_bytes?: number; scope?: string; /** resolved by the service after optional semantic lookup */ left_id?: string; right_id?: string }
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;

function communities(p: QueryGraphProjection) {
  return detectCommunities({ nodes:p.nodes.map(n=>({id:n.id,name:n.name,type:n.type})), edges:p.edges.map(e=>({id:e.id,source:e.source,target:e.target,type:e.type,weight:e.confidence,confidence:e.confidence,evidenceCount:e.evidenceCount,sourceCount:e.sourceCount,firstSeenAt:e.firstSeenAt,lastSeenAt:e.lastSeenAt})), truncated:p.truncated,graphRevision:p.graphRevision,asOf:0 });
}
function resolve(p: QueryGraphProjection, text:string, side: "left" | "right"): ResolvedSubject {
  const q=String(text??"").trim(), partition=communities(p);
  if (q.startsWith("community:")) { const c=partition.communities.find(x=>x.id===q); if (!c) throw new ResearchOperationError({error_code:"COMPARE_SUBJECT_NOT_FOUND",retryable:true,details:{side,candidates:[],truncated:false}}); return {id:c.id,name:c.id,type:"community" as const,members:[...c.node_ids].sort(cmp)}; }
  const found=p.nodes.filter(n=>n.id===q||n.name.toLowerCase()===q.toLowerCase()||n.aliases.some(a=>a.toLowerCase()===q.toLowerCase())).sort((a,b)=>cmp(a.id,b.id));
  if(!found.length) throw new ResearchOperationError({error_code:"COMPARE_SUBJECT_NOT_FOUND",retryable:true,details:{side,candidates:[],truncated:false}});
  if(found.length>1) throw new ResearchOperationError({error_code:"COMPARE_SUBJECT_AMBIGUOUS",retryable:true,details:{side,candidates:found.slice(0,5).map(n=>({id:n.id,name:n.name,type:n.type,aliases:n.aliases.slice(0,10),match_reason:n.id===q?"id_exact":n.name.toLowerCase()===q.toLowerCase()?"name_exact":"alias_exact"})),truncated:found.length>5}});
  return {id:found[0].id,name:found[0].name,type:found[0].type,members:[found[0].id]};
}

export function compareSubjects(store: GraphologyStore, input: CompareInput): KgCompareResult {
  const asOf=Number.isFinite(input.as_of)?Math.trunc(input.as_of!):Date.now();
  const p=store.queryGraphProjection({maxNodes:10000,maxEdges:50000,asOf,scope:input.scope});
  const left=resolve(p,input.left_id ?? input.left,"left"), right=resolve(p,input.right_id ?? input.right,"right"); if(left.id===right.id) throw new ResearchOperationError({error_code:"COMPARE_SAME_SUBJECT",retryable:true,details:{}});
  const depth=Number.isFinite(input.max_depth)?Math.min(4,Math.max(1,Math.trunc(input.max_depth!))):1;
  const confidence=Number.isFinite(input.confidence_min)?Math.min(1,Math.max(0,input.confidence_min!)):0;
  const from=Number.isFinite(input.valid_from)?input.valid_from!:Number.MIN_SAFE_INTEGER,to=Number.isFinite(input.valid_to)?input.valid_to!:Number.MAX_SAFE_INTEGER;
  const edges=p.edges.filter(e=>e.confidence>=confidence&&(e.validTo==null||e.validTo>=Math.min(from,to))&&(e.validFrom==null||e.validFrom<=Math.max(from,to)));
  const collect=(seeds:readonly string[])=>{ let frontier=new Set(seeds), seen=new Set(seeds); const found=new Map<string,typeof edges>(); for(let d=0;d<depth;d++){const next=new Set<string>();for(const e of edges){const a=frontier.has(e.source),b=frontier.has(e.target);if(!a&&!b)continue;const id=a?e.target:e.source;if(!seeds.includes(id)){const list=found.get(id)??[];list.push(e);found.set(id,list);}if(!seen.has(id)){seen.add(id);next.add(id);}}frontier=next;}return found;};
  const l=collect(left.members),r=collect(right.members),nodeMap=new Map(p.nodes.map(n=>[n.id,n]));
  const item=(id:string, rows:typeof edges):KgCompareItem=>{const unique=[...new Map(rows.map(edge=>[edge.id,edge])).values()];return {entity_id:id,name:nodeMap.get(id)?.name??id,relationship_types:[...new Set(unique.map(e=>e.type))].sort(cmp),relationship_ids:unique.map(e=>e.id).sort(cmp),evidence_count:unique.reduce((n,e)=>n+e.evidenceCount,0),source_count:unique.reduce((n,e)=>n+e.sourceCount,0),average_confidence:unique.length?unique.reduce((n,e)=>n+e.confidence,0)/unique.length:0};};
  const shared=[...l.keys()].filter(id=>r.has(id)).sort(cmp).map(id=>item(id,[...l.get(id)!,...r.get(id)!]));
  const only_left=[...l.keys()].filter(id=>!r.has(id)).sort(cmp).map(id=>item(id,l.get(id)!)),only_right=[...r.keys()].filter(id=>!l.has(id)).sort(cmp).map(id=>item(id,r.get(id)!));
  const limit=Number.isFinite(input.limit)?Math.min(50,Math.max(1,Math.trunc(input.limit!))):20,maxBytes=Number.isFinite(input.max_response_bytes)?Math.min(1048576,Math.max(512,Math.trunc(input.max_response_bytes!))):1048576;
  let truncated=p.truncated; while(shared.length+only_left.length+only_right.length>limit){truncated=true;(only_right.length?only_right:only_left.length?only_left:shared).pop();}
  const result:KgCompareResult={subjects:[left,right].map(x=>({id:x.id,name:x.name,type:x.type,member_count:x.members.length})),shared,only_left,only_right,graph_revision:p.graphRevision,truncated,warnings:p.truncated?[{category:"projection_truncated"}]:[]};
  while(Buffer.byteLength(JSON.stringify(result))>maxBytes&&(result.only_right.length||result.only_left.length||result.shared.length)){result.truncated=true;(result.only_right.length?result.only_right:result.only_left.length?result.only_left:result.shared).pop();}
  if(Buffer.byteLength(JSON.stringify(result))>maxBytes) throw new ResearchOperationError({error_code:"COMPARE_LIMIT_EXCEEDED",retryable:false,details:{limit:maxBytes}}); return result;
}
