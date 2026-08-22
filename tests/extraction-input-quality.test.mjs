import assert from "node:assert/strict";
import test from "node:test";
import { planAutomaticExtractionInput } from "../dist/extraction-input-quality.js";

test("input quality skips exact low-information and generic model-refusal boilerplate only", () => {
  const greeting = planAutomaticExtractionInput("谢谢！", { maxChars: 100, maxSegments: 16 });
  assert.deepEqual(greeting, { action: "skip", text: "", truncated: true, sourceSegments: 1, selectedSegments: 0, droppedSegments: 1, highSignalSegments: 0, reasonCodes: ["low_information"] });
  const refusal = planAutomaticExtractionInput("As an AI, I cannot access that link.", { maxChars: 100, maxSegments: 16 });
  assert.equal(refusal.action, "skip");
  assert.deepEqual(refusal.reasonCodes, ["agent_denial"]);
  const substantive = planAutomaticExtractionInput("I cannot access the staging server because my account was revoked.", { maxChars: 100, maxSegments: 16 });
  assert.equal(substantive.action, "extract");
  assert.equal(substantive.text, "I cannot access the staging server because my account was revoked.");
});

test("input quality protects a later correction within a bounded budget and preserves source order", () => {
  const plan = planAutomaticExtractionInput("This is background context that is deliberately long.\n\n更正：以后请用中文回复。\n\nThanks!", { maxChars: 28, maxSegments: 16 });
  assert.equal(plan.action, "extract");
  assert.match(plan.text, /更正：以后请用中文回复/u);
  assert.equal(plan.text.length <= 28, true);
  assert.equal(plan.highSignalSegments, 1);
  assert.equal(plan.droppedSegments, 1);
  assert.deepEqual(plan.reasonCodes, ["low_information"]);
});

test("input quality caps selected segments without changing segment text beyond the existing budget", () => {
  const plan = planAutomaticExtractionInput("one. two. I decided to use SQLite. four.", { maxChars: 100, maxSegments: 2 });
  assert.equal(plan.text, "one.\n\nI decided to use SQLite.");
  assert.deepEqual({ source: plan.sourceSegments, selected: plan.selectedSegments, dropped: plan.droppedSegments, high: plan.highSignalSegments }, { source: 4, selected: 2, dropped: 2, high: 1 });
});
