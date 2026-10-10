import test from "node:test";
import assert from "node:assert/strict";
import { gatewayInferenceRequest, gatewayInferenceAnswer, gatewayInferenceResult, providerTokenUsage } from "../scripts/project-inference.mjs";

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

test("empty failed completions retain reported input/cache usage and never become successful answers", () => {
  const r=response();r.result.payloads=[];
  r.result.meta.agentMeta.usage={input:100,output:0,cacheRead:25,cacheWrite:5,total:130,cost:{total:0}};
  for(const code of [0,1,null]){
    const result=gatewayInferenceResult(JSON.stringify(r),code,"prompt");
    assert.deepEqual(result.tokenUsage,{input:100,output:0,cacheRead:25,cacheWrite:5,total:130});
    assert.ok(result.error);
    assert.equal(result.answer,undefined);
  }
  assert.deepEqual(providerTokenUsage({input:0,output:0,cacheRead:40,cacheWrite:0,total:40}),{input:0,output:0,cacheRead:40,cacheWrite:0,total:40});
  assert.equal(providerTokenUsage({input:0,output:0,cacheRead:0,cacheWrite:0,total:0}),null);
});

test("nonzero exits preserve known usage even for a valid reply without accepting success", () => {
  const raw=JSON.stringify(response());
  for(const code of [1,42,null]){
    const result=gatewayInferenceResult(`Host warning\n${raw}`,code,"prompt");
    assert.equal(result.tokenUsage.total,130);
    assert.equal(result.answer,undefined);
    assert.ok(result.error);
  }
  const success=gatewayInferenceResult(raw,0,"prompt");
  assert.equal(success.answer.provider,"fixture");
  assert.equal(success.error,undefined);
  const wrongPrompt=gatewayInferenceResult(raw,0,"other");
  assert.ok(wrongPrompt.error);
  assert.equal(wrongPrompt.tokenUsage.total,130);
});

test("truncated, overflowing, missing and inconsistent counters remain unknown without exposing raw output", () => {
  const r=response();const raw=JSON.stringify(r);
  for(const [output,overflow] of [[raw.slice(0,-1),false],["PRIVATE_DIAGNOSTIC",false],[raw,true],["x".repeat(512001),false]]){
    const result=gatewayInferenceResult(output,1,"prompt",overflow);
    assert.equal(result.tokenUsage,null);
    assert.ok(result.error);
    assert.doesNotMatch(result.error.message,/PRIVATE_DIAGNOSTIC|requestId|fixture-model/);
  }
  delete r.result.meta.agentMeta.usage;
  assert.equal(gatewayInferenceResult(JSON.stringify(r),1,"prompt").tokenUsage,null);
  r.result.meta.agentMeta.usage={input:100,output:0,cacheRead:0,cacheWrite:0,total:101};
  assert.equal(gatewayInferenceResult(JSON.stringify(r),1,"prompt").tokenUsage,null);
});
