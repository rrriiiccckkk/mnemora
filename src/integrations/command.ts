import { spawn } from "node:child_process";

export type CommandFailure = "unavailable" | "timeout" | "cancelled" | "output_too_large" | "invalid_response" | "operation_failed";
export class BoundedCommandError extends Error { constructor(readonly category: CommandFailure) { super(category); } }
export interface CommandRunner { run(command: string, args: readonly string[], options: { maxOutputBytes: number; deadlineAt: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number }>; }

/** A shell-free, output-bounded public command boundary for provider adapters. */
export class SpawnCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[], options: { maxOutputBytes: number; deadlineAt: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const now = Date.now(), remaining = Math.max(0, Math.trunc(options.deadlineAt - now));
      let failure: CommandFailure | undefined, settled = false;
      const finish = (callback: () => void) => { if (!settled) { settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abortExternal); callback(); } };
      const abortExternal = () => { failure = "cancelled"; controller.abort(); child.kill(); };
      const timer = setTimeout(() => { failure = "timeout"; controller.abort(); child.kill(); }, remaining);
      if (options.signal?.aborted) { clearTimeout(timer); reject(new BoundedCommandError("cancelled")); return; }
      let child: ReturnType<typeof spawn>;
      try { child = spawn(command, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal: controller.signal }); }
      catch { clearTimeout(timer); reject(new BoundedCommandError("unavailable")); return; }
      options.signal?.addEventListener("abort", abortExternal, { once: true });
      const stdout: Buffer[] = [], stderr: Buffer[] = []; let size = 0;
      const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
        if (size > options.maxOutputBytes && !failure) { failure = "output_too_large"; controller.abort(); child.kill(); return; }
        if (!failure) target.push(buffer);
      };
      child.stdout!.on("data", collect(stdout)); child.stderr!.on("data", collect(stderr));
      child.once("error", error => finish(() => {
        const category = failure ?? (error.name === "AbortError" ? "cancelled" : "unavailable");
        reject(new BoundedCommandError(category));
      }));
      child.once("close", code => finish(() => {
        if (failure) reject(new BoundedCommandError(failure));
        else if (code !== 0) reject(new BoundedCommandError("operation_failed"));
        else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code ?? 0 });
      }));
    });
  }
}
