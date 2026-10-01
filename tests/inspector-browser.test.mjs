import { createTempDir } from "./helpers/temp.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rmSync } from "node:fs";

import { join } from "node:path";
import { chromium } from "playwright";
import { ConversationEventRepository, EpisodeRepository, Mnemora, createInspectorApplication, startInspector } from "../dist/index.js";
import { TaskOutcomeService } from "../dist/cognition/outcomes.js";
import { createMnemoraContextRef } from "../dist/context/context-ref.js";
import { MemoryImpactService } from "../dist/correction/impact-service.js";

test("client bootstrap removes the secret fragment and keeps CSRF only in module memory",()=>{
  const manifest=JSON.parse(readFileSync("dist/inspector/asset-manifest.json","utf8")),bundle=readFileSync(`dist/inspector/${manifest.app}`,"utf8");
  assert.match(bundle,/replaceState/);assert.match(bundle,/x-csrf-token/i);assert.doesNotMatch(bundle,/localStorage|sessionStorage|document\.cookie/);
});

test("client imports Sigma and destroys the previous renderer before graph replacement",()=>{
  const manifest=JSON.parse(readFileSync("dist/inspector/asset-manifest.json","utf8")),bundle=readFileSync(`dist/inspector/${manifest.app}`,"utf8");
  assert.match(bundle,/kill\(\)/);assert.match(bundle,/community_color/);assert.match(bundle,/next_cursor/);assert.match(bundle,/community_id/);assert.match(bundle,/config_revision/);
});

test("operations UI is capability-gated and completes backup preview then confirmation",{timeout:120_000},async()=>{
  const directory=createTempDir("mnemora-browser-ops-"),graph=new Mnemora({config:{dbPath:join(directory,"memory.db")}}),application=createInspectorApplication({graph,allowOperations:true,artifactDirectory:directory,randomBytes:()=>Buffer.alloc(32,0xff)}),running=await startInspector({graph:application,allowOperations:true});
  const browser=await chromium.launch({headless:true});
  try{const page=await browser.newPage();await page.goto(running.url);await page.waitForSelector("#overview-cards .card");const operations=page.locator('button[data-view="operations"]');assert.equal(await operations.isVisible(),true);await operations.click();await page.locator("#operations:not([hidden])").waitFor();await page.locator('#operation-form select[name="operation"]').selectOption("backup");const previewResponse=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/operations/preview"&&response.request().method()==="POST",{timeout:30_000});await page.locator("#operation-form").evaluate(form=>form.requestSubmit());assert.equal((await previewResponse).ok(),true);await page.waitForFunction(()=>document.querySelector("#operation-result")?.textContent?.includes('"phase": "preview"'),undefined,{timeout:10_000});assert.equal(await page.locator("#confirm-operation").isEnabled(),true);const confirmResponse=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/operations/confirm"&&response.request().method()==="POST",{timeout:30_000});await page.locator("#confirm-operation").click();assert.equal((await confirmResponse).ok(),true);await page.waitForFunction(()=>document.querySelector("#operation-result")?.textContent?.includes('"confirmed": true'),undefined,{timeout:10_000});}
  finally{await browser.close();await running.close();graph.close();try{rmSync(directory,{recursive:true,force:true});}catch{}}
});

test("real browser bootstraps once, clears the fragment, and renders a non-empty graph without client failures",async()=>{
  const directory=createTempDir("mnemora-browser-"),graph=new Mnemora({config:{dbPath:":memory:"}});
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
  const directory = createTempDir("mnemora-browser-parallel-"), graph = new Mnemora({ config: { dbPath: ":memory:" } });
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
  const directory = createTempDir("mnemora-browser-workbench-"), graph = new Mnemora({ config: { dbPath: ":memory:", scope: { default: "project:alpha" } } });
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

test("task resume view submits an explicit read-only task query and renders its source-linked projection", async () => {
  const directory = createTempDir("mnemora-browser-task-resume-"), graph = new Mnemora({ config: { dbPath: ":memory:", scope: { default: "project:alpha" } } });
  const event = new ConversationEventRepository(graph.store.db, { maxInlineChars: 16_000, maxEventBytes: 262_144, sensitiveContentPolicy: "redact" }).append({ scope: "project:alpha", sessionId: "task-resume", kind: "user_message", role: "user", parts: [{ type: "text", text: "Resume the deployment migration." }] });
  const episode = new EpisodeRepository(graph.store.db).create({ scope: "project:alpha", kind: "task", title: "Deployment migration", summary: "Move deployment after the upstream merge.", sourceEventIds: [event.id], importance: .8, confidence: .9 });
  const taskRef = createMnemoraContextRef({ scope: "project:alpha", kind: "episode", id: episode.id }), eventRef = createMnemoraContextRef({ scope: "project:alpha", kind: "conversation-event", id: event.id });
  const outcomes = new TaskOutcomeService(graph.store.db, () => 1_700_000_000_000);
  for (let index = 0; index < 9; index++) {
    const input = { scope: "project:alpha", taskRef, verdict: "partial", impact: "neutral", summary: `Retained task record ${index + 1}.`, evidenceRefs: [eventRef] };
    outcomes.confirm(input, outcomes.preview(input).preview_hash);
  }
  const application = createInspectorApplication({ graph, allowOperations: false, artifactDirectory: directory }), running = await startInspector({ graph: application, allowOperations: false }), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(running.url); await page.waitForSelector("#overview-cards .card");
    await page.locator('button[data-view="task-resume"]').click();
    await page.locator('#task-resume-form input[name="query"]').fill("deployment migration");
    await page.locator("#task-resume-form").evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector("#task-resume-result")?.textContent?.includes("Deployment migration"));
    assert.match(await page.locator("#task-resume-result").textContent(), /Retained task record/);
    assert.match(await page.locator("#task-resume-result").textContent(), /Showing first 8 records; additional pending records are not shown/);
    assert.match(await page.locator(".resume-evidence").textContent(), /Readable task sourcesAvailable/);
    assert.match(await page.locator(".resume-evidence").textContent(), /Accepted current state in memoryAvailable/);
    assert.match(await page.locator("#task-resume-result").textContent(), /Recorded progress: in progress/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await running.close(); graph.close(); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("task resume shows memory coverage on candidates and selected tasks without promoting sources to confirmed state", async () => {
  const directory = createTempDir("mnemora-browser-task-coverage-"), graph = new Mnemora({ config: { dbPath: ":memory:", scope: { default: "project:alpha" } } });
  const policy = { maxInlineChars: 16_000, maxEventBytes: 262_144, sensitiveContentPolicy: "redact" };
  const createTask = (title, scope = "project:alpha", hashOnly = false) => {
    const event = new ConversationEventRepository(graph.store.db, { ...policy, ...(hashOnly ? { sensitiveContentPolicy: "hash_only" } : {}) }).append({ scope, sessionId: title, kind: "user_message", role: "user", parts: [{ type: "text", text: hashOnly ? "password=PRIVATE_SOURCE_DO_NOT_RENDER" : `${title}: source evidence remains readable.` }] });
    const episode = new EpisodeRepository(graph.store.db).create({ scope, kind: "task", title, summary: "Resume this rollout.", sourceEventIds: [event.id], importance: .8, confidence: .9 });
    return { event, taskRef: createMnemoraContextRef({ scope, kind: "episode", id: episode.id }) };
  };
  const gap = createTask("Unreviewed rollout");
  createTask("Hash-only rollout", "project:alpha", true);
  const acceptedOnly = createTask("Accepted-only rollout", "project:alpha", true);
  const evidence = new ConversationEventRepository(graph.store.db, policy).append({ scope: "project:alpha", sessionId: "accepted-evidence", kind: "user_message", role: "user", parts: [{ type: "text", text: "The rollout is partially complete." }] });
  const outcomes = new TaskOutcomeService(graph.store.db), input = { scope: "project:alpha", taskRef: acceptedOnly.taskRef, verdict: "partial", impact: "neutral", summary: "Confirmed partial rollout.", evidenceRefs: [createMnemoraContextRef({ scope: "project:alpha", kind: "conversation-event", id: evidence.id })] };
  outcomes.confirm(input, outcomes.preview(input).preview_hash);
  createTask("OTHER_SCOPE_DO_NOT_RENDER", "project:beta");
  const application = createInspectorApplication({ graph, allowOperations: false, artifactDirectory: directory }), running = await startInspector({ graph: application, allowOperations: false }), browser = await chromium.launch({ headless: true });
  const changeCount = () => graph.store.db.prepare("SELECT total_changes() AS value").get().value;
  try {
    const page = await browser.newPage(), errors = [], before = changeCount();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(running.url); await page.waitForSelector("#overview-cards .card");
    await page.locator('button[data-view="task-resume"]').click();
    await page.waitForFunction(() => document.querySelectorAll(".resume-evidence").length === 3);
    const candidate = title => page.locator(".resume-item").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
    assert.match(await candidate("Unreviewed rollout").textContent(), /Readable task sourcesAvailable/);
    assert.match(await candidate("Unreviewed rollout").textContent(), /Accepted current state in memoryNot available/);
    assert.match(await candidate("Unreviewed rollout").textContent(), /Memory coverage gap/);
    assert.match(await candidate("Hash-only rollout").textContent(), /Readable task sourcesUnavailable/);
    assert.match(await candidate("Hash-only rollout").textContent(), /Accepted current state in memoryNot available/);
    assert.doesNotMatch(await candidate("Hash-only rollout").textContent(), /Memory coverage gap|Inspect sources/);
    assert.match(await candidate("Accepted-only rollout").textContent(), /Accepted current state in memoryAvailable/);
    assert.match(await candidate("Accepted-only rollout").textContent(), /original sources are unavailable/);
    assert.doesNotMatch(await page.locator("#task-resume-result").textContent(), /PRIVATE_SOURCE_DO_NOT_RENDER|OTHER_SCOPE_DO_NOT_RENDER/);
    await candidate("Unreviewed rollout").getByRole("button", { name: "Resume this task" }).click();
    await page.getByRole("heading", { name: "Unreviewed rollout", exact: true, level: 3 }).waitFor();
    assert.match(await page.locator(".resume-evidence").textContent(), /Memory coverage gap/);
    assert.match(await page.locator("#task-resume-result").textContent(), /Recorded progress: needs reconfirmation/);
    assert.equal(changeCount(), before, "Reading candidates and selecting a task must not mutate memory.");

    const impact = new MemoryImpactService(graph.store.db), target = { scope: "project:alpha", kind: "event", id: gap.event.id }, preview = impact.preview(target);
    impact.forget({ ...target, previewHash: preview.previewHash, confirm: true });
    const afterForget = changeCount();
    const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/task-resume" && value.request().method() === "POST");
    await page.locator("#task-resume-form").evaluate(form => form.requestSubmit());
    await response;
    await page.waitForFunction(() => document.querySelector(".resume-evidence")?.textContent?.includes("Readable task sourcesUnavailable"));
    assert.doesNotMatch(await page.locator(".resume-evidence").textContent(), /Memory coverage gap|Inspect sources/);
    assert.equal(changeCount(), afterForget, "Re-reading forgotten evidence must remain read-only.");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await running.close(); graph.close(); try { rmSync(directory, { recursive: true, force: true }); } catch {} }
});

test("task resume source excerpts stay unverified, render as text and tolerate legacy responses", async () => {
  const directory = createTempDir("mnemora-browser-resume-excerpts-"), graph = new Mnemora({ config: { dbPath: ":memory:" } });
  const application = createInspectorApplication({ graph, allowOperations: false, artifactDirectory: directory }), running = await startInspector({ graph: application, allowOperations: false }), browser = await chromium.launch({ headless: true });
  const userText = '<img src="invalid" onerror="window.sourceExecuted=true"> Please finish the rollout.';
  const assistantText = "The rollout is complete.\nThis is only an assistant report.";
  const fixture = {
    kind: "task_resume", status: "needs_reconfirmation", scope: "default",
    task: { id: "excerpt-task", task_ref: "mnemora://v1/scope/default/episode/excerpt-task", title: "Excerpt-only rollout", goal: "Inspect original reports", progress: "needs_reconfirmation", memory_evidence: { source_available: true, accepted_current_state_available: false }, last_verified_at: null, last_evidence_at: 1700000000000, source_refs: [], artifact_refs: [] },
    completed: [], pending: [], blockers: [], constraints: [], next_steps: [], decisions: [], planned: [], history: [], needs_reconfirmation: [], truncated_sections: [], truncated: false,
    source_evidence: { authority: "unverified_source", items: [
      { source_ref: "mnemora://v1/scope/default/conversation-event/source-user", role: "user", created_at: 1700000000000, text: userText, truncated: false },
      { source_ref: "mnemora://v1/scope/default/conversation-event/source-assistant", role: "assistant", created_at: 1700000001000, text: assistantText, truncated: true }
    ], truncated: true }
  };
  try {
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let response = fixture;
    await page.route("**/api/task-resume", route => route.fulfill({ json: response }));
    await page.goto(running.url); await page.waitForSelector("#overview-cards .card");
    await page.locator('button[data-view="task-resume"]').click();
    const sources = page.getByRole("region", { name: "Unverified source excerpts" });
    await sources.waitFor({ timeout: 5000 });
    assert.match(await sources.textContent(), /Not confirmed.*not accepted task state or proof of completion/);
    const items = sources.locator("article");
    assert.equal(await items.count(), 2);
    assert.match(await items.nth(0).textContent(), /Role: User.*Not confirmed.*Excerpt: Not truncated/);
    assert.match(await items.nth(1).textContent(), /Role: Assistant.*Not confirmed.*Excerpt: Truncated/);
    assert.equal(await items.nth(0).locator("time").getAttribute("datetime"), "2023-11-14T22:13:20.000Z");
    assert.equal(await items.nth(1).locator("time").getAttribute("datetime"), "2023-11-14T22:13:21.000Z");
    assert.equal(await items.nth(0).locator(".resume-source-text").textContent(), userText);
    assert.equal(await items.nth(1).locator(".resume-source-text").textContent(), assistantText);
    assert.match(await sources.textContent(), /Source window: Truncated/);
    assert.match(await items.nth(0).textContent(), /conversation-event\/source-user/);
    assert.equal(await sources.locator("img").count(), 0);
    assert.equal(await page.evaluate(() => window.sourceExecuted), undefined);
    assert.match(await page.locator(".resume-columns").textContent(), /No accepted completed item/);
    assert.doesNotMatch(await page.locator(".resume-columns").textContent(), /The rollout is complete|Please finish the rollout/);
    assert.match(await page.locator(".resume-evidence").textContent(), /Accepted current state in memoryNot available/);
    const submit = async () => {
      await page.locator("#task-resume-form").evaluate(form => form.requestSubmit());
    };
    response = { ...fixture, source_evidence: { authority: "unverified_source", items: [-8640000000000001, 8640000000000001, "invalid-time"].map((created_at, index) => ({ ...fixture.source_evidence.items[0], source_ref: `mnemora://v1/scope/default/conversation-event/invalid-time-${index}`, created_at })), truncated: false } };
    await submit();
    await page.waitForFunction(() => document.querySelector(".resume-source-evidence")?.textContent?.includes("Recorded at: Unknown"), undefined, { timeout: 5000 });
    assert.equal(await sources.locator("article").count(), 3);
    assert.deepEqual(await sources.locator("time").allTextContents(), ["Unknown", "Unknown", "Unknown"]);
    assert.equal(await sources.locator("time[datetime]").count(), 0);
    assert.deepEqual(await sources.locator(".resume-source-text").allTextContents(), [userText, userText, userText]);
    assert.equal(await sources.locator("img").count(), 0);
    assert.deepEqual(errors, [], "Invalid source dates must not interrupt rendering.");
    response = { ...fixture, source_evidence: { authority: "unverified_source", items: [], truncated: false } };
    await submit();
    await page.waitForFunction(() => document.querySelector(".resume-source-evidence")?.textContent?.includes("No readable source excerpts available"));
    assert.equal(await sources.locator("article").count(), 0);
    assert.match(await sources.textContent(), /Source window: Not truncated/);
    const { source_evidence, ...legacy } = fixture;
    response = legacy;
    await submit();
    await page.waitForFunction(() => document.querySelector(".resume-source-evidence")?.textContent?.includes("Source excerpts were not provided by this response"));
    assert.equal(await sources.locator("article").count(), 0);
    assert.match(await page.locator("#task-resume-result").textContent(), /Recorded progress: needs reconfirmation/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await running.close(); graph.close(); }
});

test("recall explanation distinguishes a policy trace from a matching ContextEngine attachment", async () => {
  const directory = createTempDir("mnemora-browser-recall-explain-"), graph = new Mnemora({ config: { dbPath: ":memory:", unifiedRetrieval: { enabled: true, shadowMode: true, tokenBudget: 240, maxItems: 2, minConfidence: .5 } } });
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
  const directory = createTempDir("mnemora-browser-correction-"), graph = new Mnemora({ config: { dbPath: ":memory:" } });
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
  const directory = createTempDir("mnemora-browser-claim-evidence-"), graph = new Mnemora({ config: { dbPath: ":memory:" } }), now = Date.now();
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
