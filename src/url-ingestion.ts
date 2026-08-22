import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mnemoraVersion } from "./version.js";
import { Parser } from "htmlparser2";

export type SafeUrlErrorCategory = "invalid_url" | "blocked_address" | "redirect_blocked" | "too_many_redirects" | "timeout" | "http_error" | "unsupported_content" | "response_too_large" | "invalid_text" | "network_error";
export class SafeUrlError extends Error {
  constructor(readonly category: SafeUrlErrorCategory) { super(category.replaceAll("_", " ")); this.name = "SafeUrlError"; }
}

export function canonicalizeUrl(input: string): string {
  const authority = input.match(/^https?:\/\/([^/?#]+)/i)?.[1] ?? "";
  const rawHostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const rawHost = rawHostPort.startsWith("[") ? rawHostPort.slice(0, rawHostPort.indexOf("]") + 1) : rawHostPort.replace(/:\d+$/, "");
  if (/^0x/i.test(rawHost) || (/^[0-9.]+$/.test(rawHost) && !isCanonicalIpv4(rawHost))) throw new SafeUrlError("invalid_url");
  let url: URL;
  try { url = new URL(input); } catch { throw new SafeUrlError("invalid_url"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hostname.includes("%")) throw new SafeUrlError("invalid_url");
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
  if (!url.pathname) url.pathname = "/";
  const pairs = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
  url.search = "";
  for (const [key, value] of pairs) url.searchParams.append(key, value);
  return url.toString();
}

function isCanonicalIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

const blocked = new BlockList();
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as Array<[string, number]>) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16]] as Array<[string, number]>) blocked.addSubnet(network, prefix, "ipv6");

export function classifyAddress(input: string): "public" | "blocked" {
  let address = input.toLowerCase();
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) address = mapped[1];
  const mappedHex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16), low = Number.parseInt(mappedHex[2], 16);
    address = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  const family = isIP(address);
  if (!family) return "blocked";
  if (family === 6 && !globalIpv6.check(address, "ipv6")) return "blocked";
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6") ? "blocked" : "public";
}

export interface UrlFetchLimits { maxBytes: number; maxRedirects: number; timeoutMs: number }
export interface UrlTransportResponse { status: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array>; destroy?(error?: Error): void }
export interface UrlRequest { url: string; address: string; family: 4 | 6; headers: Record<string, string>; signal: AbortSignal }
export interface UrlFetchDependencies {
  resolver?: (hostname: string, signal: AbortSignal) => Promise<Array<{ address: string; family: number }>>;
  transport?: (request: UrlRequest) => Promise<UrlTransportResponse>;
}
export interface UrlFetchResult { requestedUrl: string; finalUrl: string; redirects: number; contentType: string; text: string }

export async function fetchUrlResource(input: string, limits: UrlFetchLimits, dependencies: UrlFetchDependencies = {}): Promise<UrlFetchResult> {
  const requestedUrl = canonicalizeUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const resolver = dependencies.resolver ?? defaultResolver;
  const transport = dependencies.transport ?? nodeTransport;
  const visited = new Set<string>();
  let current = requestedUrl;
  let redirects = 0;
  try {
    while (true) {
      if (controller.signal.aborted) throw new SafeUrlError("timeout");
      if (visited.has(current)) throw new SafeUrlError("too_many_redirects");
      visited.add(current);
      const url = new URL(current);
      const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
      const literalFamily = isIP(hostname);
      let answers: Array<{ address: string; family: number }>;
      try { answers = literalFamily ? [{ address: hostname, family: literalFamily }] : await withAbort(resolver(hostname, controller.signal), controller.signal); }
      catch (error) { if (controller.signal.aborted) throw new SafeUrlError("timeout"); if (error instanceof SafeUrlError) throw error; throw new SafeUrlError("network_error"); }
      if (!answers.length || answers.some(answer => classifyAddress(answer.address) !== "public")) throw new SafeUrlError("blocked_address");
      const selected = [...answers].sort((a, b) => a.family - b.family || a.address.localeCompare(b.address))[0];
      let response: UrlTransportResponse;
      try { response = await transport({ url: current, address: selected.address, family: selected.family === 6 ? 6 : 4, signal: controller.signal, headers: fixedHeaders }); }
      catch (error) { if (controller.signal.aborted) throw new SafeUrlError("timeout"); if (error instanceof SafeUrlError) throw error; throw new SafeUrlError("network_error"); }
      if (response.status >= 300 && response.status < 400) {
        const location = header(response.headers, "location");
        if (!location) failResponse(response, "http_error");
        if (redirects >= limits.maxRedirects) failResponse(response, "too_many_redirects");
        let next: string;
        try { next = canonicalizeUrl(new URL(location, current).toString()); }
        catch (error) { response.destroy?.(); throw error; }
        if (url.protocol === "https:" && new URL(next).protocol === "http:") failResponse(response, "redirect_blocked");
        response.destroy?.(); current = next; redirects++; continue;
      }
      if (response.status < 200 || response.status >= 300) failResponse(response, "http_error");
      const contentTypeHeader = header(response.headers, "content-type") ?? "";
      const [media, ...parameters] = contentTypeHeader.toLowerCase().split(";").map(value => value.trim());
      if (!["text/plain", "text/markdown", "text/html"].includes(media)) failResponse(response, "unsupported_content");
      const charset = parameters.find(value => value.startsWith("charset="))?.slice(8).replaceAll('"', "");
      if (charset && charset !== "utf-8" && charset !== "utf8") failResponse(response, "unsupported_content");
      const encoding = (header(response.headers, "content-encoding") ?? "identity").toLowerCase();
      if (encoding !== "identity") failResponse(response, "unsupported_content");
      const declared = Number(header(response.headers, "content-length"));
      if (Number.isFinite(declared) && declared > limits.maxBytes) failResponse(response, "response_too_large");
      const chunks: Uint8Array[] = []; let total = 0;
      for await (const chunk of response.body) { total += chunk.byteLength; if (total > limits.maxBytes) { response.destroy?.(); throw new SafeUrlError("response_too_large"); } chunks.push(chunk); }
      let raw: string;
      try { raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))); } catch { throw new SafeUrlError("invalid_text"); }
      const text = media === "text/html" ? extractVisibleHtml(raw) : raw.replace(/\r\n?/g, "\n").trim();
      if (!text) throw new SafeUrlError("invalid_text");
      return { requestedUrl, finalUrl: current, redirects, contentType: media, text };
    }
  } catch (error) { if (controller.signal.aborted && !(error instanceof SafeUrlError && error.category === "response_too_large")) throw new SafeUrlError("timeout"); throw error; }
  finally { clearTimeout(timer); }
}

const fixedHeaders = { "user-agent": `mnemora/${mnemoraVersion}`, accept: "text/plain, text/markdown, text/html", "accept-encoding": "identity" };
const header = (headers: Record<string, string | string[] | undefined>, name: string) => { const value = headers[name] ?? headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; };
function failResponse(response: UrlTransportResponse, category: SafeUrlErrorCategory): never { response.destroy?.(); throw new SafeUrlError(category); }
const defaultResolver = async (hostname: string, _signal: AbortSignal) => (await lookup(hostname, { all: true, verbatim: true })).map(answer => ({ address: answer.address, family: answer.family }));

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SafeUrlError("timeout"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new SafeUrlError("timeout"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const nodeTransport = (input: UrlRequest): Promise<UrlTransportResponse> => new Promise((resolve, reject) => {
  const url = new URL(input.url);
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "GET", headers: input.headers, signal: input.signal, lookup: (_host, _options, callback) => callback(null, input.address, input.family) }, response => resolve({ status: response.statusCode ?? 0, headers: response.headers as Record<string, string | string[] | undefined>, body: response, destroy: error => response.destroy(error) }));
  request.on("error", reject); request.end();
});

const excluded = new Set(["script", "style", "noscript", "template", "form", "svg", "canvas"]);
const blocks = new Set(["title", "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "tr", "td", "th", "br", "div", "section", "article"]);
export function extractVisibleHtml(html: string): string {
  const parts: string[] = []; const stack: boolean[] = []; let hiddenDepth = 0;
  const boundary = () => { if (parts.at(-1) !== "\n") parts.push("\n"); };
  const parser = new Parser({ onopentag(name, attributes) { const hide = excluded.has(name) || "hidden" in attributes || attributes["aria-hidden"]?.toLowerCase() === "true"; stack.push(hide); if (hide) hiddenDepth++; if (!hiddenDepth && blocks.has(name)) boundary(); }, ontext(text) { if (!hiddenDepth) parts.push(text); }, onclosetag(name) { if (!hiddenDepth && blocks.has(name)) boundary(); if (stack.pop()) hiddenDepth--; } }, { decodeEntities: true });
  parser.write(html); parser.end();
  return parts.join("").split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}
