import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/openclaw/openclaw.mjs", import.meta.url));
export function assertKnownIncompatibility(command, result) {
  const diagnostics = `status=${String(result.status)} signal=${String(result.signal)} error=${result.error ? `${result.error.code ?? "unknown"}:${result.error.message}` : "none"}`;
  if (result.error) throw new Error(`official OpenClaw ${command} launch failed: ${diagnostics}`);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, `official OpenClaw ${command} unexpectedly accepted an advanced definePluginEntry plugin; promote this gate into verify`);
  assert.match(output, /does not expose defineToolPlugin metadata/, `official OpenClaw ${command} failed for an unexpected reason: ${diagnostics}\n${output}`);
}

export function runOfficialPluginGate(spawn = spawnSync) {
  for (const command of ["build", "validate"]) {
    const result = spawn(process.execPath, [cli, "plugins", command, "--entry", "./dist/plugin.js", "--root", "."], { encoding: "utf8" });
    assertKnownIncompatibility(command, result);
  }
  console.log("official OpenClaw simple-tool gates deterministically reject definePluginEntry metadata (known 2026.6.11 incompatibility)");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) runOfficialPluginGate();
