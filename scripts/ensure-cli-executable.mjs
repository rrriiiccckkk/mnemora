import { chmodSync } from "node:fs";
import { resolve } from "node:path";

// OpenClaw may copy an unpacked plugin rather than create npm's bin shim.
// Keep the bundled CLI directly runnable on platforms that honor POSIX modes.
chmodSync(resolve("dist", "cli.js"), 0o755);
