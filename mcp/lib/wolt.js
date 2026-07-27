// Wolt search + store-selection + basket building.
// Search is unauthenticated (no bearer token needed); only the cart write is.

const SEARCH_URL = "https://restaurant-api.wolt.com/v1/pages/search";
const BASKET_URL = "https://consumer-api.wolt.com/order-xp/v1/baskets";
const BASKETS_PAGE_URL = "https://consumer-api.wolt.com/order-xp/web/v1/pages/baskets";
const BASKETS_DELETE_URL = "https://consumer-api.wolt.com/order-xp/v1/baskets/bulk/delete";

// POSTing a venue SLUG as venue_id returns a success-shaped response and bumps
// the basket count, but the basket never persists — a silent "phantom basket"
// (observed live). Only 24-hex Mongo ObjectIDs are real venue ids.
export const isVenueObjectId = (id) => /^[a-f0-9]{24}$/.test(String(id || ""));

// Search items near a location. Returns normalized candidates.
// mode: "grocery" (default, drops restaurant dishes) or "restaurant" (dishes only).
// fetchImpl lets tests/extension inject a fetch (default global fetch).
export async function searchItems(query, { lat, lon, lang = "en", mode = "grocery", fetchImpl = fetch } = {}) {
  const res = await fetchImpl(SEARCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "app-language": lang },
    body: JSON.stringify({ q: query, target: "items", lat, lon })
  });
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
  const json = await res.json();
  return normalizeSearchResponse(json, { mode });
}

export function normalizeSearchResponse(json, { mode = "grocery" } = {}) {
  const out = [];
  for (const section of json.sections || []) {
    for (const entry of section.items || []) {
      const mi = entry.menu_item;
      if (!mi || !mi.id || !mi.venue_id) continue;
      if (mi.is_available === false) continue;
      const details = entry.link?.menu_item_details || {};
      // product_line separates groceries from restaurant dishes; entries with
      // no product_line are treated as grocery (the historical behavior).
      const isGrocery = !details.product_line || details.product_line === "grocery";
      if (mode === "grocery" ? !isGrocery : isGrocery) continue;
      out.push({
        itemId: mi.id,
        name: mi.name,
        price: mi.price, // minor units (agorot)
        currency: mi.currency || "ILS",
        venueId: mi.venue_id,
        venueSlug: entry.link?.menu_item_details?.venue_slug || null,
        venueName: mi.venue_name || null,
        venueRating: mi.venue_rating?.rating ?? null,
        citySlug: entry.link?.menu_item_details?.city_slug || null,
        country: (mi.country || entry.link?.menu_item_details?.country || "").toLowerCase() || null,
        isWeighted: !!entry.link?.menu_item_details?.is_sold_by_weight,
        unitSizeText: mi.unit_size_v2 || null,
        image: mi.image?.url || null
      });
    }
  }
  return out;
}

// Rank every venue by how many ingredients it covers (tie-break: cheaper basket,
// then higher rating). Input candidates should be ranked best-first.
// Returns [{ venue, coverage, cost, byIngredient }] sorted best-first.
export function rankVenues(perIngredient) {
  const venues = new Map();
  for (const { ingredient, candidates } of perIngredient) {
    for (const c of candidates) {
      let v = venues.get(c.venueId);
      if (!v) {
        v = { venueId: c.venueId, venueSlug: c.venueSlug, venueName: c.venueName, rating: c.venueRating, citySlug: c.citySlug, country: c.country, byIngredient: new Map() };
        venues.set(c.venueId, v);
      }
      if (!v.byIngredient.has(ingredient)) v.byIngredient.set(ingredient, c); // keep best-ranked per ingredient
    }
  }
  return [...venues.values()]
    .map((v) => ({
      venue: { venueId: v.venueId, venueSlug: v.venueSlug, venueName: v.venueName, rating: v.rating, citySlug: v.citySlug, country: v.country },
      coverage: v.byIngredient.size,
      cost: [...v.byIngredient.values()].reduce((s, c) => s + (c.price || 0), 0),
      byIngredient: v.byIngredient
    }))
    .sort((a, b) => b.coverage - a.coverage || a.cost - b.cost || (b.venue.rating || 0) - (a.venue.rating || 0));
}

// Pick the single best-covering venue.
// Returns { venue, chosen: [{ingredient, candidate}], missing: [ingredient], alternatives }.
export function selectBestVenue(perIngredient) {
  const ranked = rankVenues(perIngredient);
  if (!ranked.length) return { venue: null, chosen: [], missing: perIngredient.map((p) => p.ingredient), alternatives: [] };
  const best = ranked[0];
  const chosen = [];
  const covered = new Set();
  for (const { ingredient } of perIngredient) {
    const c = best.byIngredient.get(ingredient);
    if (c) { chosen.push({ ingredient, candidate: c }); covered.add(ingredient); }
  }
  const missing = perIngredient.map((p) => p.ingredient).filter((i) => !covered.has(i));
  const alternatives = ranked.slice(1, 4).map((r) => ({ venue: r.venue, coverage: r.coverage }));
  return { venue: best.venue, chosen, missing, alternatives };
}

// Build the POST /baskets body (matches the schema proven in the spike).
// selections: [{ candidate, count, grams?, options? }] where options follows
// the basket shape: [{id: groupId, values: [{id, count, price}]}].
export function buildBasketBody(selections, venueId, currency = "ILS") {
  const items = selections.map(({ candidate, count = 1, grams, options }) => {
    const item = {
      id: candidate.itemId,
      count,
      name: candidate.name,
      price: candidate.price,
      options: (options || []).map((o) => ({
        id: o.id,
        values: (o.values || []).map((v) => ({ id: v.id, count: v.count > 0 ? v.count : 1, price: v.price || 0 }))
      })),
      substitution_settings: { is_allowed: true }
    };
    if (candidate.isWeighted) {
      item.weighted_item_info = {
        count,
        purchased_weight_in_grams: grams || parseGrams(candidate.unitSizeText) || 1000,
        weighted_item_input_type: "grams"
      };
    }
    return item;
  });
  return { items, venue_id: venueId, currency };
}

// Fetch the user's current baskets (authed). Returns the raw page; baskets
// live under page.baskets, each { id, venue: {id, name, slug?}, items: [...] }.
export async function fetchBasketsPage({ headers, lat, lon, fetchImpl = fetch }) {
  const url = `${BASKETS_PAGE_URL}?lat=${lat}&lon=${lon}`;
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`baskets fetch failed: HTTP ${res.status}`);
  return res.json();
}

export function findBasketForVenue(page, venueId) {
  for (const basket of page?.baskets || []) {
    if (basket?.venue?.id === venueId) return basket;
  }
  return null;
}

// Re-encode an existing basket line into the POST /baskets item shape,
// preserving options and substitution settings (matches the web
// client's upsert shape).
export function upsertItemFromLine(line, count = null) {
  return {
    id: line.id,
    count: count ?? (line.count > 0 ? line.count : 1),
    name: line.name || "",
    price: line.price || 0,
    options: (line.options || []).map((o) => ({
      id: o.id,
      values: (o.values || []).map((v) => ({ id: v.id, count: v.count > 0 ? v.count : 1, price: v.price || 0 }))
    })),
    substitution_settings: { is_allowed: !!line.substitution_settings?.is_allowed },
    ...(line.weighted_item_info ? { weighted_item_info: line.weighted_item_info } : {})
  };
}

// POST /baskets REPLACES the venue's basket wholesale, so adds must be
// read-merge-write: existing lines are carried over, and a new line whose item
// id already exists bumps that line's count instead of duplicating it.
export function mergeBasketItems(existingLines, newItems) {
  const merged = (existingLines || []).map((line) => upsertItemFromLine(line));
  for (const item of newItems) {
    const existing = merged.find((m) => m.id === item.id);
    if (existing) existing.count += item.count > 0 ? item.count : 1;
    else merged.push(item);
  }
  return merged;
}

function parseGrams(text) {
  if (!text) return null;
  const m = String(text).match(/([\d.]+)\s*(kg|g)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return /kg/i.test(m[2]) ? Math.round(n * 1000) : Math.round(n);
}

export { BASKET_URL, SEARCH_URL, BASKETS_PAGE_URL, BASKETS_DELETE_URL };
