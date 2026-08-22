import type { DatabaseSyncInstance } from "@photostructure/sqlite";

interface HealthStore { db: DatabaseSyncInstance; graphRevision(): number; }
export interface HealthReport {
  graph_revision: number;
  evidence: { current: number; stale: number; unverified: number; samples: Array<{ relationship_id: string; confidence: number; freshness: number; review_state: "current" | "stale" | "unverified" }> };
  automatic: { daily: Array<{ day: string; feature: "extract" | "recall"; succeeded: number; failed: number; running: number }> };
  suggestions: Array<{ code: "review_stale_evidence" | "verify_single_source" | "inspect_failed_automation"; count: number }>;
}
export class HealthService {
  private readonly now: () => number;
  constructor(private readonly options: { store: HealthStore; now?: () => number }) { this.now = options.now ?? Date.now; }
  report(): HealthReport {
    const now = this.now(), rows = this.options.store.db.prepare(`SELECT e.id,e.type,AVG(o.confidence) AS confidence,MAX(COALESCE(o.valid_from,o.created_at)) AS latest,
      COUNT(DISTINCT CASE WHEN typeof(o.source)='text' AND length(o.source)<=200 THEN o.source END) AS source_count,
      MAX(CASE WHEN o.valid_to IS NOT NULL AND o.valid_to<? THEN 1 ELSE 0 END) AS expired,
      MAX(CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END) AS conflicted
      FROM kg_edges e JOIN kg_observations o ON o.edge_id=e.id
      LEFT JOIN kg_conflict_candidates c ON c.status='pending' AND (c.edge_a=e.id OR c.edge_b=e.id)
      WHERE e.deleted_at IS NULL AND typeof(o.confidence) IN ('integer','real') AND o.confidence BETWEEN 0 AND 1
      GROUP BY e.id,e.type ORDER BY e.id LIMIT 101`).all(now) as Array<{ id:string;type:string;confidence:number;latest:number;source_count:number;expired:number;conflicted:number }>;
    let current=0,stale=0,unverified=0;
    const samples = rows.slice(0,100).map(row => { const windowDays = row.type === "related_to" ? 90 : 180, age = Math.max(0, now-Number(row.latest)), freshness = Math.exp(-Math.log(2)*age/(windowDays*86400000)); const state = row.expired || age>windowDays*86400000 ? "stale" : row.source_count<2 || row.conflicted ? "unverified" : "current"; if(state==="stale")stale++;else if(state==="unverified")unverified++;else current++; return { relationship_id:row.id,confidence:clamp(Number(row.confidence)),freshness:clamp(freshness),review_state:state } as const; });
    const daily = (this.options.store.db.prepare(`SELECT day,feature,SUM(succeeded) AS succeeded,SUM(failed) AS failed,SUM(running) AS running FROM (
      SELECT date(day*86400,'unixepoch') AS day,feature,SUM(CASE WHEN outcome='succeeded' THEN count ELSE 0 END) AS succeeded,SUM(CASE WHEN outcome='failed' THEN count ELSE 0 END) AS failed,0 AS running FROM kg_auto_metrics GROUP BY day,feature
      UNION ALL SELECT strftime('%Y-%m-%d',started_at/1000,'unixepoch'),feature,SUM(status='succeeded'),SUM(status='failed'),SUM(status='running') FROM kg_auto_runs r WHERE feature IN ('extract','recall') AND NOT EXISTS(SELECT 1 FROM kg_auto_metrics m WHERE m.feature=r.feature AND m.day=CAST(r.started_at/86400000 AS INTEGER)) GROUP BY CAST(started_at/86400000 AS INTEGER),feature
      ) GROUP BY day,feature ORDER BY day DESC,feature LIMIT 62`).all() as Array<Record<string,unknown>>)
      .map(row=>({day:String(row.day),feature:row.feature as "extract"|"recall",succeeded:n(row.succeeded),failed:n(row.failed),running:n(row.running)}));
    const failed = daily.reduce((sum,row)=>sum+row.failed,0), suggestions:HealthReport["suggestions"]=[];
    if(stale)suggestions.push({code:"review_stale_evidence",count:stale}); if(unverified)suggestions.push({code:"verify_single_source",count:unverified}); if(failed)suggestions.push({code:"inspect_failed_automation",count:failed});
    return {graph_revision:this.options.store.graphRevision(),evidence:{current,stale,unverified,samples},automatic:{daily},suggestions};
  }
}
function clamp(value:number):number{return Math.min(1,Math.max(0,Number.isFinite(value)?value:0));} function n(value:unknown):number{return Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):0;}
