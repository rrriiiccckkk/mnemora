import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { createTempDir } from "./helpers/temp.mjs";
import { distributionFingerprint, verifyDistribution, sourceFingerprint } from "../scripts/package-artifact.mjs";
const root = process.cwd();
const nodeEnv = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` };
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: nodeEnv, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function fixture() {
  const dir = createTempDir("package-build-");
  for (const file of ["package.json", "package-lock.json", "openclaw.plugin.json", "tsconfig.json", "tsconfig.inspector.json", "scripts/build-package.mjs", "scripts/node-compat.mjs", "scripts/package-artifact.mjs", "scripts/build-inspector.mjs", "scripts/ensure-cli-executable.mjs", "scripts/verify-package.mjs"]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true }); cpSync(join(root, file), join(dir, file));
  }
  mkdirSync(join(dir, "src/inspector/client"), { recursive: true });
  const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
  for (const [file, text] of Object.entries({ "schema.ts": "export const SUPPORTED_SCHEMA_VERSION = 85;", "version.ts": `export const mnemoraVersion = "${version}";`, "plugin.ts": "export default {};", "index.ts": "export * from './schema.js';", "cli.ts": "#!/usr/bin/env node\nconsole.log('fixture');", "inspector/client/app.ts": "console.log('inspector');", "inspector/client/styles.css": "body { color: black; }", "inspector/client/index.html": '<script src="__APP__"></script><link href="__STYLES__">' })) writeFileSync(join(dir, "src", file), text);
  // Use the actual TypeScript/esbuild toolchain. npm pack excludes node_modules.
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return dir;
}

test("npm pack rebuilds stale dist and the packed runtime/schema match current source", () => {
  const dir = fixture(), out = createTempDir("package-archive-");
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist/schema.js"), "export const SUPPORTED_SCHEMA_VERSION = 84;");
  writeFileSync(join(dir, "dist/orphan.js"), "stale output");
  const npm = process.env.npm_execpath || join(execFileSync("npm", ["root", "-g"], { env: nodeEnv, encoding: "utf8" }).trim(), "npm/bin/npm-cli.js");
  const version = JSON.parse(readFileSync(join(dir, "package.json"))).version;
  const archive = join(out, `mnemora-${version}.tgz`);
  run(process.execPath, [npm, "pack", "--ignore-scripts", "--pack-destination", out], dir);
  assert.match(run("tar", ["-xOf", archive, "package/dist/schema.js"], dir), /VERSION = 84/);
  run(process.execPath, [npm, "pack", "--pack-destination", out], dir);
  assert.match(run("tar", ["-xOf", archive, "package/dist/schema.js"], dir), /VERSION = 85/);
  assert.doesNotMatch(run("tar", ["-tzf", archive], dir), /orphan\.js/);
  const unpacked = createTempDir("package-unpack-");
  run("tar", ["-xzf", archive, "-C", unpacked], dir);
  assert.deepEqual(verifyDistribution(join(unpacked, "package")), verifyDistribution(dir));
});

test("package verifier rejects changed source, modified output and missing files; same-version snapshots change", () => {
  const dir = fixture();
  run(process.execPath, [join(dir, "scripts/build-package.mjs")], dir);
  const before = distributionFingerprint(dir);
  const schemaPath = join(dir, "dist/schema.js"), original = readFileSync(schemaPath);
  writeFileSync(schemaPath, "export const SUPPORTED_SCHEMA_VERSION = 84;");
  assert.notEqual(distributionFingerprint(dir), before);
  assert.throws(() => verifyDistribution(dir));
  writeFileSync(schemaPath, original);
  const source = join(dir, "src/schema.ts");
  const sourceBefore = readFileSync(source, "utf8");
  writeFileSync(source, sourceBefore + "\n// source changed without a rebuild\n");
  assert.throws(() => verifyDistribution(dir), /source_and_dist_mismatch/);
  writeFileSync(source, sourceBefore);
  const packagePath = join(dir, "package.json"), metadata = readFileSync(packagePath, "utf8");
  writeFileSync(packagePath, JSON.stringify({ ...JSON.parse(metadata), description: "changed metadata" }));
  assert.throws(() => verifyDistribution(dir), /artifact_package_metadata_mismatch/);
  writeFileSync(packagePath, metadata);
  unlinkSync(join(dir, "dist/plugin.js"));
  assert.throws(() => verifyDistribution(dir), /artifact_file_set_mismatch/);
});

test("lockfile whitespace and key order do not invalidate source, but dependency changes still do", () => {
  const dir = fixture();
  run(process.execPath, [join(dir, "scripts/build-package.mjs")], dir);
  const path = join(dir, "package-lock.json"), original = readFileSync(path, "utf8");
  const parsed = JSON.parse(original);
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).reverse().map(k => [k, reverse(value[k])])) : value;
  writeFileSync(path, JSON.stringify(reverse(parsed)) + "\r\n");
  assert.doesNotThrow(() => verifyDistribution(dir));
  parsed.packages[""].dependencies.graphology = "0.0.0-synthetic";
  writeFileSync(path, JSON.stringify(parsed));
  assert.throws(() => verifyDistribution(dir), /source_and_dist_mismatch/);
  writeFileSync(path, original);
  const manifestPath = join(dir, "dist/build-manifest.json"), manifest = JSON.parse(readFileSync(manifestPath));
  delete manifest.sourceFingerprintFormat;
  manifest.sourceFingerprint = sourceFingerprint(dir, "raw-v1");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.doesNotThrow(() => verifyDistribution(dir));
  writeFileSync(path, JSON.stringify(reverse(JSON.parse(original))));
  assert.throws(() => verifyDistribution(dir), /source_and_dist_mismatch/);
});
