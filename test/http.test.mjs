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

// 429 with Retry-After retries once
r = await woltFetch("https://x.test/b", { fetchImpl: stub([mkRes(429, "slow down", { "retry-after": "0" }), mkRes(200, '{"v":2}')]) });
if (!r.ok || r.json?.v !== 2 || calls !== 2) fail("retry-after path");

// 429 without Retry-After: no retry
r = await woltFetch("https://x.test/c", { fetchImpl: stub([mkRes(429, "nope")]) });
if (r.ok || r.status !== 429 || calls !== 1) fail("429-without-header path");

// 404: no retry, json null on non-JSON body
r = await woltFetch("https://x.test/d", { fetchImpl: stub([mkRes(404, "not json")]) });
if (r.ok || r.json !== null || r.text !== "not json" || calls !== 1) fail("error passthrough path");

console.log("http.test.mjs: all assertions passed");
