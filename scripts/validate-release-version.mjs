import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, root), "utf8"));

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const openClaw = readJson("openclaw.plugin.json");
const contextEngineSource = readFileSync(new URL("src/context-engine/engine.ts", root), "utf8");
const versionSource = readFileSync(new URL("src/version.ts", root), "utf8");
const versions = {
  "package.json": pkg.version,
  "package-lock.json": lock.version,
  "package-lock root": lock.packages?.[""]?.version,
  "openclaw.plugin.json": openClaw.version,
};

for (const [source, version] of Object.entries(versions)) {
  assert.equal(version, pkg.version, `${source} version must match package.json`);
}
assert.match(contextEngineSource, /version: mnemoraVersion/, "ContextEngine info must use the shared release version");
assert.match(versionSource, new RegExp(`mnemoraVersion = "${pkg.version.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"`), "shared runtime version must match package.json");

const tag = process.env.RELEASE_TAG?.trim();
if (tag) assert.equal(tag, `v${pkg.version}`, "release tag must match package.json");

console.log(`release version consistency ok: v${pkg.version}`);
