import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const readJson = (file) => JSON.parse(readFileSync(new URL(file, root), "utf8"));
const pkg = readJson("package.json");
const manifest = readJson("openclaw.plugin.json");
const lock = readJson("package-lock.json");
const readme = readFileSync(new URL("README.md", root), "utf8");
const readmeZh = readFileSync(new URL("README.zh-CN.md", root), "utf8");

test("v1 release metadata is independent and consistently versioned", () => {
  assert.equal(pkg.name, "mnemora");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(manifest.id, "mnemora");
  assert.equal(manifest.name, "Mnemora");
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.deepEqual(pkg.bin, { mnemora: "dist/cli.js" });
  assert.equal("legacyPluginIds" in manifest, false);
  assert.match(pkg.repository.url, /rrriiiccckkk\/mnemora\.git$/);
  assert.equal(existsSync(new URL("docs/releases/v1.0.0.md", root)), true);
  assert.match(readFileSync(new URL("src/version.ts", root), "utf8"), /mnemoraVersion = "1\.0\.0"/);
  execFileSync(process.execPath, ["scripts/validate-release-version.mjs"], {
    cwd: fileURLToPath(root), env: { ...process.env, RELEASE_TAG: "v1.0.0" }, stdio: "pipe"
  });
});

test("README is bilingual, concise, and describes the public integration boundary", () => {
  assert.match(readme, /README\.zh-CN\.md/);
  assert.match(readmeZh, /README\.md/);
  for (const text of [readme, readmeZh]) {
    assert.match(text, /lossless-claw/);
    assert.match(text, /memory-lancedb-pro/);
    assert.match(text, /ContextEngine/);
    assert.match(text, /private (?:code|storage)|私有(?:代码|存储)/i);
    assert.doesNotMatch(text, /v(?:2|3|4|5|6)\./);
    assert.doesNotMatch(text, /Mnemora Mnemos|mnemora-mnemos|mnemora-graphology/i);
  }
});

test("release workflow publishes repository-owned v1 notes after exact-commit CI", () => {
  const release = readFileSync(new URL(".github/workflows/release.yml", root), "utf8");
  assert.match(release, /docs\/releases\/v\$\{version\}\.md/);
  assert.match(release, /git merge-base --is-ancestor/);
  assert.match(release, /workflow_id: "ci\.yml"/);
});
