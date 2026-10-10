import { providerTokenUsage } from "./project-inference.mjs";
// Allowlisted telemetry: never retain prompts, replies, credentials or proxy usage.
export function projectMeasurement(id, pluginVersion, elapsedMs, succeeded, calls) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("Invalid elapsed time");
  const inference = calls.map(call => {
    if (!Number.isFinite(call.elapsedMs) || call.elapsedMs < 0 || !Number.isSafeInteger(call.inputChars) || call.inputChars < 0) throw new Error("Invalid inference measurement");
    const tokenUsage = call.usageSource === "public_gateway_agent_meta" ? providerTokenUsage(call.tokenUsage) : null;
    const memory = {};
    for (const key of ["memoryChars", "forwardedMemoryChars"]) if (call[key] !== undefined) {
      if (!Number.isSafeInteger(call[key]) || call[key] < 0) throw new Error("Invalid memory size measurement");
      memory[key] = call[key];
    }
    return { status: call.status === "succeeded" ? "succeeded" : "failed", elapsedMs: Math.round(call.elapsedMs), inputChars: call.inputChars, ...memory, responseValidation: call.responseValidation === "request_bound" ? "request_bound" : "not_validated", tokenUsage, ...(tokenUsage ? { usageSource: "public_gateway_agent_meta" } : { tokenUsageUnavailableReason: "Missing or invalid public Gateway provider usage; proxy counts are synthetic" }) };
  });
  let tokenUsage = null;
  if (inference.length && inference.every(call => call.tokenUsage)) {
    const aggregate = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "total"].map(key => [key, inference.reduce((sum, call) => sum + call.tokenUsage[key], 0)]));
    tokenUsage = providerTokenUsage(aggregate);
  }
  return {
    schema: "project-measurement.v2", id, pluginVersion,
    at: new Date().toISOString(), status: succeeded ? "succeeded" : "failed",
    elapsedMs: Math.round(elapsedMs),
    inference, tokenUsage,
    ...(tokenUsage ? { usageSource: "public_gateway_agent_meta" } : { tokenUsageUnavailableReason: "At least one call has missing/invalid public Gateway provider usage, aggregate overflow, or no calls were measured" }),
  };
}
