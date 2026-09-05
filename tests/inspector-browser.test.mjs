import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Mnemora, createInspectorApplication, startInspector } from "../dist/index.js";

test("client bootstrap removes the secret fragment and keeps CSRF only in module memory",()=>{
  const manifest=JSON.parse(readFileSync("dist/inspector/asset-manifest.json","utf8")),bundle=readFileSync(`dist/inspector/${manifest.app}`,"utf8");
  assert.match(bundle,/replaceState/);assert.match(bundle,/x-csrf-token/i);assert.doesNotMatch(bundle,/localStorage|sessionStorage|document\.cookie/);
});

test("client imports Sigma and destroys the previous renderer before graph replacement",()=>{
  const manifest=JSON.parse(readFileSync("dist/inspector/asset-manifest.json","utf8")),bundle=readFileSync(`dist/inspector/${manifest.app}`,"utf8");
  assert.match(bundle,/kill\(\)/);assert.match(bundle,/community_color/);assert.match(bundle,/next_cursor/);assert.match(bundle,/community_id/);assert.match(bundle,/config_revision/);
});

test("operations UI is capability-gated and completes backup preview then confirmation",{timeout:120_000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),"mnemora-browser-ops-")),graph=new Mnemora({config:{dbPath:":memory:"}}),application=createInspectorApplication({graph,allowOperations:true,artifactDirectory:directory}),running=await startInspector({graph:application,allowOperations:true});
  const browser=await chromium.launch({headless:true});
  try{const page=await browser.newPage();await page.goto(running.url);await page.waitForSelector("#overview-cards .card");const operations=page.locator('button[data-view="operations"]');assert.equal(await operations.isVisible(),true);await operations.click();await page.locator("#operations:not([hidden])").waitFor();await page.locator('#operation-form select[name="operation"]').selectOption("backup");const previewResponse=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/operations/preview"&&response.request().method()==="POST",{timeout:30_000});await page.locator("#operation-form").evaluate(form=>form.requestSubmit());assert.equal((await previewResponse).ok(),true);await page.waitForFunction(()=>document.querySelector("#operation-result")?.textContent?.includes('"phase": "preview"'),undefined,{timeout:10_000});assert.equal(await page.locator("#confirm-operation").isEnabled(),true);const confirmResponse=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/operations/confirm"&&response.request().method()==="POST",{timeout:30_000});await page.locator("#confirm-operation").click();assert.equal((await confirmResponse).ok(),true);await page.waitForFunction(()=>document.querySelector("#operation-result")?.textContent?.includes('"confirmed": true'),undefined,{timeout:10_000});}
  finally{await browser.close();await running.close();graph.close();try{rmSync(directory,{recursive:true,force:true});}catch{}}
});

test("real browser bootstraps once, clears the fragment, and renders a non-empty graph without client failures",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"mnemora-browser-")),graph=new Mnemora({config:{dbPath:":memory:"}});
  graph.store.ingest(
    [{name:"Acme",type:"company",confidence:.9,evidence_span:"Acme relates to Widget."},{name:"Widget",type:"product",confidence:.9,evidence_span:"Acme relates to Widget."}],
    [{source:"Acme",target:"Widget",type:"related_to",confidence:.9,evidence_span:"Acme relates to Widget."}],
    "fixture:browser-graph",0,{edgeMinConfidence:0,relatedToMinConfidence:.85,edgeTypeMinConfidence:{}},"default"
  );
  const application=createInspectorApplication({graph,allowOperations:false,artifactDirectory:directory}),running=await startInspector({graph:application,allowOperations:false}),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto(running.url);await page.waitForSelector("#overview-cards .card");assert.equal(new URL(page.url()).hash,"");assert.equal(await page.locator('button[data-view="operations"]').isHidden(),true);
    await page.locator('button[data-view="graph"]').click();await page.waitForSelector("#graph-canvas canvas");
    assert.deepEqual(errors,[]);
    const storage=await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length,hash:location.hash}));assert.deepEqual(storage,{local:0,session:0,hash:""});
  } finally{await browser.close();await running.close();graph.close();try{rmSync(directory,{recursive:true,force:true});}catch{}}
});
