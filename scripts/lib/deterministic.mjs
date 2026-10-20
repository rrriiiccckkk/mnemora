// Deterministic process state for repeatable recall evaluations.
//
// Mnemora names records with crypto.randomUUID() and stamps them with
// Date.now(); ranking breaks exact score ties by record reference, so random
// ids and a running clock make two runs over the same data differ by a
// question or two. An evaluation that has to compare runs (the CI retrieval
// gate) seeds the ids and drives the clock by call count instead.
//
// Import this module before anything from dist/: it rewrites node:crypto's
// randomUUID and syncs the ESM named exports, so `import { randomUUID } from
// "node:crypto"` in Mnemora's modules sees the seeded version.
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";

const nodeCrypto = createRequire(import.meta.url)("node:crypto");
const systemRandomUUID = nodeCrypto.randomUUID;
const systemNow = Date.now;
let seed, counter = 0;

/** A version-4-shaped UUID derived from `seed` and a counter. */
export function seededUUID(value, index) {
  const hex = createHash("sha256").update(`${value}\0${index}`).digest("hex");
  const variant = (8 | (Number.parseInt(hex[16], 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

nodeCrypto.randomUUID = () => seed === undefined ? systemRandomUUID() : seededUUID(seed, counter++);
syncBuiltinESMExports();

/**
 * Seed ids with `name` and start a clock at `startMs` that advances 1 ms per
 * call (monotonic, independent of machine speed). Returns a function that
 * restores the system clock and random ids.
 */
export function enterDeterministic(name, startMs) {
  seed = String(name); counter = 0;
  let tick = 0;
  Date.now = () => startMs + tick++;
  return () => { seed = undefined; Date.now = systemNow; };
}
