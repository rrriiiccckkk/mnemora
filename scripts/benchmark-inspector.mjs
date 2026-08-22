import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GraphologyStore } from "../dist/store.js";
import { InspectorService } from "../dist/inspector/service.js";

const NODE_COUNT = 50_000;
const EDGE_COUNT = 200_000;
const NOW = Date.parse("2026-07-19T00:00:00.000Z");
const MAX_OPERATION_MS = 5_000;
const WATCHDOG_SLACK_MS = 1_000;
const FIXTURE_WATCHDOG_MS = 60_000;

if (process.argv.includes("--worker")) await runBenchmark();
else await runWithWatchdog();

async function runWithWatchdog() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let phase = "fixture setup", timedOut = false, pending = "";
  let timer = arm(FIXTURE_WATCHDOG_MS);
  const reset = (name, timeoutMs) => { phase = name; clearTimeout(timer); timer = arm(timeoutMs); };
  function arm(timeoutMs) {
    return setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
  }
  const inspect = (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const started = /^inspector benchmark: operation (.+) start$/.exec(line);
      if (started) reset(`operation ${started[1]}`, MAX_OPERATION_MS + WATCHDOG_SLACK_MS);
    }
  };
  child.stdout.on("data", chunk => process.stdout.write(chunk));
  child.stderr.on("data", chunk => { process.stderr.write(chunk); inspect(chunk); });
  await new Promise((resolve, reject) => child.once("error", reject).once("exit", (code, signal) => {
    clearTimeout(timer);
    if (timedOut) reject(new Error(`inspector benchmark watchdog exceeded during ${phase}`));
    else if (code === 0) resolve(undefined);
    else reject(new Error(`inspector benchmark worker failed (${signal ?? code ?? "unknown"})`));
  }));
}

async function runBenchmark() {
const directory = mkdtempSync(join(tmpdir(), "mnemora-inspector-benchmark-"));
const databasePath = join(directory, "graph.db");
let store;
let peakRss = process.memoryUsage().rss;
const samples = new Map();
const observeMemory = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
const percentile = (values, ratio) => values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*ratio)-1)];
const measure = async (name, operation, repetitions = 5) => {
  const values=[];let result;
  for(let index=0;index<repetitions;index++){console.error(`inspector benchmark: operation ${name} start`);const started=performance.now();result=await operation();const elapsed=performance.now()-started;assert.ok(Number.isFinite(elapsed)&&elapsed<MAX_OPERATION_MS,`${name} exceeded deadline`);values.push(elapsed);observeMemory();console.error(`inspector benchmark: operation ${name} complete`);}
  samples.set(name,values);return result;
};

try {
  store = new GraphologyStore(databasePath);
  store.db.exec("BEGIN IMMEDIATE");
  store.db.exec(`WITH RECURSIVE seq(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM seq WHERE i<${NODE_COUNT-1})
    INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at)
    SELECT printf('company:%05d',i),'company',printf('Benchmark Company %d',i),'',printf('["BC %d"]',i),(i%100)/100.0,${NOW}-i,${NOW} FROM seq`);
  store.db.exec(`WITH RECURSIVE seq(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM seq WHERE i<${EDGE_COUNT-1}), shaped AS (
      SELECT i,CAST(i/4 AS INTEGER) source,(i%4)+1 offset FROM seq), endpoints AS (
      SELECT i,source,(CAST(source/100 AS INTEGER)*100)+((source-(CAST(source/100 AS INTEGER)*100)+offset)%100) target FROM shaped)
    INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,created_at,updated_at)
    SELECT printf('edge:%06d',i),printf('company:%05d',source),printf('company:%05d',target),CASE i%4 WHEN 0 THEN 'supplies' WHEN 1 THEN 'uses' WHEN 2 THEN 'owns' ELSE 'related_to' END,'{}',.65+(i%4)*.1,${NOW}-i,${NOW} FROM endpoints`);
  store.db.exec(`WITH RECURSIVE seq(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM seq WHERE i<${EDGE_COUNT-1})
    INSERT INTO kg_observations(id,edge_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at)
    SELECT printf('observation:%06d',i),printf('edge:%06d',i),'{}',printf('benchmark:source:%d',i%8),'',.65+(i%4)*.1,${NOW-86_400_000},${NOW+86_400_000},1,${NOW}-(i%1000) FROM seq`);
  for(let index=0;index<150;index++)store.db.prepare("INSERT INTO kg_query_runs(id,plan_hash,normalized_plan,status,graph_revision,result_count,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?)").run(`query:${String(index).padStart(3,"0")}`,"a".repeat(64),'{"version":1,"steps":[{"op":"lookup","query":"benchmark","mode":"lexical"}]}',"succeeded",1,index%50,index%20,NOW-index);
  store.db.prepare("UPDATE kg_graph_state SET value=1,updated_at=? WHERE key='content_revision'").run(NOW);
  store.db.exec("COMMIT");
  console.error("inspector benchmark: fixture ready");
  const counts=store.db.prepare("SELECT (SELECT COUNT(*) FROM kg_nodes) nodes,(SELECT COUNT(*) FROM kg_edges) edges,(SELECT COUNT(*) FROM kg_observations) observations").get();
  assert.deepEqual({nodes:Number(counts.nodes),edges:Number(counts.edges),observations:Number(counts.observations)},{nodes:NODE_COUNT,edges:EDGE_COUNT,observations:EDGE_COUNT});
  const inspector = new InspectorService({store,now:()=>NOW});
  const overview = await measure("overview",()=>inspector.overview());
  console.error("inspector benchmark: overview complete");
  assert.equal(overview.nodes,NODE_COUNT);assert.equal(overview.edges,EDGE_COUNT);
  const graphRequest={kind:"graph",max_nodes:5_000,max_edges:20_000,max_response_bytes:4*1024*1024,deadline_ms:5_000};
  const firstPage = await measure("pagination",()=>inspector.graph(graphRequest),3);
  console.error("inspector benchmark: first page complete");
  assert.ok(firstPage.nodes.length<=5_000&&firstPage.edges.length<=20_000&&firstPage.next_cursor);
  const secondPage = await measure("pagination_next",()=>inspector.graph({...graphRequest,cursor:firstPage.next_cursor}),3);
  console.error("inspector benchmark: pagination complete");
  assert.notDeepEqual(secondPage.edges[0]?.id,firstPage.edges[0]?.id);
  const filtered = await measure("filter",()=>inspector.graph({...graphRequest,filters:{sources:["benchmark:source:1"],confidence_min:.7,node_types:["company"]}}),3);
  console.error("inspector benchmark: filter complete");
  assert.ok(filtered.edges.every(item=>item.confidence>=.7));
  const communityId=firstPage.nodes.find(item=>item.community_id)?.community_id;assert.ok(communityId);
  const community = await measure("community",()=>inspector.graph({...graphRequest,filters:{community_id:communityId}}),3);
  console.error("inspector benchmark: community complete");
  assert.ok(community.nodes.every(item=>item.community_id===communityId));
  const aliases = await measure("entity_aliases",()=>inspector.entity({kind:"entity",id:"company:00000",section:"aliases",limit:50}));
  assert.equal(aliases.kind,"entity");
  const evidence = await measure("entity_evidence",()=>inspector.entity({kind:"entity",id:"company:00000",section:"evidence",limit:50}));
  assert.equal(evidence.kind,"entity");assert.ok(evidence.evidence.length>0);
  const entity = await measure("entity_relationships",()=>inspector.entity({kind:"entity",id:"company:00000",section:"relationships",limit:50}));
  assert.equal(entity.kind,"entity");assert.ok(entity.relationships.length>0);
  const timeline = await measure("entity_timeline",()=>inspector.entity({kind:"entity",id:"company:00000",section:"timeline",limit:50}));
  assert.equal(timeline.kind,"entity");assert.ok(timeline.timeline.length>0);
  const research = await measure("research",()=>inspector.research({kind:"research",section:"history",limit:100}));
  assert.equal(research.items.length,100);assert.ok(research.next_cursor);
  const serialization = await measure("serialization",()=>JSON.stringify({firstPage,secondPage,filtered,community,entity,timeline,research}));
  assert.ok(Buffer.byteLength(serialization,"utf8")<=16*1024*1024);
  const metrics=Object.fromEntries([...samples].map(([name,values])=>[name,{p50_ms:Number(percentile(values,.5).toFixed(3)),p95_ms:Number(percentile(values,.95).toFixed(3))}]));
  const databaseBytes=statSync(databasePath).size;assert.ok(databaseBytes>0&&Number.isSafeInteger(databaseBytes));assert.ok(peakRss<1_500_000_000,"peak RSS exceeded 1.5 GB");
  console.log(JSON.stringify({fixture:{nodes:NODE_COUNT,edges:EDGE_COUNT,observations:EDGE_COUNT},limits:{max_nodes:5_000,max_edges:20_000,deadline_ms:MAX_OPERATION_MS},metrics,peak_rss_bytes:peakRss,database_bytes:databaseBytes}));
} finally {
  try{store?.close();}catch{}
  try{rmSync(directory,{recursive:true,force:true});}catch{}
}
}
