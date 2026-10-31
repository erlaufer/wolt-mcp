// History pagination stays offline and uses no account credentials.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wolt-history-test-"));
process.env.WOLT_STATE_DIR = dir;
const jwt = ["e30", Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString("base64url"), "sig"].join(".");
writeFileSync(join(dir, "tokens.json"), JSON.stringify({ accessToken: jwt }));
const { setFetchImpl } = await import("../mcp/lib/http.js");
const { getOrderHistory } = await import("../mcp/lib/account.js");
const calls = [];
let mode = "normal";
setFetchImpl(async url => {
  const u = new URL(url); calls.push(u);
  assert(!u.searchParams.has("skip"), "Wolt ignores offsets; never send skip");
  const start = Number(u.searchParams.get("page_token") || 0), limit = Number(u.searchParams.get("limit"));
  let body = { orders: Array.from({ length: Math.min(limit, Math.max(0, 130 - start)) }, (_, i) => ({ purchase_id: `order-${start + i}` })), next_page_token: start + limit < 130 ? String(start + limit) : null };
  if (mode === "api-error") body = { error_code: "INVALID_ARGUMENT" };
  if (mode === "malformed") body = {};
  if (mode === "stuck") body = { orders: [{ purchase_id: "same" }], next_page_token: "same" };
  return new Response(JSON.stringify(body));
});
try {
  let page = await getOrderHistory({ limit: null, skip: null });
  assert.equal(page.orders.length, 10);
  assert.equal(page.next_page_token, "10");
  page = await getOrderHistory({ limit: 2, pageToken: page.next_page_token });
  assert.deepEqual(page.orders.map(o => o.purchase_id), ["order-10", "order-11"]);
  assert.equal(calls.at(-1).searchParams.get("page_token"), "10");
  const before = calls.length;
  page = await getOrderHistory({ limit: 10, skip: 105 });
  assert.equal(calls.length, before + 2);
  assert.equal(page.orders[0].purchase_id, "order-105");
  assert.equal(page.next_page_token, "115", "the cursor follows the returned records");
  page = await getOrderHistory({ limit: 10, skip: 200 });
  assert.deepEqual(page.orders, []);
  for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 2.5 }, { skip: -1 }, { skip: 1001 }, { pageToken: "" }, { pageToken: "10", skip: 1 }]) {
    const before = calls.length;
    await assert.rejects(getOrderHistory(args));
    assert.equal(calls.length, before, "invalid arguments are rejected before Wolt");
  }
  mode = "api-error"; await assert.rejects(getOrderHistory(), /Wolt INVALID_ARGUMENT/);
  mode = "malformed"; await assert.rejects(getOrderHistory(), /no orders list/);
  mode = "stuck"; await assert.rejects(getOrderHistory({ skip: 3 }), /did not advance/);
} finally { setFetchImpl(null); rmSync(dir, { recursive: true, force: true }); }
console.log("account.test.mjs: bounded inputs, cursor paging, legacy offsets and API errors pass");
