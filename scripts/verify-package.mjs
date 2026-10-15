import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDistribution } from "./package-artifact.mjs";
if (process.argv.length > 3) throw new Error("Usage: node scripts/verify-package.mjs [package-directory]");
console.log(JSON.stringify({ verified: verifyDistribution(resolve(process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url)))) }));
