import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInspectorSession, consumeBootstrap, sessionCookie, validCsrf, validSession } from "./auth.js";
import { inspectorRoutes, json, type InspectorGraphApi } from "./routes.js";

export interface StartInspectorOptions { graph: InspectorGraphApi; allowOperations: boolean; port?: number; now?: () => number; randomBytes?: (size: number) => Buffer; }
export interface RunningInspector { url: string; close(): Promise<void>; }
const BODY_LIMIT = 64 * 1024;
// Chromium blocks these ports before any loopback request is made. An
// on-demand Inspector must never occasionally publish an unusable bootstrap URL.
const BROWSER_UNSAFE_PORTS = new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,5060,5061,6566,6665,6666,6667,6668,6669,6697,10080]);

export async function startInspector(options: StartInspectorOptions): Promise<RunningInspector> {
  const auth = createInspectorSession(options.randomBytes ?? randomBytes);
  const routes = inspectorRoutes(options.graph, options.allowOperations);
  const assets = clientAssets();
  let authority = "";
  const server = createServer(async (request, response) => {
    secureHeaders(response);
    try {
      if (!validHost(request, authority)) return json(response, 400, { error: "bad_request" });
      const path = safePath(request.url);
      if (!path) return json(response, 404, { error: "not_found" });
      if (request.method === "GET" && assets.has(path)) { const asset=assets.get(path)!; response.setHeader("Content-Type",asset.type); if(path!=="/")response.setHeader("Cache-Control","public,max-age=31536000,immutable"); response.end(asset.body); return; }
      if (path === "/api/bootstrap") {
        if (request.method !== "POST") return method(response);
        if (!isJson(request)) return json(response, 415, { error: "unsupported_media_type" });
        const body = await readBody(request);
        if (!consumeBootstrap(auth, record(body)?.token)) return json(response, 401, { error: "unauthorized" });
        response.setHeader("Set-Cookie", sessionCookie(auth));
        return json(response, 200, { csrf: auth.csrf });
      }
      if (path.startsWith("/api/")) {
        if (request.headers.origin !== `http://${authority}` || !validSession(auth, request.headers.cookie)) return json(response, 401, { error: "unauthorized" });
        const key = `${request.method ?? ""} ${path}`, route = routes.get(key);
        if (!route) return routesForPath(routes, path) ? method(response) : json(response, 404, { error: "not_found" });
        const operation = path.startsWith("/api/operations/");
        if (operation && !validCsrf(auth, header(request, "x-csrf-token"))) return json(response, 403, { error: "forbidden" });
        let body: unknown;
        if (request.method === "POST") {
          if (!isJson(request)) return json(response, 415, { error: "unsupported_media_type" });
          body = await readBody(request);
        }
        await route(request, response, body); return;
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      return json(response, error instanceof BodyError ? error.status : 500, { error: error instanceof BodyError ? error.code : "operation_failed" });
    }
  });
  const requestedPort = options.port ?? 0;
  if (requestedPort !== 0 && !browserSafePort(requestedPort)) throw new Error("inspector_unsafe_port");
  let address: ReturnType<typeof server.address> = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await listenLoopback(server, requestedPort);
    address = server.address();
    if (address && typeof address !== "string" && browserSafePort(address.port)) break;
    await closeServer(server);
  }
  if (!address || typeof address === "string" || !browserSafePort(address.port)) { if (server.listening) await closeServer(server); throw new Error("inspector startup failed"); }
  authority = `127.0.0.1:${address.port}`;
  return { url: `http://${authority}/#bootstrap=${auth.bootstrap}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function secureHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}
function browserSafePort(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535 && !BROWSER_UNSAFE_PORTS.has(value); }
function listenLoopback(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { server.off("error", fail); server.off("listening", done); resolve(); };
    const fail = (error: Error) => { server.off("listening", done); reject(error); };
    server.once("error", fail); server.once("listening", done); server.listen(port, "127.0.0.1");
  });
}
function closeServer(server: ReturnType<typeof createServer>): Promise<void> { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
function validHost(request: IncomingMessage, authority: string): boolean { return request.headers.host === authority; }
function safePath(url: string | undefined): string | null {
  if (!url || url.includes("\\") || /%2f|%5c|%2e/i.test(url)) return null;
  try { const parsed = new URL(url, "http://inspector.invalid"); return parsed.pathname.includes("..") ? null : parsed.pathname; } catch { return null; }
}
function isJson(request: IncomingMessage): boolean { return request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"; }
function header(request: IncomingMessage, name: string): string | undefined { const value = request.headers[name]; return Array.isArray(value) ? undefined : value; }
function routesForPath(routes: Map<string, unknown>, path: string): boolean { return [...routes.keys()].some(key => key.endsWith(` ${path}`)); }
function method(response: ServerResponse): void { response.setHeader("Allow", "POST"); json(response, 405, { error: "method_not_allowed" }); }
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > BODY_LIMIT) throw new BodyError(413, "payload_too_large"); chunks.push(buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new BodyError(400, "bad_request"); }
}
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
class BodyError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function clientAssets():Map<string,{body:Buffer;type:string}>{const root=dirname(fileURLToPath(import.meta.url));try{const manifest=JSON.parse(readFileSync(resolve(root,"asset-manifest.json"),"utf8")) as {app:string;styles:string};const map=new Map<string,{body:Buffer;type:string}>();map.set("/",{body:readFileSync(resolve(root,"index.html")),type:"text/html; charset=utf-8"});for(const [file,type] of [[manifest.app,"text/javascript; charset=utf-8"],[manifest.styles,"text/css; charset=utf-8"]] as const)if(/^assets\/[a-z]+\.[a-f0-9]{12}\.(js|css)$/.test(file))map.set(`/${file}`,{body:readFileSync(resolve(root,file)),type});return map;}catch{return new Map();}}
