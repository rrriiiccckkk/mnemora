import test from "node:test";
import assert from "node:assert/strict";
import { GraphologyStore } from "../dist/store.js";
import { buildTimeline } from "../dist/query/timeline.js";

function fixture() {
  const store = new GraphologyStore(":memory:");
  const node = (id, name) => store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run(id,"company",name,"","[]",0,1,1);
  node("company:a", "Alpha"); node("company:b", "Beta");
  store.db.prepare("INSERT INTO kg_edges(id,source_id,target_id,type,edge_props,weight,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?)").run("edge:1","company:a","company:b","supplies","{}",1,1,1);
  const insert = store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  insert.run("obs:1","edge:1",null,"{\"private\":\"SECRET_PAYLOAD\"}","https://SECRET_URL","SECRET_QUOTE",.8,20,30,.7,10);
  insert.run("obs:2","edge:1",null,"{}","other","q",.9,20,30,.8,10);
  return store;
}

test("timeline distinguishes observation and inclusive validity times without event-time claims", () => {
  const store = fixture();
  try {
    const result = buildTimeline(store, { subject: "Alpha", from: 10, to: 30, limit: 50 });
    assert.deepEqual(result.events.map(x => [x.timestamp, x.kind]), [[10,"observed"],[20,"became_valid"],[30,"became_invalid"]]);
    assert.deepEqual(result.events[0].observation_ids, ["obs:1","obs:2"]);
    assert.deepEqual(result.events[0].relationship_ids, ["edge:1"]);
    assert.match(result.temporal_note, /not necessarily.*event time/i);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_PAYLOAD|SECRET_QUOTE|SECRET_URL/);
  } finally { store.close(); }
});

test("timeline normalizes reversed bounds, sorts stably, and caps at fifty", () => {
  const store = fixture();
  try {
    const result = buildTimeline(store, { subject: "company:a", from: 30, to: 10, limit: 999 });
    assert.ok(result.events.length <= 50);
    assert.deepEqual(result.range, { from: 10, to: 30, inclusive: true });
    assert.deepEqual(result.events, [...result.events].sort((a,b) => a.timestamp-b.timestamp || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)));
  } finally { store.close(); }
});
