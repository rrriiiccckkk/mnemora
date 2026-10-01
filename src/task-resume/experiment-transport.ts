export async function callExperimentModel(
  request: { model: string; temperature: number; max_tokens: number; messages: { role: "system" | "user"; content: string }[] },
  options: { endpoint: string; apiKey: string; timeoutMs: number; fetch?: typeof fetch }
): Promise<unknown> {
  const failure = () => new Error("experiment_model_call_failed");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let signal: AbortSignal | undefined, onAbort: (() => void) | undefined;
  const cancel = () => { try { void reader?.cancel().catch(() => {}); } catch { /* cleanup must not leak provider errors */ } };
  try {
    const endpoint = new URL(options.endpoint);
    if (!/^https:\/\//iu.test(options.endpoint) || /[\s?#]/u.test(options.endpoint)
      || endpoint.protocol !== "https:" || !endpoint.hostname || endpoint.username || endpoint.password
      || /^https:\/\/[^/]*@/iu.test(options.endpoint)
      || !options.apiKey.trim() || options.apiKey !== options.apiKey.trim() || /[\r\n]/u.test(options.apiKey)
      || !Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) throw failure();
    signal = AbortSignal.timeout(options.timeoutMs);
    const timeoutSignal = signal;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { cancel(); reject(failure()); };
      timeoutSignal.addEventListener("abort", onAbort, { once: true });
    });
    const operation = async () => {
      const response = await (options.fetch ?? fetch)(options.endpoint, {
        method: "POST", redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ model: request.model, temperature: request.temperature, max_tokens: request.max_tokens, messages: request.messages.map(({ role, content }) => ({ role, content })) }), signal: timeoutSignal
      });
      if (!response.body) throw failure();
      reader = response.body.getReader();
      try {
        timeoutSignal.throwIfAborted();
        if (!response.ok || response.redirected) throw failure();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0, text = "";
        while (true) {
          timeoutSignal.throwIfAborted();
          const chunk = await reader.read();
          timeoutSignal.throwIfAborted();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 4 * 1024 * 1024) throw failure();
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        if (text.includes(options.apiKey)) throw failure();
        const payload: unknown = JSON.parse(text);
        // Check decoded strings and property names too: JSON escaping must not
        // let a malicious endpoint smuggle a credential into persisted results.
        const pending: unknown[] = [payload];
        while (pending.length) {
          const value = pending.pop();
          if (typeof value === "string" && value.includes(options.apiKey)) throw failure();
          if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
            if (key.includes(options.apiKey)) throw failure();
            pending.push(item);
          }
        }
        return payload;
      } catch { cancel(); throw failure(); }
      finally { reader.releaseLock(); }
    };
    return await Promise.race([operation(), aborted]);
  } catch { cancel(); throw failure(); }
  finally { if (signal && onAbort) signal.removeEventListener("abort", onAbort); }
}
