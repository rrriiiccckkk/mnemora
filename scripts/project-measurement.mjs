// Allowlisted telemetry: never retain prompts, replies, credentials or proxy usage.
export function projectMeasurement(id, pluginVersion, elapsedMs, succeeded, calls) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("Invalid elapsed time");
  return {
    schema: "project-measurement.v1", id, pluginVersion,
    at: new Date().toISOString(), status: succeeded ? "succeeded" : "failed",
    elapsedMs: Math.round(elapsedMs),
    inference: calls.map(call => {
      if (!Number.isFinite(call.elapsedMs) || call.elapsedMs < 0 || !Number.isSafeInteger(call.inputChars) || call.inputChars < 0) throw new Error("Invalid inference measurement");
      return { status: call.status === "succeeded" ? "succeeded" : "failed", elapsedMs: Math.round(call.elapsedMs), inputChars: call.inputChars };
    }),
    tokenUsage: null,
    tokenUsageUnavailableReason: "Public stateless inference does not expose provider token usage; proxy counts are synthetic",
  };
}
