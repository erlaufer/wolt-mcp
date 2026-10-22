// Placing an order: the one thing in this server that moves money.
//
// Two phases, mirroring what wolt.com's own checkout page does, captured from
// a real card order:
//
//   prepareOrder()  basket + saved address + saved card -> POST pages/checkout
//                   (the same quote checkout_preview uses, now with a payment
//                   method and a delivery address) -> a quote: the exact total
//                   Wolt will charge, Wolt's checkout id, and the item
//                   checksums the purchase call must echo. Saved to disk under
//                   the account for two minutes. Nothing is bought.
//   placeOrder()    quote id + the total the user saw -> POST post-checkout-config
//                   (consents Wolt would show on the page; any pending one
//                   stops us) -> POST v2/purchases with the quote's checkout id,
//                   totals and checksums. The quote's uuid is the purchase's
//                   client_nonce, so a retry of the same quote cannot buy twice.
//
// Only a saved card is supported: Apple Pay, cash and the rest need Wolt's own
// page. Basket lines with options are refused, because the purchase payload's
// option shape has not been captured yet and a wrong guess buys the wrong food.
// Credits and tokens are applied the way the website does (use_credits_and_tokens).
//
// Whether a caller may order at all is decided outside this module: the
// `order` OAuth scope ticked on the approve page, or WOLT_ALLOW_ORDERS=1 for
// stdio and fixed API tokens. See server.mjs.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { woltFetch } from "./http.js";
import { CHECKOUT_URL, loadBasketPlan, checkoutRows } from "./checkout.js";
import { currentStateDir } from "./context.js";

const DELIVERY_INFO_URL = "https://restaurant-api.wolt.com/v2/delivery/info";
const PAYMENT_METHODS_URL = "https://restaurant-api.wolt.com/v3/user/me/payment_methods";
const ASSORTMENT_BASE = "https://consumer-api.wolt.com/consumer-api/consumer-assortment/v1/venues/slug/";
const POST_CHECKOUT_CONFIG_URL = "https://restaurant-api.wolt.com/v1/post-checkout-config";
const PURCHASES_URL = "https://restaurant-api.wolt.com/v2/purchases";

export const QUOTE_TTL_MS = 2 * 60 * 1000;
const quoteFile = () => join(currentStateDir(), "order-quote.json");

const minorToText = (amount, currency) => `${(amount / 100).toFixed(2)} ${currency}`;

export function readQuote() {
  try { return JSON.parse(readFileSync(quoteFile(), "utf8")); } catch (e) { return null; }
}
function writeQuote(q) {
  mkdirSync(currentStateDir(), { recursive: true });
  writeFileSync(quoteFile(), JSON.stringify(q, null, 2), { mode: 0o600 });
}
export function dropQuote() {
  try { unlinkSync(quoteFile()); } catch (e) {}
}

// The saved addresses, in the shape use_saved_address shows the model.
export async function savedAddresses() {
  const r = await woltFetch(DELIVERY_INFO_URL);
  if (!r.ok) throw new Error(`address fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  const rows = r.json?.results || r.json?.addresses || [];
  return rows.map((row) => {
    const coords = row.location?.user_coordinates?.coordinates || row.location?.google_place_coordinates?.coordinates || null;
    return {
      id: String(row.id || row.address_id || ""),
      alias: row.alias || null,
      labelType: row.label_type || null,
      address: [row.location?.address, row.location?.city].filter(Boolean).join(", ") || null,
      lat: coords ? coords[1] : null,
      lon: coords ? coords[0] : null
    };
  }).filter((a) => a.id && a.lat != null && a.lon != null);
}

// The saved cards Wolt will charge, in the shape the checkout quote wants.
export async function savedCards() {
  const r = await woltFetch(PAYMENT_METHODS_URL);
  if (!r.ok) throw new Error(`payment methods failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  const cards = r.json?.results?.cards || r.json?.cards || [];
  return cards.filter((c) => c.type === "card" && c.valid_for_payments !== false).map((c) => ({
    id: typeof c.id === "object" ? c.id.$uuid : String(c.id),
    type: "card",
    title: c.nickname || c.method_code || "card",
    number: c.method_title || null, // masked by Wolt, e.g. 431571******8543
    scheme: c.method_code || null,
    isDefault: !!c.is_default
  }));
}

function pickOne(list, id, what, prefer) {
  if (id) {
    const hit = list.find((x) => x.id === id);
    if (!hit) throw new Error(`${what} ${id} is not on this Wolt account`);
    return hit;
  }
  if (!list.length) throw new Error(`no saved ${what} on this Wolt account; add one on wolt.com first`);
  if (list.length === 1) return list[0];
  const preferred = list.find(prefer);
  if (preferred) return preferred;
  throw new Error(`several saved ${what}s and no default — ask the user which one and pass its id`);
}

// Fresh catalog records for the basket's items: the purchase call echoes each
// item's checksum and current price, so a line whose price moved since it was
// added is refused rather than charged at a number the user never saw.
async function catalogItems(slug, ids) {
  const r = await woltFetch(`${ASSORTMENT_BASE}${slug}/assortment/items`, { method: "POST", body: { item_ids: ids }, auth: false });
  if (!r.ok || !Array.isArray(r.json?.items)) throw new Error(`could not load the venue's catalog for the order: HTTP ${r.status}`);
  return new Map(r.json.items.map((it) => [it.id, it]));
}

// Quote the order. Returns the summary the model shows the user; the quote
// itself is on disk for placeOrder().
export async function prepareOrder({ venueId = null, venueSlug = null, lat, lon, tip = 0, comment = "", paymentMethodId = null, addressId = null, language = "en" }) {
  const plan = await loadBasketPlan({ venueId, venueSlug, lat, lon });
  if (!plan.slug) throw new Error("cannot order: the venue's slug is unknown (pass venue_slug)");
  const withOptions = plan.lines.filter((l) => (l.options || []).length);
  if (withOptions.length) {
    throw new Error(`cannot order lines with options yet (${withOptions.map((l) => l.name || l.id).join(", ")}); order this basket on wolt.com`);
  }
  const address = pickOne(await savedAddresses(), addressId, "address", (a) => a.labelType === "home");
  const card = pickOne(await savedCards(), paymentMethodId, "card", (c) => c.isDefault);
  const catalog = await catalogItems(plan.slug, plan.lines.map((l) => l.id));

  const items = plan.lines.map((line, i) => {
    const it = catalog.get(line.id);
    if (!it) throw new Error(`${line.name || line.id} is no longer in the venue's catalog; remove it from the basket`);
    if (it.disabled_info) throw new Error(`${it.name || line.id} is currently unavailable; remove it from the basket`);
    const count = line.count > 0 ? line.count : 1;
    if (it.price !== line.price) throw new Error(`the price of ${it.name || line.id} changed since it was added (${line.price} -> ${it.price}); re-add it and quote again`);
    return {
      id: line.id,
      configIndex: i,
      count,
      name: [{ value: it.name || line.name || "", lang: language }],
      category: plan.menuItems[i].category_id,
      exclude_from_credits: !!it.exclude_from_credits,
      exclude_from_discounts: !!it.exclude_from_discounts,
      exclude_from_discounts_min_basket: !!it.exclude_from_discounts_min_basket,
      from_recommendation: false,
      alcohol_percentage: (it.alcohol_permille || 0) / 10,
      product_hierarchy_tags: it.product_hierarchy_tags || [],
      vat_percentage: it.vat_percentage || 0,
      baseprice: it.price,
      end_amount: it.price * count,
      restrictions: it.restrictions || [],
      options: [],
      checksum: it.checksum
    };
  });
  if (items.some((it) => !it.checksum)) throw new Error("the catalog returned no checksum for an item; cannot build the purchase");

  const payload = {
    purchase_plan: {
      courier_tip: tip,
      delivery: { delivery_coordinates: { longitude: address.lon, latitude: address.lat }, delivery_info_id: address.id },
      delivery_method: "homedelivery",
      delivery_config: { method: "homedelivery", schedule: "standard", time_slot: null },
      payment_methods: [{ id: card.id, type: "card", title: card.title, number: card.number }],
      menu_items: plan.menuItems,
      selected_offer_ids: [],
      use_cash: false,
      use_credits_and_tokens: true,
      use_loyalty_points_amount: 0,
      use_promo_surcharge_ids: [],
      venue: { id: plan.venueId, country: plan.country, currency: plan.currency, self_delivery: false, preorder_config: null }
    }
  };
  const r = await woltFetch(CHECKOUT_URL, { method: "POST", body: payload });
  if (!r.ok) throw new Error(`checkout quote failed: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  const j = r.json || {};
  if (j.purchasing_disabled) throw new Error(`Wolt will not take this order right now: ${JSON.stringify(j.purchasing_disabled).slice(0, 200)}`);
  if (j.is_age_verification_required) throw new Error("this order needs age verification, which only wolt.com can do");
  if (!j.id || typeof j.payable_amount !== "number" || !j.purchase_validation) throw new Error("the checkout quote came back without an id, a total or the validation block; order on wolt.com");
  if (j.payment_breakdown?.unallocated?.amount) throw new Error("the saved card does not cover the whole total (credits or split payment in play); order on wolt.com");
  const standard = (j.delivery_configs || []).find((d) => d.method === "homedelivery" && d.schedule === "standard") || (j.delivery_configs || [])[0];
  const estimate = standard?.estimate?.label || null;

  const now = Date.now();
  const quote = {
    id: randomUUID(),
    createdAt: now,
    expiresAt: now + QUOTE_TTL_MS,
    checkoutId: j.id,
    venue: { id: plan.venueId, slug: plan.slug, name: plan.venue.name || null, currency: plan.currency, country: plan.country },
    items,
    endAmount: j.payable_amount,
    validation: j.purchase_validation,
    deliveryPrice: j.purchase_validation.delivery_price ?? 0,
    tip,
    comment: String(comment || "").slice(0, 500),
    language,
    estimate,
    address,
    card: { id: card.id, title: card.title, number: card.number },
    rows: checkoutRows(j)
  };
  writeQuote(quote);
  return summarize(quote);
}

export function summarize(quote) {
  return {
    quoteId: quote.id,
    expiresInSeconds: Math.max(0, Math.round((quote.expiresAt - Date.now()) / 1000)),
    venue: quote.venue.name || quote.venue.slug,
    items: quote.items.map((it) => ({ name: it.name[0].value, count: it.count, price: it.baseprice })),
    rows: quote.rows,
    payableAmount: quote.endAmount,
    currency: quote.venue.currency,
    total: minorToText(quote.endAmount, quote.venue.currency),
    deliveryTo: [quote.address.alias, quote.address.address].filter(Boolean).join(" — "),
    paidWith: [quote.card.title, quote.card.number].filter(Boolean).join(" "),
    eta: quote.estimate,
    tip: quote.tip,
    next: `Show the user the total, the address and the card. If they confirm, call place_order with quote_id "${quote.id}" and total ${quote.endAmount}.`
  };
}

// Pay. `total` is the minor-units total the user confirmed; `cap` an optional
// per-order ceiling in minor units from the grant.
export async function placeOrder({ quoteId, total, cap = null, now = Date.now() }) {
  const quote = readQuote();
  if (!quote || quote.id !== quoteId) throw new Error("that quote is unknown or was replaced; call prepare_order again");
  if (quote.orderId) throw new Error(`this quote was already paid (order ${quote.orderId}); prepare a new one for another order`);
  if (now > quote.expiresAt) { dropQuote(); throw new Error("the quote expired (two minutes); call prepare_order again and re-confirm the total with the user"); }
  if (total !== quote.endAmount) throw new Error(`the total you passed (${total}) is not the quoted ${quote.endAmount} ${quote.venue.currency}; show the user the quote and pass its payableAmount`);
  if (cap != null && quote.endAmount > cap) throw new Error(`this order (${minorToText(quote.endAmount, quote.venue.currency)}) is over the per-order limit set when this connection was approved (${minorToText(cap, quote.venue.currency)})`);

  const cfg = await woltFetch(POST_CHECKOUT_CONFIG_URL, { method: "POST", body: { venue_id: quote.venue.id, country: quote.venue.country, basket: quote.items } });
  if (!cfg.ok) throw new Error(`post-checkout-config failed: HTTP ${cfg.status} ${cfg.text.slice(0, 200)}`);
  const consents = cfg.json?.required_consents || [];
  if (consents.length) throw new Error(`Wolt wants the user to accept something before this order (${consents.map((c) => c.id || c.type || JSON.stringify(c)).join(", ")}); order on wolt.com once`);

  const v = quote.validation;
  const body = {
    client_nonce: quote.id,
    ravelin_device_id: `rjs-${quote.id}`,
    signature_datetime: { $date: now },
    language: quote.language,
    currency: quote.venue.currency,
    client_pre_estimate: quote.estimate ? quote.estimate.replace(/\s*min$/i, "") : "",
    consumer_comment: quote.comment,
    corporate_order_comment: "",
    delivery_method: "homedelivery",
    items: quote.items.map(({ category, exclude_from_discounts, ...it }) => it),
    type: "purchase",
    signature: "N/A",
    pricing_model_version: 2023,
    payment_method_type: "card",
    payment_method_id: quote.card.id,
    end_amount: quote.endAmount,
    tip_amount: quote.tip > 0 ? quote.tip : null,
    no_credits_or_tokens: false,
    device_channel: "browser",
    to_type: "venue",
    venue_id: quote.venue.id,
    browser_info: { color_depth: 24, java_enabled: false, language: quote.language, screen_height: 900, screen_width: 1440, time_zone_offset: 0, user_agent: "wolt-mcp" },
    payment_links: { return_url: `https://wolt.com/${quote.language}` }, // only redirect payments use it; a saved card never redirects
    delivery_info: { id: { $oid: quote.address.id }, use_last_100m_address_picker: true },
    delivery_price: quote.deliveryPrice,
    additional_checkout_options: { no_contact_delivery: false },
    discounts: v.discounts || [],
    offers: v.offers || [],
    surcharges: v.surcharges || [],
    use_token: !!v.use_token,
    price_shadowing: v,
    menu_items_source: "consumer-assortment",
    checkout_id: quote.checkoutId,
    use_self_service_cancellation: true
  };

  // Mark the attempt before sending: a crash between the request and the
  // response must not leave a quote that looks unspent.
  quote.submittedAt = now;
  writeQuote(quote);
  const r = await woltFetch(PURCHASES_URL, { method: "POST", body });
  if (!r.ok) {
    quote.lastError = `HTTP ${r.status} ${r.text.slice(0, 300)}`;
    writeQuote(quote);
    throw new Error(`Wolt refused the purchase: ${quote.lastError}. The same quote can be retried once if this looks transient; otherwise order on wolt.com`);
  }
  const res = r.json?.results || r.json || {};
  const orderId = res.id?.$oid || res.id || res.purchase_id || null;
  quote.orderId = orderId || "unknown";
  quote.status = res.status || null;
  writeQuote(quote);
  return {
    ok: true,
    orderId,
    status: res.status || null,
    total: minorToText(res.amount ?? quote.endAmount, quote.venue.currency),
    eta: res.client_pre_estimate ? `${res.client_pre_estimate} min` : quote.estimate,
    venue: quote.venue.name || quote.venue.slug,
    deliveryTo: [quote.address.alias, quote.address.address].filter(Boolean).join(" — "),
    paidWith: [quote.card.title, quote.card.number].filter(Boolean).join(" "),
    note: "Paid with the saved card. Track or cancel it in the Wolt app; get_order shows its status."
  };
}

// Ordering permission for the transports that have no approve page: stdio and
// fixed API tokens. { allowed, cap } with cap in minor units, or null.
export function orderingFromEnv(env = process.env) {
  const allowed = env.WOLT_ALLOW_ORDERS === "1";
  const major = Number(env.WOLT_ORDER_CAP);
  const cap = env.WOLT_ORDER_CAP && Number.isFinite(major) && major > 0 ? Math.round(major * 100) : null;
  return { allowed, cap };
}
