#!/usr/bin/env node
// Local MCP server for Wolt.
//
// Design: the MCP *client's* model does the reasoning — read the recipe, pick
// the product, choose the venue — so there's no hosted LLM and no API key here.
// This server exposes the Wolt primitives: search, browse menus, read and write
// baskets, preview checkout. Ordering and payment always happen on wolt.com.
//
// Auth: search needs none. Account and basket calls need a token — connect once
// via login_via_chrome (or set_wolt_token); it auto-renews after that.
// See docs/architecture.md for how the API layer works.
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  searchItems, selectBestVenue, rankVenues, buildBasketBody, BASKET_URL,
  BASKETS_PAGE_URL, BASKETS_DELETE_URL, isVenueObjectId, findBasketForVenue, mergeBasketItems
} from "./lib/wolt.js";
import { woltFetch } from "./lib/http.js";
import { rankCandidates, tokens } from "./lib/match.js";
import { parseIngredientLine } from "./lib/recipe.js";
import { setTokens, describeTokens, getAccessToken } from "./lib/auth.js";
import { getLocation, setLocation, estimateLocation } from "./lib/config.js";
import { checkoutPreview } from "./lib/checkout.js";
import { cdpLogin } from "./lib/cdp-login.js";
import { getVenue, getMenu, getItemOptions, getCategories, resolveItem, parseItemUrl, searchVenueItems } from "./lib/venue.js";
import { getOrderHistory, getOrder, geocodeAddress } from "./lib/account.js";

// Detect the (Wolt-market) language a query is written in from its script, so
// in-venue searches return names in the same language the query uses.
const SCRIPT_LANGS = [[/[֐-׿]/, "he"], [/[؀-ۿ]/, "ar"], [/[Ѐ-ӿ]/, "ru"], [/[Ͱ-Ͽ]/, "el"], [/[Ⴀ-ჿ]/, "ka"]];
const langOf = (s) => SCRIPT_LANGS.find(([re]) => re.test(String(s)))?.[1] || "en";

// Map with bounded concurrency — per-ingredient searches are independent HTTP
// round-trips, and running them serially is what made planning slow.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Resolve coordinates for a tool call: explicit args win, then the saved/env
// location, then a one-shot city-level IP estimate. Throws an actionable error
// when nothing is available so the model asks the user instead of guessing.
async function needLocation(lat, lon) {
  if (lat != null && lon != null) return { lat, lon };
  const loc = getLocation() || await estimateLocation();
  if (!loc) throw new Error("No delivery location is set and IP detection failed. Ask the user for their address and call set_location, or call use_saved_address to use their saved Wolt addresses.");
  return { lat: lat ?? loc.lat, lon: lon ?? loc.lon };
}

async function getBasketsPage(lat, lon) {
  const r = await woltFetch(`${BASKETS_PAGE_URL}?lat=${lat}&lon=${lon}`);
  if (!r.ok) throw new Error(`baskets fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

// `npx -y wolt-mcp install` — one-liner setup: registers this server in Claude
// Desktop's config (and prints the JSON for any other MCP client), then exits.
if (process.argv[2] === "install") {
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
const server = new McpServer({ name: "wolt-mcp", version: VERSION }, {
  instructions: "When the user wants to BUY something (not just browse), call wolt_status FIRST — it live-verifies the Wolt login. If it reports loginNeeded, sort the login out with the user (login_via_chrome, or set_wolt_token on Firefox/Safari) before searching and planning, so the work isn't lost to an expired session mid-checkout. Searching and browsing venues never need a login. For the delivery address: use_saved_address pulls the user's saved Wolt addresses and sets one as the search location (get_wolt_profile does NOT have addresses); a spoken address goes through resolve_address + set_location. Baskets are single-venue: source every item from one store. The fast path for a shopping list is wolt_status -> use_saved_address (if no location) -> ONE plan_cart call (it auto-picks the store and reports runner-up coverage) -> review the matches -> add_to_cart -> checkout_preview. Don't compare stores manually with repeated searches unless the user asks, and never write a lowCoverage plan without agreeing with the user first."
});

// --- search_products: one ingredient -> candidate products (no auth) ---
server.tool(
  "search_products",
  "Search Wolt grocery products for a single ingredient near a location. Returns candidates across nearby stores with itemId, name, price (minor units), venueId, venueName, whether it's sold by weight, and unit size. Call once per ingredient, then pick the best match yourself. For a whole recipe or shopping list, prefer plan_cart (pinned to a venue_slug) — it resolves every ingredient in one call. A basket must be all from ONE venueId. MATCHING RULES when picking: (1) Match the ingredient ITSELF — never a plant-based, vegan, imitation, or flavored substitute unless the user explicitly asked. e.g. 'Redefine Meat'/'plant-based mince' is NOT ground beef; margarine is NOT butter; imitation crab is NOT crab. (2) Do NOT just pick the cheapest — Wolt surfaces cheap 'Substitute Deals' that are often imitation products; prefer the real, mainstream item at a sensible package size. (3) Match the right FORM (crushed tomatoes ≠ tomato paste; ground beef ≠ beef sausage). When unsure, prefer the plainest real version of the actual ingredient.",
  {
    query: z.string().describe("Product search term, e.g. 'crushed tomatoes'"),
    lat: z.number().optional().describe("Override latitude; defaults to the saved location"),
    lon: z.number().optional().describe("Override longitude; defaults to the saved location")
  },
  async ({ query, lat, lon }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const items = await searchItems(query, { lat, lon, lang: "en" });
      // Venue metadata goes once into `venues`, not on all 20 items — these
      // responses are read by a model every turn, and the repetition was
      // roughly half the payload.
      const venues = {};
      const top = items.slice(0, 20).map((c) => {
        venues[c.venueId] ||= { name: c.venueName, slug: c.venueSlug, rating: c.venueRating, citySlug: c.citySlug, country: c.country };
        return {
          itemId: c.itemId, name: c.name, price: c.price, currency: c.currency,
          venueId: c.venueId, isWeighted: c.isWeighted, unitSize: c.unitSizeText
        };
      });
      return text({ query, count: top.length, items: top, venues });
    } catch (e) {
      return errText(`search failed: ${e.message}`);
    }
  }
);

// --- search_restaurant_dishes: restaurant food, separate from groceries ---
server.tool(
  "search_restaurant_dishes",
  "Search RESTAURANT dishes (prepared food) near a location — separate from search_products, which is groceries only. Returns dishes with itemId, price, venueId/venueName. A basket is per-venue: don't mix dishes with grocery items. For dishes that likely have choices (burgers, pizzas, combos), call get_dish_options first and pass the user's selections to add_to_cart.",
  {
    query: z.string().describe("Dish or cuisine search term, e.g. 'pad thai'"),
    lat: z.number().optional().describe("Override latitude; defaults to the saved location"),
    lon: z.number().optional().describe("Override longitude; defaults to the saved location")
  },
  async ({ query, lat, lon }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const items = await searchItems(query, { lat, lon, lang: "en", mode: "restaurant" });
      const venues = {};
      const top = items.slice(0, 20).map((c) => {
        venues[c.venueId] ||= { name: c.venueName, slug: c.venueSlug, rating: c.venueRating, citySlug: c.citySlug, country: c.country };
        return { itemId: c.itemId, name: c.name, price: c.price, currency: c.currency, venueId: c.venueId };
      });
      return text({ query, count: top.length, dishes: top, venues });
    } catch (e) {
      return errText(`restaurant search failed: ${e.message}`);
    }
  }
);

// --- use_saved_address: pull the delivery address from the Wolt account ---
server.tool(
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
      return text({ saved, pickedAddressId: pick.id, addresses });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// Plan a whole ingredient list against ONE venue's own catalog. Returns the
// same shape whether called for a pinned store or as one contestant of the
// multi-store race in plan_cart's auto mode.
async function planAtVenue(venue_slug, ingredients) {
  const venue = await getVenue(venue_slug);
  const lineItems = [], missing = [], unmatched = [];
  const resolved = await mapPool(ingredients, 4, async (raw) => {
    const name = parseIngredientLine(raw).name;
    const lang = langOf(name);
    let hits = [];
    try { hits = await searchVenueItems(venue_slug, name, { lang }); } catch (e) {}
    // Multi-word queries often miss; the store search wants short terms.
    if (!hits.length) {
      const longest = tokens(name).sort((a, b) => b.length - a.length)[0];
      if (longest && longest !== name) {
        try { hits = await searchVenueItems(venue_slug, longest, { lang }); } catch (e) {}
      }
    }
    // Only auto-pick scored matches — the raw first hit of a missed query is
    // garbage (a "shrimp" miss once returned Sprite Zero). Unscorable hits
    // still go back as candidates for the model to judge — it matches by
    // meaning, which token overlap can't.
    return { raw, hits, ranked: rankCandidates(name, hits, { topK: 3, minScore: 0.15 }) };
  });
  for (const { raw, hits, ranked } of resolved) {
    const best = ranked[0];
    if (best) {
      lineItems.push({
        ingredient: raw, name: best.name, itemId: best.itemId, price: best.price,
        alternatives: ranked.slice(1).map((c) => ({ name: c.name, itemId: c.itemId, price: c.price }))
      });
    } else if (hits.length) {
      unmatched.push({ ingredient: raw, candidates: hits.slice(0, 3).map((c) => ({ name: c.name, itemId: c.itemId, price: c.price })) });
    } else missing.push(raw);
  }
  const basket = lineItems.length
    ? buildBasketBody(lineItems.map((li) => ({ candidate: { itemId: li.itemId, name: li.name, price: li.price, isWeighted: false }, count: 1 })), venue.venueId, venue.currency || "EUR")
    : null;
  return {
    venue: { venueId: venue.venueId, slug: venue_slug, name: venue.name, currency: venue.currency },
    coverageCount: lineItems.length,
    cost: lineItems.reduce((s, li) => s + (li.price || 0), 0),
    lineItems, missing, unmatched, basket
  };
}

function planResponse(plan, total) {
  const lowCoverage = plan.coverageCount < Math.ceil(total * 0.7);
  return {
    venue: plan.venue,
    coverage: `${plan.coverageCount}/${total}`,
    ...(lowCoverage ? { lowCoverage: true, coverageNote: "Coverage is LOW — tell the user what's missing and agree on a store or substitutions BEFORE writing any basket." } : {}),
    lineItems: plan.lineItems,
    missing: plan.missing,
    ...(plan.unmatched.length ? { unmatched: plan.unmatched, unmatchedNote: "The store returned these candidates but token scoring couldn't confirm them — judge each by meaning and add the good ones to the basket yourself (never a flavored/imitation substitute)." } : {}),
    basket: plan.basket,
    ...(plan.missing.length ? { note: "Missing items may just be a language/phrasing miss — retry them in the store's catalog language, or drop them." } : {})
  };
}

// --- plan_cart: whole list -> single-store plan, one call ---
server.tool(
  "plan_cart",
  "Resolve a whole ingredient list into a single-store cart in ONE call. Without venue_slug it auto-picks: shortlists the best-covering nearby stores and races the list against each store's own catalog, returning the winner plus per-store coverage of the runners-up (evaluatedVenues) — if lowCoverage is flagged, agree with the user before writing anything. With venue_slug it plans against that store only. Write ingredient lines in the store's catalog language (e.g. Hebrew for Israeli stores). Returns line items with alternatives + a ready add_to_cart basket; sanity-check matches before writing.",
  {
    ingredients: z.array(z.string()).describe("Ingredient lines, e.g. ['800 g crushed tomatoes', '1 onion'] — use the store's catalog language (e.g. Hebrew for Israeli stores)"),
    venue_slug: z.string().optional().describe("Pin planning to this store instead of auto-picking"),
    lat: z.number().optional().describe("Override latitude; defaults to the saved location"),
    lon: z.number().optional().describe("Override longitude; defaults to the saved location")
  },
  async ({ ingredients, venue_slug, lat, lon }) => {
    try {
      if (venue_slug) {
        return text(planResponse(await planAtVenue(venue_slug, ingredients), ingredients.length));
      }
      ({ lat, lon } = await needLocation(lat, lon));
      const perIngredient = await mapPool(ingredients, 6, async (raw) => {
        const q = parseIngredientLine(raw).name;
        let candidates = [];
        try { candidates = await searchItems(q, { lat, lon, lang: "en" }); } catch (e) {}
        return { ingredient: raw, spec: { query: q }, candidates: rankCandidates(q, candidates) };
      });
      // In-venue planning needs a token; without one, fall back to the pure
      // global-search pick rather than failing.
      let hasToken = true;
      try { await getAccessToken(); } catch (e) { hasToken = false; }
      if (hasToken) {
        const shortlist = rankVenues(perIngredient).slice(0, 5).filter((r) => r.venue.venueSlug);
        if (shortlist.length) {
          const plans = (await mapPool(shortlist, 5, async (r) => {
            try { return await planAtVenue(r.venue.venueSlug, ingredients); } catch (e) { return null; }
          })).filter(Boolean);
          if (plans.length) {
            // Coverage always beats price: a cheap 2/10 store is not a plan.
            plans.sort((a, b) => b.coverageCount - a.coverageCount || a.cost - b.cost);
            const best = plans[0];
            return text({
              ...planResponse(best, ingredients.length),
              evaluatedVenues: plans.map((p) => ({ name: p.venue.name, slug: p.venue.slug, coverage: `${p.coverageCount}/${ingredients.length}` }))
            });
          }
        }
      }
      const { venue, chosen, missing } = selectBestVenue(perIngredient);
      if (!venue) return text({ venue: null, missing, note: "No store covered these ingredients." });
      const basket = buildBasketBody(chosen.map((c) => ({ candidate: c.candidate, count: 1 })), venue.venueId, chosen[0]?.candidate.currency || "ILS");
      return text({
        venue,
        coverage: `${chosen.length}/${ingredients.length}`,
        lineItems: chosen.map((c) => ({ ingredient: c.ingredient, name: c.candidate.name, itemId: c.candidate.itemId, price: c.candidate.price, isWeighted: c.candidate.isWeighted })),
        missing,
        basket
      });
    } catch (e) {
      return errText(`plan failed: ${e.message}`);
    }
  }
);

// --- add_to_cart: write the basket (needs WOLT_BEARER_TOKEN) ---
server.tool(
  "add_to_cart",
  "Write items to the user's Wolt basket for one venue. All items must share the venue_id. Needs login (if wolt_status says loginNeeded, do that first). Returns a checkoutUrl — give it to the user, and call checkout_preview for the real total including fees. Nothing is ever ordered automatically; the user reviews and pays on wolt.com.",
  {
    venue_id: z.string(),
    venue_slug: z.string().optional().describe("venueSlug from search results — used to build the checkout link"),
    city_slug: z.string().optional().describe("citySlug from search results"),
    country: z.string().optional().describe("3-letter country from search results, e.g. 'isr'"),
    currency: z.string().optional().describe("Currency from search results (e.g. 'ILS', 'EUR'); resolved from the venue if omitted"),
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
      // Resolve currency/country from the venue when not supplied (keeps the
      // tool country-agnostic; ILS only as a last-resort fallback).
      let venueInfo = null;
      if (venue_slug && (!currency || !country)) {
        try { venueInfo = await getVenue(venue_slug); } catch (e) {}
      }
      currency = currency || venueInfo?.currency || "ILS";
      country = country || venueInfo?.country?.toLowerCase() || null;
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
      const checkoutUrl = venue_slug
        ? (country && city_slug ? `https://wolt.com/en/${country}/${city_slug}/venue/${venue_slug}` : `https://wolt.com/search?q=${encodeURIComponent(venue_slug)}`)
        : "https://wolt.com";
      return text({ ok: true, status: r.status, basketId: r.json?.id ?? null, itemsWritten: items.length, existingLinesPreserved: mergedFromExisting, checkoutUrl, note: `Basket written. Give the user this link to review and check out: ${checkoutUrl}` });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- get_baskets: list the user's current Wolt baskets ---
server.tool(
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
        items: (b.items || []).map((it) => ({ id: it.id, name: it.name, count: it.count, price: it.price }))
      }));
      return text({ count: baskets.length, baskets });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- clear_basket: delete a basket by id ---
server.tool(
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
server.tool(
  "get_venue",
  "Venue details by slug (from search results): rating, address, currency, delivery price, and opening hours per day with timezone. Check hours before adding food from a restaurant that might be closed.",
  { venue_slug: z.string() },
  async ({ venue_slug }) => {
    try { return text(await getVenue(venue_slug)); } catch (e) { return errText(e.message); }
  }
);

// --- get_venue_menu: browse/search within one venue ---
server.tool(
  "get_venue_menu",
  "Browse a venue's full menu by slug: categories and items with prices. Optional query (free-text filter) and category (slug). Items flag requiredOptions=true when the dish needs choices — fetch those with get_dish_options before add_to_cart.",
  {
    venue_slug: z.string(),
    query: z.string().optional().describe("Search items by name/description (uses Wolt's in-venue search for large catalogs)"),
    category: z.string().optional().describe("Category slug from get_venue_categories or a previous call"),
    limit: z.number().int().default(30)
  },
  async ({ venue_slug, query, category, limit }) => {
    try { return text(await getMenu(venue_slug, { query, categorySlug: category, limit })); } catch (e) { return errText(e.message); }
  }
);

// --- get_venue_categories: the browse index (big groceries nest deeply) ---
server.tool(
  "get_venue_categories",
  "List a venue's categories (nested: depth, parent, subcategories, item counts). Start here to browse a large grocery store, then call get_venue_menu with a category slug. Restaurants usually have a handful of flat categories.",
  { venue_slug: z.string() },
  async ({ venue_slug }) => {
    try { return text(await getCategories(venue_slug)); } catch (e) { return errText(e.message); }
  }
);

// --- find_item: resolve an item by name or wolt.com URL ---
server.tool(
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
server.tool(
  "get_dish_options",
  "Option groups for one menu item (sizes, toppings, sides): group ids, required/min/max, and each value's id/name/price. Ask the user for required choices, then pass options to add_to_cart as [{id: groupId, values: [{id: valueId, count: 1, price}]}].",
  { venue_slug: z.string(), item_id: z.string().describe("itemId from get_venue_menu — availability varies by hour, so fetch the menu first") },
  async ({ venue_slug, item_id }) => {
    try { return text(await getItemOptions(venue_slug, item_id)); } catch (e) { return errText(e.message); }
  }
);

// --- get_order_history / get_order: enables "reorder my usual" ---
server.tool(
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

server.tool(
  "get_order",
  "Full detail for one past order by purchase_id (from get_order_history), including line items — feed them back into add_to_cart to reorder.",
  { purchase_id: z.string() },
  async ({ purchase_id }) => {
    try { return text(await getOrder(purchase_id)); } catch (e) { return errText(e.message); }
  }
);

// --- resolve_address: free-form address -> coordinates (OpenStreetMap) ---
server.tool(
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
server.tool(
  "get_feed",
  "Wolt's discovery feed near the user: sections like 'Order again', 'Popular right now' with venues (name, slug, rating, delivery estimate). Good for 'what should I eat?' questions.",
  {
    lat: z.number().optional(), lon: z.number().optional(),
    section: z.string().optional().describe("Return only the section whose title contains this text")
  },
  async ({ lat, lon, section }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const r = await woltFetch(`https://consumer-api.wolt.com/v1/pages/front?lat=${lat}&lon=${lon}`);
      if (!r.ok) return errText(`feed failed: HTTP ${r.status}`);
      let sections = (r.json?.sections || []).map((s) => ({
        title: s.title || s.name || null,
        venues: (s.items || []).filter((it) => it.venue).slice(0, 10).map((it) => ({
          name: it.venue.name, slug: it.venue.slug, venueId: it.venue.id,
          rating: it.venue.rating?.score ?? it.venue.rating?.rating ?? null,
          estimate: it.venue.estimate_range || it.venue.delivery_price || null,
          online: it.venue.online ?? null
        }))
      })).filter((s) => s.title && s.venues.length);
      if (section) sections = sections.filter((s) => s.title.toLowerCase().includes(section.toLowerCase()));
      return text({ sections });
    } catch (e) { return errText(e.message); }
  }
);

// --- top_venues: ranked venues with real filters (open-now, fee, score) ---
server.tool(
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
      const r = await woltFetch(`https://consumer-api.wolt.com/v1/pages/front?lat=${lat}&lon=${lon}`);
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
      return text({ totalNearby: total, matching: venues.length, venues: venues.slice(0, limit) });
    } catch (e) { return errText(e.message); }
  }
);

// --- search_venues: find venues (not items) by name/cuisine ---
server.tool(
  "search_venues",
  "Search venues (stores AND restaurants) by name or cuisine near the user. Returns name, slug, venueId, rating, online status. Use get_venue for hours, get_venue_menu to browse.",
  { query: z.string(), lat: z.number().optional(), lon: z.number().optional() },
  async ({ query, lat, lon }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const r = await woltFetch("https://restaurant-api.wolt.com/v1/pages/search", {
        method: "POST", body: { q: query, target: null, lat, lon }
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
            online: v.online ?? null, address: v.address || null,
            productLine: v.product_line || null
          });
        }
      }
      return text({ query, count: venues.length, venues: venues.slice(0, 15) });
    } catch (e) { return errText(e.message); }
  }
);

// --- get_payment_methods (read-only) ---
server.tool(
  "get_payment_methods",
  "The user's saved Wolt payment methods (needs a token). Read-only — payment always happens on wolt.com.",
  async () => {
    try {
      const r = await woltFetch("https://restaurant-api.wolt.com/v3/user/me/payment_methods");
      if (!r.ok) return errText(`payment methods failed: HTTP ${r.status}`);
      return text(r.json?.results ?? r.json);
    } catch (e) { return errText(e.message); }
  }
);

// --- favorites ---
server.tool(
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

server.tool(
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

server.tool(
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

// --- checkout_preview: price the basket (fees, delivery) — never orders ---
server.tool(
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
      return text(summary);
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- update_cart_item: change a line's count or remove it ---
server.tool(
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
      const body = { items, venue_id, currency: basket.currency || "ILS" };
      const r = await woltFetch(BASKET_URL, { method: "POST", body });
      if (!r.ok) return errText(`cart update failed: HTTP ${r.status} ${r.text.slice(0, 300)}`);
      return text({ ok: true, itemId: item_id, newCount: count, linesNow: items.length, note: count === 0 ? "Line removed. Verify with get_baskets — if the line reappears, Wolt may not support removing single lines from multi-line baskets server-side." : "Count updated." });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- login_via_chrome: zero-paste login by watching a Chrome you launch ---
server.tool(
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
server.tool(
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

// --- get_wolt_profile: authenticated user info (may include saved addresses) ---
server.tool(
  "get_wolt_profile",
  "Fetch the logged-in user's Wolt profile — name/email/phone only (GET /v1/user/me; needs a token). It does NOT contain delivery addresses: to pull the user's saved addresses and set one as the search location, call use_saved_address instead.",
  async () => {
    try {
      const r = await woltFetch("https://restaurant-api.wolt.com/v1/user/me");
      if (!r.ok) return errText(`profile fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      return text(r.json ?? r.text);
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- set_location: persist the delivery location ---
server.tool(
  "set_location",
  "Save the user's delivery location (persisted; used as the default for all searches). When the user gives an address or city, geocode it with resolve_address first and pass the coordinates here with the human-readable text as label. For their saved Wolt addresses, use use_saved_address instead.",
  {
    lat: z.number().describe("Latitude"),
    lon: z.number().describe("Longitude"),
    label: z.string().optional().describe("Human-readable place, e.g. 'Aleksanterinkatu 1, Helsinki'")
  },
  async ({ lat, lon, label }) => text({ saved: setLocation({ lat, lon, label }) })
);

// --- wolt_status: live login check + location ---
server.tool(
  "wolt_status",
  "Call this FIRST whenever the user wants to buy or manage their account: it live-verifies the Wolt login (refreshing the access token if needed) and reports the configured location. If loginNeeded is true, offer login_via_chrome (or set_wolt_token) before planning a cart. Search works without a token.",
  async () => {
    // Actually exercise the token chain instead of reporting what's on disk —
    // a stored refresh token can be stale, and finding that out here beats
    // finding out after the cart is planned.
    let loginNeeded = false, loginDetail = null;
    try { await getAccessToken(); } catch (e) { loginNeeded = true; loginDetail = e.message; }
    return text({
      loginNeeded,
      ...(loginDetail ? { loginDetail } : {}),
      ...describeTokens(),
      location: getLocation() || { label: "not set (estimated from IP on first search)", hint: "use_saved_address sets it from the user's saved Wolt addresses; set_location takes a spoken address" }
    });
  }
);

await server.connect(new StdioServerTransport());
console.error("wolt-mcp server running on stdio");
