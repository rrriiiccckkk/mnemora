import { createHash, randomBytes as systemRandomBytes, timingSafeEqual } from "node:crypto";

export interface InspectorSession {
  bootstrap: string;
  session: string;
  csrf: string;
  bootstrapped: boolean;
}

export function createInspectorSession(randomBytes: (size: number) => Buffer = systemRandomBytes): InspectorSession {
  return { bootstrap: secret(randomBytes), session: secret(randomBytes), csrf: secret(randomBytes), bootstrapped: false };
}

export function consumeBootstrap(state: InspectorSession, candidate: unknown): boolean {
  if (state.bootstrapped || typeof candidate !== "string" || !equal(candidate, state.bootstrap)) return false;
  state.bootstrapped = true;
  state.bootstrap = "";
  return true;
}

export function validSession(state: InspectorSession, cookie: string | undefined): boolean {
  if (!state.bootstrapped || !cookie) return false;
  const value = cookie.split(";").map(part => part.trim()).find(part => part.startsWith("mnemora_inspector="))?.slice(18);
  return typeof value === "string" && equal(value, state.session);
}

export function validCsrf(state: InspectorSession, value: string | undefined): boolean { return typeof value === "string" && equal(value, state.csrf); }
export function sessionCookie(state: InspectorSession): string { return `mnemora_inspector=${state.session}; HttpOnly; SameSite=Strict; Path=/`; }

function secret(randomBytes: (size: number) => Buffer): string {
  const value = randomBytes(32);
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error("inspector entropy unavailable");
  return value.toString("base64url");
}
function equal(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest(), b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}
