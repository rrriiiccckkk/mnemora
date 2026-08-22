import { basename } from "node:path";

/** USER.md is an explicit external profile boundary, never an implicit graph source. */
export function isExclusiveUserMdPath(path: string, enabled: boolean): boolean {
  return enabled && basename(path).trim().toLowerCase() === "user.md";
}

/** Source labels are defensive metadata, not a substitute for path validation. */
export function isExclusiveUserMdSource(source: string, enabled: boolean): boolean {
  if (!enabled || !source.startsWith("file:")) return false;
  return basename(source.slice("file:".length)).trim().toLowerCase() === "user.md";
}
