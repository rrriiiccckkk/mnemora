import assert from "node:assert/strict";
import test from "node:test";
import { Mnemora, canonicalizeUrl, classifyAddress, extractVisibleHtml, fetchUrlResource } from "../dist/index.js";

test("canonicalizeUrl produces stable public resource identities", () => {
  assert.equal(canonicalizeUrl("HTTPS://Example.COM:443?b=2&a=1#x"), "https://example.com/?a=1&b=2");
  assert.equal(canonicalizeUrl("http://Example.com:80/path?z=2&z=1"), "http://example.com/path?z=1&z=2");
  for (const value of ["ftp://example.com", "https://user:pass@example.com", "not a url"]) {
    assert.throws(() => canonicalizeUrl(value), error => error.category === "invalid_url");
  }
  for (const value of ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/"]) {
    assert.throws(() => canonicalizeUrl(value), error => error.category === "invalid_url", value);
  }
});

test("kg_ingest_url delegates safe final content and deduplicates before extraction", async () => {
  let extracts = 0, fetches = 0;
  const graph = new Mnemora({ config: { dbPath: ":memory:" }, urlFetcher: async () => { fetches++; return { requestedUrl: "https://example.com/", finalUrl: "https://example.com/final", redirects: 1, contentType: "text/plain", text: "Acme URL SECRET" }; }, extractor: { async extract(text, source) { extracts++; assert.equal(source, "url:https://example.com/final"); return { entities: [{ name: "Acme", type: "company", confidence: 1, evidence_span: text }], relations: [] }; } } });
  try {
    const first = await graph.kg_ingest_url("https://example.com");
    const second = await graph.kg_ingest_url("https://example.com");
    assert.deepEqual([first.status, second.status, fetches, extracts], ["succeeded", "skipped_duplicate", 2, 1]);
    assert.doesNotMatch(JSON.stringify(first), /URL SECRET/);
  } finally { graph.close(); }
});

test("kg_ingest_url returns structured acquisition failures without extracting or leaking details", async () => {
  let extracts = 0;
  const graph = new Mnemora({
    config: { dbPath: ":memory:" },
    urlFetcher: async () => { const error = new Error("SECRET socket detail"); error.category = "network_error"; throw error; },
    extractor: { async extract() { extracts++; throw new Error("must not extract"); } }
  });
  try {
    const result = await graph.kg_ingest_url("https://Example.com/a#fragment");
    assert.equal(result.status, "failed");
    assert.deepEqual(result.error, { category: "network_error", summary: "network error" });
    assert.equal(result.requested_url, "https://example.com/a");
    assert.equal(result.final_url, "https://example.com/a");
    assert.equal(result.fingerprint, "");
    assert.equal(extracts, 0);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|socket|fragment/);
  } finally { graph.close(); }
});

const body = text => ({ async *[Symbol.asyncIterator]() { yield Buffer.from(text); } });
test("fetchUrlResource pins validated DNS and revalidates redirects", async () => {
  const calls = [];
  const resolver = async host => host === "example.com" ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "142.250.72.14", family: 4 }];
  const transport = async request => {
    calls.push(request);
    if (calls.length === 1) return { status: 302, headers: { location: "https://other.example/final" }, body: body("") };
    return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: body("hello") };
  };
  const result = await fetchUrlResource("https://example.com/start", { maxBytes: 100, maxRedirects: 5, timeoutMs: 1000 }, { resolver, transport });
  assert.equal(result.text, "hello");
  assert.deepEqual(calls.map(call => call.address), ["93.184.216.34", "142.250.72.14"]);
  assert.match(calls[0].headers["user-agent"], /^mnemora\/\d+\.\d+\.\d+$/);
  assert.equal(result.redirects, 1);
});

test("fetchUrlResource rejects mixed DNS answers and HTTPS downgrade", async () => {
  const transport = async () => { throw new Error("must not connect"); };
  await assert.rejects(fetchUrlResource("https://example.com", { maxBytes: 100, maxRedirects: 5, timeoutMs: 1000 }, { resolver: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }], transport }), error => error.category === "blocked_address");
  await assert.rejects(fetchUrlResource("https://example.com", { maxBytes: 100, maxRedirects: 5, timeoutMs: 1000 }, { resolver: async () => [{ address: "93.184.216.34", family: 4 }], transport: async () => ({ status: 302, headers: { location: "http://example.com" }, body: body("") }) }), error => error.category === "redirect_blocked");
});

test("fetchUrlResource classifies literal IPv6 without DNS and sanitizes resolver failures", async () => {
  let resolutions = 0;
  await assert.rejects(fetchUrlResource("http://[::1]/", { maxBytes: 100, maxRedirects: 5, timeoutMs: 1000 }, {
    resolver: async () => { resolutions++; return [{ address: "93.184.216.34", family: 4 }]; },
    transport: async () => { throw new Error("must not connect"); }
  }), error => error.category === "blocked_address");
  assert.equal(resolutions, 0);
  await assert.rejects(fetchUrlResource("https://example.com", { maxBytes: 100, maxRedirects: 5, timeoutMs: 1000 }, {
    resolver: async () => { throw new Error("SECRET DNS detail"); }
  }), error => error.category === "network_error" && !error.message.includes("SECRET"));
});

test("fetchUrlResource enforces the total deadline even when resolver ignores abort", { timeout: 2_000 }, async () => {
  await assert.rejects(fetchUrlResource("https://example.com", { maxBytes: 100, maxRedirects: 5, timeoutMs: 20 }, {
    resolver: async () => new Promise(() => {})
  }), error => error.category === "timeout");
});

test("fetchUrlResource destroys redirect responses before following them", async () => {
  let destroyed = false;
  const result = await fetchUrlResource("https://example.com/start", { maxBytes: 100, maxRedirects: 5, timeoutMs: 1000 }, {
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async request => request.url.endsWith("/start")
      ? { status: 302, headers: { location: "/final" }, body: body("ignored"), destroy: () => { destroyed = true; } }
      : { status: 200, headers: { "content-type": "text/plain" }, body: body("ok") }
  });
  assert.equal(result.text, "ok");
  assert.equal(destroyed, true);
});

test("fetchUrlResource destroys responses rejected before body consumption", async () => {
  for (const response of [
    { status: 404, headers: {} },
    { status: 200, headers: { "content-type": "application/json" } },
    { status: 200, headers: { "content-type": "text/plain", "content-length": "101" } },
    { status: 302, headers: { location: "http://example.com/unsafe" } },
    { status: 302, headers: { location: "ftp://example.com/unsafe" } }
  ]) {
    let destroyed = false;
    await assert.rejects(fetchUrlResource("https://example.com", { maxBytes: 100, maxRedirects: 5, timeoutMs: 1000 }, {
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => ({ ...response, body: body("unconsumed"), destroy: () => { destroyed = true; } })
    }));
    assert.equal(destroyed, true, JSON.stringify(response));
  }
});

test("response policy is bounded and HTML excludes active or hidden content", async () => {
  const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const transport = async () => ({ status: 200, headers: { "content-type": "text/html" }, body: body("<h1>Title</h1><script>SECRET</script><p>Hello &amp; bye</p><div hidden>HIDE</div>") });
  const result = await fetchUrlResource("https://example.com", { maxBytes: 200, maxRedirects: 5, timeoutMs: 1000 }, { resolver, transport });
  assert.equal(result.text, "Title\nHello & bye");
  assert.equal(extractVisibleHtml("<p>A</p><style>SECRET</style><p>B</p>"), "A\nB");
  await assert.rejects(fetchUrlResource("https://example.com", { maxBytes: 3, maxRedirects: 5, timeoutMs: 1000 }, { resolver, transport: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: body("1234") }) }), error => error.category === "response_too_large");
});

test("classifyAddress rejects non-global IPv4 and IPv6 including mapped forms", () => {
  for (const value of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "192.88.99.1", "192.168.1.1", "192.0.2.1", "224.0.0.1", "::", "::1", "100::1", "4000::1", "64:ff9b:1::1", "fc00::1", "fe80::1", "2001::1", "2002::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(classifyAddress(value), "blocked", value);
  }
  assert.equal(classifyAddress("93.184.216.34"), "public");
  assert.equal(classifyAddress("2606:2800:220:1:248:1893:25c8:1946"), "public");
  assert.equal(classifyAddress("::ffff:5db8:d822"), "public");
});
