import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

test("Inspector build emits a local hashed manifest without CDN or source maps",()=>{
  const manifest=JSON.parse(readFileSync("dist/inspector/asset-manifest.json","utf8"));
  assert.match(manifest.app,/^assets\/app\.[a-f0-9]{12}\.js$/);assert.match(manifest.styles,/^assets\/styles\.[a-f0-9]{12}\.css$/);
  assert.equal(existsSync(`dist/inspector/${manifest.app}`),true);assert.equal(existsSync(`dist/inspector/${manifest.styles}`),true);
  const html=readFileSync("dist/inspector/index.html","utf8"),bundle=readFileSync(`dist/inspector/${manifest.app}`,"utf8");
  assert.doesNotMatch(html+bundle,/https?:\/\/|sourceMappingURL|<script[^>]*>\s*[^<]/i);assert.match(html,new RegExp(manifest.app.replaceAll(".","\\.")));
});

test("Inspector shell is accessible and operations navigation is hidden by default",()=>{
  const html=readFileSync("dist/inspector/index.html","utf8");
  for(const label of ["Overview","Graph","Entity","Research","Trust","Operations"])assert.match(html,new RegExp(`>${label}<`));
  assert.match(html,/data-view="operations"[^>]*hidden/);assert.match(html,/aria-label="Inspector navigation"/);assert.match(html,/id="graph-canvas"/);
});
