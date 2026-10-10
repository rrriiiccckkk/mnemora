import test from "node:test";
import assert from "node:assert/strict";
import { gatewayInferenceRequest, gatewayInferenceAnswer } from "../scripts/project-inference.mjs";

const response = () => ({status:"ok",result:{payloads:[{text:'{"requestId":"id","answer":"Reported guard passed, release pending"}'}],meta:{agentMeta:{provider:"fixture",model:"fixture-model",usage:{input:100,output:20,cacheRead:10,cacheWrite:0,total:130,cost:{total:0}},terminalReceipt:{successfulToolNames:[]}},finalPromptText:"prompt",systemPromptReport:{systemPrompt:{chars:0}},executionTrace:{fallbackUsed:false},completion:{stopReason:"stop"}}}});

test("public inference request is stateless and response exposes allowlisted provider usage", () => {
  const request=gatewayInferenceRequest("prompt","model-run-id","once");
  assert.equal(request.promptMode,"none");
  assert.equal(request.modelRun,true);
  assert.equal(request.sessionKey,"agent:main:explicit:model-run-id");
  assert.equal(request.idempotencyKey,"once");
  assert.equal(request.thinking,"off");
  assert.ok(!("provider" in request) && !("model" in request) && !("tools" in request));
  const result=gatewayInferenceAnswer(response(),"prompt");
  assert.equal(result.provider,"fixture");
  assert.deepEqual(result.tokenUsage,{input:100,output:20,cacheRead:10,cacheWrite:0,total:130});
});

test("history injection, tool execution, fallback, truncation and prompt mismatch are rejected", () => {
  for(const change of [r=>r.status="error",r=>r.result.meta.finalPromptText="daily history",r=>r.result.meta.systemPromptReport.systemPrompt.chars=10,r=>r.result.meta.agentMeta.terminalReceipt.successfulToolNames=["exec"],r=>r.result.meta.executionTrace.fallbackUsed=true,r=>delete r.result.meta.executionTrace,r=>r.result.meta.completion.stopReason="length",r=>r.result.payloads=[],r=>r.result.meta.agentMeta.model=""]){const r=response();change(r);assert.throws(()=>gatewayInferenceAnswer(r,"prompt"));}
});

test("a valid reply with absent or inconsistent provider usage keeps usage unknown", () => {
  const r=response();delete r.result.meta.agentMeta.usage;
  assert.equal(gatewayInferenceAnswer(r,"prompt").tokenUsage,null);
  r.result.meta.agentMeta.usage={input:100,output:20,cacheRead:10,cacheWrite:0,total:999};
  assert.equal(gatewayInferenceAnswer(r,"prompt").tokenUsage,null);
});
