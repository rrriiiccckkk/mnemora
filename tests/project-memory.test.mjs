import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { projectArguments } from "../scripts/project-memory.mjs";

test("project entry rejects ambiguous inputs before any provider call or state allocation", () => {
  for (const args of [[], ["unknown"], ["status", "--message", "x"], ["ask"], ["ask", "--message", " "], ["ask", "--message", "x", "--file", "y"], ["ask", "--message", "x".repeat(12001)]]) assert.throws(() => projectArguments(args));
  const child = spawnSync(process.execPath, ["scripts/project-memory.mjs", "ask", "--message", ""], { encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Usage:/);
  assert.doesNotMatch(child.stdout, /Host test artifacts|OpenClaw/);
});

test("project entry passes messages literally without shell interpretation", () => {
  const message = 'Line 1\n$(echo secret) `command` "quoted"';
  assert.deepEqual(projectArguments(["ask", "--message", message]), ["--project", "--message", message]);
  assert.deepEqual(projectArguments(["ask", "--file", "project note.md"]), ["--project", "--file", "project note.md"]);
  assert.deepEqual(projectArguments(["status"]), ["--project", "--status"]);
});
