import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { projectMeasurement } from "./project-measurement.mjs";
import { adviserPrompt, adviserAnswer } from "./project-adviser.mjs";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, appendFileSync, writeFileSync, symlinkSync, readFileSync, existsSync, openSync, closeSync, unlinkSync, statSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createPortServer } from "node:net";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Mnemora, ConversationEventRepository } from "../dist/index.js";
import { createTempDir, runInTempProcess } from "../tests/helpers/temp.mjs";
const measurementStarted = performance.now();
const measurementId = randomUUID();

const taskRecall = process.argv.includes("--task-recall");
const project = process.argv.includes("--project");
if (project && taskRecall) throw new Error("Task recall fixtures require an isolated host; persistent project mode is forbidden");
const projectStatus = project && process.argv.includes("--status");
let projectMessage;
if (project && !projectStatus) {
  const messageIndex = process.argv.indexOf("--message"), fileIndex = process.argv.indexOf("--file");
  if ((messageIndex >= 0) === (fileIndex >= 0)) throw new Error("Supply exactly one project message or file");
  if (fileIndex >= 0) {
    const path = process.argv[fileIndex + 1];
    if (!path || statSync(path).size > 48000) throw new Error("Project input file exceeds 48000 bytes");
    projectMessage = readFileSync(path, "utf8");
  } else projectMessage = process.argv[messageIndex + 1];
  if (!projectMessage?.trim() || projectMessage.length > 12000) throw new Error("Project message must contain 1–12000 characters");
}
const dogfood = project || process.argv.includes("--dogfood");
if (!project && !process.argv.includes("--worker")) {
  process.exit(await runInTempProcess([fileURLToPath(import.meta.url), "--worker", ...(dogfood ? ["--dogfood"] : []), ...(taskRecall ? ["--task-recall"] : [])]));
}
const taskMarker = taskRecall ? "RELEASE_TASK_42" : "OFG_CONFIG_ISOLATION";
const taskEvidence = taskRecall ? "CURRENT_COMMIT_42" : "构建校验只能读取测试专用空配置，禁止读取日常配置，禁止复制宿主凭据";
const firstMessage = taskRecall
  ? "继续 RELEASE_TASK_42，发布的最终提交与状态是什么？请只依据记忆，不执行工具。"
  : dogfood
  ? `Mnemora 开发任务 ${taskMarker}：official-plugin-gate.mjs 使用固定的 OpenClaw 版本，但子进程默认继承日常宿主环境，未隔离配置和凭据。当前 CLI 的元数据拒绝检查能通过，仍需消除环境耦合。修复决定：${taskEvidence}。我们将为两次 build/validate 调用生成一个独立 state/config，并添加环境白名单与外层配置损坏的回归测试。请用中文给出三项验证点，不调用工具，不宣称已经执行。`
  : "Remember: MNEMORA_HOST_CANARY_7F3A uses sapphire widgets.";
const secondMessage = taskRecall
  ? "继续 release_task_42，发布最终提交是什么？请只依据记忆，不执行工具。"
  : dogfood
  ? `继续 ${taskMarker} 修复任务。之前决定如何处理配置与凭据？请依据记忆给出验证点；没有证据就明确说明。用中文简短回答，不调用工具。`
  : "What widgets does MNEMORA_HOST_CANARY_7F3A use?";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = project ? join(root, ".dogfood", "project-mnemora") : createTempDir("host-");
if (projectStatus && !existsSync(join(directory, "memory.db"))) {
  console.log(JSON.stringify({ scope: "project:mnemora", initialized: false, reasoningDeliveryEnabled: false }));
  process.exit(0);
}
if (project) mkdirSync(directory, { recursive: true, mode: 0o700 });
let projectLock;
if (project) {
  // Exclusive creation fails closed. Never remove a lock owned by another run.
  try { projectLock = openSync(join(directory, "active.lock"), "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.error("Project memory is busy. If a previous run was interrupted, inspect active.lock and its PID before removing it.");
    process.exit(2);
  }
  writeFileSync(projectLock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  process.once("exit", () => { closeSync(projectLock); unlinkSync(join(directory, "active.lock")); });
}
if (projectStatus) {
  const graph = new Mnemora({ config: { dbPath: join(directory, "memory.db"), scope: { default: "project:mnemora" } } });
  try { console.log(JSON.stringify({ scope: "project:mnemora", initialized: true, scopes: graph.kg_scopes(), capturedEvents: graph.store.db.prepare("SELECT count(*) AS n FROM mnemora_conversation_events WHERE scope = ? AND deleted_at IS NULL").get("project:mnemora").n, reasoningDeliveryEnabled: false }, null, 2)); }
  finally { graph.close(); }
  process.exit(0);
}
const state = join(directory, "state"), workspace = join(directory, "workspace"), home = join(directory, "home");
for (const path of [state, workspace, home]) mkdirSync(path, { recursive: true, mode: 0o700 });
const configPath = join(state, "openclaw.json"), dbPath = join(directory, "memory.db"), token = randomUUID();
// Load an immutable distribution snapshot. Loading the repository root would
// include changing .tmp artifacts in newer hosts' source-consistency checks.
const pluginSource = project ? (process.env.MNEMORA_PROJECT_PLUGIN || join(homedir(), ".openclaw", "extensions", "mnemora")) : root;
const pluginVersion = JSON.parse(readFileSync(join(pluginSource, "package.json"), "utf8")).version;
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(pluginVersion)) throw new Error("Invalid project plugin version");
const pluginRoot = join(directory, `plugin-${pluginVersion}`);
if (!existsSync(pluginRoot)) {
  const staging = `${pluginRoot}.install-${randomUUID()}`;
  mkdirSync(staging);
  for (const name of ["dist", "package.json", "openclaw.plugin.json", "skills"]) cpSync(join(pluginSource, name), join(staging, name), { recursive: true });
  symlinkSync(join(pluginSource, "node_modules"), join(staging, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  renameSync(staging, pluginRoot);
}
// Explicit allowlist: never inherit provider keys, channel tokens, host profiles,
// shell-env import settings, or credentials from the developer's environment.
const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { HOME: home, USERPROFILE: home, TMPDIR: directory, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_LOAD_SHELL_ENV: "0", OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_CRON: "1" });
// npm prepends the pinned dependency's bin directory. This test deliberately
// targets the installed host, while official-plugin-gate targets the pinned CLI.
env.PATH = env.PATH.split(delimiter).filter(path => !path.endsWith(`${join("node_modules", ".bin")}`)).join(delimiter);
const cli = process.env.MNEMORA_OPENCLAW_BIN || "openclaw";
const requests = [];
const scope = dogfood ? "project:mnemora" : "project:host-test";
const replies = [];
const inferenceMeasurements = [];
let projectSucceeded = false;
let activeQuestion = project ? projectMessage : firstMessage;
async function completeViaDailyGateway(input) {
  const requestId = randomUUID();
  const { prompt } = adviserPrompt(input.messages, activeQuestion, requestId);
  const call = { status: "failed", responseValidation: "not_validated", elapsedMs: 0, inputChars: prompt.length };
  const callStarted = performance.now();
  try { return await new Promise((resolve, reject) => {
    // Public stateless inference reuses the running Gateway's model/auth;
    // no provider credentials or daily memory are copied into the canary.
    const child = spawn(cli, ["infer", "model", "run", "--gateway", "--prompt", prompt, "--thinking", "off", "--json"], { cwd: root, env: { ...process.env, PATH: env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-4000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(`Public model inference failed (${code}): ${errors}`);
        const result = JSON.parse(output.slice(output.indexOf("{")));
        const rawText = result.outputs?.map(item => item.text ?? "").join("\n").trim();
        const text = adviserAnswer(rawText, requestId);
        if (!result.ok || !text || text.length > 16000) throw new Error("Public model inference returned no bounded text");
        call.status = "succeeded";
        call.responseValidation = "request_bound";
        replies.push({ provider: result.provider, model: result.model, text });
        resolve(text);
      } catch (error) { reject(error); }
    });
  }); } finally {
    call.elapsedMs = performance.now() - callStarted;
    inferenceMeasurements.push(call);
  }
}
const model = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) { body += chunk; if (body.length > 2_000_000) throw new Error("Mock request too large"); }
    const input = JSON.parse(body);
    requests.push(input);
    const reply = dogfood ? await completeViaDailyGateway(input) : "Recorded synthetic test evidence.";
    const base = { id: "chatcmpl-host-test", object: "chat.completion.chunk", created: 1, model: "host-test" };
    if (input.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const delta of [{ role: "assistant", content: reply }, {}]) {
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: delta.content ? null : "stop" }] })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
  } catch (error) { response.writeHead(400); response.end(String(error)); }
});
let gateway, gatewayLog = "";
if (project) for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, async () => {
    await stopGateway();
    model.closeAllConnections();
    process.exit(code);
  });
}
async function command(args, timeoutMs = 60000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`${args[0]} failed (${code}):\n${output}`)); });
  });
}
async function stopGateway() {
  if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return;
  const child = gateway;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
async function startGateway(port) {
  gateway = spawn(cli, ["gateway", "run", "--port", String(port), "--bind", "loopback"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  gateway.on("error", error => { gatewayLog += String(error); });
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on("data", chunk => { gatewayLog = (gatewayLog + chunk).slice(-100000); });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null || gateway.signalCode !== null) throw new Error(`Gateway exited:\n${gatewayLog}`);
    try {
      await command(["gateway", "health", "--url", `ws://127.0.0.1:${port}`, "--token", token, "--json", "--timeout", "2000"], 10000);
      assert.doesNotMatch(gatewayLog, /mnemora failed during load|plugin failed during load.*plugin=mnemora/, "Gateway must load Mnemora successfully");
      return;
    } catch (error) {
      if (error instanceof assert.AssertionError) throw new Error(`${error.message}\n${gatewayLog}`);
      await delay(500);
    }
  }
  throw new Error(`Gateway readiness timed out:\n${gatewayLog}`);
}
function journalIds() {
  const graph = new Mnemora({ config: { dbPath } });
  try { return graph.store.db.prepare("SELECT id FROM mnemora_conversation_events WHERE deleted_at IS NULL ORDER BY id").all().map(row => row.id); }
  finally { graph.close(); }
}
try {
  console.log(`Host test artifacts: ${directory}`);
  console.log((await command(["--version"])).trim());
  await new Promise((resolve, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", resolve); });
  const probe = createPortServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  writeFileSync(configPath, JSON.stringify({
    logging: { file: join(directory, "host.jsonl") },
    update: { checkOnStart: false },
    gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token }, controlUi: { enabled: false } },
    discovery: { mdns: { mode: "off" } },
    agents: { defaults: { workspace, model: { primary: "hostmock/host-test" }, heartbeat: { every: "0m" } } },
    memory: { search: { enabled: false } },
    models: { providers: { hostmock: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "synthetic-host-test", api: "openai-completions", models: [{ id: "host-test", name: "Host test", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
    plugins: { allow: ["mnemora"], load: { paths: [pluginRoot] }, slots: { contextEngine: "mnemora" }, entries: { mnemora: { enabled: true, config: { dbPath, toolSurface: "core", scope: { default: scope }, conversationJournal: { enabled: true }, contextEngine: { enabled: true, compaction: { enabled: false } }, episodicMemory: { enabled: true, autoExtract: false }, extraction: { enabled: false, autoExtract: false }, unifiedRetrieval: { enabled: true, shadowMode: true, tokenBudget: dogfood || taskRecall ? 1500 : 800 }, cognition: { reasoningRuntime: { shadowMode: true, scopes: [scope], delivery: { enabled: false, scopes: [] } } } } } } }
  }, null, 2), { mode: 0o600 });
  if (taskRecall) {
    const graph = new Mnemora({ config: { dbPath } });
    try {
      const journal = new ConversationEventRepository(graph.store.db, { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" }), now = Date.now();
      for (let index = 0; index < 10; index++) journal.append({ scope, sessionId: `older-${index}`, kind: "user_message", role: "user", createdAt: now - 20000 + index, parts: [{ type: "text", text: `历史发布提交状态：OLD_BATCH_${index} 已结束。${"此前项目验证已完成。".repeat(10)}` }] });
      journal.append({ scope, sessionId: "completion", kind: "user_message", role: "user", createdAt: now - 1000, parts: [{ type: "text", text: `RELEASE_TASK_42 发布完成，最终提交为 CURRENT_COMMIT_42，两个平台校验成功。${"构建校验与持久化验证均通过；这是一条详细的完成记录。".repeat(26)}` }] });
      journal.append({ scope: "project:foreign", sessionId: "foreign", kind: "user_message", role: "user", createdAt: now, parts: [{ type: "text", text: "RELEASE_TASK_42 发布完成，最终提交为 FOREIGN_COMMIT_42。" }] });
    } finally { graph.close(); }
  }
  const priorTaskEvents = taskRecall ? journalIds() : [];
  await startGateway(port);
  const priorProjectEvents = project ? journalIds() : [];
  await command(["agent", "--session-id", randomUUID(), "--message", project ? projectMessage : firstMessage, "--thinking", "off", "--json", "--timeout", dogfood ? "120" : "30"], dogfood ? 150000 : 60000);
  if (project) {
    let projectEvents = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      projectEvents = journalIds();
      if (projectEvents.length >= priorProjectEvents.length + 2) break;
      await delay(250);
    }
    assert.ok(projectEvents.length >= priorProjectEvents.length + 2, "Project turn must durably capture user and assistant events");
    const observed = new Set(projectEvents);
    assert.ok(priorProjectEvents.every(id => observed.has(id)), "Project request must preserve earlier journal events");
    await stopGateway();
    assert.deepEqual(journalIds(), projectEvents, "Project events must survive Gateway shutdown");
    const answer = replies.at(-1);
    if (!answer) throw new Error("No project model answer");
    projectSucceeded = true;
    const measurement = projectMeasurement(measurementId, pluginVersion, performance.now() - measurementStarted, true, inferenceMeasurements);
    const result = { measurement, scope, pluginVersion, at: new Date().toISOString(), freshSession: true, capturedEvents: journalIds().length, reasoningDeliveryEnabled: false, inferenceTransport: "daily-gateway-stateless", answer: answer.text, provider: answer.provider, model: answer.model };
    writeFileSync(join(directory, "latest-answer.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  } else {
  // afterTurn can finish after the agent RPC returns; wait for durable capture.
  let captured = [];
  for (let attempt = 0; attempt < 40; attempt++) { captured = journalIds(); if (captured.length >= Math.max(2, priorTaskEvents.length + 2)) break; await delay(250); }
  assert.ok(captured.length >= Math.max(2, priorTaskEvents.length + 2), "Real host must capture user and assistant events");
  await stopGateway();
  assert.deepEqual(journalIds(), captured, "Journal must survive Gateway shutdown");
  await startGateway(port);
  assert.deepEqual(journalIds(), captured, "Gateway restart must preserve existing events without replay duplicates");
  requests.length = 0;
  activeQuestion = secondMessage;
  await command(["agent", "--session-id", randomUUID(), "--message", secondMessage, "--thinking", "off", "--json", "--timeout", dogfood ? "120" : "30"], dogfood ? 150000 : 60000);
  assert.ok(requests.some(input => JSON.stringify(input.messages).normalize("NFKC").includes((dogfood || taskRecall ? taskEvidence : "sapphire widgets").normalize("NFKC"))), "A fresh session must receive persisted evidence through ContextEngine recall");
  if (taskRecall) {
    assert.ok(requests.every(input => !JSON.stringify(input.messages).includes("FOREIGN_COMMIT_42")), "Foreign scope must not enter the model request");
    if (dogfood) assert.ok(replies.every(reply => reply.text.includes("CURRENT_COMMIT_42")), "Actual model must identify the current completion from recalled evidence");
    console.log("task identifier recall passed: detailed completion retained, bounded context, no foreign scope");
  }
  if (dogfood) {
    writeFileSync(join(directory, "dogfood-result.json"), JSON.stringify({ task: taskMarker, scope, capturedEvents: captured.length, restartPreservedEvents: true, recalledDecisionInFreshSession: true, reasoningDeliveryEnabled: false, inferenceTransport: "daily-gateway-stateless", replies }, null, 2), { mode: 0o600 });
    console.log("dogfood passed: project:mnemora, actual provider, persisted development decision in a fresh session");
  }
  console.log("host integration passed: real Gateway, durable turn capture, restart persistence, cross-session recall");
  }
} finally {
  await stopGateway();
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  writeFileSync(join(directory, "gateway.log"), gatewayLog);
  if (project) appendFileSync(join(directory, "measurements.jsonl"), JSON.stringify(projectMeasurement(measurementId, pluginVersion, performance.now() - measurementStarted, projectSucceeded, inferenceMeasurements)) + "\n", { mode: 0o600 });
  if (dogfood && !project) {
    writeFileSync(join(directory, "dogfood-debug.json"), JSON.stringify({ task: taskMarker, scope, requests, replies }, null, 2), { mode: 0o600 });
    const artifacts = join(root, ".dogfood", randomUUID());
    mkdirSync(artifacts, { recursive: true, mode: 0o700 });
    // Retain only bounded diagnostic reports; native databases and fixture state
    // belong to the parent-owned temporary root and are removed after exit.
    for (const name of ["dogfood-result.json", "dogfood-debug.json", "gateway.log"]) {
      try { cpSync(join(directory, name), join(artifacts, name)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    console.log(`Dogfood reports: ${artifacts}`);
  }
}
