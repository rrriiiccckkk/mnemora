// Public Gateway stateless model run. Never copy provider credentials, attach
// daily conversation history, or request tools/model overrides.
export function gatewayInferenceRequest(prompt, sessionId, idempotencyKey) {
  return { agentId: "main", sessionId, sessionKey: `agent:main:explicit:${sessionId}`, message: prompt, thinking: "off", modelRun: true, promptMode: "none", cleanupBundleMcpOnRunEnd: true, idempotencyKey };
}

export function providerTokenUsage(value) {
  const keys = ["input", "output", "cacheRead", "cacheWrite", "total"];
  if (!value || !keys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return null;
  const sum = value.input + value.output + value.cacheRead + value.cacheWrite;
  if (!Number.isSafeInteger(sum) || sum !== value.total || value.total === 0 || value.output === 0) return null;
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
