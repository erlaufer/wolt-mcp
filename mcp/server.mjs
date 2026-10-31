#!/usr/bin/env node
// Local MCP server for Wolt.
//
// Design: the MCP *client's* model does the reasoning — read the recipe, pick
// the product, choose the venue — so there's no hosted LLM and no API key here.
// This server exposes the Wolt primitives: search, browse menus, read and write
// baskets and preview checkout, with saved-card ordering when opted in.
//
// Auth: search needs none. Account and basket calls need a token — connect once
// via login_via_chrome (or set_wolt_token); it auto-renews after that.
// See docs/architecture.md for how the API layer works.
//
// Transports: stdio by default (what every desktop MCP client speaks), or
// `--http` for a remote Streamable HTTP server behind OAuth — see docs/remote.md.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  searchItems, selectBestVenue, rankVenues, buildBasketBody, reconcileWeightedItems, resolveCurrency, BASKET_URL,
  BASKETS_PAGE_URL, BASKETS_DELETE_URL, isVenueObjectId, findBasketForVenue, mergeBasketItems
} from "./lib/wolt.js";
import { woltFetch } from "./lib/http.js";
import { rankCandidates } from "./lib/match.js";
import { parseIngredientLine } from "./lib/recipe.js";
import { setTokens, describeTokens, getAccessToken, exportRefreshToken, isRemoteMode } from "./lib/auth.js";
import { serveHttp, parseHttpArgs } from "./lib/remote.js";
import { getLocation, setLocation, estimateLocation } from "./lib/config.js";
import { checkoutPreview } from "./lib/checkout.js";
import { prepareOrder, placeOrder, orderingFromEnv, attachPaymentContext, paymentContextStatus, PaymentRefusal } from "./lib/order.js";
import { getAddOnOptions } from "./lib/add-on.js";
import { cdpLogin } from "./lib/cdp-login.js";
import { getVenue, getMenu, getItemOptions, getCategories, resolveItem, parseItemUrl, searchVenueItems, getCatalogLanguage, getMarketLanguage, getWeightConfigs } from "./lib/venue.js";
import { getOrderHistory, getOrder, geocodeAddress } from "./lib/account.js";
import { langOf, sameScript, isNonLatinLang } from "./lib/lang.js";
import { planAtVenue, planResponse, translationPreflight, rankPlans, mapPool } from "./lib/plan.js";
import { rich, uiMeta, resultMeta, describe, registerUi, imageUrlOf, woltImageUrl, woltLinkUrl } from "./lib/ui.js";

// catalogLanguage (+ a hint for non-Latin markets) for tool responses that
// establish or report the user's location — so the model knows to translate
// its queries BEFORE the first plan_cart. Best-effort: never throws, {} on
// unknown, and cached per ~11km bucket so repeat calls are free.
async function marketLanguageFields(lat, lon) {
  const language = await getMarketLanguage({ lat, lon });
  if (!language) return {};
  return {
    catalogLanguage: language,
    ...(isNonLatinLang(language)
      ? { languageHint: `Write product queries and plan_cart ingredient lines in '${language}' (translate them yourself).` }
      : {})
  };
}

// Resolve coordinates for a tool call: explicit args win, then the saved/env
// location, then a one-shot city-level IP estimate. Throws an actionable error
// when nothing is available so the model asks the user instead of guessing.
async function needLocation(lat, lon) {
  if (lat != null && lon != null) return { lat, lon };
  // A server's public IP says where the server is, not the user — remotely
  // the model has to ask (or pull the saved Wolt address) instead.
  const loc = getLocation() || (isRemoteMode() ? null : await estimateLocation());
  if (!loc) throw new Error("No delivery location is set and IP detection failed. Ask the user for their address and call set_location, or call use_saved_address to use their saved Wolt addresses.");
  return { lat: lat ?? loc.lat, lon: lon ?? loc.lon };
}

async function getBasketsPage(lat, lon) {
  const r = await woltFetch(`${BASKETS_PAGE_URL}?lat=${lat}&lon=${lon}`);
  if (!r.ok) throw new Error(`baskets fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

// Only the process started with this file as its entry point acts on argv and
// opens a transport. Importers (the tests, a custom host) get buildServer and
// nothing else happens. realpath: `npx wolt-mcp` runs through a bin symlink.
const isMain = (() => {
  try { return process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch (e) { return false; }
})();

// `npx -y wolt-mcp install` — one-liner setup: registers this server in Claude
// Desktop's config (and prints the JSON for any other MCP client), then exits.
if (isMain && process.argv[2] === "install") {
  const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const entry = { command: "npx", args: ["-y", "wolt-mcp"] };
  const cfgPath = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : process.platform === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  try {
    // Read first, and treat "file missing" and "file unparseable" differently.
    // Missing is fine (fresh install). Unparseable is NOT: these configs are
    // hand-edited, and silently replacing one with {} would delete every other
    // MCP server the user has registered.
    let existingRaw = null;
    try { existingRaw = readFileSync(cfgPath, "utf8"); } catch (e) { /* no config yet */ }

    let cfg = {};
    let bakPath = null;
    if (existingRaw && existingRaw.trim()) {
      try { cfg = JSON.parse(existingRaw); } catch (e) {
        console.log(`✗ ${cfgPath}\n  exists but isn't valid JSON (${e.message}).`);
        console.log(`  Refusing to rewrite it — that would delete your other MCP servers.`);
        console.log(`  Fix the file (a trailing comma is the usual culprit) and re-run, or add this by hand:`);
        console.log(`    "wolt-mcp": ${JSON.stringify(entry)}`);
        process.exit(1);
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        console.log(`✗ ${cfgPath} is valid JSON but not an object — leaving it alone.`);
        console.log(`  Add this by hand:  "wolt-mcp": ${JSON.stringify(entry)}`);
        process.exit(1);
      }
      // Same check for the one member we actually mutate: spreading a string or
      // an array below would turn it into {"0": ...} and break the whole file.
      if (cfg.mcpServers != null && (typeof cfg.mcpServers !== "object" || Array.isArray(cfg.mcpServers))) {
        console.log(`✗ ${cfgPath} has an "mcpServers" that isn't an object — leaving it alone.`);
        console.log(`  Fix that key and re-run, or add this by hand:  "wolt-mcp": ${JSON.stringify(entry)}`);
        process.exit(1);
      }
      // Keep a copy of whatever was there before we touch it — without ever
      // overwriting an existing backup, which may be the pristine copy from an
      // earlier install run or one the user made themselves. A backup whose
      // contents already match is reused rather than duplicated.
      bakPath = `${cfgPath}.bak`;
      for (let i = 1; i <= 20 && existsSync(bakPath) && readFileSync(bakPath, "utf8") !== existingRaw; i++) {
        bakPath = `${cfgPath}.bak.${i}`;
      }
      if (!existsSync(bakPath)) writeFileSync(bakPath, existingRaw);
      else if (readFileSync(bakPath, "utf8") !== existingRaw) bakPath = null; // all taken — clobber none
    }

    cfg.mcpServers = { ...cfg.mcpServers, "wolt-mcp": entry };
    mkdirSync(join(cfgPath, ".."), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const kept = Object.keys(cfg.mcpServers).filter((k) => k !== "wolt-mcp");
    console.log(`✓ Added wolt-mcp to Claude Desktop (${cfgPath}).`);
    if (kept.length) console.log(`  Left your other servers untouched: ${kept.join(", ")}${bakPath ? ` (backup: ${bakPath})` : ""}`);
    console.log(`  Restart Claude Desktop, then say: "Connect my Wolt account."`);
  } catch (e) {
    console.log(`Could not write Claude Desktop config (${e.message}).`);
  }
  console.log(`\nFor any other MCP client, add:\n  "wolt-mcp": ${JSON.stringify(entry)}`);
  process.exit(0);
}

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const errText = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

// Version comes from package.json so a release bump can't leave the server
// reporting a stale one (test/version.test.mjs keeps manifest.json in step).
const { version: VERSION } = createRequire(import.meta.url)("./package.json");
export { VERSION };

// `npx -y wolt-mcp login` — harvest a Wolt refresh token on THIS machine (the
// browser login can't run on a remote server) and print it for set_wolt_token
// on the remote. The tokens also land in the local store as usual.
if (isMain && process.argv[2] === "login") {
  try {
    const { tokenState } = await cdpLogin({});
    const refresh = exportRefreshToken();
    console.log(`Connected. Tokens stored in ${tokenState.stateFile}.`);
    if (refresh) console.log(`\nRefresh token for a remote wolt-mcp (paste it via set_wolt_token, or copy tokens.json to the server's state dir):\n\n${refresh}\n`);
    process.exit(0);
  } catch (e) {
    console.error(`Login failed: ${e.message}`);
    process.exit(1);
  }
}

// Tools are collected in a registry and applied by buildServer(), because the
// HTTP transport is stateless and builds a fresh McpServer per request, while
// stdio builds exactly one. Registering 29 tools costs about a millisecond.
//
// Annotations are what a client shows before a call: ChatGPT treats every
// tool WITHOUT readOnlyHint as a write and asks for confirmation each time,
// so the hints are kept here in one table and a test checks it is complete.
// openWorldHint is true throughout — every tool talks to wolt.com.
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
// Moves money and cannot be undone from here: every host asks before it.
const PAYS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
export const TOOL_ANNOTATIONS = {
  search_products: READ, search_restaurant_dishes: READ, plan_cart: READ, get_baskets: READ,
  get_venue: READ, get_venue_menu: READ, get_venue_categories: READ, find_item: READ, get_dish_options: READ,
  get_order_history: READ, get_order: READ, get_order_add_on_options: READ, resolve_address: READ, get_feed: READ, top_venues: READ,
  search_venues: READ, get_payment_methods: READ, get_favorites: READ, checkout_preview: READ,
  get_wolt_profile: READ, wolt_status: READ, show_picks: READ, prepare_order: READ, get_order_payment_context: READ,
  // These change the basket, the account, or this server's own saved state.
  use_saved_address: WRITE, add_to_cart: WRITE, update_cart_item: WRITE, add_favorite: WRITE,
  remove_favorite: WRITE, login_via_chrome: WRITE, set_wolt_token: WRITE, set_location: WRITE,
  clear_basket: DESTRUCTIVE, set_order_payment_context: WRITE,
  // Pays with the saved card; gated by the order permission (see lib/order.js).
  place_order: PAYS
};
// Tools that only make sense on the user's own machine. A remote server has no
// browser to drive; its users connect with `npx -y wolt-mcp login` locally.
const LOCAL_ONLY_TOOLS = new Set(["login_via_chrome"]);

const registry = [];
// tool(name, description, [schema], handler, [extra]) — the shape the
// registrations below have always used; the schema is optional for
// argument-less tools, and extra carries outputSchema / _meta when a tool
// has them.
function tool(name, description, schemaOrHandler, maybeHandler, maybeExtra) {
  const hasSchema = typeof schemaOrHandler !== "function";
  const handler = hasSchema ? maybeHandler : schemaOrHandler;
  const schema = hasSchema ? schemaOrHandler : undefined;
  const extra = (hasSchema ? maybeExtra : maybeHandler) || {};
  const annotations = TOOL_ANNOTATIONS[name];
  if (!annotations) throw new Error(`tool ${name} has no entry in TOOL_ANNOTATIONS`);
  registry.push({ name, description, schema, annotations, handler, ...extra });
}

const INSTRUCTIONS = (remote) => "When the user wants to BUY something (not just browse), call wolt_status FIRST — it live-verifies the Wolt login. If it reports loginNeeded, sort the login out with the user (" +
  (remote
    ? "this server runs remotely, so there is no browser login here: the user logs in at wolt.com, opens developer tools → Network, finds the request to authentication.wolt.com/v1/wauth2/access_token, copies its refresh_token, and pastes it to set_wolt_token"
    : "login_via_chrome, or set_wolt_token on Firefox/Safari") +
  ") before searching and planning, so the work isn't lost to an expired session mid-checkout. Searching and browsing venues never need a login.";

// ordering: { allowed, cap } — whether this connection may place orders and
// an optional per-order ceiling in minor units. Decided per grant by the
// remote transport, by WOLT_ALLOW_ORDERS / WOLT_ORDER_CAP on stdio.
export function buildServer({ remote = false, ordering = null } = {}) {
  const server = new McpServer({ name: "wolt-mcp", version: VERSION }, {
    instructions: INSTRUCTIONS(remote) + " For the delivery address: use_saved_address pulls the user's saved Wolt addresses and sets one as the search location (get_wolt_profile does NOT have addresses); a spoken address goes through resolve_address + set_location. Baskets are single-venue: source every item from one store. The fast path for a shopping list is wolt_status -> use_saved_address (if no location) -> ONE plan_cart call (it auto-picks the store and reports runner-up coverage) -> review the matches -> add_to_cart -> checkout_preview. wolt_status and the address tools report the market's catalogLanguage — translate the ingredient list into it BEFORE calling plan_cart (Greek in Greece, Japanese in Japan, Hebrew in Israel, Georgian in Georgia, and so on), and write each product in dictionary form (singular nominative, like a shelf label) since catalog search matches prefixes and inflected words find little or nothing; plan_cart refuses off-language lists with needsTranslation. Don't compare stores manually with repeated searches unless the user asks, and never write a lowCoverage plan without agreeing with the user first. Pictures: items and venues come with imageUrl, Wolt's own photo on a public CDN — show those when you illustrate results, never stock or web-search images, and if you can't embed them, link them. Whenever you present a shortlist — dinner ideas, the best venues nearby, product options — research with the search/feed/menu tools (they return text) and then call show_picks ONCE with the final picks (names, prices, imageUrl, rating, venue) so they appear as one set of photo cards; keep the prose short since the cards carry the details. Only show_picks, checkout_preview and prepare_order draw a card; get_baskets is a plain lookup, so for \"add X\" or \"clear my basket\" do the write and report it in a sentence rather than listing every basket. Ordering: only when the user asks to order or pay, and only if this connection was approved for it (place_order says so otherwise). prepare_order quotes the basket with the saved address and card. Its card reuses recent device preparation, collects it inline where supported, or detects completion of browser preparation, and lets the user Confirm and pay without typing Done; that explicit button click confirms the displayed total. In text chat, show the total, address and card, wait for explicit confirmation, then call place_order. Let the checkout card own its confirmation; do not create a second custom Confirm button or repeat a ready-for-confirmation card underneath it. A local device-preparation check is not a Wolt rejection. Never call place_order without the user confirming that exact total in this conversation."
  });
  for (const t of registry) {
    if (remote && LOCAL_ONLY_TOOLS.has(t.name)) continue;
    const meta = { ...(uiMeta(t.name) || {}), ...(t._meta || {}) };
    const stamp = resultMeta(t.name);
    // A render tool's result carries the card metadata too (see resultMeta).
    // Handlers get the connection's ordering permission as a third argument
    // (the SDK passes only `extra` to a tool without a schema, hence the two
    // shapes); only the order tools look at it.
    const call = t.schema ? (args, extra) => t.handler(args, extra, ordering) : (extra) => t.handler(extra, undefined, ordering);
    const handler = stamp ? async (args, extra) => {
      const r = await call(args, extra);
      return r && r.structuredContent && !r.isError ? { ...r, _meta: { ...stamp, ...(r._meta || {}) } } : r;
    } : call;
    server.registerTool(t.name, { description: describe(t.name, t.description), inputSchema: t.schema, outputSchema: t.outputSchema, annotations: t.annotations, _meta: Object.keys(meta).length ? meta : undefined }, handler);
  }
  // The inline-card template for hosts that render MCP Apps (lib/ui.js).
  registerUi(server);
  return server;
}

// --- search_products: one ingredient -> candidate products (no auth) ---
tool(
  "search_products",
  "Search Wolt store products (grocery, pharmacy, health and beauty, alcohol, household and other non-restaurant items) for a single ingredient or product. Default: searches ALL nearby stores. With venue_slug: searches ONE store's own catalog (needs login; query in the store's language) — use this to check or fix a single item at the store you're building the basket at. For a whole recipe or shopping list, prefer plan_cart — it resolves every ingredient in one call. A basket must be all from ONE venueId. MATCHING RULES when picking: (1) Match the ingredient ITSELF — never a plant-based, vegan, imitation, or flavored substitute unless the user explicitly asked. e.g. 'Redefine Meat'/'plant-based mince' is NOT ground beef; margarine is NOT butter; imitation crab is NOT crab. (2) Do NOT just pick the cheapest — Wolt surfaces cheap 'Substitute Deals' that are often imitation products; prefer the real, mainstream item at a sensible package size. (3) Match the right FORM (crushed tomatoes ≠ tomato paste; ground beef ≠ beef sausage). When unsure, prefer the plainest real version of the actual ingredient.",
  {
    query: z.string().describe("Product search term, e.g. 'crushed tomatoes' — with venue_slug set, write it in the store's catalogLanguage (returned by get_venue/plan_cart/this tool), in dictionary form (singular nominative, as a shelf label reads): catalog search matches prefixes, so an inflected word finds little or nothing"),
    venue_slug: z.string().optional().describe("Search only this store's catalog (the venue you're building the basket at)"),
    lat: z.number().optional().describe("Override latitude; defaults to the saved location"),
    lon: z.number().optional().describe("Override longitude; defaults to the saved location")
  },
  async ({ query, venue_slug, lat, lon }) => {
    if (venue_slug) {
      try {
        const [venue, catalogLanguage, hits] = await Promise.all([
          getVenue(venue_slug),
          getCatalogLanguage(venue_slug),
          searchVenueItems(venue_slug, query, { lang: langOf(query) })
        ]);
        return rich("products", {
          query, venue: { venueId: venue.venueId, slug: venue_slug, name: venue.name, currency: venue.currency, catalogLanguage, imageUrl: venue.imageUrl ?? null },
          count: hits.length,
          items: hits.slice(0, 15).map((c) => ({ itemId: c.itemId, name: c.name, price: c.price, imageUrl: c.imageUrl ?? null, ...(c.isWeighted ? { isWeighted: true, sellByWeight: c.sellByWeight } : {}) })),
          ...(catalogLanguage && isNonLatinLang(catalogLanguage) && !sameScript(query, catalogLanguage)
            ? { languageNote: `This catalog is indexed in '${catalogLanguage}' and the query isn't — results may be poor or wrong-form. Translate the query to ${catalogLanguage} and retry for better matches.` }
            : {})
        });
      } catch (e) { return errText(e.message); }
    }
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      // Header follows the query's script so result names come back in the
      // query's language instead of machine-translated (relevance is driven by
      // the query text itself; the header only controls display names).
      const items = await searchItems(query, { lat, lon, lang: langOf(query) });
      // Venue metadata goes once into `venues`, not on all 20 items — these
      // responses are read by a model every turn, and the repetition was
      // roughly half the payload.
      const venues = {};
      const top = items.slice(0, 20).map((c) => {
        venues[c.venueId] ||= { name: c.venueName, slug: c.venueSlug, rating: c.venueRating, citySlug: c.citySlug, country: c.country, ...(c.venueImage ? { imageUrl: c.venueImage } : {}) };
        return {
          itemId: c.itemId, name: c.name, price: c.price, currency: c.currency,
          venueId: c.venueId, isWeighted: c.isWeighted, unitSize: c.unitSizeText, imageUrl: c.image || null
        };
      });
      return rich("products", { query, count: top.length, items: top, venues });
    } catch (e) {
      return errText(`search failed: ${e.message}`);
    }
  }
);

// --- search_restaurant_dishes: restaurant food, separate from groceries ---
tool(
  "search_restaurant_dishes",
  "Search RESTAURANT dishes (prepared food) near a location — separate from search_products, which covers store products. Returns dishes with itemId, price, venueId/venueName. A basket is per-venue: don't mix dishes with grocery items. For dishes that likely have choices (burgers, pizzas, combos), call get_dish_options first and pass the user's selections to add_to_cart.",
  {
    query: z.string().describe("Dish or cuisine search term, e.g. 'pad thai'"),
    lat: z.number().optional().describe("Override latitude; defaults to the saved location"),
    lon: z.number().optional().describe("Override longitude; defaults to the saved location")
  },
  async ({ query, lat, lon }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const items = await searchItems(query, { lat, lon, lang: langOf(query), mode: "restaurant" });
      const venues = {};
      const top = items.slice(0, 20).map((c) => {
        venues[c.venueId] ||= { name: c.venueName, slug: c.venueSlug, rating: c.venueRating, citySlug: c.citySlug, country: c.country, ...(c.venueImage ? { imageUrl: c.venueImage } : {}) };
        return { itemId: c.itemId, name: c.name, price: c.price, currency: c.currency, venueId: c.venueId, imageUrl: c.image || null };
      });
      return rich("dishes", { query, count: top.length, dishes: top, venues });
    } catch (e) {
      return errText(`restaurant search failed: ${e.message}`);
    }
  }
);

// --- use_saved_address: pull the delivery address from the Wolt account ---
tool(
  "use_saved_address",
  "Fetch the user's saved Wolt delivery addresses (needs a token) and set one as the default search location. With no address_id: lists all addresses and auto-saves the one Wolt marks selected (or the only one). Call this right after connecting the account so searches use the user's real address instead of the default.",
  { address_id: z.string().optional().describe("Address id from a previous call, to pick a specific one") },
  async ({ address_id }) => {
    try {
      const r = await woltFetch("https://restaurant-api.wolt.com/v2/delivery/info");
      if (!r.ok) return errText(`address fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      const rows = r.json?.results || r.json?.addresses || [];
      // Live-verified shape: coordinates are GeoJSON [lon, lat] under
      // location.user_coordinates (user's pin) or google_place_coordinates.
      const addresses = rows.map((row) => {
        const coords = row.location?.user_coordinates?.coordinates
          || row.location?.google_place_coordinates?.coordinates || null;
        return {
          id: String(row.id || row.address_id || ""),
          alias: row.alias || null,
          labelType: row.label_type || null, // "home" / "work" / "other"
          address: [row.location?.address, row.location?.city].filter(Boolean).join(", ") || null,
          lat: coords ? coords[1] : null,
          lon: coords ? coords[0] : null
        };
      }).filter((a) => a.lat != null && a.lon != null);
      if (!addresses.length) return errText("No saved addresses with coordinates on this Wolt account. Ask the user for their address and use set_location.");
      // No "selected" flag in the payload — prefer the home-labeled address.
      const pick = address_id
        ? addresses.find((a) => a.id === address_id)
        : addresses.length === 1 ? addresses[0]
        : addresses.find((a) => a.labelType === "home") || null;
      if (!pick) return text({ addresses, note: "Multiple addresses and none labeled home — ask the user which to use, then call again with address_id." });
      const saved = setLocation({ lat: pick.lat, lon: pick.lon, label: pick.alias ? `${pick.alias} — ${pick.address}` : pick.address });
      return text({ saved, pickedAddressId: pick.id, addresses, ...(await marketLanguageFields(pick.lat, pick.lon)) });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- plan_cart: whole list -> single-store plan, one call ---
tool(
  "plan_cart",
  "Resolve a whole ingredient list into a single-store cart in ONE call. Without venue_slug it auto-picks: shortlists the best-covering nearby stores and races the list against each store's own catalog, returning the winner plus per-store coverage of the runners-up (evaluatedVenues) — if lowCoverage is flagged, agree with the user before writing anything. With venue_slug it plans against that store only. Write ingredient lines in the market's catalog language (reported by wolt_status/set_location/use_saved_address as catalogLanguage — translate them yourself), and name each product in DICTIONARY form — singular nominative, the way a shelf label reads — because catalog search matches prefixes: an inflected line like '2 sipulia' finds a fraction of what '2 sipuli' finds, and in the worst case nothing. If most lines are in the wrong script it returns needsTranslation instead of planning — translate and call again. A rateLimited response means Wolt throttled the burst: wait ~30s and retry, don't rephrase. Returns line items with alternatives + a ready add_to_cart basket. Each line carries a confidence: 'low' ones are listed again under verifyBeforeWriting with the reason — read those names yourself and judge by meaning (a sauce, pesto, snack or flavoured version scores just as well as the real product), swapping in an alternative or dropping the line before you write anything.",
  {
    ingredients: z.array(z.string()).describe("Ingredient lines, e.g. ['800 g crushed tomatoes', '1 onion'] — in the store's catalogLanguage (translate them yourself; the plan response reports it), and each product named in DICTIONARY form: singular nominative, as a shop shelf labels it, not as a recipe inflects it ('2 sipuli' not '2 sipulia', '400 g tomaattimurska' not 'tomaattimurskaa')"),
    venue_slug: z.string().optional().describe("Pin planning to this store instead of auto-picking"),
    lat: z.number().optional().describe("Override latitude; defaults to the saved location"),
    lon: z.number().optional().describe("Override longitude; defaults to the saved location")
  },
  async ({ ingredients, venue_slug, lat, lon }) => {
    try {
      if (venue_slug) {
        // Preflight: refuse to burn a whole planning round on off-script lines.
        const early = translationPreflight(ingredients, await getCatalogLanguage(venue_slug));
        if (early) return text(early);
        return rich("plan", planResponse(await planAtVenue(venue_slug, ingredients), ingredients.length));
      }
      ({ lat, lon } = await needLocation(lat, lon));
      const early = translationPreflight(ingredients, await getMarketLanguage({ lat, lon }));
      if (early) return text(early);
      const perIngredient = await mapPool(ingredients, 6, async (raw) => {
        const q = parseIngredientLine(raw).name;
        let candidates = [];
        try { candidates = await searchItems(q, { lat, lon, lang: langOf(q) }); } catch (e) {}
        return { ingredient: raw, spec: { query: q }, candidates: rankCandidates(q, candidates) };
      });
      // In-venue planning is tokenless — every user gets the full store race.
      // Top 3 by global coverage: the winner is overwhelmingly in there, and 5
      // venues' searches were half of the burst that got us rate-limited.
      const shortlist = rankVenues(perIngredient).slice(0, 3).filter((r) => r.venue.venueSlug);
      if (shortlist.length) {
        const plans = (await mapPool(shortlist, 3, async (r) => {
          try { return await planAtVenue(r.venue.venueSlug, ingredients); } catch (e) { return null; }
        })).filter(Boolean);
        if (plans.length) {
          // Coverage always beats price, and a half-degraded plan can't win —
          // its coverage number is a lie, not a store comparison.
          const { best, allDegraded } = rankPlans(plans, ingredients.length);
          if (allDegraded) {
            return text({ rateLimited: true, note: "Wolt rate-limited the planning burst. Wait ~30 seconds and call plan_cart again, or pin one store with venue_slug." });
          }
          return rich("plan", {
            ...planResponse(best, ingredients.length),
            evaluatedVenues: plans.map((p) => ({
              name: p.venue.name, slug: p.venue.slug, coverage: `${p.coverageCount}/${ingredients.length}`,
              ...(p.searchErrors ? { searchErrors: p.searchErrors } : {})
            }))
          });
        }
      }
      const { venue, chosen, missing } = selectBestVenue(perIngredient);
      if (!venue) return text({ venue: null, missing, note: "No store covered these ingredients." });
      const currency = resolveCurrency({ candidates: chosen.map((c) => c.candidate), country: venue.country });
      return rich("plan", {
        venue,
        coverage: `${chosen.length}/${ingredients.length}`,
        lineItems: chosen.map((c) => ({ ingredient: c.ingredient, name: c.candidate.name, itemId: c.candidate.itemId, price: c.candidate.price, isWeighted: c.candidate.isWeighted, imageUrl: c.candidate.image || null })),
        missing,
        basket: currency ? buildBasketBody(chosen.map((c) => ({ candidate: c.candidate, count: 1 })), venue.venueId, currency) : null,
        ...(currency ? {} : { basketNote: "No currency on record for this venue — call add_to_cart with an explicit currency taken from search_products results." })
      });
    } catch (e) {
      return errText(`plan failed: ${e.message}`);
    }
  }
);

// --- add_to_cart: write the basket (needs WOLT_BEARER_TOKEN) ---
tool(
  "add_to_cart",
  "Write items to the user's Wolt basket for one venue. All items must share the venue_id. Needs login (if wolt_status says loginNeeded, do that first). ALWAYS pass venue_slug: it lets each line's weighted flag be reconciled against how the catalog actually sells the item — items named '~900 g pack' are often COUNT items, truly weighted items only accept multiples of their gramsPerStep, and either mismatch is silently dropped by Wolt. Corrections made are reported as `adjustments`. The response also re-reads the basket and reports droppedLines for anything Wolt still discarded — treat those as NOT added. Returns a checkoutUrl — give it to the user, and call checkout_preview for the real total including fees. Nothing is ever ordered automatically; the user reviews and pays on wolt.com.",
  {
    venue_id: z.string(),
    venue_slug: z.string().optional().describe("Venue slug — in search_products results it is venues[venueId].slug, not a field on the item"),
    city_slug: z.string().optional().describe("City slug — venues[venueId].citySlug in search_products results"),
    country: z.string().optional().describe("3-letter country — venues[venueId].country in search_products results, e.g. 'fin', 'deu', 'jpn'"),
    currency: z.string().optional().describe("Currency, taken from the item you picked (e.g. 'EUR', 'SEK', 'PLN'); resolved from the venue if omitted"),
    items: z.array(z.object({
      id: z.string(),
      name: z.string(),
      price: z.number().describe("price in minor units"),
      count: z.number().int().default(1),
      weighted: z.boolean().default(false),
      grams: z.number().nullable().default(null).describe("grams to buy for by-weight items"),
      options: z.array(z.object({
        id: z.string().describe("groupId from get_dish_options"),
        values: z.array(z.object({
          id: z.string().describe("valueId from get_dish_options"),
          count: z.number().int().default(1),
          price: z.number().default(0)
        }))
      })).optional().describe("Dish option selections; required-option dishes need these")
    }))
  },
  async ({ venue_id, venue_slug, city_slug, country, currency, items }) => {
    // A slug posted as venue_id yields a success-shaped response but a basket
    // that never persists (phantom basket). Refuse early rather than lie.
    if (!isVenueObjectId(venue_id)) {
      return errText(`venue_id "${venue_id}" is not a Wolt venue id (24 hex chars). Use the venueId field from search_products — not the venue slug — or the item was NOT added.`);
    }
    try {
      // Resolve currency/country from the venue when not supplied, then from
      // the venue's market — never from a hardcoded default, which would price
      // one market's basket in another's money.
      let venueInfo = null;
      if (venue_slug && (!currency || !country)) {
        try { venueInfo = await getVenue(venue_slug); } catch (e) {}
      }
      country = country || venueInfo?.country?.toLowerCase() || null;
      currency = resolveCurrency({ currency, venue: venueInfo, country });
      if (!currency) {
        return errText(`can't tell which currency this venue prices in, so nothing was written. Pass currency (the value from the search_products results, e.g. 'EUR') — and venue_slug, if you have it — and call add_to_cart again.`);
      }
      // The caller's weighted flag is a guess (names like "~900 g pack" read
      // as weighted but are count items, and vice versa). Reconcile every
      // line against how the catalog actually sells it, and snap weighted
      // grams onto the item's step — either kind of mismatch is a line Wolt
      // accepts and then silently repairs or removes.
      const adjustments = venue_slug
        ? reconcileWeightedItems(items, await getWeightConfigs(venue_slug, items.map((it) => it.id)))
        : [];
      let body = buildBasketBody(
        items.map((it) => ({ candidate: { itemId: it.id, name: it.name, price: it.price, isWeighted: it.weighted }, count: it.count, grams: it.grams || undefined, options: it.options })),
        venue_id, currency
      );
      // POST /baskets replaces the venue's basket wholesale — merge with any
      // existing lines first so we never clobber what the user already added.
      let mergedFromExisting = 0;
      try {
        const loc = getLocation();
        const existing = loc ? findBasketForVenue(await getBasketsPage(loc.lat, loc.lon), venue_id) : null;
        if (existing?.items?.length) {
          body = { ...body, items: mergeBasketItems(existing.items, body.items) };
          mergedFromExisting = existing.items.length;
        }
      } catch (e) { /* best effort — a fresh basket write is still correct */ }
      const r = await woltFetch(BASKET_URL, { method: "POST", body });
      if (!r.ok) return errText(`cart write failed: HTTP ${r.status} ${r.text.slice(0, 300)}`);
      // Read-after-write: Wolt's basket POST returns success even for lines it
      // silently discards (invalid weight, unavailable item). Re-read the
      // basket and diff, so "ok" is never claimed for a line that isn't there.
      let verification = {};
      try {
        const loc = getLocation();
        if (loc) {
          const after = findBasketForVenue(await getBasketsPage(loc.lat, loc.lon), venue_id);
          const present = new Set((after?.items || []).map((i) => i.id));
          const dropped = items.filter((it) => !present.has(it.id)).map((it) => it.name);
          verification = {
            verified: true,
            linesInBasket: (after?.items || []).length,
            ...(dropped.length ? {
              droppedLines: dropped,
              droppedNote: "Wolt accepted the write but silently DROPPED these lines — usually an invalid weight (must be a multiple of the item's gramsPerStep) or an unavailable item. They are NOT in the cart: fix and re-add them, and don't tell the user they're included."
            } : {})
          };
        }
      } catch (e) { /* verification is best-effort; the write itself succeeded */ }
      let checkoutUrl = "https://wolt.com";
      if (venue_slug && country && city_slug) {
        checkoutUrl = `https://wolt.com/en/${country}/${city_slug}/venue/${venue_slug}`;
      } else if (venue_slug) {
        // The venue's own share_url is the canonical link — no city/country
        // plumbing needed from the caller.
        try { checkoutUrl = (await getVenue(venue_slug)).shareUrl || checkoutUrl; } catch (e) {}
        if (checkoutUrl === "https://wolt.com") checkoutUrl = `https://wolt.com/search?q=${encodeURIComponent(venue_slug)}`;
      }
      return text({
        ok: true, status: r.status, basketId: r.json?.id ?? null, itemsWritten: items.length, existingLinesPreserved: mergedFromExisting,
        ...(adjustments.length ? { adjustments } : {}),
        ...verification,
        checkoutUrl,
        note: `Basket written. Give the user this link to review and check out: ${checkoutUrl}. Then call checkout_preview for the delivery-included total.`
      });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- get_baskets: list the user's current Wolt baskets ---
tool(
  "get_baskets",
  "List the user's current Wolt baskets (needs a token): basket id, venue, and line items with names, counts, and prices (minor units). Use before add_to_cart to see what's already there, or after to confirm the write persisted.",
  {
    lat: z.number().optional().describe("Override latitude; defaults to the saved location"),
    lon: z.number().optional().describe("Override longitude; defaults to the saved location")
  },
  async ({ lat, lon }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const page = await getBasketsPage(lat, lon);
      const baskets = (page.baskets || []).map((b) => ({
        basketId: b.id,
        venueId: b.venue?.id,
        venueName: b.venue?.name,
        currency: b.currency || null,
        items: (b.items || []).map((it) => ({ id: it.id, name: it.name, count: it.count, price: it.price, imageUrl: imageUrlOf(it.image) || it.image_url || null }))
      }));
      return rich("baskets", { count: baskets.length, baskets });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- clear_basket: delete a basket by id ---
tool(
  "clear_basket",
  "Delete one of the user's Wolt baskets entirely (needs a token). Get the basketId from get_baskets. Confirm with the user before clearing a basket they built themselves.",
  { basket_id: z.string().describe("Basket id from get_baskets") },
  async ({ basket_id }) => {
    try {
      const r = await woltFetch(BASKETS_DELETE_URL, { method: "POST", body: { ids: [basket_id] } });
      if (!r.ok) return errText(`basket delete failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      return text({ ok: true, deleted: basket_id });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- get_venue: detail + hours (slug-cached 24h) ---
tool(
  "get_venue",
  "Venue details by slug (from search results): rating, address, currency, delivery price, opening hours per day with timezone, and catalogLanguage (the language the venue's catalog is indexed in — query/plan in it for best matches). Check hours before adding food from a restaurant that might be closed.",
  { venue_slug: z.string() },
  async ({ venue_slug }) => {
    try {
      const [venue, catalogLanguage] = await Promise.all([getVenue(venue_slug), getCatalogLanguage(venue_slug)]);
      return rich("venue", { ...venue, catalogLanguage });
    } catch (e) { return errText(e.message); }
  }
);

// --- get_venue_menu: browse/search within one venue ---
tool(
  "get_venue_menu",
  "Browse a venue's full menu by slug: categories and items with prices. Optional query (free-text filter) and category (slug). Items flag requiredOptions=true when the dish needs choices — fetch those with get_dish_options before add_to_cart.",
  {
    venue_slug: z.string(),
    query: z.string().optional().describe("Search items by name/description (uses Wolt's in-venue search for large catalogs)"),
    category: z.string().optional().describe("Category slug from get_venue_categories or a previous call"),
    limit: z.number().int().default(30)
  },
  async ({ venue_slug, query, category, limit }) => {
    try {
      // The venue (cached) supplies the currency the prices are in; the menu
      // alone doesn't say, and a card would otherwise guess.
      const [menu, venue] = await Promise.all([getMenu(venue_slug, { query, categorySlug: category, limit }), getVenue(venue_slug).catch(() => null)]);
      return rich("menu", { venueSlug: venue_slug, currency: venue?.currency ?? null, ...menu });
    } catch (e) { return errText(e.message); }
  }
);

// --- get_venue_categories: the browse index (big groceries nest deeply) ---
tool(
  "get_venue_categories",
  "List a venue's categories (nested: depth, parent, subcategories, item counts). Start here to browse a large grocery store, then call get_venue_menu with a category slug. Restaurants usually have a handful of flat categories.",
  { venue_slug: z.string() },
  async ({ venue_slug }) => {
    try { return text(await getCategories(venue_slug)); } catch (e) { return errText(e.message); }
  }
);

// --- find_item: resolve an item by name or wolt.com URL ---
tool(
  "find_item",
  "Resolve one item in a venue by name, item id, or a wolt.com item URL (…/venue/<slug>/itemid-<id>). Exact name matches win; an ambiguous name returns the top candidates so you can ask the user which they meant. Use when the user pastes a Wolt link or names a dish loosely.",
  {
    item: z.string().describe("Item name, 24-hex item id, or full wolt.com item URL"),
    venue_slug: z.string().optional().describe("Required unless the URL contains /venue/<slug>/")
  },
  async ({ item, venue_slug }) => {
    try {
      const parsed = parseItemUrl(item);
      const resolved = await resolveItem(venue_slug || parsed.slug, item);
      return text({ venueSlug: venue_slug || parsed.slug, ...resolved });
    } catch (e) { return errText(e.message); }
  }
);

// --- get_dish_options: option groups for one item ---
tool(
  "get_dish_options",
  "Option groups for one menu item (sizes, toppings, sides): group ids, required/min/max, and each value's id/name/price. Ask the user for required choices, then pass options to add_to_cart as [{id: groupId, values: [{id: valueId, count: 1, price}]}].",
  { venue_slug: z.string(), item_id: z.string().describe("itemId from get_venue_menu — availability varies by hour, so fetch the menu first") },
  async ({ venue_slug, item_id }) => {
    try { return text(await getItemOptions(venue_slug, item_id)); } catch (e) { return errText(e.message); }
  }
);

// --- get_order_history / get_order: enables "reorder my usual" ---
tool(
  "get_order_history",
  "The user's past Wolt orders (needs a token): venue, date, total, status, purchase_id. Use get_order for line items — together these enable 'order my usual again'.",
  { limit: z.number().int().default(10), skip: z.number().int().default(0) },
  async ({ limit, skip }) => {
    try {
      const j = await getOrderHistory({ limit, skip });
      const orders = (j.orders || []).map((o) => ({
        purchaseId: o.purchase_id, venue: o.venue_name, receivedAt: o.received_at,
        status: o.status, total: o.total_amount, active: o.is_active
      }));
      return text({ orders, nextPageToken: j.next_page_token ?? null });
    } catch (e) { return errText(e.message); }
  }
);

tool(
  "get_order",
  "Full detail for one past order by purchase_id (from get_order_history), including line items — feed them back into add_to_cart to reorder.",
  { purchase_id: z.string() },
  async ({ purchase_id }) => {
    try { return text(await getOrder(purchase_id)); } catch (e) { return errText(e.message); }
  }
);

// --- resolve_address: free-form address -> coordinates (OpenStreetMap) ---
tool(
  "resolve_address",
  "Geocode a free-form address to coordinates via OpenStreetMap (no Wolt account needed). Use the result with set_location. Returns up to 3 candidates — confirm with the user if ambiguous.",
  { address: z.string().describe("e.g. 'Aleksanterinkatu 1, Helsinki'") },
  async ({ address }) => {
    try {
      const candidates = await geocodeAddress(address);
      if (!candidates.length) return errText(`no results for "${address}" — try adding a city or country`);
      return text({ candidates });
    } catch (e) { return errText(e.message); }
  }
);

// --- get_feed: discovery front page ("Popular", "Order again", …) ---
tool(
  "get_feed",
  "Wolt's discovery feed near the user: sections like 'Order again', 'Popular right now' with venues (name, slug, rating, delivery estimate). Good for 'what should I eat?' questions.",
  {
    lat: z.number().optional(), lon: z.number().optional(),
    section: z.string().optional().describe("Return only the section whose title contains this text")
  },
  async ({ lat, lon, section }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const r = await woltFetch(`https://consumer-api.wolt.com/v1/pages/front?lat=${lat}&lon=${lon}`, { auth: "optional" });
      if (!r.ok) return errText(`feed failed: HTTP ${r.status}`);
      let sections = (r.json?.sections || []).map((s) => ({
        title: s.title || s.name || null,
        venues: (s.items || []).filter((it) => it.venue).slice(0, 10).map((it) => ({
          name: it.venue.name, slug: it.venue.slug, venueId: it.venue.id,
          rating: it.venue.rating?.score ?? it.venue.rating?.rating ?? null,
          ratingVolume: it.venue.rating?.volume ?? null,
          imageUrl: it.venue.image_url || imageUrlOf(it.image) || null,
          estimate: it.venue.estimate_range || it.venue.delivery_price || null,
          online: it.venue.online ?? null
        }))
      })).filter((s) => s.title && s.venues.length);
      if (section) sections = sections.filter((s) => s.title.toLowerCase().includes(section.toLowerCase()));
      return rich("venues", { sections });
    } catch (e) { return errText(e.message); }
  }
);

// --- top_venues: ranked venues with real filters (open-now, fee, score) ---
tool(
  "top_venues",
  "Top venues near the user with real filters: open now, min score (0-10), max delivery fee, Wolt+ only, restaurant vs grocery, tag/name text. Sorted by score by default. THE tool for 'what's good and open near me right now?'.",
  {
    lat: z.number().optional(), lon: z.number().optional(),
    open_now: z.boolean().default(true),
    min_score: z.number().optional().describe("Minimum rating score, 0-10 (e.g. 8.5)"),
    max_delivery_fee: z.number().optional().describe("Max delivery fee in minor units"),
    wolt_plus_only: z.boolean().default(false),
    kind: z.enum(["restaurant", "grocery", "any"]).default("any"),
    query: z.string().optional().describe("Filter by name/tags/description substring, e.g. 'sushi'"),
    sort: z.enum(["score", "delivery_fee", "estimate"]).default("score"),
    limit: z.number().int().default(10)
  },
  async ({ lat, lon, open_now, min_score, max_delivery_fee, wolt_plus_only, kind, query, sort, limit }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const r = await woltFetch(`https://consumer-api.wolt.com/v1/pages/front?lat=${lat}&lon=${lon}`, { auth: "optional" });
      if (!r.ok) return errText(`feed failed: HTTP ${r.status}`);
      const seen = new Set();
      let venues = [];
      for (const s of r.json?.sections || []) {
        for (const it of s.items || []) {
          const v = it.venue;
          if (!v?.id || seen.has(v.id)) continue;
          seen.add(v.id);
          venues.push({
            name: v.name, slug: v.slug, venueId: v.id,
            score: v.rating?.score ?? null, ratingVolume: v.rating?.volume ?? null,
            imageUrl: v.image_url || imageUrlOf(it.image) || null, currency: v.currency || null,
            online: v.online ?? null, estimateMinutes: v.estimate ?? null,
            deliveryFee: v.delivery_price_int ?? null, deliveryFeeFormatted: v.delivery_price ?? null,
            woltPlus: !!v.show_wolt_plus, productLine: v.product_line || null,
            tags: v.tags || [], description: v.short_description || null
          });
        }
      }
      const total = venues.length;
      if (open_now) venues = venues.filter((v) => v.online !== false);
      if (min_score != null) venues = venues.filter((v) => v.score != null && v.score >= min_score);
      if (max_delivery_fee != null) venues = venues.filter((v) => v.deliveryFee != null && v.deliveryFee <= max_delivery_fee);
      if (wolt_plus_only) venues = venues.filter((v) => v.woltPlus);
      if (kind !== "any") venues = venues.filter((v) => kind === "grocery" ? v.productLine !== "restaurant" : v.productLine === "restaurant");
      if (query) {
        const q = query.toLowerCase();
        venues = venues.filter((v) => [v.name, v.description, ...(v.tags || [])].filter(Boolean).some((t) => t.toLowerCase().includes(q)));
      }
      venues.sort((a, b) =>
        sort === "delivery_fee" ? (a.deliveryFee ?? 1e9) - (b.deliveryFee ?? 1e9)
        : sort === "estimate" ? (a.estimateMinutes ?? 1e9) - (b.estimateMinutes ?? 1e9)
        : (b.score ?? -1) - (a.score ?? -1)
      );
      return rich("venues", { totalNearby: total, matching: venues.length, venues: venues.slice(0, limit) });
    } catch (e) { return errText(e.message); }
  }
);

// --- search_venues: find venues (not items) by name/cuisine ---
tool(
  "search_venues",
  "Search venues (stores AND restaurants) by name or cuisine near the user. Returns name, slug, venueId, rating, online status. Use get_venue for hours, get_venue_menu to browse.",
  { query: z.string(), lat: z.number().optional(), lon: z.number().optional() },
  async ({ query, lat, lon }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const r = await woltFetch("https://restaurant-api.wolt.com/v1/pages/search", {
        method: "POST", body: { q: query, target: null, lat, lon }, auth: "optional"
      });
      if (!r.ok) return errText(`venue search failed: HTTP ${r.status}`);
      const venues = [];
      for (const s of r.json?.sections || []) {
        for (const it of s.items || []) {
          const v = it.venue;
          if (!v || venues.some((x) => x.venueId === v.id)) continue;
          venues.push({
            name: v.name, slug: v.slug, venueId: v.id,
            rating: v.rating?.score ?? v.rating?.rating ?? null,
            ratingVolume: v.rating?.volume ?? null,
            imageUrl: v.image_url || imageUrlOf(it.image) || null,
            online: v.online ?? null, address: v.address || null,
            productLine: v.product_line || null
          });
        }
      }
      return rich("venues", { query, count: venues.length, venues: venues.slice(0, 15) });
    } catch (e) { return errText(e.message); }
  }
);

// --- order add-ons and saved payment methods (read-only) ---
tool(
  "get_order_add_on_options",
  "Check Wolt's time-limited add-on offer for an existing order. Returns eligible venues, the saved address, the exact deadline and Wolt's delivery terms. No added delivery fee may apply, but service fees and minimums still can; one courier is not guaranteed. Pass parent_purchase_id to prepare_order for an eligible venue. Read-only; never orders.",
  { purchase_id: z.string().min(1).describe("Existing order id from place_order or get_order_history") },
  async ({ purchase_id }) => {
    try { return text(await getAddOnOptions(purchase_id)); }
    catch (e) { return errText(e.message); }
  }
);

tool(
  "get_payment_methods",
  "The user's saved Wolt payment methods (needs a token). Read-only. Payment happens on wolt.com, or through place_order with a saved card when this connection was approved for ordering.",
  async () => {
    try {
      const r = await woltFetch("https://restaurant-api.wolt.com/v3/user/me/payment_methods");
      if (!r.ok) return errText(`payment methods failed: HTTP ${r.status}`);
      return text(r.json?.results ?? r.json);
    } catch (e) { return errText(e.message); }
  }
);

// --- favorites ---
tool(
  "get_favorites",
  "The user's favorited Wolt venues (needs a token).",
  async () => {
    try {
      const loc = await needLocation();
      const r = await woltFetch(`https://consumer-api.wolt.com/v1/pages/venue-list/profile/favourites?lat=${loc.lat}&lon=${loc.lon}`);
      if (!r.ok) return errText(`favorites failed: HTTP ${r.status}`);
      const venues = (r.json?.sections || []).flatMap((s) => (s.items || []))
        .filter((it) => it.venue)
        .map((it) => ({ name: it.venue.name, slug: it.venue.slug, venueId: it.venue.id, rating: it.venue.rating?.score ?? null, online: it.venue.online ?? null }));
      return text({ count: venues.length, venues });
    } catch (e) { return errText(e.message); }
  }
);

tool(
  "add_favorite",
  "Add a venue to the user's Wolt favorites (needs a token).",
  { venue_id: z.string().describe("Venue id (24 hex)") },
  async ({ venue_id }) => {
    try {
      const r = await woltFetch(`https://restaurant-api.wolt.com/v3/venues/favourites/${venue_id}`, { method: "PUT" });
      if (!r.ok) return errText(`add favorite failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      return text({ ok: true, favorited: venue_id });
    } catch (e) { return errText(e.message); }
  }
);

tool(
  "remove_favorite",
  "Remove a venue from the user's Wolt favorites (needs a token).",
  { venue_id: z.string().describe("Venue id (24 hex)") },
  async ({ venue_id }) => {
    try {
      const r = await woltFetch(`https://restaurant-api.wolt.com/v3/venues/favourites/${venue_id}`, { method: "DELETE" });
      if (!r.ok) return errText(`remove favorite failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      return text({ ok: true, unfavorited: venue_id });
    } catch (e) { return errText(e.message); }
  }
);

// --- checkout_preview: price the basket (fees, delivery) — orders nothing ---
tool(
  "checkout_preview",
  "Preview the checkout for the user's current basket at one venue: total payable amount including delivery fees and service charges, delivery options, and active offers. Read-only — never places an order. Use after add_to_cart to tell the user their real total before they open wolt.com.",
  {
    venue_id: z.string().optional().describe("Venue id (24 hex) of the basket to price; defaults to the user's only/first basket"),
    venue_slug: z.string().optional().describe("venueSlug from search results — improves category resolution"),
    tip: z.number().int().default(0).describe("Courier tip in minor units"),
    promo_code: z.string().optional(),
    lat: z.number().optional(), lon: z.number().optional()
  },
  async ({ venue_id, venue_slug, tip, promo_code, lat, lon }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const preview = await checkoutPreview({
        venueId: venue_id || null, venueSlug: venue_slug || null,
        lat, lon, tip, promoCode: promo_code || null
      });
      const { raw, ...summary } = preview; // keep the tool result compact
      return rich("checkout", summary);
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- prepare_order / place_order: pay for the basket with a saved card ---
// The only tools that move money. Both read the connection's ordering
// permission (lib/order.js explains the two phases and what is refused).
const NOT_ALLOWED = "This connection is not allowed to place orders. The user can enable it by connecting again and ticking \"allow this connection to place and pay for orders\" on the approve page (WOLT_ALLOW_ORDERS=1 for a local server). Until then, send them to wolt.com to check out: the venue link opens the saved basket.";
tool(
  "prepare_order",
  "Quote the user's basket at one venue for a real order: total including fees, delivery, credits and any weight reserve, saved address and saved card. Supports multiple quantities, dish options, and items sold in grams (final weight may change the charge). Orders nothing; quote valid up to two minutes. The rendered card reuses recent preparation and offers Confirm and pay; never ask the user to type Done. Embedded iPhone/iPad cards use paymentContextUrl when browser preparation is needed and detect completion automatically; other compatible hosts can prepare inline. For an add-on, check get_order_add_on_options and pass parent_purchase_id; same address, eligible venue and deadline are enforced. Needs ordering permission. Show the total, address and card and wait for an explicit yes before place_order.",
  {
    venue_id: z.string().optional().describe("Venue id (24 hex) of the basket to order; defaults to the user's only/first basket"),
    venue_slug: z.string().optional().describe("venueSlug from search results"),
    tip: z.number().int().min(0).default(0).describe("Courier tip in minor units"),
    comment: z.string().max(500).optional().describe("Note to the courier/venue"),
    payment_method_id: z.string().optional().describe("A specific saved card id from get_payment_methods; defaults to the default card"),
    address_id: z.string().optional().describe("A specific saved address id from use_saved_address; defaults to the home address"),
    parent_purchase_id: z.string().min(1).optional().describe("Existing order for a time-limited add-on; first check get_order_add_on_options"),
    lat: z.number().optional(), lon: z.number().optional()
  },
  async ({ venue_id, venue_slug, tip, comment, payment_method_id, address_id, parent_purchase_id, lat, lon }, _extra, ordering) => {
    if (!ordering?.allowed) return errText(NOT_ALLOWED);
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      let paymentSdkConfig = null;
      if (ordering.paymentSdkConfig) {
        try { paymentSdkConfig = await ordering.paymentSdkConfig(); } catch { /* the external page remains a fallback */ }
      }
      const quote = await prepareOrder({ venueId: venue_id || null, venueSlug: venue_slug || null, lat, lon, tip, comment: comment || "", paymentMethodId: payment_method_id || null, addressId: address_id || null, parentPurchaseId: parent_purchase_id || null, paymentSetup: ordering.paymentSetup || null });
      if (paymentSdkConfig) quote.paymentSdkConfig = paymentSdkConfig;
      if (ordering.cap != null && quote.payableAmount > ordering.cap) {
        quote.warning = `over the per-order limit set for this connection (${(ordering.cap / 100).toFixed(2)} ${quote.currency}); place_order will refuse it`;
      }
      return rich("checkout", quote);
    } catch (e) {
      return errText(e.message);
    }
  }
);
tool(
  "set_order_payment_context",
  "Checkout UI only: attach the real SDK device ID and browser metadata collected by the rendered checkout card. Never invent these values. Does not call Wolt or place an order.",
  {
    quote_id: z.string().uuid(),
    device_id: z.string().min(1).max(512),
    browser_info: z.object({ color_depth: z.number().int().positive(), java_enabled: z.boolean(), language: z.string().min(1).max(80), screen_height: z.number().int().positive(), screen_width: z.number().int().positive(), time_zone_offset: z.number().int().min(-1440).max(1440), user_agent: z.string().min(1).max(2000) })
  },
  async ({ quote_id, device_id, browser_info }, _extra, ordering) => {
    if (!ordering?.allowed) return errText(NOT_ALLOWED);
    try { return text(attachPaymentContext({ quoteId: quote_id, deviceId: device_id, browserInfo: browser_info })); }
    catch (e) { return errText(e.message); }
  },
  { _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true, "openai/visibility": "private" } }
);
tool(
  "get_order_payment_context",
  "Checkout UI only: check whether browser preparation has completed for this quote. Reads local preparation state only; never calls Wolt or submits an order.",
  { quote_id: z.string().uuid(), require_browser: z.boolean().default(false) },
  async ({ quote_id, require_browser }, _extra, ordering) => {
    if (!ordering?.allowed) return errText(NOT_ALLOWED);
    try { return text(paymentContextStatus({ quoteId: quote_id, requireBrowser: require_browser })); }
    catch (e) { return errText(e.message); }
  },
  { _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true, "openai/visibility": "private" } }
);
tool(
  "place_order",
  "Pay for a quoted basket with the user's saved card. Irreversible from here (cancel in Wolt). Call only after the user confirmed the exact quoted total in chat or clicked Confirm and pay on that checkout card. The card handles device preparation and reports its result; never ask for another confirmation after a card attempt. A result with ok:false and code:payment_declined is a real refusal: show checkoutUrl and stop, do not refresh the quote and retry. Check uncertain outcomes with get_order_history/get_order, not get_baskets. Refuses expired quotes, different totals and amounts over the connection's limit.",
  {
    quote_id: z.string().uuid().describe("quoteId from prepare_order"),
    total: z.number().int().describe("payableAmount from that quote, in minor units — the number the user confirmed")
  },
  async ({ quote_id, total }, _extra, ordering) => {
    if (!ordering?.allowed) return errText(NOT_ALLOWED);
    try {
      return text(await placeOrder({ quoteId: quote_id, total, cap: ordering.cap ?? null }));
    } catch (e) {
      if (e instanceof PaymentRefusal) return { ...text(e.result), structuredContent: e.result };
      return errText(e.message);
    }
  },
  { _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true } }
);

// --- show_picks: the answer's own photo cards, one call per recommendation ---
tool(
  "show_picks",
  "Present a curated shortlist (dishes, products or venues you are recommending) as ONE set of photo cards. Call it once, at the end, with the final picks — never per venue. Copy name, price (minor units) + currency, imageUrl, rating and venue from the results you got; imageUrl must be the Wolt photo from those results (other hosts are dropped) and url, if given, a wolt.com page. Does not touch Wolt. The cards offer Add and Open/Menu actions, so keep the prose around them short.",
  {
    title: z.string().max(120).optional().describe("Heading, e.g. 'Dinner tonight'"),
    note: z.string().max(300).optional().describe("One line under the cards, e.g. 'Menu prices before fees'"),
    items: z.array(z.object({
      name: z.string().max(120),
      description: z.string().max(200).optional(),
      venueName: z.string().max(120).optional(),
      venueSlug: z.string().max(120).optional(),
      itemId: z.string().max(64).optional().describe("From the menu/search result, so the Add button can target it"),
      price: z.number().int().nonnegative().optional().describe("Minor units, as returned by the tools"),
      currency: z.string().length(3).optional(),
      priceText: z.string().max(40).optional().describe("Instead of price+currency when only a formatted string is known"),
      imageUrl: z.string().url().optional(),
      rating: z.number().min(0).max(10).optional(),
      eta: z.string().max(40).optional().describe("Delivery estimate as text, e.g. '30-40 min'"),
      url: z.string().url().optional().describe("A wolt.com page for the pick (venue shareUrl)")
    })).min(1).max(12)
  },
  async ({ title, note, items }) => {
    const picks = items.map((p) => {
      const out = { ...p };
      if (p.imageUrl) { const u = woltImageUrl(p.imageUrl); if (u) out.imageUrl = u; else delete out.imageUrl; }
      if (p.url) { const u = woltLinkUrl(p.url); if (u) out.url = u; else delete out.url; }
      return out;
    });
    return rich("picks", { title: title ?? null, note: note ?? null, items: picks });
  }
);

// --- update_cart_item: change a line's count or remove it ---
tool(
  "update_cart_item",
  "Set the count of one item in the user's basket at a venue, or remove it (count 0). Uses read-merge-write like add_to_cart. If removing the LAST line, the whole basket is deleted instead (Wolt has no empty-basket state).",
  {
    venue_id: z.string().describe("Venue id (24 hex) from get_baskets"),
    item_id: z.string().describe("Item id of the line to change"),
    count: z.number().int().min(0).describe("New count; 0 removes the line")
  },
  async ({ venue_id, item_id, count }) => {
    if (!isVenueObjectId(venue_id)) return errText(`venue_id "${venue_id}" is not a Wolt venue id (24 hex chars).`);
    try {
      const loc = await needLocation();
      const page = await getBasketsPage(loc.lat, loc.lon);
      const basket = findBasketForVenue(page, venue_id);
      if (!basket) return errText(`no basket found for venue ${venue_id}`);
      const line = (basket.items || []).find((it) => it.id === item_id);
      if (!line) return errText(`item ${item_id} not in this basket. Lines: ${(basket.items || []).map((i) => `${i.id} (${i.name})`).join(", ")}`);

      const remaining = (basket.items || []).filter((it) => it.id !== item_id);
      if (count === 0 && remaining.length === 0) {
        // last line → delete the basket
        const r = await woltFetch(BASKETS_DELETE_URL, { method: "POST", body: { ids: [basket.id] } });
        if (!r.ok) return errText(`basket delete failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
        return text({ ok: true, removedItem: item_id, basketDeleted: basket.id });
      }
      const items = mergeBasketItems(count === 0 ? remaining : basket.items, [])
        .map((it) => (it.id === item_id ? { ...it, count } : it))
        .filter((it) => it.count > 0);
      // The basket's own currency is authoritative here; the venue's market is
      // the fallback. Rewriting a basket in a guessed currency is worse than
      // failing loudly.
      const currency = resolveCurrency({ currency: basket.currency, country: basket.venue?.country });
      if (!currency) return errText(`basket ${basket.id} has no currency on record and the venue's market is unknown — nothing was changed. Re-add the line with add_to_cart (passing currency) instead.`);
      const body = { items, venue_id, currency };
      const r = await woltFetch(BASKET_URL, { method: "POST", body });
      if (!r.ok) return errText(`cart update failed: HTTP ${r.status} ${r.text.slice(0, 300)}`);
      return text({ ok: true, itemId: item_id, newCount: count, linesNow: items.length, note: count === 0 ? "Line removed. Verify with get_baskets — if the line reappears, Wolt may not support removing single lines from multi-line baskets server-side." : "Count updated." });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- login_via_chrome: zero-paste login by watching a Chrome you launch ---
tool(
  "login_via_chrome",
  "Zero-paste Wolt login: launches a Chromium-based browser with wolt.com open; the user logs in normally and the refresh token is picked up automatically and exchanged for an API token. Tell the user two things: (1) a browser window will open in a SEPARATE, EMPTY profile, so they log into Wolt fresh there — their everyday profile, cookies and extensions are untouched; (2) this tool waits up to 2 minutes — if it times out the window stays open, so if they need longer (waiting on an emailed code), let them finish signing in there and call this again. Requires a Chromium-family browser — the user's default browser is auto-detected and used when it's Chrome, Edge, Brave, Vivaldi, Arc or Chromium (CDP-based, so Firefox and Safari cannot work; use set_wolt_token there instead). CHROME_BIN overrides the choice if needed. After a successful login, call use_saved_address so searches use the user's real address.",
  {},
  async () => {
    try {
      const { via, tokenState } = await cdpLogin({});
      return text({ ok: true, connectedVia: via, ...tokenState });
    } catch (e) {
      return errText(`Browser login didn't complete: ${e.message}\nIf they use a non-Chrome Chromium browser (Edge, Brave, Vivaldi, Chromium), set CHROME_BIN to its binary and retry.\nFallback for Firefox/Safari users, or if no Chromium browser is installed: ask the user to paste a Wolt refresh token and store it with set_wolt_token (see the README).`);
    }
  }
);

// --- set_wolt_token: paste tokens in-chat; enables auto-refresh ---
tool(
  "set_wolt_token",
  "Store the user's Wolt tokens (persisted locally, chmod 600). Prefer login_via_chrome; use this when the user pastes a token themselves. Accepts access_token and/or refresh_token, or a JSON blob containing either. With a refresh token stored, the server auto-refreshes forever — the user pastes once.",
  {
    blob: z.string().optional().describe("A JSON blob containing the tokens, e.g. {\"refresh_token\":\"...\"}"),
    access_token: z.string().optional().describe("Wolt access JWT (eyJ..., 'Bearer ' prefix ok)"),
    refresh_token: z.string().optional().describe("Wolt refresh token — enables permanent auto-refresh")
  },
  async ({ blob, access_token, refresh_token }) => {
    if (blob) {
      try {
        const j = JSON.parse(blob);
        access_token = access_token || j.access_token || j.accessToken || j.authorization;
        refresh_token = refresh_token || j.refresh_token || j.refreshToken;
      } catch (e) { return errText("blob is not valid JSON — paste the raw token instead, or use access_token / refresh_token."); }
    }
    if (!access_token && !refresh_token) return errText("Provide a blob, or access_token and/or refresh_token.");
    return text(setTokens({ accessToken: access_token, refreshToken: refresh_token }));
  }
);

// --- get_wolt_profile: who the connected Wolt account is ---
//
// Doubles as the connection's identity for clients that label linked
// accounts: ChatGPT looks for a tool marked _meta["openai/profile"] and calls
// it with the connection's credentials, expecting {id, name?, email?,
// nickname?} and nothing else, with a stable id. So the shape is exactly that,
// in structuredContent and as JSON text. A profile without an id is an error,
// never a made-up one — an invented id would make ChatGPT merge or split
// accounts wrongly.
tool(
  "get_wolt_profile",
  "Who the connected Wolt account is: id, name and email (GET /v1/user/me; needs a token). It does NOT contain delivery addresses: to pull the user's saved addresses and set one as the search location, call use_saved_address instead.",
  async () => {
    try {
      const r = await woltFetch("https://restaurant-api.wolt.com/v1/user/me");
      if (!r.ok) return errText(`profile fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      const profile = woltProfile(r.json);
      if (!profile) return errText("Wolt returned a profile without a stable user id — nothing to report.");
      return { content: [{ type: "text", text: JSON.stringify(profile) }], structuredContent: profile };
    } catch (e) {
      return errText(e.message);
    }
  },
  {
    outputSchema: {
      id: z.string().min(1).regex(/\S/).describe("Wolt user id — stable for the account"),
      name: z.string().optional(),
      email: z.string().optional(),
      nickname: z.string().optional().describe("First name, to tell connected accounts apart")
    },
    _meta: { "openai/profile": true }
  }
);

// Wolt's /v1/user/me wraps the record in `user`, with a Mongo-style id
// (`_id: {$oid}`, verified live) and the name as {first_name, last_name}.
// Plain-string ids and names are accepted too in case another endpoint
// version shows up. Only the identity fields are kept — see the tool's comment.
export function woltProfile(json) {
  const u = json?.user || json || {};
  const rawId = u._id ?? u.id ?? u.user_id;
  const id = typeof rawId === "object" && rawId ? rawId.$oid : rawId;
  if (typeof id !== "string" || !id.trim()) return null;
  const n = u.name;
  const first = typeof n === "object" && n ? n.first_name : u.first_name;
  const last = typeof n === "object" && n ? n.last_name : u.last_name;
  const name = typeof n === "string" ? n : [first, last].filter(Boolean).join(" ");
  const email = typeof u.email === "string" ? u.email : undefined;
  return {
    id,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(first ? { nickname: first } : {})
  };
}

// --- set_location: persist the delivery location ---
tool(
  "set_location",
  "Save the user's delivery location (persisted; used as the default for all searches). When the user gives an address or city, geocode it with resolve_address first and pass the coordinates here with the human-readable text as label. For their saved Wolt addresses, use use_saved_address instead.",
  {
    lat: z.number().describe("Latitude"),
    lon: z.number().describe("Longitude"),
    label: z.string().optional().describe("Human-readable place, e.g. 'Aleksanterinkatu 1, Helsinki'")
  },
  async ({ lat, lon, label }) => text({ saved: setLocation({ lat, lon, label }), ...(await marketLanguageFields(lat, lon)) })
);

// --- wolt_status: live login check + location ---
tool(
  "wolt_status",
  "Call this FIRST whenever the user wants to buy or manage their account: it live-verifies the Wolt login (refreshing the access token if needed) and reports the configured location plus the market's catalogLanguage — write product queries and plan_cart ingredient lines in that language (translate them yourself). If loginNeeded is true, offer login_via_chrome (or set_wolt_token) before planning a cart. Search works without a token.",
  async () => {
    // Actually exercise the token chain instead of reporting what's on disk —
    // a stored refresh token can be stale, and finding that out here beats
    // finding out after the cart is planned.
    let loginNeeded = false, loginDetail = null;
    try { await getAccessToken(); } catch (e) { loginNeeded = true; loginDetail = e.message; }
    const loc = getLocation();
    return text({
      loginNeeded,
      ...(loginDetail ? { loginDetail } : {}),
      ...describeTokens(),
      location: loc || { label: "not set (estimated from IP on first search)", hint: "use_saved_address sets it from the user's saved Wolt addresses; set_location takes a spoken address" },
      ...(loc ? await marketLanguageFields(loc.lat, loc.lon) : {})
    });
  }
);

if (isMain) {
  const http = parseHttpArgs(process.argv.slice(2), process.env);
  if (http) {
    await serveHttp({ buildServer, version: VERSION, ...http });
  } else {
    await buildServer({ ordering: orderingFromEnv(process.env) }).connect(new StdioServerTransport());
    console.error("wolt-mcp server running on stdio");
  }
}
