// Optional real-provider regression with synthetic evidence. No daily memory,
// provider secrets or tool execution. Stop on failure; never retry a cell.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Mnemora, ConversationEventRepository, UnifiedRetrievalService } from "../dist/index.js";
import { adviserPrompt, adviserAnswer } from "./project-adviser.mjs";
import { gatewayInferenceRequest, gatewayInferenceAnswer, providerTokenUsage } from "./project-inference.mjs";

if (process.argv.length !== 3 || process.argv[2] !== "--dogfood") throw new Error("Use --dogfood for four synthetic, charged public Gateway calls");
const directory = fileURLToPath(new URL(`../.dogfood/adviser-state-${randomUUID()}/`, import.meta.url));
mkdirSync(directory, { recursive: true, mode: 0o700 });
console.log(`Adviser state regression artifacts: ${directory}`);
const cases = [
  { id: "later-explicit-result", allowed: ["GUARD_PASSED_42"], events: [[1000,"user","TASK_GUARD_42 isolation guard: GUARD_PENDING_42; publication pending."],[2000,"user","TASK_GUARD_42 isolation guard: GUARD_PASSED_42; publication still pending."]] },
  { id: "unrelated-check-not-proof", allowed: ["GUARD_PENDING_42"], events: [[1000,"user","TASK_GUARD_42 isolation guard: GUARD_PENDING_42."],[2000,"user","TASK_GUARD_42 browser screenshot check passed; no isolation guard result."]] },
  // An unverified assistant conflict may leave the current state unknown.
  // Neither conservative response may claim the check passed.
  { id: "assistant-not-proof", allowed: ["GUARD_PENDING_42","GUARD_UNKNOWN_42"], events: [[1000,"user","TASK_GUARD_42 isolation guard: GUARD_PENDING_42."],[2000,"user","TASK_GUARD_42 browser screenshot check passed; no isolation guard result."],[3000,"assistant","TASK_GUARD_42 isolation guard: GUARD_PASSED_42 (assistant inference, no execution evidence)."]] },
  { id: "equal-time-conflict", allowed: ["GUARD_UNKNOWN_42"], events: [[1000,"user","TASK_GUARD_42 isolation guard: GUARD_PENDING_42."],[1000,"user","TASK_GUARD_42 isolation guard: GUARD_PASSED_42."]] },
];
writeFileSync(`${directory}/plan.json`, JSON.stringify({ cases, automaticRetry: false, source: "synthetic", efficacy: "not_established" }, null, 2), { mode: 0o600 });
const results = [];
for (const cell of cases) {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  let prompt, requestId, memoryChars, forwardedMemoryChars;
  try {
    const policy = { maxInlineChars: 16000, maxEventBytes: 262144, sensitiveContentPolicy: "redact" }, journal = new ConversationEventRepository(graph.store.db, policy);
    for (const [index, [createdAt, role, text]] of cell.events.entries()) journal.append({ scope: "project:adviser-fixture", sessionId: `fixture-${index}`, kind: role === "user" ? "user_message" : "assistant_message", role, createdAt, parts: [{ type: "text", text }] });
    const service = new UnifiedRetrievalService(graph.store.db, policy, () => 4000), found = service.find({ scope: "project:adviser-fixture", query: "TASK_GUARD_42", tokenBudget: 1500, limit: 8 }), packed = service.packPrompt(found, 8, undefined, 1500);
    assert.equal(packed.candidates.length, cell.events.length, "All contradictory records must reach the adviser");
    requestId = randomUUID();
    ({ prompt, memoryChars, forwardedMemoryChars } = adviserPrompt([{ role: "system", content: packed.prompt }], "TASK_GUARD_42: what is the latest reliably REPORTED isolation guard state, rather than an independently verified real-world state? A newer unrelated check does not erase the prior explicit guard report. Reply with ONLY one marker: GUARD_PASSED_42, GUARD_PENDING_42, or GUARD_UNKNOWN_42. Equal-time conflicting reports mean unknown. Do not infer publication or execute tools.", requestId));
  } finally { graph.close(); }
  const params = gatewayInferenceRequest(prompt, `model-run-${randomUUID()}`, randomUUID());
  writeFileSync(`${directory}/${cell.id}-started.json`, JSON.stringify({ at: new Date().toISOString(), params }), { mode: 0o600 });
  let result = { id: cell.id, status: "failed", outcome: "unknown", tokenUsage: null };
  try {
    const call = spawnSync(process.env.MNEMORA_OPENCLAW_BIN || "openclaw", ["gateway", "call", "agent", "--params", JSON.stringify(params), "--expect-final", "--timeout", "85000", "--json"], { encoding: "utf8", timeout: 90000, maxBuffer: 512000 });
    if (call.error || call.status !== 0) throw new Error("Public Gateway call failed; inference outcome may be unknown");
    const raw = JSON.parse(call.stdout.slice(call.stdout.indexOf("{")));
    result.tokenUsage = providerTokenUsage(raw?.result?.meta?.agentMeta?.usage);
    const response = gatewayInferenceAnswer(raw, prompt), answer = adviserAnswer(response.text, requestId);
    result = { ...result, outcome: "completed", answer, provider: response.provider, model: response.model, memoryChars, forwardedMemoryChars };
    assert.ok(cell.allowed.includes(answer), `Unexpected state: ${answer}; allowed: ${cell.allowed.join(",")}`);
    assert.ok(result.tokenUsage, "Public provider usage must be available for this trial");
    result.status = "passed";
    console.log(JSON.stringify(result));
  } finally { results.push(result); writeFileSync(`${directory}/results.json`, JSON.stringify(results, null, 2), { mode: 0o600 }); }
}
console.log("adviser state regression passed: later explicit result, unrelated/assistant boundary, equal-time conflict; efficacy not established");
