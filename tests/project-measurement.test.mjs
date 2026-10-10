import test from "node:test";
import assert from "node:assert/strict";
import { projectMeasurement } from "../scripts/project-measurement.mjs";
import { gatewayInferenceResult } from "../scripts/project-inference.mjs";

test("project telemetry preserves failed calls and excludes proxy usage and conversation content", () => {
  const result = projectMeasurement("run-1", "1.32.8", 120.8, false, [
    { status: "failed", elapsedMs: 90.1, inputChars: 500, prompt: "private prompt", usage: { total_tokens: 15 } },
    { status: "succeeded", elapsedMs: 10.8, inputChars: 300, answer: "private reply" },
  ]);
  assert.equal(result.status, "failed");
  assert.equal(result.elapsedMs, 121);
  assert.deepEqual(result.inference.map(({status,elapsedMs,inputChars,responseValidation})=>({status,elapsedMs,inputChars,responseValidation})), [{ status: "failed", elapsedMs: 90, inputChars: 500, responseValidation: "not_validated" }, { status: "succeeded", elapsedMs: 11, inputChars: 300, responseValidation: "not_validated" }]);
  assert.equal(result.tokenUsage, null);
  assert.doesNotMatch(JSON.stringify(result), /private prompt|private reply|total_tokens/);
  assert.equal(projectMeasurement("run-2", "1.32.8", 10, true, []).tokenUsage, null);
});

test("provider usage includes caches exactly once and known failed calls remain charged", () => {
  const usage = { input: 100, output: 20, cacheRead: 40, cacheWrite: 10, total: 170, cost: { total: 0 }, secret: "private" };
  const call = { status: "failed", elapsedMs: 10, inputChars: 20, usageSource: "public_gateway_agent_meta", tokenUsage: usage, memoryChars: 10, forwardedMemoryChars: 8 };
  const measurement = projectMeasurement("id", "v", 30, false, [call, {...call,status:"succeeded"}]);
  assert.equal(measurement.schema, "project-measurement.v2");
  assert.deepEqual(measurement.tokenUsage, {input:200,output:40,cacheRead:80,cacheWrite:20,total:340});
  assert.equal(measurement.inference[0].status, "failed");
  assert.doesNotMatch(JSON.stringify(measurement), /cost|secret|private/);
  const partial = projectMeasurement("id", "v", 30, false, [call, {...call,tokenUsage:null}]);
  assert.equal(partial.tokenUsage, null);
  assert.equal(partial.inference[0].tokenUsage.total, 170);
  assert.equal(partial.inference[1].tokenUsage, null);
});

test("missing, invalid, proxy and overflowing usage is not published as a complete total", () => {
  const usage = {input:10,output:5,cacheRead:0,cacheWrite:0,total:15}, call = {elapsedMs:1,inputChars:5,usageSource:"public_gateway_agent_meta",tokenUsage:usage};
  for (const tokenUsage of [undefined,{...usage,total:16},{...usage,input:"10"},{...usage,cacheRead:-1},{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}]) assert.equal(projectMeasurement("id","v",2,true,[{...call,tokenUsage}]).tokenUsage,null);
  assert.equal(projectMeasurement("id","v",2,true,[{...call,usageSource:"proxy"}]).tokenUsage,null);
  const large={...call,tokenUsage:{input:Number.MAX_SAFE_INTEGER-1,output:1,cacheRead:0,cacheWrite:0,total:Number.MAX_SAFE_INTEGER}};
  assert.equal(projectMeasurement("id","v",2,true,[large,large]).tokenUsage,null);
});

test("project telemetry rejects invalid clocks and lengths instead of publishing invented values", () => {
  for (const elapsed of [-1, NaN, Infinity]) assert.throws(() => projectMeasurement("run", "1.32.8", elapsed, true, []));
  assert.throws(() => projectMeasurement("run", "1.32.8", 10, true, [{ elapsedMs: 1, inputChars: -1 }]));
});

test("failed zero-output CLI calls survive measurement and partial batches remain incomplete", () => {
  const raw=JSON.stringify({status:"error",result:{payloads:[],meta:{agentMeta:{usage:{input:80,output:0,cacheRead:20,cacheWrite:0,total:100}}}}});
  const outcome=gatewayInferenceResult(raw,1,"prompt");
  assert.ok(outcome.error);
  const call={status:"failed",elapsedMs:2,inputChars:10,responseValidation:"not_validated",usageSource:"public_gateway_agent_meta",tokenUsage:outcome.tokenUsage};
  const failed=projectMeasurement("failed","1.32.12",4,false,[call]);
  assert.equal(failed.status,"failed");
  assert.deepEqual(failed.tokenUsage,{input:80,output:0,cacheRead:20,cacheWrite:0,total:100});
  assert.equal(failed.inference[0].responseValidation,"not_validated");
  const partial=projectMeasurement("partial","1.32.12",5,false,[call,{...call,tokenUsage:null}]);
  assert.equal(partial.tokenUsage,null);
  assert.equal(partial.inference[0].tokenUsage.total,100);
  assert.equal(partial.inference[1].tokenUsage,null);
});
