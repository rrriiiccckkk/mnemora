import { performance } from "node:perf_hooks";
import { GraphologyStore } from "../dist/index.js";

const requested = process.env.MNEMORA_INGESTION_BENCHMARK_SIZES?.split(",").map(value => Number(value.trim())).filter(Number.isSafeInteger);
const sizes = requested?.length ? requested.filter(value => [10_000, 50_000, 100_000].includes(value)) : [10_000, 50_000, 100_000];
if (!sizes.length) throw new Error("MNEMORA_INGESTION_BENCHMARK_SIZES must select 10000,50000, or 100000");
const batchSize = 50;
const report = [];
for (const size of sizes) {
  const store = new GraphologyStore(":memory:");
  try {
    const started = performance.now(); let inserted = 0;
    for (let offset = 0; offset < size; offset += batchSize) {
      const count = Math.min(batchSize, size - offset);
      const entities = Array.from({ length: count }, (_, index) => {
        const n = offset + index;
        return { name: `Benchmark Entity ${n}`, type: "company", confidence: .8, evidence_span: `benchmark entity ${n}` };
      });
      store.ingest(entities, [], `benchmark:ingestion:${offset}`);
      inserted += count;
    }
    const elapsed = performance.now() - started;
    const total = store.stats().nodes.total;
    if (total !== size || inserted !== size) throw new Error(`ingestion benchmark persistence mismatch: ${total}/${size}`);
    const result = { nodes: size, batch_size: batchSize, elapsed_ms: Math.round(elapsed), nodes_per_second: Math.round(size / (elapsed / 1000)) };
    report.push(result); console.log(JSON.stringify({ benchmark: "sustained-ingestion-v1", completed: result }));
  } finally { store.close(); }
}
console.log(JSON.stringify({ benchmark: "sustained-ingestion-v1", data_shape: "unique company entity observations, 50-item transaction batches, in-memory SQLite", results: report }, null, 2));
// @photostructure/sqlite may retain native cleanup handles after a large
// in-memory run. This is a one-shot benchmark, so terminate only after every
// result has been printed and every store has been closed above.
process.exit(0);
