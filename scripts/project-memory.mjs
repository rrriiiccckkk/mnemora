import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export function projectArguments(args) {
  const [command, ...rest] = args;
  if (command === "status" && rest.length === 0) return ["--project", "--status"];
  if (command === "ask" && rest.length === 2 && ["--message", "--file"].includes(rest[0]) && rest[1].trim()) {
    if (rest[0] === "--message" && rest[1].length > 12000) throw new Error("Project message exceeds 12000 characters");
    return ["--project", ...rest];
  }
  throw new Error('Usage: npm run dev:memory -- status | ask --message "text" | ask --file path');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = projectArguments(process.argv.slice(2));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("test-openclaw-host.mjs", import.meta.url)), ...args], { stdio: "inherit", env: process.env });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
