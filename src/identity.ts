import { homedir } from "node:os";
import { resolve } from "node:path";

export const PRODUCT_NAME = "Mnemora";
export const CANONICAL_IDENTIFIER = "mnemora";
export const CANONICAL_DEFAULT_DATABASE = "~/.openclaw/mnemora.db";

/** Expand only a conventional leading home marker; all other paths stay local caller input. */
export function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

/** Mnemora has one database identity. A fresh installation never probes or adopts another plugin's storage. */
export function resolveDatabasePath(input?: string): string {
  return typeof input === "string" && input.trim() ? input.trim() : CANONICAL_DEFAULT_DATABASE;
}
