// Checkout preview: price the user's basket (fees, delivery, offers) without
// placing an order. Mirrors the web client's checkout payload.
//
// The preview endpoint requires each menu item to carry a category_id. We
// resolve it from the venue's assortment (and per-item venue pages as a
// fallback); as a last resort we fall back to the item id itself, which
// the endpoint accepts.
import { woltFetch } from "./http.js";
import { BASKETS_PAGE_URL, findBasketForVenue, resolveCurrency } from "./wolt.js";
import { getVenue } from "./venue.js";

const CHECKOUT_URL = "https://consumer-api.wolt.com/order-xp/web/v2/pages/checkout";
const ASSORTMENT_BASE = "https://consumer-api.wolt.com/consumer-api/consumer-assortment/v1/venues/slug/";
const VENUE_ITEM_BASE = "https://consumer-api.wolt.com/order-xp/web/v1/pages/venue/";

const isObjectId = (id) => /^[a-f0-9]{24}$/.test(String(id || ""));

// Walk any payload shape and index item id -> category id. Handles both
// "category has an items list" and "item carries category ids" shapes.
function indexCategories(node, index, currentCategoryId = null) {
  if (Array.isArray(node)) { for (const v of node) indexCategories(v, index, currentCategoryId); return; }
  if (!node || typeof node !== "object") return;
  const looksLikeCategory = node.id && (Array.isArray(node.items) || node.item_ids) && (node.slug || node.name) && !node.price;
  const catId = looksLikeCategory ? node.id : currentCategoryId;
  const itemIds = [
    ...(Array.isArray(node.items) ? node.items.filter((x) => typeof x === "string") : []),
    ...(Array.isArray(node.item_ids) ? node.item_ids : [])
  ];
  if (catId) for (const id of itemIds) if (!index.has(id)) index.set(id, catId);
  if (node.id && !index.has(node.id)) {
    const own = node.category_id || (Array.isArray(node.category_ids) && node.category_ids[0]) || node.category?.id;
    if (own) index.set(node.id, own);
    else if (!looksLikeCategory && currentCategoryId && (node.price != null || node.purchasable != null)) index.set(node.id, currentCategoryId);
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "object" && v !== null) indexCategories(v, index, catId ?? currentCategoryId);
  }
}

async function tryFetchJson(url, opts) {
  try {
    const r = await woltFetch(url, opts);
    return r.ok ? r.json : null;
  } catch (e) { return null; }
}

// Preview checkout for the user's existing basket at one venue.
// Returns { payableAmount, rows, deliveryConfigs, offers, warnings, raw }.
export async function checkoutPreview({ venueId, venueSlug = null, lat, lon, country = null, tip = 0, promoCode = null }) {
  const warnings = [];
  const pageRes = await woltFetch(`${BASKETS_PAGE_URL}?lat=${lat}&lon=${lon}`);
  if (!pageRes.ok) throw new Error(`baskets fetch failed: HTTP ${pageRes.status}`);
  const basket = venueId ? findBasketForVenue(pageRes.json, venueId) : (pageRes.json?.baskets || [])[0];
  if (!basket) throw new Error(venueId ? `no basket found for venue ${venueId}` : "no baskets found — add items first");

  const venue = basket.venue || {};
  const resolvedVenueId = venue.id || venueId;
  const slug = venueSlug || venue.slug || venue.venue_slug || venue.public_slug || venue.url_slug || null;

  // Currency and country come off the basket/venue, and from the venue record
  // when the baskets page carries neither — the preview payload prices the
  // whole order, so a guessed market here would quote the wrong money.
  let currency = basket.currency || venue.currency || null;
  let venueCountry = venue.country || country || null;
  if ((!currency || !venueCountry) && slug) {
    try {
      const detail = await getVenue(slug);
      currency = currency || detail.currency;
      venueCountry = venueCountry || detail.country;
    } catch (e) { /* best effort — the map below may still resolve it */ }
  }
  currency = resolveCurrency({ currency, country: venueCountry });
  if (!currency || !venueCountry) {
    throw new Error(`cannot price this basket: ${!currency ? "currency" : "country"} unknown for venue ${resolvedVenueId}${slug ? ` (${slug})` : ""}`);
  }

  // --- category_id enrichment ---
  const categoryIndex = new Map();
  if (slug) {
    const assortment = await tryFetchJson(`${ASSORTMENT_BASE}${slug}/assortment`);
    if (assortment) indexCategories(assortment, categoryIndex);
    else warnings.push(`could not load assortment for slug ${slug}`);
  } else {
    warnings.push("no venue slug available — category mapping limited to per-item lookups");
  }

  const menuItems = [];
  for (const line of basket.items || []) {
    const count = line.count > 0 ? line.count : 1;
    const price = line.price || 0;
    if (!price) throw new Error(`cannot resolve base_price for basket item ${line.id}`);
    let categoryId = categoryIndex.get(line.id) || null;
    if (!categoryId) {
      const detail = await tryFetchJson(`${VENUE_ITEM_BASE}${resolvedVenueId}/item/${line.id}`);
      if (detail) { indexCategories(detail, categoryIndex); categoryId = categoryIndex.get(line.id) || null; }
    }
    if (!categoryId) {
      if (isObjectId(line.id)) { categoryId = line.id; warnings.push(`category_id unresolved for ${line.name || line.id}; using item id`); }
      else throw new Error(`cannot resolve category_id for basket item ${line.id}`);
    }
    menuItems.push({
      id: line.id,
      venue_id: resolvedVenueId,
      count,
      base_price: price,
      end_amount: count * price,
      is_weighted_item: !!line.weighted_item_info,
      category_id: categoryId,
      category_ids: [categoryId],
      alcohol_permille: line.alcohol_permille || 0,
      exclude_from_credits: !!line.exclude_from_credits,
      exclude_from_discounts: !!line.exclude_from_discounts,
      exclude_from_discounts_min_basket: !!line.exclude_from_discounts_min_basket,
      restrictions: line.restrictions || [],
      age_limit: line.age_limit ?? null,
      options: (line.options || []).map((o) => ({
        id: o.id,
        values: (o.values || []).map((v) => ({ id: v.id, count: v.count > 0 ? v.count : 1, price: v.price || 0 }))
      }))
    });
  }

  const payload = {
    purchase_plan: {
      venue: { id: resolvedVenueId, currency, country: venueCountry.toUpperCase() },
      delivery_method: "homedelivery",
      menu_items: menuItems,
      use_promo_discount_ids: promoCode ? [promoCode] : [],
      courier_tip: tip,
      use_cash: false,
      use_credits_and_tokens: false,
      use_loyalty_points_amount: 0,
      use_promo_surcharge_ids: [],
      payment_methods: [],
      is_priority_delivery: false,
      delivery: { delivery_coordinates: { latitude: lat, longitude: lon } }
    }
  };

  const r = await woltFetch(CHECKOUT_URL, { method: "POST", body: payload });
  if (!r.ok) throw new Error(`checkout preview failed: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  const j = r.json || {};
  return {
    payableAmount: j.payable_amount ?? null,
    currency,
    rows: (j.checkout_rows || []).map((row) => {
      // observed live: row.amount is { amount, formatted_amount, reason }
      const a = row.amount_row?.amount ?? row.price_total_amount_row?.amount ?? row.amount;
      return {
        label: row.label || row.title || null,
        amount: typeof a === "number" ? a : a?.amount ?? null,
        formatted: a?.formatted_amount ?? null
      };
    }).filter((r) => r.label || r.amount != null),
    deliveryConfigs: j.delivery_configs ?? null,
    offers: j.offers ?? null,
    tipConfig: j.tip_config ?? null,
    warnings,
    raw: j
  };
}
