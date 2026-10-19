/** The recall packet of an assemble result, wherever it was placed: the
 * system prompt addition, or the start of the active user message (default
 * since 1.37). Undefined when nothing was attached. */
export function recallText(result) {
  if (!result) return undefined;
  if (typeof result.systemPromptAddition === "string") return result.systemPromptAddition;
  const messages = Array.isArray(result.messages) ? result.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message?.role ?? "").toLowerCase() !== "user") continue;
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) && message.content[0]?.type === "text" ? message.content[0].text : "";
    const match = /^<MNEMORA_MEMORY\b[\s\S]*?<\/MNEMORA_MEMORY>/.exec(text ?? "");
    return match ? match[0] : undefined;
  }
  return undefined;
}

/** The active user message as the host sent it, without a placed packet. */
export function withoutRecall(message) {
  if (!message || typeof message.content !== "string") return message;
  return { ...message, content: message.content.replace(/^<MNEMORA_MEMORY\b[\s\S]*?<\/MNEMORA_MEMORY>\n\n/, "") };
}
