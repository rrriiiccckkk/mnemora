import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startInspector } from "../dist/inspector/http.js";

const graph = {
  overview: () => ({ kind: "overview" }), graph: input => ({ kind: "graph", input }), entity: input => ({ kind: "entity", input }),
  research: input => ({ kind: "research", input }), trust: input => ({ kind: "trust", input }), consolidation: input => ({ kind: "consolidation", input }), memory: input => ({ kind: "memory", input }), intelligence: async input => ({ kind: "intelligence", input }), healthSummary: () => ({ kind: "health" }),
  operationPreview: () => ({ preview: true }), operationConfirm: () => ({ confirmed: true })
};

test("Inspector binds loopback and enforces one-time bootstrap, session, origin, and security headers", async () => {
  const running = await startInspector({ graph, allowOperations: false });
  try {
    const url = new URL(running.url), token = new URLSearchParams(url.hash.slice(1)).get("bootstrap");
    assert.equal(url.hostname, "127.0.0.1");
    const badHost = await request(url, "/api/bootstrap", { method: "POST", host: "evil.test", body: { token } });
    assert.equal(badHost.status, 400);
    const boot = await request(url, "/api/bootstrap", { method: "POST", body: { token } });
    assert.equal(boot.status, 200);
    assert.match(boot.headers["set-cookie"][0], /HttpOnly/); assert.match(boot.headers["set-cookie"][0], /SameSite=Strict/);
    assert.match(boot.headers["content-security-policy"], /default-src 'self'/);
    assert.equal(boot.headers["x-content-type-options"], "nosniff"); assert.equal(boot.headers["cache-control"], "no-store");
    assert.equal((await request(url, "/api/bootstrap", { method: "POST", body: { token } })).status, 401);
    const cookie = boot.headers["set-cookie"][0].split(";", 1)[0];
    assert.equal((await request(url, "/api/overview", { cookie, origin: "http://evil.test" })).status, 401);
    assert.equal((await request(url, "/api/overview", { cookie, origin: url.origin })).status, 200);
    const trust = await request(url, "/api/trust", { cookie, origin: url.origin });
    assert.deepEqual(trust.json, { kind: "trust" });
    assert.deepEqual((await request(url, "/api/consolidation", { cookie, origin: url.origin })).json, { kind: "consolidation" });
    assert.deepEqual((await request(url, "/api/memory", { cookie, origin: url.origin })).json, { kind: "memory" });
    assert.deepEqual((await request(url, "/api/intelligence", { cookie, origin: url.origin })).json, { kind: "intelligence" });
    assert.equal((await request(url, "/api/operations/preview", { method: "POST", cookie, origin: url.origin, body: {} })).status, 404);
  } finally { await running.close(); }
});

test("Inspector rejects a Chromium-unsafe explicit port before publishing a URL", async () => {
  await assert.rejects(() => startInspector({ graph, allowOperations: false, port: 6668 }), /inspector_unsafe_port/);
});

test("operation routes are conditional and require CSRF; methods, media, bodies, and traversal are bounded", async () => {
  const running = await startInspector({ graph, allowOperations: true });
  try {
    const url = new URL(running.url), token = new URLSearchParams(url.hash.slice(1)).get("bootstrap");
    assert.equal((await request(url, "/api/bootstrap", { method: "GET" })).status, 405);
    assert.equal((await request(url, "/api/bootstrap", { method: "POST", contentType: "text/plain", body: { token } })).status, 415);
    const boot = await request(url, "/api/bootstrap", { method: "POST", body: { token } });
    const cookie = boot.headers["set-cookie"][0].split(";", 1)[0], base = { cookie, origin: url.origin };
    assert.equal((await request(url, "/api/operations/preview", { ...base, method: "POST", body: {} })).status, 403);
    assert.equal((await request(url, "/api/operations/preview", { ...base, method: "POST", csrf: boot.json.csrf, body: {} })).status, 200);
    assert.equal((await request(url, "/api/graph", { ...base, method: "GET" })).status, 405);
    assert.deepEqual((await request(url, "/api/trust", { ...base, method: "POST", body: { scope: "project:alpha" } })).json, { kind: "trust", input: { scope: "project:alpha" } });
    assert.equal((await request(url, "/api/%2e%2e/health", base)).status, 404);
    const huge = `{"value":"${"x".repeat(70_000)}"}`;
    assert.equal((await request(url, "/api/graph", { ...base, method: "POST", rawBody: huge })).status, 413);
  } finally { await running.close(); }
});

function request(base, path, options = {}) {
  const raw = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: base.hostname, port: base.port, path, method: options.method ?? "GET", headers: {
      Host: options.host ?? base.host, ...(raw === undefined ? {} : { "Content-Type": options.contentType ?? "application/json", "Content-Length": Buffer.byteLength(raw) }),
      ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.origin ? { Origin: options.origin } : {}), ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {})
    } }, response => { const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: response.headers, json: text ? JSON.parse(text) : null }); }); });
    req.on("error", reject); if (raw !== undefined) req.end(raw); else req.end();
  });
}
