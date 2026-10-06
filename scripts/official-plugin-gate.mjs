import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir, withTempRoot } from "../tests/helpers/temp.mjs";

const cli = fileURLToPath(new URL("../node_modules/openclaw/openclaw.mjs", import.meta.url));
export function assertKnownIncompatibility(command, result) {
  const diagnostics = `status=${String(result.status)} signal=${String(result.signal)} error=${result.error ? `${result.error.code ?? "unknown"}:${result.error.message}` : "none"}`;
  if (result.error) throw new Error(`official OpenClaw ${command} launch failed: ${diagnostics}`);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, `official OpenClaw ${command} unexpectedly accepted an advanced definePluginEntry plugin; promote this gate into verify`);
  assert.match(output, /(?:does not expose defineToolPlugin metadata|does not expose tool or feature authoring metadata)/, `official OpenClaw ${command} failed for an unexpected reason: ${diagnostics}\n${output}`);
}

export async function runOfficialPluginGate(spawn = spawnSync) {
  return await withTempRoot(() => {
    const state = createTempDir("official-gate-");
    const config = join(state, "openclaw.json");
    writeFileSync(config, "{}", { mode: 0o600 });
    // The pinned authoring CLI must not parse a newer daily host's config,
    // discover its extensions, or inherit provider/channel credentials.
    const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: config, OPENCLAW_HOME: state, OPENCLAW_LOAD_SHELL_ENV: "0" });
    for (const command of ["build", "validate"]) {
      const result = spawn(process.execPath, [cli, "plugins", command, "--entry", "./dist/plugin.js", "--root", "."], { encoding: "utf8", env, timeout: 60000 });
      assertKnownIncompatibility(command, result);
    }
    console.log("official OpenClaw simple-tool gates deterministically reject advanced definePluginEntry metadata (known 2026.9.2 incompatibility)");
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await runOfficialPluginGate();
