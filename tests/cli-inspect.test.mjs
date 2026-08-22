import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("inspect rejects unknown flags without starting", async()=>{
  const child=spawn(process.execPath,["dist/cli.js","inspect","--unknown"],{env:{...process.env,MNEMORA_DB:":memory:"},stdio:["ignore","pipe","pipe"]});let stderr="";child.stderr.on("data",c=>stderr+=c);const [code]=await once(child,"exit");assert.equal(code,1);assert.match(stderr,/unknown option/);
});

test("inspect prints only loopback bootstrap metadata and closes on SIGINT",async()=>{
  const child=spawn(process.execPath,["dist/cli.js","inspect"],{env:{...process.env,MNEMORA_DB:":memory:"},stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";child.stdout.on("data",c=>stdout+=c);child.stderr.on("data",c=>stderr+=c);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("startup timeout")),5000);child.stdout.on("data",()=>{if(stdout.includes("bootstrap=")){clearTimeout(timer);resolve();}});});
  assert.match(stdout,/http:\/\/127\.0\.0\.1:\d+\/#bootstrap=/);assert.doesNotMatch(stdout+stderr,/mnemora-(?:graphology|mnemora)\.db|artifact|Users\\|\/home\//i);
  child.kill("SIGINT");const [code,signal]=await once(child,"exit");assert.ok(code===0||signal==="SIGINT");
});
