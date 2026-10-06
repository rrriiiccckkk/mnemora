import test from "node:test";
import assert from "node:assert/strict";
import { assertKnownIncompatibility, runOfficialPluginGate } from "../scripts/official-plugin-gate.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createTempDir } from "./helpers/temp.mjs";

test("official gate distinguishes launch failures and empty unexpected exits", () => {
  assert.throws(()=>assertKnownIncompatibility("build",{status:null,signal:null,error:Object.assign(new Error("spawn ENOENT"),{code:"ENOENT"}),stdout:"",stderr:""}),/launch failed.*ENOENT/);
  assert.throws(()=>assertKnownIncompatibility("validate",{status:2,signal:"SIGTERM",stdout:"",stderr:""}),/unexpected reason.*status=2.*signal=SIGTERM/);
});

test("official gate isolates both commands from host config and credentials", async () => {
  const calls = [];
  await runOfficialPluginGate((_cli, args, options) => {
    calls.push({ args, options });
    assert.equal(readFileSync(options.env.OPENCLAW_CONFIG_PATH, "utf8"), "{}");
    assert.equal(options.env.OPENCLAW_LOAD_SHELL_ENV, "0");
    assert.equal(options.env.OPENCLAW_GATEWAY_TOKEN, undefined);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    return { status: 1, stdout: "", stderr: "plugin entry does not expose tool or feature authoring metadata" };
  });
  assert.deepEqual(calls.map(call => call.args[2]), ["build", "validate"]);
  assert.equal(calls[0].options.env.OPENCLAW_CONFIG_PATH, calls[1].options.env.OPENCLAW_CONFIG_PATH);
  assert.equal(calls[0].options.timeout, 60000);
});

test("official gate reaches metadata validation even when inherited host config is invalid", () => {
  const state = createTempDir("foreign-host-"), config = join(state, "openclaw.json");
  writeFileSync(config, JSON.stringify({ foreignHostSetting: "synthetic-new-host-key" }));
  const result = spawnSync(process.execPath, ["scripts/official-plugin-gate.mjs"], {
    encoding: "utf8", timeout: 60000,
    env: { ...process.env, OPENCLAW_CONFIG_PATH: config, OPENCLAW_STATE_DIR: state, OPENCLAW_HOME: state, OPENCLAW_LOAD_SHELL_ENV: "0", OPENAI_API_KEY: "synthetic-sentinel" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /known 2026\.9\.2 incompatibility/);
  assert.equal(JSON.parse(readFileSync(config, "utf8")).foreignHostSetting, "synthetic-new-host-key");
});

test("official gate accepts only the known nonzero incompatibility", () => {
  assert.doesNotThrow(()=>assertKnownIncompatibility("build",{status:1,signal:null,stdout:"",stderr:"does not expose defineToolPlugin metadata"}));
  assert.doesNotThrow(()=>assertKnownIncompatibility("build",{status:1,signal:null,stdout:"",stderr:"plugin entry does not expose tool or feature authoring metadata"}));
  assert.throws(()=>assertKnownIncompatibility("build",{status:0,signal:null,stdout:"accepted",stderr:""}),/unexpectedly accepted/);
});
