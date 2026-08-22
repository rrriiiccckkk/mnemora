import test from "node:test";
import assert from "node:assert/strict";
import { GraphologyStore } from "../dist/index.js";
import { HealthService } from "../dist/operations/health.js";

test("health separates immutable confidence from derived freshness and emits bounded report-only suggestions", () => {
  const store = new GraphologyStore(":memory:"), now = 1_700_000_000_000;
  try {
    const node = store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
    node.run("company:a","company","A","","[]",0,now,now); node.run("product:b","product","B","","[]",0,now,now);
    store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,created_at,updated_at) VALUES('edge:old','company:a','product:b','uses','{}',0,?,?)").run(now,now);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,payload,source,quote,confidence,created_at) VALUES('obs:old','edge:old','{}','report:one','',.9,?)").run(now-400*86400000);
    const report = new HealthService({ store, now: () => now }).report();
    assert.equal(report.evidence.samples[0].confidence, .9); assert.equal(report.evidence.samples[0].review_state, "stale");
    assert.equal(store.db.prepare("SELECT confidence FROM kg_observations WHERE id='obs:old'").get().confidence, .9);
    assert.ok(report.suggestions.length > 0); assert.equal("apply" in report, false);
    assert.doesNotMatch(JSON.stringify(report), /quote|payload|C:\\|credential|provider/i);
  } finally { store.close(); }
});

test("daily automatic metrics are aggregate-only and bounded", () => {
  const store = new GraphologyStore(":memory:"), now = 1_700_000_000_000;
  try {
    store.db.prepare("INSERT INTO kg_auto_runs(turn_key,feature,status,attempts,last_error,started_at,finished_at) VALUES('extract:SECRET','extract','failed',1,'provider body SECRET',?,?)").run(now-1,now);
    const report = new HealthService({ store, now: () => now }).report();
    assert.deepEqual(report.automatic.daily[0], { day: "2023-11-14", feature: "extract", succeeded: 0, failed: 1, running: 0 });
    assert.doesNotMatch(JSON.stringify(report.automatic), /SECRET|provider body/);
  } finally { store.close(); }
});
