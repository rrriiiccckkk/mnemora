import test from "node:test";
import assert from "node:assert/strict";
import { projectMeasurement } from "../scripts/project-measurement.mjs";

test("project telemetry preserves failed calls and excludes proxy usage and conversation content", () => {
  const result = projectMeasurement("run-1", "1.32.8", 120.8, false, [
    { status: "failed", elapsedMs: 90.1, inputChars: 500, prompt: "private prompt", usage: { total_tokens: 15 } },
    { status: "succeeded", elapsedMs: 10.8, inputChars: 300, answer: "private reply" },
  ]);
  assert.equal(result.status, "failed");
  assert.equal(result.elapsedMs, 121);
  assert.deepEqual(result.inference, [{ status: "failed", elapsedMs: 90, inputChars: 500, responseValidation: "not_validated" }, { status: "succeeded", elapsedMs: 11, inputChars: 300, responseValidation: "not_validated" }]);
  assert.equal(result.tokenUsage, null);
  assert.doesNotMatch(JSON.stringify(result), /private prompt|private reply|total_tokens/);
  assert.equal(projectMeasurement("run-2", "1.32.8", 10, true, []).tokenUsage, null);
});

test("project telemetry rejects invalid clocks and lengths instead of publishing invented values", () => {
  for (const elapsed of [-1, NaN, Infinity]) assert.throws(() => projectMeasurement("run", "1.32.8", elapsed, true, []));
  assert.throws(() => projectMeasurement("run", "1.32.8", 10, true, [{ elapsedMs: 1, inputChars: -1 }]));
});
