import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createTempDir } from "./helpers/temp.mjs";

const helper = new URL("./helpers/temp.mjs", import.meta.url).href;
const runner = new URL("../scripts/run-unit-tests.mjs", import.meta.url).href;
const smoke = new URL("../scripts/smoke-test.mjs", import.meta.url).href;
const store = new URL("../dist/store.js", import.meta.url).href;
const imports = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import {basename,dirname,join} from 'node:path'; import {createTempDir,getTempRoot,clearTempRoot,tempEnvironment,withTempRoot} from ${JSON.stringify(helper)};`;
function run(code, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.MNEMORA_TEST_TEMP_ROOT; delete env.MNEMORA_TEST_TEMP_TOKEN;
  if (extra.MNEMORA_TEST_TEMP_ROOT) { env.MNEMORA_TEST_TEMP_ROOT = extra.MNEMORA_TEST_TEMP_ROOT; env.MNEMORA_TEST_TEMP_TOKEN = extra.MNEMORA_TEST_TEMP_TOKEN; }
  return spawnSync(process.execPath, ["--input-type=module", "-e", imports + code], { encoding: "utf8", env, timeout: 30000 });
}
function success(result) { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim().split("\n").at(-1)); }

test("temporary fixtures are unique, below the system temp root, and cleaned on success", () => {
  const result = success(run(`const state=await withTempRoot(()=>{const root=getTempRoot(),a=createTempDir('a-'),b=createTempDir('a-');assert.notEqual(a,b);fs.writeFileSync(join(a,'probe'),'ok');for(const prefix of ['../escape','/absolute','', 'a/b'])assert.throws(()=>createTempDir(prefix),/invalid_test_temp_prefix/);return {root,a,b};});assert.equal(fs.existsSync(state.root),false);clearTempRoot();clearTempRoot();console.log(JSON.stringify(state));`));
  assert.equal(dirname(result.root), fs.realpathSync(tmpdir()));
  assert.equal(fs.existsSync(result.a), false);
  assert.equal(fs.existsSync(result.b), false);
});

test("operation failure cleans fixtures and preserves the original error", () => {
  success(run(`const primary=new Error('primary'),state={};await assert.rejects(withTempRoot(()=>{state.root=getTempRoot();createTempDir();throw primary;}),error=>error===primary);assert.equal(fs.existsSync(state.root),false);console.log('{}');`));
});

test("a borrower cannot delete the parent-owned root", () => {
  success(run(`const {spawnSync}=await import('node:child_process');await withTempRoot(()=>{const root=getTempRoot();const child=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(imports)}+'createTempDir();clearTempRoot();assert.equal(fs.existsSync(getTempRoot()),true);'],{encoding:'utf8',env:tempEnvironment()});assert.equal(child.status,0,child.stderr);assert.equal(fs.existsSync(root),true);});console.log('{}');`));
});

test("arbitrary inherited directories are rejected without deleting their data", () => {
  const directory = createTempDir("unrelated-"), sentinel = join(directory, "sentinel");
  fs.writeFileSync(sentinel, "keep");
  const result = run(`assert.throws(()=>getTempRoot(),/unsafe_test_temp_root/);clearTempRoot();console.log('{}');`, { MNEMORA_TEST_TEMP_ROOT: directory, MNEMORA_TEST_TEMP_TOKEN: "0".repeat(64) });
  success(result);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
});

test("a replaced root junction is refused and unrelated target files survive", () => {
  const target = createTempDir("junction-target-"), sentinel = join(target, "sentinel");
  fs.writeFileSync(sentinel, "keep");
  success(run(`const root=getTempRoot(),backup=root+'-owned-backup',target=process.env.TARGET;assert.equal(dirname(backup),dirname(root));assert.match(basename(root),/^mnemora-tests-[a-zA-Z0-9]{6}$/);fs.renameSync(root,backup);try{fs.symlinkSync(target,root,process.platform==='win32'?'junction':'dir');assert.throws(()=>clearTempRoot(),/unsafe_test_temp_root/);assert.throws(()=>createTempDir(),/unsafe_test_temp_root/);}finally{if(fs.lstatSync(root).isSymbolicLink())fs.unlinkSync(root);fs.renameSync(backup,root);clearTempRoot();}console.log('{}');`, { TARGET: target }));
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
});

test("cleanup failure is visible and cannot hide an earlier operation failure", () => {
  success(run(`const original=fs.rmSync,primary=new Error('primary'),cleanup=new Error('cleanup');let root;fs.rmSync=()=>{throw cleanup;};try{await assert.rejects(withTempRoot(()=>{root=getTempRoot();throw primary;}),error=>error instanceof AggregateError&&error.cause===primary&&error.errors[0]===primary&&error.errors[1]===cleanup);await assert.rejects(withTempRoot(()=>42),error=>error===cleanup);}finally{fs.rmSync=original;clearTempRoot();}assert.equal(fs.existsSync(root),false);console.log('{}');`));
});

for (const fail of [false, true]) test(`unit runner cleans child fixtures after ${fail ? "failed" : "successful"} tests`, () => {
  const directory = createTempDir("runner-probe-"), file = join(directory, "probe.test.mjs"), witness = join(directory, "witness.json");
  fs.writeFileSync(file, `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createTempDir,getTempRoot} from ${JSON.stringify(helper)};test('probe',()=>{const fixture=createTempDir();fs.writeFileSync(${JSON.stringify(witness)},JSON.stringify({root:getTempRoot(),fixture}));assert.equal(${fail},false);});`);
  const result = run(`const {runUnitTests}=await import(${JSON.stringify(runner)});process.exitCode=await runUnitTests([${JSON.stringify(file)}]);`);
  assert.equal(result.status, fail ? 1 : 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(witness, "utf8"));
  assert.equal(fs.existsSync(state.root), false);
  assert.equal(fs.existsSync(state.fixture), false);
  assert.equal(fs.existsSync(file), true);
});

test("unit runner retains the test exit code when its cleanup also fails", () => {
  success(run(`const {runUnitTests}=await import(${JSON.stringify(runner)});const original=fs.rmSync;fs.rmSync=()=>{throw new Error('cleanup');};try{await assert.rejects(runUnitTests(['missing-owned-test-file.test.mjs']),error=>error.testExitCode===1);}finally{fs.rmSync=original;clearTempRoot();}console.log('{}');`));
});

for (const fail of [false, true]) test(`unit runner removes native SQLite fixtures after a ${fail ? "failed" : "successful"} worker exits`, () => {
  const directory = createTempDir("native-probe-"), file = join(directory, "native.test.mjs"), witness = join(directory, "witness.json");
  fs.writeFileSync(file, `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';import {GraphologyStore} from ${JSON.stringify(store)};import {createTempDir,getTempRoot} from ${JSON.stringify(helper)};test('native probe',()=>{const fixture=createTempDir();const graph=new GraphologyStore(join(fixture,'probe.db'));try{graph.db.prepare('SELECT 1 AS value').get();fs.writeFileSync(${JSON.stringify(witness)},JSON.stringify({root:getTempRoot(),fixture}));assert.equal(${fail},false);}finally{graph.close();}});`);
  const result = run(`const {runUnitTests}=await import(${JSON.stringify(runner)});process.exitCode=await runUnitTests([${JSON.stringify(file)}]);`);
  assert.equal(result.status, fail ? 1 : 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(witness, "utf8"));
  assert.equal(fs.existsSync(state.root), false);
  assert.equal(fs.existsSync(state.fixture), false);
  assert.equal(fs.existsSync(file), true);
});

test("direct failed-process exit also cleans its owned fixtures", () => {
  const witness = join(createTempDir("exit-probe-"), "witness.json");
  const result = run(`const root=getTempRoot();createTempDir();fs.writeFileSync(process.env.WITNESS,JSON.stringify({root}));process.exit(13);`, { WITNESS: witness });
  assert.equal(result.status, 13, result.stderr);
  assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(witness, "utf8")).root), false);
});

test("smoke success closes its resources and removes owned fixtures", () => {
  success(run(`const {runSmoke}=await import(${JSON.stringify(smoke)});const root=getTempRoot();await runSmoke();assert.equal(fs.existsSync(root),false);console.log('{}');`));
});

for (const cleanupFail of [false, true]) test(`smoke initialization failure cleans fixtures${cleanupFail ? " and retains shutdown failure evidence" : ""}`, () => {
  success(run(`const {runSmokeScenario}=await import(${JSON.stringify(smoke)});const primary=new Error('registration-failed'),cleanup=new Error('shutdown-failed'),root=getTempRoot();let url;await assert.rejects(withTempRoot(()=>runSmokeScenario({registerPlugin(api){url=api.pluginConfig.llm.baseURL;${cleanupFail ? "api.on('gateway_stop',()=>{throw cleanup;});" : ""}throw primary;}})),error=>${cleanupFail ? "error instanceof AggregateError&&error.cause===primary&&error.errors[0]===primary&&error.errors[1]===cleanup" : "error===primary"});assert.equal(fs.existsSync(root),false);await assert.rejects(fetch(url,{signal:AbortSignal.timeout(1000)}));console.log('{}');`));
});

test("test and benchmark fixtures cannot regress to raw temp allocation or repo .tmp writes", () => {
  for (const directory of ["tests", "scripts"]) for (const filename of fs.readdirSync(directory).filter(name => name.endsWith(".mjs") && name !== "temp-hygiene.test.mjs")) {
    const path = join(directory, filename), source = fs.readFileSync(path, "utf8"), parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function scan(node) {
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) for (const item of node.importClause.namedBindings.elements) assert.ok(!["mkdtempSync", "mkdtemp", "tmpdir"].includes((item.propertyName ?? item.name).text), `raw temp import in ${path}`);
      if (ts.isCallExpression(node)) assert.ok(!node.arguments.some(arg => ts.isStringLiteral(arg) && arg.text === ".tmp"), `repo temp allocation in ${path}`);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) assert.ok(!["mkdtempSync", "mkdtemp", "tmpdir"].includes(node.expression.name.text), `raw temp call in ${path}`);
      ts.forEachChild(node, scan);
    }
    scan(parsed);
  }
});
