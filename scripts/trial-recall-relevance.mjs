import { readFileSync, statSync } from "node:fs";
import { RecallRelevanceShadow } from "../dist/retrieval/relevance-shadow.js";
const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length || statSync(path).size > 65536) throw new Error("Supply one synthetic/deidentified trial JSON file of at most 64 KiB");
const input = JSON.parse(readFileSync(path, "utf8"));
if (input.evidence !== "synthetic" || typeof input.query !== "string" || input.query.length > 512 || !Array.isArray(input.candidates) || input.candidates.length > 8 || input.candidates.some(c => !c || typeof c.title !== "string" || typeof c.excerpt !== "string" || c.title.length + c.excerpt.length > 2000)) throw new Error("Invalid bounded synthetic trial input");
const candidates = input.candidates.map((c, i) => ({ contextRef: `trial:${i}`, kind: "memory-document", scope: "isolated:relevance-trial", title: c.title, excerpt: c.excerpt, estimatedTokens: 0, bytes: 0, score: 1, sourceIds: [], sourceRefs: [], authority: "unknown", confidence: 1, freshness: 1, selectionReason: "lexical_match" }));
const timeoutMs = process.env.MNEMORA_RELEVANCE_TIMEOUT_MS === undefined ? 3000 : Number(process.env.MNEMORA_RELEVANCE_TIMEOUT_MS);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error("Trial timeout must be an integer between 100 and 10000 ms");
const service = new RecallRelevanceShadow({ enabled: true, endpoint: process.env.MNEMORA_RELEVANCE_ENDPOINT, model: process.env.MNEMORA_RELEVANCE_MODEL, apiKey: process.env.MNEMORA_RELEVANCE_API_KEY, timeoutMs });
const result = await service.evaluate("isolated:relevance-trial", input.query, candidates);
// No database, host config, excerpts, credentials or raw provider output are persisted.
console.log(JSON.stringify({ evidence: "synthetic", qualityEvidence: false, observation: result.observation }, null, 2));
if (result.observation.status !== "succeeded") process.exitCode = 2;
