import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const ROOT_KEY = "MNEMORA_TEST_TEMP_ROOT", TOKEN_KEY = "MNEMORA_TEST_TEMP_TOKEN";
const MARKER = ".mnemora-test-owner";
let root, token, identity, owned = false;

function validate(directory, expectedToken) {
  const parent = fs.realpathSync(tmpdir());
  if (dirname(resolve(directory)) !== parent || !/^mnemora-tests-[a-zA-Z0-9]{6}$/.test(basename(directory)) || !/^[a-f0-9]{64}$/.test(expectedToken ?? "")) throw new Error("unsafe_test_temp_root");
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== resolve(directory) || fs.readFileSync(join(directory, MARKER), "utf8") !== expectedToken) throw new Error("unsafe_test_temp_root");
  return stat;
}

export function getTempRoot() {
  if (root) { validate(root, token); return root; }
  const inherited = process.env[ROOT_KEY];
  if (inherited) {
    token = process.env[TOKEN_KEY];
    validate(inherited, token);
    root = resolve(inherited);
  } else {
    root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "mnemora-tests-"));
    token = randomBytes(32).toString("hex");
    owned = true;
    identity = fs.lstatSync(root);
    fs.writeFileSync(join(root, MARKER), token, { flag: "wx", mode: 0o600 });
  }
  return root;
}

export function createTempDir(prefix = "fixture-") {
  if (typeof prefix !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(prefix)) throw new Error("invalid_test_temp_prefix");
  return fs.mkdtempSync(join(getTempRoot(), prefix));
}

export function tempEnvironment() {
  return { ...process.env, [ROOT_KEY]: getTempRoot(), [TOKEN_KEY]: token };
}

/** Only the process that created the root can remove it, never a child borrower. */
export function clearTempRoot() {
  if (!root || !owned) return;
  let stat;
  try { stat = fs.lstatSync(root); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (stat) {
    const parent = fs.realpathSync(tmpdir());
    if (dirname(resolve(root)) !== parent || !/^mnemora-tests-[a-zA-Z0-9]{6}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== resolve(root) || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error("unsafe_test_temp_root");
    fs.rmSync(root, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  }
  root = token = identity = undefined;
  owned = false;
}

export async function withTempRoot(operation) {
  let primary;
  try { return await operation(tempEnvironment()); }
  catch (error) { primary = error; throw error; }
  finally {
    try { clearTempRoot(); }
    catch (cleanupError) { if (primary) throw new AggregateError([primary, cleanupError], "test_operation_and_cleanup_failed", { cause: primary }); throw cleanupError; }
  }
}

/** Native database handles must leave the worker before the owner deletes files. */
export async function runInTempProcess(args) {
  let status;
  try {
    return await withTempRoot(env => {
      const result = spawnSync(process.execPath, args, { stdio: "inherit", env, windowsHide: true });
      if (result.error) throw result.error;
      status = result.status ?? 1;
      return status;
    });
  } catch (error) {
    if (status) error.operationExitCode = status;
    throw error;
  }
}

// Pure-JS direct invocations get a safety net; native fixtures use a parent runner.
process.once("exit", () => {
  try { clearTempRoot(); }
  catch { console.error("test_temp_cleanup_failed"); if (!process.exitCode) process.exitCode = 1; }
});
