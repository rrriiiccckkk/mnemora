import { CognitionGraduationService, FormationService, GraphologyStore, ReflectionService } from "../dist/index.js";

let now = 1_700_000_000_000;
const store = new GraphologyStore(":memory:");
try {
  const formation = new FormationService(store.db, () => ++now, { mode: "enforce", beliefs: { enabled: true, autoCorroborate: true } });
  formation.observe({ scope: "benchmark", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "fixture:1", content: "I prefer concise technical explanations." });
  formation.observe({ scope: "benchmark", origin: "memory_store", authority: "user_explicit_preference", kind: "memory_document", source: "fixture:2", content: "I prefer concise technical explanations." });
  const beliefsBefore = Number(store.db.prepare("SELECT COUNT(*) AS count FROM mnemora_beliefs").get().count);
  const reflection = new ReflectionService(store.db, () => ++now), preview = reflection.preview({ scope: "benchmark", staleAfterDays: 3650 });
  reflection.runPreview({ scope: "benchmark", previewHash: preview.preview_hash, staleAfterDays: 3650 });
  const beliefsAfter = Number(store.db.prepare("SELECT COUNT(*) AS count FROM mnemora_beliefs").get().count);
  const report = new CognitionGraduationService(store.db, { enabled: true, formationShadow: true, admissionMode: "enforce", beliefsEnabled: true, contextCompilerEnabled: true, reflectionEnabled: true }).status("benchmark");
  const metrics = { audit_integrity: report.audit.valid, restart_recovery_ready: report.gates.restart_recovery_ready, unsafe_promotion_rate: beliefsAfter === beliefsBefore ? 0 : 1, reflection_candidates: preview.candidates.length, explicit_configuration: report.gates.explicit_configuration };
  console.log(JSON.stringify({ benchmark: "cognition-graduation-c8-v1", metrics, passed: report.ready && metrics.unsafe_promotion_rate === 0 }, null, 2));
  if (!report.ready || metrics.unsafe_promotion_rate !== 0) process.exitCode = 1;
} finally { store.close(); }
