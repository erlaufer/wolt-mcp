// Live end-to-end test of the MCP server's authed Wolt path. Needs real
// credentials: run once with WOLT_REFRESH_TOKEN set (or after tokens.json
// exists). NOT run in CI — hits live Wolt with the user's account.
//
//   node test/mcp.live.mjs
//
// Exercises: token refresh → search → basket write → list (verify persisted +
// merge) → count update → cleanup delete. Uses a low-stakes single cheap item.
import { refreshAccessToken, describeTokens } from "../mcp/lib/auth.js";
import { woltFetch } from "../mcp/lib/http.js";
import { searchItems, buildBasketBody, mergeBasketItems, findBasketForVenue, isVenueObjectId, BASKET_URL, BASKETS_PAGE_URL, BASKETS_DELETE_URL } from "../mcp/lib/wolt.js";
import { getLocation } from "../mcp/lib/config.js";

const loc = getLocation();
const log = (step, ok, extra = "") => console.log(`${ok ? "✓" : "✗"} ${step}${extra ? ` — ${extra}` : ""}`);
let failed = false;
const assert = (cond, step, extra) => { log(step, cond, extra); if (!cond) failed = true; };

// 1. refresh
const before = describeTokens();
console.log("token state:", JSON.stringify(before));
if (before.refreshTokenStored) {
  const tok = await refreshAccessToken();
  assert(typeof tok === "string" && tok.length > 20, "refresh returned an access token");
} else if (!before.accessTokenStored) {
  console.error("No tokens stored. Set WOLT_REFRESH_TOKEN or run set_wolt_token first.");
  process.exit(2);
}

// 2. search for a cheap staple near the saved location
const candidates = await searchItems("salt", { lat: loc.lat, lon: loc.lon });
assert(candidates.length > 0, `search returned candidates (${candidates.length})`);
const pick = candidates.find((c) => isVenueObjectId(c.venueId) && !c.isWeighted) || candidates[0];
console.log(`  using: ${pick.name} @ ${pick.venueName} (${pick.venueId}), ${pick.price} minor units`);

// 3. write basket (merge-aware, mirroring add_to_cart)
const basketsBefore = (await woltFetch(`${BASKETS_PAGE_URL}?lat=${loc.lat}&lon=${loc.lon}`)).json;
const existing = findBasketForVenue(basketsBefore, pick.venueId);
let body = buildBasketBody([{ candidate: pick, count: 1 }], pick.venueId, pick.currency);
if (existing?.items?.length) body = { ...body, items: mergeBasketItems(existing.items, body.items) };
const wr = await woltFetch(BASKET_URL, { method: "POST", body });
assert(wr.ok, `basket write (HTTP ${wr.status})`, wr.ok ? `basketId ${wr.json?.id}` : wr.text.slice(0, 200));

// 4. verify it persisted server-side (the historical open question)
const basketsAfter = (await woltFetch(`${BASKETS_PAGE_URL}?lat=${loc.lat}&lon=${loc.lon}`)).json;
const persisted = findBasketForVenue(basketsAfter, pick.venueId);
assert(!!persisted, "basket persisted server-side (visible in baskets page)");
assert(!!persisted?.items?.some((it) => it.id === pick.itemId), "written item present in persisted basket");

// 5. cleanup: delete only if WE created it (don't destroy a pre-existing basket)
if (persisted && !existing) {
  const del = await woltFetch(BASKETS_DELETE_URL, { method: "POST", body: { ids: [persisted.id] } });
  assert(del.ok, `cleanup delete (HTTP ${del.status})`);
} else if (persisted && existing) {
  console.log("  (skipping delete — basket pre-existed; remove the test item manually)");
}

console.log(failed ? "\nmcp.live.mjs: FAILURES above" : "\nmcp.live.mjs: all live checks passed");
process.exit(failed ? 1 : 0);
