// How long the tools actually take, measured through a real MCP client — the
// number a user waits on, not a synthetic one. Live but tokenless: planning
// and search need no login, and it writes its location to a throwaway state
// dir rather than the user's.
//
//   node mcp/test/timing.mjs
//
// Latency is dominated by Wolt, not by us. Measured 2026-08-05 for a
// 10-ingredient list: 46 requests, ~17-22 s, split about evenly between the
// global-search phase that shortlists stores (10 requests, ~2 s each) and the
// venue race that plans the list at each of 3 stores (30 requests, ~2.7 s
// each). Our own pacing is a small part of it: loosening the limiter from
// 6/80ms to 12/30ms moved a 10-line plan 21.8 s -> 19.1 s and changed nothing
// at 5 lines. The levers that matter are how many searches we make — stores
// raced x ingredients — not how fast we're allowed to make them.
//
// Note this measures the server as a separate process, which is the only
// honest way to include the limiter: instrumenting in-process via
// setFetchImpl bypasses pacing by design.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), "wolt-timing-"));

const transport = new StdioClientTransport({
  command: "node",
  args: [join(HERE, "..", "server.mjs")],
  env: { ...process.env, WOLT_STATE_DIR: stateDir }
});
const client = new Client({ name: "timing", version: "1" }, { capabilities: {} });
await client.connect(transport);

const rows = [];
async function time(label, name, args) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const body = res.content?.[0]?.text ?? "";
  let json = null; try { json = JSON.parse(body); } catch (e) {}
  rows.push([label, ms, body.length, json]);
  return json;
}

// Helsinki, dictionary-form Finnish: the case the tools are meant to handle.
const FIVE = ["500 g spagetti", "400 g tomaattimurska", "200 g parmesaani", "2 sipuli", "oliiviöljy"];
const TEN = [...FIVE, "500 g jauheliha", "1 valkosipuli", "200 g kermaviili", "1 l maito", "6 kananmuna"];

await time("set_location (cold: city feed)", "set_location", { lat: 60.1699, lon: 24.9384, label: "timing" });
await time("set_location (warm: cached)", "set_location", { lat: 60.1699, lon: 24.9384, label: "timing" });
await time("search_products (global)", "search_products", { query: "sipuli" });
await time("search_products (one store)", "search_products", { query: "sipuli", venue_slug: "wolt-market-kamppi" });
const five = await time("plan_cart (5 ingredients)", "plan_cart", { ingredients: FIVE });
const ten = await time("plan_cart (10 ingredients)", "plan_cart", { ingredients: TEN });

console.log("\ntool                              time     response");
for (const [label, ms, bytes] of rows) {
  console.log(`  ${label.padEnd(32)} ${(ms / 1000).toFixed(1).padStart(5)}s   ${String(Math.round(bytes / 1024)).padStart(4)} KB`);
}
console.log(`\n  plan_cart raced ${five?.evaluatedVenues?.length ?? "?"} stores, covered ${five?.coverage ?? "?"} (5 lines) / ${ten?.coverage ?? "?"} (10 lines)`);
console.log("  A plan costs roughly (stores raced x ingredients) in-venue searches, so ingredient count drives the clock.");

await client.close();
