import test from "node:test";
import assert from "node:assert/strict";
import { supportsNodeVersion } from "../scripts/node-compat.mjs";
import { readFileSync } from "node:fs";
test("Node compatibility allows 26 and newer majors while preserving SQLite patch boundaries", () => {
  for (const version of ["24.15.0", "24.21.0", "25.9.0", "26.0.0", "26.5.0", "27.0.0"]) assert.equal(supportsNodeVersion(version), true, version);
  for (const version of ["22.22.3", "24.14.0", "25.8.9", "invalid", "26.5.0-rc.1"]) assert.equal(supportsNodeVersion(version), false, version);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.engines.node, ">=24.15.0 <25 || >=25.9.0");
});
