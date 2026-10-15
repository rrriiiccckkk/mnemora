import { readFileSync, statSync } from "node:fs";
import { evaluateRecallRelevance } from "../dist/evaluation/recall-relevance-evaluation.js";
const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length || statSync(path).size > 4 * 1024 * 1024) throw new Error("Supply one evaluation JSON file of at most 4 MiB");
const input = JSON.parse(readFileSync(path, "utf8"));
console.log(JSON.stringify(evaluateRecallRelevance(input.plan, input.cases), null, 2));
