import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ConversationEventRepository, Mnemora, createInspectorApplication, startInspector } from "../dist/index.js";

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

test("graph view renders parallel relationships between the same two entities without client failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-browser-parallel-")), graph = new Mnemora({ config: { dbPath: ":memory:" } });
  graph.store.ingest(
    [
      { name: "Alpha", type: "company", confidence: .9, evidence_span: "Alpha depends on and is part of Beta." },
      { name: "Beta", type: "company", confidence: .9, evidence_span: "Alpha depends on and is part of Beta." }
    ],
    [
      { source: "Alpha", target: "Beta", type: "depends_on", confidence: .9, evidence_span: "Alpha depends on Beta." },
      { source: "Alpha", target: "Beta", type: "part_of", confidence: .9, evidence_span: "Alpha is part of Beta." }
    ],
    "fixture:browser-parallel-graph", 0, { edgeMinConfidence: 0, relatedToMinConfidence: .85, edgeTypeMinConfidence: {} }, "default"
  );
  const application = createInspectorApplication({ graph, allowOperations: false, artifactDirectory: directory }), running = await startInspector({ graph: application, allowOperations: false }), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(running.url); await page.waitForSelector("#overview-cards .card");
    await page.locator('button[data-view="graph"]').click(); await page.waitForSelector("#graph-canvas canvas");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await running.close(); graph.close(); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("memory workbench lists available scopes and switches its read-only view", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-browser-workbench-")), graph = new Mnemora({ config: { dbPath: ":memory:", scope: { default: "project:alpha" } } });
  graph.store.ingest(
    [{ name: "Alpha memory", type: "company", confidence: .9, evidence_span: "An alpha-scoped memory." }], [],
    "fixture:workbench-alpha", 0, { edgeMinConfidence: 0, relatedToMinConfidence: .85, edgeTypeMinConfidence: {} }, "project:alpha"
  );
  graph.store.ingest(
    [{ name: "Beta memory", type: "company", confidence: .9, evidence_span: "A beta-scoped memory." }], [],
    "fixture:workbench-beta", 0, { edgeMinConfidence: 0, relatedToMinConfidence: .85, edgeTypeMinConfidence: {} }, "project:beta"
  );
  const application = createInspectorApplication({ graph, allowOperations: false, artifactDirectory: directory }), running = await startInspector({ graph: application, allowOperations: false }), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(running.url); await page.waitForSelector("#overview-cards .card");
    await page.locator('button[data-view="memory"]').click(); await page.locator('#memory-workbench[data-scope="project:alpha"]').waitFor();
    assert.deepEqual((await page.locator("#memory-scope option").allTextContents()).sort(), ["default", "project:alpha", "project:beta"]);
    await page.locator("#memory-scope").selectOption("project:beta"); await page.locator('#memory-workbench[data-scope="project:beta"]').waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await running.close(); graph.close(); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("recall explanation distinguishes a policy trace from a matching ContextEngine attachment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-browser-recall-explain-")), graph = new Mnemora({ config: { dbPath: ":memory:", unifiedRetrieval: { enabled: true, shadowMode: true, tokenBudget: 240, maxItems: 2, minConfidence: .5 } } });
  graph.store.ingest(
    [{ name: "Acme", type: "company", confidence: .9, evidence_span: "Acme is in the project memory." }], [],
    "fixture:recall-explain", 0, { edgeMinConfidence: 0, relatedToMinConfidence: .85, edgeTypeMinConfidence: {} }, "default"
  );
  graph.unifiedRecallShadow.record({ scope: "default", query: "Where is Acme?", localCandidates: 1, localSelected: 1, localSuppressed: 0, graphCandidates: 1, graphAttached: true, attached: true });
  const application = createInspectorApplication({ graph, allowOperations: false, artifactDirectory: directory }), running = await startInspector({ graph: application, allowOperations: false }), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(running.url); await page.waitForSelector("#overview-cards .card");
    await page.locator('button[data-view="intelligence"]').click();
    await page.locator('#intelligence-form input[name="value"]').fill("Where is Acme?");
    await page.locator("#intelligence-form").evaluate(form => form.requestSubmit());
    await page.locator(".actual-attachment").waitFor();
    assert.match(await page.locator(".actual-attachment").textContent(), /attached memory/i);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await running.close(); graph.close(); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("memory correction previews impact before a browser confirmation removes the selected event", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-browser-correction-")), graph = new Mnemora({ config: { dbPath: ":memory:" } });
  const event = new ConversationEventRepository(graph.store.db, { maxInlineChars: 16_000, maxEventBytes: 262_144, sensitiveContentPolicy: "redact" }).append({ scope: "default", sessionId: "correction", kind: "user_message", role: "user", parts: [{ type: "text", text: "Remove this browser correction marker." }] });
  const application = createInspectorApplication({ graph, allowOperations: true, artifactDirectory: directory }), running = await startInspector({ graph: application, allowOperations: true }), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(running.url); await page.waitForSelector("#overview-cards .card");
    await page.locator('button[data-view="memory"]').click();
    await page.locator('button[data-correct-kind="event"]').click();
    await page.locator("#memory-correction:not([hidden])").waitFor();
    await page.waitForFunction(() => document.querySelector("#memory-correction-copy")?.textContent?.includes("Review the affected memory"));
    assert.equal(await page.locator("#confirm-memory-correction").isEnabled(), true);
    await page.locator("#confirm-memory-correction").click();
    await page.waitForFunction(() => document.querySelector("#memory-correction-copy")?.textContent?.includes("was removed from future recall"));
    assert.equal(graph.store.db.prepare("SELECT deleted_at FROM mnemora_conversation_events WHERE id=?").get(event.id).deleted_at === null, false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await running.close(); graph.close(); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("a known claim opens its scoped evidence trace directly from the memory browser", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-browser-claim-evidence-")), graph = new Mnemora({ config: { dbPath: ":memory:" } }), now = Date.now();
  graph.store.db.prepare("INSERT INTO kg_source_anchors(id,scope,provider,source_label,content_hash,captured_at,status) VALUES(?,?,?,?,?,?,?)").run("browser-anchor", "default", "local", "DO_NOT_SHOW_THIS_LABEL", "a".repeat(64), now, "available");
  graph.store.db.prepare("INSERT INTO kg_claim_verifications(id,claim_id,source_anchor_id,scope,status,verifier_kind,created_at) VALUES(?,?,?,?,?,?,?)").run("browser-verification", "browser-claim", "browser-anchor", "default", "verified", "human", now);
  const application = createInspectorApplication({ graph, allowOperations: false, artifactDirectory: directory }), running = await startInspector({ graph: application, allowOperations: false }), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(running.url); await page.waitForSelector("#overview-cards .card");
    await page.locator('button[data-view="memory"]').click();
    await page.locator('#memory-form select[name="section"]').selectOption("claims");
    await page.locator("#memory-form").evaluate(form => form.requestSubmit());
    await page.locator('button[data-claim-evidence="true"]').click();
    await page.locator("#intelligence:not([hidden])").waitFor();
    assert.equal(await page.locator('#intelligence-form select[name="view"]').inputValue(), "provenance");
    assert.equal(await page.locator('#intelligence-form input[name="value"]').inputValue(), "browser-claim");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await running.close(); graph.close(); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});
