// Live smoke of EVERY MCP tool through a real MCP client (spawns server.mjs
// over stdio, so zod schemas and the tool layer are exercised end-to-end).
// A coverage guard at the bottom fails the run if any registered tool goes
// uncalled, so "every tool" stays true as tools are added.
// Needs valid tokens. Mutating tests use a temp basket at a grocery venue and
// clean up; favorites add/remove is self-reversing; interactive login tools
// are skipped.  Run: node test/tools.live.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const client = new Client({ name: "tools-live-test", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(root, "mcp/server.mjs")] }));

const results = [];
async function call(name, args = {}, check = () => true) {
  try {
    const res = await client.callTool({ name, arguments: args });
    const body = res.content?.[0]?.text ?? "";
    let json = null; try { json = JSON.parse(body); } catch (e) {}
    const ok = !res.isError && check(json, body);
    results.push([name, ok ? "PASS" : "FAIL", ok ? "" : body.slice(0, 120)]);
    return json;
  } catch (e) {
    results.push([name, "FAIL", e.message.slice(0, 120)]);
    return null;
  }
}
const skip = (name, why) => results.push([name, "SKIP", why]);

// --- status & account ---
await call("wolt_status", {}, (j) => j.accessTokenStored !== undefined);
await call("get_wolt_profile", {}, (j) => !!j);
const addr = await call("use_saved_address", {}, (j) => !!j.saved || !!j.addresses);
await call("resolve_address", { address: "Aleksanterinkatu 1, Helsinki" }, (j) => j.candidates?.length > 0);

// set_location writes the user's real delivery location to disk, so snapshot
// config.json first and put it back verbatim at the end (see the restore near
// the bottom of this file). Without that, running the tests silently relabels
// — or, if use_saved_address failed, relocates — where the user shops.
const configFile = join(process.env.WOLT_STATE_DIR || join(homedir(), ".wolt-mcp"), "config.json");
let configBefore = null;
try { configBefore = await readFile(configFile, "utf8"); } catch (e) {}

// The restore near the bottom is the normal path — it verifies and reports.
// This is the safety net for every other way out: a throw mid-run, an early
// process.exit, or Ctrl-C during the ~40 live calls that follow. Sync fs is the
// only kind an exit handler can use, and SIGINT needs its own handler or the
// process dies without firing "exit" at all.
let restored = false;
process.on("exit", () => {
  if (restored) return;
  try {
    if (configBefore !== null) writeFileSync(configFile, configBefore);
    else rmSync(configFile, { force: true });
  } catch (e) {}
});
process.on("SIGINT", () => process.exit(130));

const located = await call("set_location", { lat: addr?.saved?.lat ?? 60.1699, lon: addr?.saved?.lon ?? 24.9384, label: "live-test (temporary)" }, (j) => !!j.saved);
// Which language this market's catalogs are indexed in decides what language
// the plan_cart list below has to be written in.
const catalogLanguage = located?.catalogLanguage || null;

// --- search & discovery ---
const grocery = await call("search_products", { query: "salt" }, (j) => j.count > 0);
await call("search_restaurant_dishes", { query: "pizza" }, (j) => j.count > 0);
await call("search_venues", { query: "pizza" }, (j) => j.count > 0);
await call("top_venues", { min_score: 8, kind: "restaurant", limit: 5 }, (j) => j.venues?.length > 0);
await call("get_feed", { section: "order again" }, (j) => Array.isArray(j.sections));

// --- venue layer (pinned to a known-stable venue: Mäkikupla, Helsinki) ---
await call("get_venue", { venue_slug: "makikupla" }, (j) => !!j.venueId && j.openingTimes?.length > 0);
// no query filter — restaurant menus rotate by hour, so take whatever's live
const menu = await call("get_venue_menu", { venue_slug: "makikupla" }, (j) => j.items?.length > 0);
await call("get_dish_options", { venue_slug: "makikupla", item_id: menu?.items?.[0]?.itemId ?? "missing" }, (j) => Array.isArray(j.groups));
await call("get_venue_categories", { venue_slug: "makikupla" }, (j) => Array.isArray(j.categories) && j.categories.length > 0);
// find_item three ways: by exact name, by 24-hex id, and by a pasted wolt.com URL
const dish = menu?.items?.[0];
if (dish) {
  await call("find_item", { venue_slug: "makikupla", item: dish.name }, (j) => !!j.itemId);
  await call("find_item", { venue_slug: "makikupla", item: dish.itemId }, (j) => j.itemId === dish.itemId);
  // URL form carries its own slug, so venue_slug is deliberately omitted
  await call("find_item", { item: `https://wolt.com/en/fin/helsinki/venue/makikupla/itemid-${dish.itemId}` }, (j) => j.itemId === dish.itemId);
} else {
  skip("find_item", "no menu item to resolve");
}

// --- recipe convenience ---
// plan_cart refuses a list written in the wrong script for the market's
// catalogs (needsTranslation), so the list follows the market this account
// sits in. A market we have no list for is allowed to come back
// needsTranslation — that is the correct answer there, not a failure.
const SHOPPING_LISTS = {
  en: ["2 onions", "500 g pasta"],
  he: ["2 בצלים", "500 גרם פסטה"],
  el: ["2 κρεμμύδια", "500 γρ ζυμαρικά"],
  ru: ["2 луковицы", "500 г макарон"],
  ka: ["2 ხახვი", "500 გ მაკარონი"]
};
const knownList = !catalogLanguage || !!SHOPPING_LISTS[catalogLanguage];
await call(
  "plan_cart",
  { ingredients: SHOPPING_LISTS[catalogLanguage] || SHOPPING_LISTS.en },
  (j) => !!j.venue || !!j.missing || (!knownList && j.needsTranslation === true)
);

// --- cart CRUD on a TEMP grocery basket (not the pinned restaurant venue) ---
const pick = grocery?.items?.find((i) => /^[a-f0-9]{24}$/.test(i.venueId));
// Venue metadata lives in the response's `venues` map, keyed by venueId — the
// items themselves carry only what differs per item. Reading slug/city/country
// off the item yields undefined, which is how a caller ends up with no
// currency and no checkout link.
const pickVenue = (pick && grocery?.venues?.[pick.venueId]) || {};
let cartOk = false;
if (pick) {
  const added = await call("add_to_cart", {
    venue_id: pick.venueId, venue_slug: pickVenue.slug, city_slug: pickVenue.citySlug,
    country: pickVenue.country, currency: pick.currency,
    items: [{ id: pick.itemId, name: pick.name, price: pick.price, count: 1, weighted: false, grams: null }]
  }, (j) => j.ok === true);
  const baskets = await call("get_baskets", {}, (j) => j.count >= 1);
  const temp = baskets?.baskets?.find((b) => b.venueId === pick.venueId);
  cartOk = !!temp;
  await call("update_cart_item", { venue_id: pick.venueId, item_id: pick.itemId, count: 2 }, (j) => j.ok === true && j.newCount === 2);
  await call("checkout_preview", { venue_id: pick.venueId, venue_slug: pickVenue.slug }, (j) => j.payableAmount > 0);
  if (temp) await call("clear_basket", { basket_id: temp.basketId }, (j) => j.ok === true);
  else skip("clear_basket", "temp basket not found");
} else {
  ["add_to_cart", "get_baskets", "update_cart_item", "checkout_preview", "clear_basket"].forEach((t) => skip(t, "no grocery candidate"));
}

// --- weighted line on its own temp basket ---
// Wolt accepts a weighted line whose grams aren't a multiple of the item's
// step and then silently DROPS it, so this leg asks for a deliberately
// off-step weight (349 g) and checks two things the unit tests can't: that the
// catalog lookup snapped it (reported as `adjustments`), and that the line was
// really in the basket afterwards (`droppedLines` absent, read back after the
// write). Deli counters are where weighted items live, hence the meat queries.
const MEAT_QUERIES = { en: "chicken breast", he: "עוף", el: "κοτόπουλο", ru: "курица", ka: "ქათამი", ja: "鶏肉" };
const meatQuery = MEAT_QUERIES[catalogLanguage] || MEAT_QUERIES.en;
const weighedSearch = await call("search_products", { query: meatQuery }, (j) => j.count >= 0);
const wPick = weighedSearch?.items?.find((i) => i.isWeighted && /^[a-f0-9]{24}$/.test(i.venueId) && weighedSearch.venues?.[i.venueId]?.slug);
if (wPick) {
  const wVenue = weighedSearch.venues[wPick.venueId];
  await call("add_to_cart", {
    venue_id: wPick.venueId, venue_slug: wVenue.slug, city_slug: wVenue.citySlug,
    country: wVenue.country, currency: wPick.currency,
    items: [{ id: wPick.itemId, name: wPick.name, price: wPick.price, count: 1, weighted: true, grams: 349 }]
  }, (j) => j.ok === true && !j.droppedLines && j.verified === true && (j.adjustments || []).length === 1);
  const wBaskets = await call("get_baskets", {}, (j) => j.count >= 1);
  const wTemp = wBaskets?.baskets?.find((b) => b.venueId === wPick.venueId);
  if (wTemp) await call("clear_basket", { basket_id: wTemp.basketId }, (j) => j.ok === true);
  else skip("clear_basket", "weighted temp basket not found");
} else {
  ["add_to_cart", "clear_basket"].forEach((t) => skip(t, `no weighted candidate for "${meatQuery}"`));
}

// --- orders ---
const oh = await call("get_order_history", { limit: 3 }, (j) => j.orders?.length > 0);
await call("get_order", { purchase_id: oh?.orders?.[0]?.purchaseId }, (j) => !!j);

// --- payments & favorites (add/remove self-reversing on the pinned venue) ---
await call("get_payment_methods", {}, (j) => !!j);
const favsBefore = await call("get_favorites", {}, (j) => j.count !== undefined);
const pinnedVenue = "67d298988842bb646be46947"; // makikupla
const wasFav = favsBefore?.venues?.some((v) => v.venueId === pinnedVenue);
if (!wasFav) {
  await call("add_favorite", { venue_id: pinnedVenue }, (j) => j.ok === true);
  await call("remove_favorite", { venue_id: pinnedVenue }, (j) => j.ok === true);
} else {
  await call("remove_favorite", { venue_id: pinnedVenue }, (j) => j.ok === true);
  await call("add_favorite", { venue_id: pinnedVenue }, (j) => j.ok === true);
}

// --- token & login ---
// Feed set_wolt_token the tokens already on disk rather than a dummy string:
// same code path, but it can't leave the user holding an unusable access token
// (the old dummy relied on auto-refresh to undo itself, which silently fails
// for anyone without a refresh token stored).
const tokenFile = join(process.env.WOLT_STATE_DIR || join(homedir(), ".wolt-mcp"), "tokens.json");
let stored = null;
try { stored = JSON.parse(await readFile(tokenFile, "utf8")); } catch (e) {}
// NB: keys on disk are camelCase, and setTokens() clears rotatedRefreshToken
// whenever a refresh token is supplied — so round-trip the ACCESS token only,
// or the run would throw away the live rotation chain.
if (stored?.accessToken) {
  await call("set_wolt_token", { access_token: stored.accessToken },
    (j, body) => body.includes("accessTokenStored") || body.includes("Stored"));
  // blob branch: the JSON-parsing path users hit when pasting a raw payload
  await call("set_wolt_token", { blob: JSON.stringify({ access_token: stored.accessToken }) },
    (j, body) => body.includes("accessTokenStored") || body.includes("Stored"));
} else {
  skip("set_wolt_token", "no tokens.json to round-trip safely");
}
skip("login_via_chrome", "interactive — cannot be driven headlessly");

// tokens must survive this harness untouched — verify a real authed call still works
await call("wolt_status", {}, (j) => j.refreshTokenStored === true);
await call("get_wolt_profile", {}, (j) => !!j);

// Put the user's delivery location back exactly as we found it — including the
// case where we found nothing: set_location CREATED config.json, and leaving it
// behind pins the location to this test's coordinates, since stored config
// beats the WOLT_LAT/WOLT_LON env seeds an .mcpb install runs on.
if (configBefore !== null) {
  await writeFile(configFile, configBefore);
  const now = await readFile(configFile, "utf8");
  results.push(["(restore location)", now === configBefore ? "PASS" : "FAIL", now === configBefore ? "" : "config.json not restored"]);
} else {
  rmSync(configFile, { force: true });
  const gone = !existsSync(configFile);
  results.push(["(restore location)", gone ? "PASS" : "FAIL", gone ? "" : "config.json created by the test was not removed"]);
}
restored = true;

// Coverage guard: assert every registered tool was actually exercised, so a
// newly added tool can't silently go untested (find_item and
// get_venue_categories both slipped through before this check existed).
const registered = (await client.listTools()).tools.map((t) => t.name);
const touched = new Set(results.map(([n]) => n));
const untested = registered.filter((n) => !touched.has(n));
for (const name of untested) results.push([name, "FAIL", "never called — no coverage in this harness"]);

const width = Math.max(...results.map(([n]) => n.length));
for (const [name, status, note] of results) console.log(status.padEnd(5), name.padEnd(width), note);
const fails = results.filter(([, s]) => s === "FAIL").length;
console.log(`\n${results.length} tools: ${results.filter(([, s]) => s === "PASS").length} pass, ${fails} fail, ${results.filter(([, s]) => s === "SKIP").length} skip`);
await client.close();
process.exit(fails ? 1 : 0);
