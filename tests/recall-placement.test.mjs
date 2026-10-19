import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createTempDir } from "./helpers/temp.mjs";
import { normalizeConfig } from "../dist/config.js";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { placeRecallBeforeUserMessage, stripRecallPackets } from "../dist/context-engine/message-safety.js";
import { Mnemora } from "../dist/index.js";
import { recallText } from "./helpers/recall.mjs";

const { payloads } = JSON.parse(readFileSync(new URL("./fixtures/memory-poisoning.json", import.meta.url), "utf8"));

function fixture(contextEngine = {}) {
  const dbPath = join(createTempDir("mnemora-recall-placement-"), "memory.db");
  const config = normalizeConfig({ dbPath, contextEngine: { enabled: true, maxContextTokens: 4096, ...contextEngine }, unifiedRetrieval: { enabled: true, tokenBudget: 1200 } });
  const open = () => new Mnemora({ config, extractor: { async extract() { return { entities: [], relations: [] }; } } });
  return { config, open, engine: new MnemoraContextEngine(config, open) };
}

const seed = async engine => engine.ingest({ sessionId: "old", message: { role: "user", content: "I use Adobe Premiere Pro for video editing and enjoy its advanced settings." } });
const ask = (engine, content = "Can you recommend resources for video editing?") => {
  const current = { id: "current", role: "user", content };
  return { current, result: engine.assemble({ sessionId: "new", prompt: typeof content === "string" ? content : "Can you recommend resources for video editing?", messages: [{ role: "system", content: "host policy" }, current], tokenBudget: 4096 }) };
};

test("config defaults recall placement to the user turn and accepts system", () => {
  assert.equal(normalizeConfig({}).contextEngine.recallPlacement, "user");
  assert.equal(normalizeConfig({ contextEngine: { recallPlacement: "system" } }).contextEngine.recallPlacement, "system");
  assert.equal(normalizeConfig({ contextEngine: { recallPlacement: "elsewhere" } }).contextEngine.recallPlacement, "user");
});

test("by default the packet goes just before the active user message, not the system prompt", async () => {
  const { engine } = fixture();
  await seed(engine);
  const { current, result } = ask(engine);
  const assembled = await result;
  assert.equal("systemPromptAddition" in assembled, false);
  const last = assembled.messages.at(-1);
  assert.notEqual(last, current, "host message objects are copied, never mutated");
  assert.equal(current.content, "Can you recommend resources for video editing?");
  assert.match(last.content, /^<MNEMORA_MEMORY authority="non_authoritative">[\s\S]*Premiere Pro[\s\S]*<\/MNEMORA_MEMORY>\n\nCan you recommend resources for video editing\?$/);
  assert.deepEqual(assembled.messages[0], { role: "system", content: "host policy" });
});

test("recallPlacement system keeps the packet in the system prompt addition at the same token cost", async () => {
  const user = fixture(), system = fixture({ recallPlacement: "system" });
  await seed(user.engine); await seed(system.engine);
  const placed = await ask(user.engine).result, added = await ask(system.engine).result;
  assert.match(added.systemPromptAddition ?? "", /Premiere Pro/);
  assert.equal(added.messages.at(-1).content, "Can you recommend resources for video editing?");
  const stable = text => text.replace(/ref=[^;]+; role=(\w+); recorded_at=[^\n]+/g, "role=$1");
  assert.equal(stable(recallText(placed)), stable(added.systemPromptAddition));
  assert.equal(placed.estimatedTokens, added.estimatedTokens);
});

test("structured user content gets the packet as a leading text part", async () => {
  const { engine } = fixture();
  await seed(engine);
  const parts = [{ type: "text", text: "Can you recommend resources for video editing?" }];
  const assembled = await ask(engine, parts).result;
  const content = assembled.messages.at(-1).content;
  assert.equal(content.length, 2);
  assert.match(content[0].text, /^<MNEMORA_MEMORY[\s\S]*Premiere Pro/);
  assert.deepEqual(content[1], parts[0]);
});

test("placement falls back when there is no user message or its content is unknown", () => {
  assert.equal(placeRecallBeforeUserMessage([{ role: "system", content: "policy" }], "<MNEMORA_MEMORY>x</MNEMORA_MEMORY>"), undefined);
  assert.equal(placeRecallBeforeUserMessage([{ role: "user", content: { opaque: true } }], "<MNEMORA_MEMORY>x</MNEMORA_MEMORY>"), undefined);
  const messages = [{ role: "user", content: "first" }, { role: "assistant", content: "reply" }, { role: "user", content: "second" }, { role: "assistant", content: "tool call" }];
  const placed = placeRecallBeforeUserMessage(messages, "<MNEMORA_MEMORY>x</MNEMORA_MEMORY>");
  assert.equal(placed[0], messages[0]);
  assert.equal(placed[2].content, "<MNEMORA_MEMORY>x</MNEMORA_MEMORY>\n\nsecond");
  assert.equal(messages[2].content, "second");
});

test("a captured user turn that carries a placed packet is journaled without it", async () => {
  const { engine, open } = fixture();
  await seed(engine);
  const placedTurn = (await ask(engine).result).messages.at(-1);
  await engine.ingest({ sessionId: "replay", message: placedTurn });
  const graph = open();
  try {
    const rows = graph.store.db.prepare("SELECT session_id, normalized_text FROM mnemora_conversation_events WHERE session_id = ?").all("replay");
    assert.deepEqual(rows.map(row => row.normalized_text), ["Can you recommend resources for video editing?"]);
  } finally { graph.close(); }
});

for (const payload of payloads) {
  test(`stripping a placed packet removes all of it even with hostile records: ${payload.id}`, async () => {
    const { engine } = fixture();
    await engine.ingest({ sessionId: "source", message: { role: "user", content: payload.text } });
    const assembled = await engine.assemble({ sessionId: "later", prompt: "Useful migration note", messages: [{ role: "user", content: "Useful migration note" }], tokenBudget: 4096 });
    const content = assembled.messages.at(-1).content;
    assert.match(content, /POISON_CANARY/);
    assert.equal(stripRecallPackets(content), "Useful migration note");
  });
}
