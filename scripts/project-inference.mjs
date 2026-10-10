// Public Gateway stateless model run. Never copy provider credentials, attach
// daily conversation history, or request tools/model overrides.
export function gatewayInferenceRequest(prompt, sessionId, idempotencyKey) {
  return { agentId: "main", sessionId, sessionKey: `agent:main:explicit:${sessionId}`, message: prompt, thinking: "off", modelRun: true, promptMode: "none", cleanupBundleMcpOnRunEnd: true, idempotencyKey };
}

export function providerTokenUsage(value) {
  const keys = ["input", "output", "cacheRead", "cacheWrite", "total"];
  if (!value || !keys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return null;
  const sum = value.input + value.output + value.cacheRead + value.cacheWrite;
  // A failed/empty completion can still consume reported input/cache tokens.
  // All-zero counters remain unknown: they may be a host's placeholder.
  if (!Number.isSafeInteger(sum) || sum !== value.total || value.total === 0) return null;
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

export function gatewayInferenceAnswer(result, prompt) {
  const meta = result?.result?.meta, agent = meta?.agentMeta;
  const text = result?.result?.payloads?.map(item => item.text ?? "").join("\n").trim();
  if (result?.status !== "ok" || !text || typeof agent?.provider !== "string" || !agent.provider || typeof agent?.model !== "string" || !agent.model
    || meta.finalPromptText !== prompt || meta.systemPromptReport?.systemPrompt?.chars !== 0
    || meta.executionTrace?.fallbackUsed !== false || !Array.isArray(agent.terminalReceipt?.successfulToolNames)
    || agent.terminalReceipt.successfulToolNames.length || meta.completion?.stopReason !== "stop") throw new Error("Public Gateway stateless response contract failed");
  return { text, provider: agent.provider, model: agent.model, tokenUsage: providerTokenUsage(agent.usage) };
}

// Decode reported usage before checking transport/answer success. An exited
// CLI can have returned a complete Gateway response; never accept its answer
// as successful, but do not discard valid reported counters. Partial or
// overflowing output cannot establish usage, and raw output never enters errors.
export function gatewayInferenceResult(output, exitCode, prompt, overflow = false) {
  let tokenUsage = null;
  if (overflow || typeof output !== "string" || output.length > 512000) return { tokenUsage, error: new Error("Public Gateway output exceeded its bound; usage unknown") };
  let result;
  try { result = JSON.parse(output.slice(output.indexOf("{"))); }
  catch { return { tokenUsage, error: new Error("Public Gateway returned no complete JSON response; usage unknown") }; }
  tokenUsage = providerTokenUsage(result?.result?.meta?.agentMeta?.usage);
  if (exitCode !== 0) return { tokenUsage, error: new Error("Public Gateway CLI failed; reported usage does not establish success") };
  try { return { tokenUsage, answer: gatewayInferenceAnswer(result, prompt) }; }
  catch { return { tokenUsage, error: new Error("Public Gateway stateless response contract failed") }; }
}
