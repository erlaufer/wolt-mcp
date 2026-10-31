// Unit test for woltFetch retry logic with an injected fetch stub.
// Seeds a fake token via WOLT_STATE_DIR so no real credentials are touched.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wolt-http-test-"));
process.env.WOLT_STATE_DIR = dir;
// far-future JWT so getAccessToken never tries to refresh
const exp = Math.floor(Date.now() / 1000) + 3600;
const fakeJwt = ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".");
writeFileSync(join(dir, "tokens.json"), JSON.stringify({ accessToken: fakeJwt }));

const { woltFetch } = await import("../mcp/lib/http.js");

const mkRes = (status, body = "{}", headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body
});

let calls;
const stub = (responses) => { calls = 0; return async () => responses[Math.min(calls++, responses.length - 1)]; };

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// plain success
let r = await woltFetch("https://x.test/a", { fetchImpl: stub([mkRes(200, '{"v":1}')]) });
if (!r.ok || r.json?.v !== 1 || calls !== 1) fail("success path");

// Retain only bounded support correlation IDs, never credentials/cookies.
r = await woltFetch("https://x.test/diagnostic", { fetchImpl: stub([mkRes(400, '{}', {
  "x-amz-cf-id": "support-reference_123==", "x-request-id": "request-123",
  "x-correlation-id": "bad\nheader", "cf-ray": "x".repeat(257),
  "set-cookie": "private-cookie", "authorization": "private-token"
})]) });
if (JSON.stringify(r.requestIds) !== JSON.stringify({ "x-request-id": "request-123", "x-amz-cf-id": "support-reference_123==" })) fail("only safe response correlation IDs are retained");

// 429 with Retry-After retries once
r = await woltFetch("https://x.test/b", { fetchImpl: stub([mkRes(429, "slow down", { "retry-after": "0" }), mkRes(200, '{"v":2}')]) });
if (!r.ok || r.json?.v !== 2 || calls !== 2) fail("retry-after path");

// 429 without Retry-After: default backoff ladder retries (delays injected to 0)
r = await woltFetch("https://x.test/c", { retry429Ms: [0, 0], fetchImpl: stub([mkRes(429, "nope"), mkRes(200, '{"v":3}')]) });
if (!r.ok || r.json?.v !== 3 || calls !== 2) fail("429-default-backoff path");

// 429 all the way down: ladder exhausts after 2 retries, final 429 returned
r = await woltFetch("https://x.test/c2", { retry429Ms: [0, 0], fetchImpl: stub([mkRes(429, "no"), mkRes(429, "no"), mkRes(429, "no")]) });
if (r.ok || r.status !== 429 || calls !== 3) fail("429-exhausted path");

// 404: no retry, json null on non-JSON body
r = await woltFetch("https://x.test/d", { fetchImpl: stub([mkRes(404, "not json")]) });
if (r.ok || r.json !== null || r.text !== "not json" || calls !== 1) fail("error passthrough path");

// 5xx without Retry-After: still no retry (unchanged behavior)
r = await woltFetch("https://x.test/e", { retry429Ms: [0, 0], fetchImpl: stub([mkRes(503, "down")]) });
if (r.ok || r.status !== 503 || calls !== 1) fail("5xx-without-header path");

// auth: false sends no Authorization header and never consults the token store
let sawAuthHeader = "unset";
r = await woltFetch("https://x.test/f", {
  auth: false,
  fetchImpl: async (url, init) => { sawAuthHeader = init.headers.authorization; return mkRes(200, '{"v":4}'); }
});
if (!r.ok || r.json?.v !== 4 || sawAuthHeader !== undefined) fail("auth-false path");

// auth: "optional" — a connected account is used, a missing one is not an error.
r = await woltFetch("https://x.test/e", {
  auth: "optional",
  fetchImpl: async (url, init) => { sawAuthHeader = init.headers.authorization; return mkRes(200, '{"v":5}'); }
});
if (!r.ok || r.json?.v !== 5 || !sawAuthHeader) fail("optional auth uses the stored token");
{
  const { withStateDir } = await import("../mcp/lib/context.js");
  const empty = mkdtempSync(join(tmpdir(), "wolt-http-empty-"));
  r = await withStateDir(empty, () => woltFetch("https://x.test/f", {
    auth: "optional",
    fetchImpl: async (url, init) => { sawAuthHeader = init.headers.authorization; return mkRes(200, '{"v":6}'); }
  }));
  if (!r.ok || r.json?.v !== 6 || sawAuthHeader !== undefined) fail("optional auth goes anonymous without a token");
}

console.log("http.test.mjs: all assertions passed");
