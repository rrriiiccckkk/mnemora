import test from "node:test";
import assert from "node:assert/strict";
import { assertKnownIncompatibility } from "../scripts/official-plugin-gate.mjs";

test("official gate distinguishes launch failures and empty unexpected exits", () => {
  assert.throws(()=>assertKnownIncompatibility("build",{status:null,signal:null,error:Object.assign(new Error("spawn ENOENT"),{code:"ENOENT"}),stdout:"",stderr:""}),/launch failed.*ENOENT/);
  assert.throws(()=>assertKnownIncompatibility("validate",{status:2,signal:"SIGTERM",stdout:"",stderr:""}),/unexpected reason.*status=2.*signal=SIGTERM/);
});

test("official gate accepts only the known nonzero incompatibility", () => {
  assert.doesNotThrow(()=>assertKnownIncompatibility("build",{status:1,signal:null,stdout:"",stderr:"does not expose defineToolPlugin metadata"}));
  assert.throws(()=>assertKnownIncompatibility("build",{status:0,signal:null,stdout:"accepted",stderr:""}),/unexpectedly accepted/);
});
