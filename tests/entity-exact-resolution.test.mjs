import test from "node:test";
import assert from "node:assert/strict";
import { GraphologyStore } from "../dist/store.js";

test("exact entity resolution is independent of graph size and id ordering", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const insert = store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
    store.db.exec("BEGIN");
    for (let index=0;index<10001;index++) {
      const suffix=String(index).padStart(5,"0");
      insert.run(`company:a-${suffix}`,"company",`Company ${suffix}`,"","[]",0,1,1);
    }
    insert.run("company:z-target","company","Target Company","",JSON.stringify(["Target Alias"]),0,1,1);
    store.db.exec("COMMIT");
    assert.equal(store.resolveExactEntityId("Target Company"),"company:z-target");
    assert.equal(store.resolveExactEntityId("Target Alias"),"company:z-target");
    assert.equal(store.resolveExactEntityId("company:z-target"),"company:z-target");
  } finally { store.close(); }
});
