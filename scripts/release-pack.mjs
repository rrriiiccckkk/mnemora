import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDistribution, sha256 } from "./package-artifact.mjs";
import { withTempRoot, createTempDir } from "../tests/helpers/temp.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
assert(args.length === 0 || args.length === 2 && args[0] === "--output", "Usage: npm run release:pack -- [--output directory]");
const output = resolve(root, args[1] ?? ".tmp/release");
mkdirSync(output, { recursive: true });
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const archive = join(output, `${pkg.name}-${pkg.version}.tgz`);
function run(command, values, options = {}) {
  const result = spawnSync(command, values, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout || "package_command_failed");
  return result.stdout;
}
assert(process.env.npm_execpath, "Invoke through npm run release:pack");
// npm pack executes prepack, which cleanly rebuilds and validates the distribution.
run(process.execPath, [process.env.npm_execpath, "pack", "--pack-destination", output], { env: { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` } });
const built = verifyDistribution(root);
if (process.env.GITHUB_SHA) assert.equal(built.sourceCommit, process.env.GITHUB_SHA, "artifact_commit_mismatch");
await withTempRoot(async () => {
  const unpacked = createTempDir("release-package-");
  const paths = run("tar", ["-tzf", archive]).trim().split(/\r?\n/);
  assert(paths.every(path => path.startsWith("package/") && !path.includes("\\") && !path.split("/").includes("..")), "unsafe_archive_path");
  run("tar", ["-xzf", archive, "-C", unpacked]);
  const artifact = verifyDistribution(join(unpacked, "package"), built.sourceFingerprint);
  assert.deepEqual(artifact, built, "packed_artifact_mismatch");
});
writeFileSync(join(output, "SHA256SUMS"), `${sha256(readFileSync(archive))}  ${pkg.name}-${pkg.version}.tgz\n`);
console.log(JSON.stringify({ archive, verified: built, checksum: sha256(readFileSync(archive)) }));
