import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Mnemora, GraphologyStore, WatchService } from "../dist/index.js";

const PLAN = query => ({ version: 1, steps: [{ op: "lookup", query, mode: "lexical" }], order_by: "name", limit: 10 });
const config = { query: { maxSteps: 8, maxDepth: 4, maxResults: 50, maxNodes: 100, maxEdges: 100, timeoutMs: 25, maxResponseBytes: 100000, auditRetentionDays: 30, maxWatches: 100, maxDigestWatches: 25 } };

function stores() {
  const root = join(process.cwd(), ".tmp"); mkdirSync(root, { recursive: true });
  const path = join(mkdtempSync(join(root, "watch-test-")), "kg.db");
  return [new GraphologyStore(path), new GraphologyStore(path)];
}

function service(store, overrides = {}) {
  return new WatchService({ store, config, now: overrides.now ?? (() => 1000), timeoutMs: overrides.timeoutMs ?? 25,
    execute: overrides.execute ?? (async plan => ({ entities: [{ id: `entity:${plan.steps[0].query}` }], relationships: [{ id: "edge:1" }], warnings: [], insights: [{ id: "insight:1" }] })) });
}

function node(store, id, name = id) {
  if (store.getNodeById(id)) return;
  store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run(id,"company",name,"","[]",0,1,1);
}
function create(watches, store, input) {
  const key = input.plan.steps[0].query; const id = key.includes(":") ? key : `company:${key}`;
  node(store, id, key); return watches.create({ ...input, plan: PLAN(key) });
}

test("watch CRUD accepts only closed inputs and stores normalized plans without raw questions", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const watches = service(store);
    assert.throws(() => watches.create({ name: "x", plan: PLAN("x"), schedule_hint: "hourly" }), /invalid watch/);
    assert.throws(() => watches.create({ name: "x", plan: PLAN("x"), schedule_hint: "daily", extra: true }), /invalid watch/);
    node(store, "company:apple", "Apple");
    assert.throws(() => watches.create({ id: "Bearer SECRET", name: "x", plan: PLAN("Apple"), schedule_hint: "daily" }), /invalid watch/);
    const created = watches.create({ name: " Suppliers ", question: "RAW SECRET QUESTION", plan: { ...PLAN(" Apple "), limit: 999 }, schedule_hint: "daily" });
    assert.match(created.id, /^watch:/);
    assert.equal(created.name, "Suppliers");
    assert.equal(created.plan.steps[0].query, "company:apple");
    assert.equal(created.plan.limit, 50);
    assert.equal(created.enabled, true);
    assert.equal(created.cursor, null);
    assert.doesNotMatch(JSON.stringify(store.db.prepare("SELECT * FROM kg_watches").all()), /RAW SECRET QUESTION/);
    const updated = watches.update(created.id, { schedule_hint: "weekly", enabled: false });
    assert.equal(updated.schedule_hint, "weekly"); assert.equal(updated.enabled, false);
    assert.throws(() => watches.update(created.id, { cursor: 3 }), /invalid watch/);
    assert.equal(watches.list(500).length, 1);
    assert.equal(watches.remove(created.id), true);
    assert.equal(watches.remove(created.id), false);
  } finally { store.close(); }
});

test("watch ids are unique and stable, listing is bounded, and at most 100 watches exist", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const watches = service(store);
    const ids = [];
    for (let i = 0; i < 100; i++) ids.push(create(watches, store, { name: `w${i}`, plan: PLAN(`${i}`), schedule_hint: i % 2 ? "manual" : "daily" }).id);
    assert.equal(new Set(ids).size, 100);
    assert.deepEqual(watches.list(100).map(x => x.id).sort(), [...ids].sort());
    assert.equal(watches.list(1000).length, 100);
    node(store,"company:x","x"); assert.throws(() => watches.create({ name: "overflow", plan: PLAN("x"), schedule_hint: "weekly" }), /watch limit/);
  } finally { store.close(); }
});

test("same idempotency key executes once and advances only successful cursors", async () => {
  const store = new GraphologyStore(":memory:"); const executions = new Map(); let now = 1000;
  try {
    const watches = service(store, { now: () => now, execute: async (_plan, run) => { const id = run.watchId; executions.set(id, (executions.get(id) ?? 0) + 1); if (id === "fail") throw new Error("SECRET provider body"); return { entities: [{ id: "entity:ok", evidence: "SECRET" }], relationships: [], warnings: [{ category: "truncated", narrative: "SECRET" }], insights: [{ id: "insight:ok", narrative: "SECRET" }] }; } });
    const ok = create(watches, store, { id: "ok", name: "ok", plan: PLAN("ok"), schedule_hint: "manual" });
    const fail = create(watches, store, { id: "fail", name: "fail", plan: PLAN("fail"), schedule_hint: "manual" });
    const first = await watches.digest({ idempotencyKey: "weekly:2026-07-20", watchIds: [ok.id, fail.id] });
    const retry = await watches.digest({ idempotencyKey: "weekly:2026-07-20", watchIds: [ok.id, fail.id] });
    assert.deepEqual(retry, first); assert.equal(executions.get("ok"), 1); assert.equal(executions.get("fail"), 1);
    assert.equal(store.getWatch("ok").cursor, first.finished_at); assert.equal(store.getWatch("fail").cursor, null);
    const raw = JSON.stringify(store.db.prepare("SELECT * FROM kg_digest_runs").all());
    assert.doesNotMatch(raw, /SECRET|evidence|narrative/i);
    assert.deepEqual(first.watches[0].entity_ids, ["entity:ok"]); assert.deepEqual(first.watches[0].insight_ids, ["insight:ok"]);
  } finally { store.close(); }
});

test("digest claims are atomic across stores and stale running claims reclaim after ten minutes", async () => {
  const [a, b] = stores(); let release; const gate = new Promise(resolve => { release = resolve; }); let executions = 0;
  try {
    create(service(a), a, { id: "one", name: "one", plan: PLAN("one"), schedule_hint: "manual" });
    const first = service(a, { now: () => 1000, execute: async () => { executions++; await gate; return { entities: [], relationships: [], warnings: [], insights: [] }; } }).digest({ idempotencyKey: "atomic" });
    const competing = await service(b, { now: () => 1001, execute: async () => { executions++; return {}; } }).digest({ idempotencyKey: "atomic" });
    assert.equal(competing.status, "running"); assert.equal(executions, 1); release(); await first;
    a.db.prepare("INSERT INTO kg_digest_runs(idempotency_key,status,watch_ids,started_at) VALUES('stale','running','[\"one\"]',?)").run(1000);
    await service(b, { now: () => 601000, execute: async () => { executions++; return {}; } }).digest({ idempotencyKey: "stale" });
    assert.equal(executions, 2);
  } finally { a.close(); b.close(); }
});

test("digest caps at 25, skips disabled watches, isolates timeout/failure, and advances only successes", async () => {
  const store = new GraphologyStore(":memory:"); let now = 5000; const executed = [];
  try {
    const watches = service(store, { now: () => now, timeoutMs: 10, execute: async (_plan, run) => { const id = run.watchId; executed.push(id); if (id === "failure") throw new Error("boom"); if (id === "timeout") await new Promise(() => {}); return { entities: [{ id: `entity:${id}` }], relationships: [], warnings: [], insights: [] }; } });
    create(watches, store, { id: "disabled", name: "disabled", plan: PLAN("disabled"), schedule_hint: "daily", enabled: false });
    create(watches, store, { id: "failure", name: "failure", plan: PLAN("failure"), schedule_hint: "daily" });
    create(watches, store, { id: "timeout", name: "timeout", plan: PLAN("timeout"), schedule_hint: "daily" });
    for (let i = 0; i < 27; i++) create(watches, store, { id: `ok${String(i).padStart(2,"0")}`, name: `ok${i}`, plan: PLAN(`ok${i}`), schedule_hint: "daily" });
    const result = await watches.digest({ idempotencyKey: "bounded", watchIds: ["disabled", "failure", "timeout", ...Array.from({ length: 27 }, (_, i) => `ok${String(i).padStart(2,"0")}`)], limit: 999 });
    assert.equal(result.selected_count, 25); assert.equal(executed.includes("disabled"), false); assert.ok(result.warnings.some(x => x.category === "watch_limit"));
    assert.ok(result.watches.some(x => x.status === "failed")); assert.ok(result.watches.some(x => x.status === "timeout")); assert.ok(result.watches.some(x => x.status === "succeeded"));
    assert.equal(store.getWatch("failure").cursor, null); assert.equal(store.getWatch("timeout").cursor, null);
  } finally { store.close(); }
});

test("digest has fixed concurrency at most four, closed inputs, bounded ids, and creates no resident scheduler", async () => {
  const store = new GraphologyStore(":memory:"); let active = 0; let peak = 0;
  try {
    const watches = service(store, { timeoutMs: 1000, execute: async plan => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return { entities: Array.from({ length: 500 }, (_, i) => ({ id: `${plan.steps[0].query}:${i}` })), relationships: [], warnings: [], insights: [] }; } });
    for (let i = 0; i < 12; i++) create(watches, store, { id: `w${i}`, name: `w${i}`, plan: PLAN(`w${i}`), schedule_hint: "weekly" });
    await assert.rejects(watches.digest({ idempotencyKey: "x", extra: true }), /invalid digest/);
    const result = await watches.digest({ idempotencyKey: "concurrency" });
    assert.ok(peak <= 4); assert.ok(peak >= 1); assert.ok(result.watches.every(x => x.entity_ids.length <= 100));
    const source = readFileSync(join(process.cwd(), "src/query/watch.ts"), "utf8");
    assert.doesNotMatch(source, /setInterval\s*\(/);
  } finally { store.close(); }
});

test("watch persistence compiles exact names and aliases to canonical ids and rejects free text", () => {
  const store = new GraphologyStore(":memory:");
  try {
    node(store, "company:apple", "Apple");
    store.db.prepare("UPDATE kg_nodes SET aliases='[\"AAPL\"]' WHERE id='company:apple'").run();
    const watches = service(store);
    const created = watches.create({ name: "compiled", question: "RAW QUESTION", plan: { version: 1, steps: [{ op: "lookup", query: "AAPL" }, { op: "traverse", from: ["$previous", "Apple"], direction: "both", depth: 1 }], order_by: "name", limit: 5 }, schedule_hint: "manual" });
    assert.equal(created.plan.steps[0].query, "company:apple");
    assert.deepEqual(created.plan.steps[1].from, ["$previous", "company:apple"]);
    const raw = JSON.stringify(store.db.prepare("SELECT * FROM kg_watches").all());
    assert.doesNotMatch(raw, /RAW QUESTION|AAPL|Bearer|C:\\\\Users|\/home\/|EVIDENCE_SENTINEL/);
    for (const secret of ["Bearer secret", "C:\\Users\\rick\\secret", "/home/rick/secret", "EVIDENCE_SENTINEL"]) assert.throws(() => watches.create({ name: "bad", plan: PLAN(secret), schedule_hint: "manual" }), /invalid watch/);
  } finally { store.close(); }
});

test("requested watch ids are stable-deduped and contenders report stored claim time", async () => {
  const [a,b] = stores(); let release; const gate = new Promise(r => { release = r; }); const seen=[];
  try {
    const wa=service(a,{now:()=>1000,execute:async (_p,o)=>{seen.push(o.watchId);await gate;return {};}});
    create(wa,a,{id:"one",name:"one",plan:PLAN("one"),schedule_hint:"manual"}); create(wa,a,{id:"two",name:"two",plan:PLAN("two"),schedule_hint:"manual"});
    const pending=wa.digest({idempotencyKey:"dedupe",watchIds:["two","one","two","one"]});
    const contender=await service(b,{now:()=>9000}).digest({idempotencyKey:"dedupe"});
    assert.equal(contender.started_at,1000); release(); await pending; assert.deepEqual(seen,["two","one"]);
  } finally {a.close();b.close();}
});

test("ignored aborts retain slots, never exceed four active executions, and digest terminates", async () => {
  const store=new GraphologyStore(":memory:"); let active=0,peak=0,started=0;
  try {
    const watches=service(store,{timeoutMs:5,execute:async()=>{started++;active++;peak=Math.max(peak,active);await new Promise(()=>{});}});
    for(let i=0;i<9;i++) create(watches,store,{id:`hang${i}`,name:`hang${i}`,plan:PLAN(`hang${i}`),schedule_hint:"manual"});
    const result=await watches.digest({idempotencyKey:"ignored"});
    assert.equal(started,4); assert.equal(peak,4); assert.equal(result.watches.length,9); assert.ok(result.watches.every(x=>x.status==="timeout"));
  } finally {store.close();}
});

test("lost stale claimant returns newer stored running state instead of its local result", async () => {
  const [a,b]=stores(); let releaseA,releaseB; const gateA=new Promise(r=>releaseA=r),gateB=new Promise(r=>releaseB=r);
  try {
    create(service(a),a,{id:"one",name:"one",plan:PLAN("one"),schedule_hint:"manual"});
    const old=service(a,{now:()=>1000,execute:async()=>{await gateA;return {entities:[{id:"company:one"}]};}}).digest({idempotencyKey:"lost"});
    const newer=service(b,{now:()=>601000,execute:async()=>{await gateB;return {};}}).digest({idempotencyKey:"lost"});
    releaseA(); const oldResult=await old; assert.equal(oldResult.status,"running"); assert.equal(oldResult.started_at,601000); assert.equal(oldResult.selected_count,1);
    releaseB(); await newer;
  } finally {a.close();b.close();}
});

test("summary strictly validates ids, warning categories and serialized byte ceiling", async () => {
  const store=new GraphologyStore(":memory:");
  try {
    const watches=service(store,{execute:async()=>({entities:[{id:"company:ok"},{id:"Bearer SECRET"},{id:`company:${"x".repeat(500)}`}],relationships:[{id:"edge:ok"}],insights:[{id:"insight:ok"},{id:"/home/secret"}],warnings:[{category:"provider SECRET body"},{category:"truncated"}]} )});
    create(watches,store,{id:"one",name:"one",plan:PLAN("one"),schedule_hint:"manual"});
    const result=await watches.digest({idempotencyKey:"sanitized"}); const raw=JSON.stringify(store.db.prepare("SELECT summary FROM kg_digest_runs").get());
    assert.deepEqual(result.watches[0].entity_ids,["company:ok"]); assert.deepEqual(result.watches[0].insight_ids,["insight:ok"]);
    assert.ok(Buffer.byteLength(raw)<=65536); assert.doesNotMatch(raw,/Bearer|SECRET|\/home|provider body/); assert.deepEqual(result.watches[0].warnings,[{category:"truncated"},{category:"unknown"}]);
  } finally {store.close();}
});

test("default digest executor filters by cursor and includes bounded insight ids", async () => {
  let now=100; const graph=new Mnemora({config:{dbPath:":memory:"},now:()=>now});
  try {
    node(graph.store,"company:apple","Apple"); graph.insights.analyze=async()=>({status:"ok",graph_revision:1,algorithm_version:"x",cache_hit:false,truncated:false,communities:[],insights:[{id:"insight:fixture"}],warnings:[]});
    graph.watches.create({id:"apple",name:"apple",plan:PLAN("Apple"),schedule_hint:"manual"});
    const first=await graph.watches.digest({idempotencyKey:"first"}); assert.deepEqual(first.watches[0].insight_ids,["insight:fixture"]); assert.deepEqual(first.watches[0].entity_ids,["company:apple"]);
    now=200; const second=await graph.watches.digest({idempotencyKey:"second"}); assert.deepEqual(second.watches[0].entity_ids,[]);
    graph.store.db.prepare("UPDATE kg_nodes SET updated_at=201 WHERE id='company:apple'").run(); now=202;
    const third=await graph.watches.digest({idempotencyKey:"third"}); assert.deepEqual(third.watches[0].entity_ids,["company:apple"]);
  } finally {graph.close();}
});
