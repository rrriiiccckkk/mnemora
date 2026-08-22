import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("inspector benchmark uses exact production scale and remains offline and bounded",()=>{
  const source=readFileSync("scripts/benchmark-inspector.mjs","utf8"),pkg=JSON.parse(readFileSync("package.json","utf8"));
  assert.equal(pkg.scripts["benchmark:inspector"],"npm run build && node scripts/benchmark-inspector.mjs");
  assert.match(source,/InspectorService/);assert.match(source,/GraphologyStore/);
  assert.match(source,/NODE_COUNT\s*=\s*50_000/);assert.match(source,/EDGE_COUNT\s*=\s*200_000/);
  assert.match(source,/max_nodes:\s*5_000/);assert.match(source,/max_edges:\s*20_000/);
  for(const feature of ["pagination","filter","community","entity","timeline","serialization"])assert.match(source,new RegExp(feature));
  for(const metric of ["p50_ms","p95_ms","peak_rss_bytes","database_bytes"])assert.match(source,new RegExp(metric));
  assert.doesNotMatch(source,/fetch\s*\(|https?:\/\//i);
});
