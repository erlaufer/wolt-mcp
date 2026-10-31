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
// page. Dishes with options are ordered the way the website does it: the
// basket line's option and value ids are joined to the venue's catalog for the
// type, the names and the prices the purchase payload spells out (captured
// from a second real order). Credits and tokens are applied the way the
// website does (use_credits_and_tokens).
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
import { getVenue } from "./venue.js";
import { getAddOnOptions, requireAddOn } from "./add-on.js";
import { orderWeight, itemAmount } from "./weight.js";
import { rememberBrowserContext, recentBrowserContext } from "./browser-context.js";
import { recordPaymentAttempt } from "./payment-diagnostics.js";

const DELIVERY_INFO_URL = "https://restaurant-api.wolt.com/v2/delivery/info";
const PAYMENT_METHODS_URL = "https://restaurant-api.wolt.com/v3/user/me/payment_methods";
const ASSORTMENT_BASE = "https://consumer-api.wolt.com/consumer-api/consumer-assortment/v1/venues/slug/";
const POST_CHECKOUT_CONFIG_URL = "https://restaurant-api.wolt.com/v1/post-checkout-config";
const PURCHASES_URL = "https://restaurant-api.wolt.com/v2/purchases";

export const QUOTE_TTL_MS = 2 * 60 * 1000;
const quoteFile = () => join(currentStateDir(), "order-quote.json");
const placing = new Set();

const minorToText = (amount, currency) => `${(amount / 100).toFixed(2)} ${currency}`;

// Authorization refusal is a business outcome, not a broken MCP invocation.
// Returning it as isError makes some hosts expose a RuntimeException wrapper.
export class PaymentRefusal extends Error {
  constructor({ quoteId, checkoutUrl = null, alreadyRefused = false, providerCode = 800 }) {
    const note = alreadyRefused
      ? "This quoted card payment was already refused. Do not retry this quote. Review the attempt in Wolt before choosing another way to pay."
      : "Wolt could not authorize the saved card payment. It did not provide a detailed reason. Do not retry from here; review the attempt in Wolt or choose another card.";
    super(note);
    this.result = { ok: false, quoteId, status: "payment_declined", code: "payment_declined", providerCode, retryable: false, note, checkoutUrl };
  }
}

export function readQuote() {
  try { return JSON.parse(readFileSync(quoteFile(), "utf8")); } catch (e) { return null; }
}
function writeQuote(q) {
  mkdirSync(currentStateDir(), { recursive: true });
  writeFileSync(quoteFile(), JSON.stringify(q, null, 2), { mode: 0o600 });
}

export function attachPaymentContext({ quoteId, browserInfo, deviceId, source = "inline" }) {
  const quote = readQuote();
  if (!quote || quote.id !== quoteId || quote.expiresAt <= Date.now() || quote.submittedAt) throw new Error("quote expired, replaced or already submitted; prepare a new quote");
  // Rendering another iframe must not replace a recent prepared identity.
  // An explicitly opened browser page can replace inline preparation.
  if (source === "inline" && quote.browserContext) return { ok: true, reused: true };
  quote.browserContext = rememberBrowserContext({ browserInfo, deviceId }, Date.now(), source);
  writeQuote(quote);
  return { ok: true };
}

export function paymentContextStatus({ quoteId, requireBrowser = false }) {
  const quote = readQuote();
  if (!quote || quote.id !== quoteId) throw new Error("quote replaced; request a fresh quote");
  const context = [quote.browserContext, recentBrowserContext()].find(c => c && (!requireBrowser || c.source === "browser"));
  return { ok: true, ready: !!context && !quote.submittedAt, quoteExpired: Date.now() >= quote.expiresAt, submitted: !!quote.submittedAt };
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
async function catalogItems(slug, ids, language) {
  // Without ?language the catalog answers in the venue's own language, and the
  // purchase would carry those names tagged with the user's.
  const r = await woltFetch(`${ASSORTMENT_BASE}${slug}/assortment/items?language=${encodeURIComponent(language)}`, { method: "POST", body: { item_ids: ids }, auth: false });
  if (!r.ok || !Array.isArray(r.json?.items)) throw new Error(`could not load the venue's catalog for the order: HTTP ${r.status}`);
  return {
    items: new Map(r.json.items.map((it) => [it.id, it])),
    options: new Map((r.json.options || []).map((o) => [o.id, o]))
  };
}

// The purchase payload's option types, as the website maps the catalog's.
const OPTION_TYPES = { choice: "Choice", multichoice: "Multichoice", multi_choice: "Multichoice", bool: "Bool" };

// A basket line's chosen options in the purchase payload's shape. The line
// names option groups by the item's binding id and values by id only; the
// type, the names and the prices come from the catalog (bindings on the item,
// definitions at the top level), the same join the basket write makes.
function purchaseOptions(line, it, defs, language) {
  const label = it.name || line.name || line.id;
  return (line.options || []).map((sel) => {
    const binding = (it.options || []).find((b) => b.id === sel.id);
    const def = binding && defs.get(binding.option_id);
    if (!def) throw new Error(`${label}: one of its options is no longer in the venue's catalog; re-add the dish and quote again`);
    const type = OPTION_TYPES[String(def.type || "").toLowerCase()];
    if (!type) throw new Error(`${label}: option "${def.name}" has a type this server does not know (${def.type}); order on wolt.com`);
    const values = (sel.values || []).filter((v) => (v.count ?? 1) > 0).map((v) => {
      const dv = (def.values || []).find((x) => x.id === v.id);
      if (!dv) throw new Error(`${label}: a chosen "${def.name}" value is no longer offered; re-add the dish and quote again`);
      return { count: v.count ?? 1, name: [{ value: dv.name || "", lang: language }], price: dv.price || 0, id: v.id };
    });
    return { type, id: sel.id, name: [{ value: def.name || binding.name || "", lang: language }], values, freeSelections: binding.multi_choice_config?.free_selections || 0 };
  });
}

// The lowest recent price the website echoes for a discounted item; the
// catalog has carried it both as a number and as { price }.
function lowestPrice(it) {
  const v = it.lowest_price ?? it.lowest_price_v2;
  const n = typeof v === "number" ? v : v?.price;
  return typeof n === "number" ? n : null;
}

// What one unit's options add to its price. The website drops the most
// expensive `free_selections` picks of a group before summing.
function optionsPrice(options) {
  return options.reduce((sum, o) => {
    const prices = o.values.flatMap((v) => Array(v.count).fill(v.price)).sort((a, b) => b - a).slice(o.freeSelections);
    return sum + prices.reduce((a, b) => a + b, 0);
  }, 0);
}

export function optionsText(options) {
  return (options || []).map((o) => `${o.name[0].value}: ${o.values.map((v) => (v.count > 1 ? `${v.count}× ` : "") + v.name[0].value).join(", ")}`).join("; ");
}

// Quote the order. Returns the summary the model shows the user; the quote
// itself is on disk for placeOrder().
export async function prepareOrder({ venueId = null, venueSlug = null, lat, lon, tip = 0, comment = "", paymentMethodId = null, addressId = null, language = "en", parentPurchaseId = null, paymentSetup = null }) {
  if (placing.has(quoteFile())) throw new Error("a payment is already in progress; wait for its result before preparing another order");
  const plan = await loadBasketPlan({ venueId, venueSlug, lat, lon });
  if (!plan.slug) throw new Error("cannot order: the venue's slug is unknown (pass venue_slug)");
  const addOn = parentPurchaseId ? await getAddOnOptions(parentPurchaseId) : null;
  const address = pickOne(await savedAddresses(), addressId || addOn?.addressId, "address", (a) => a.labelType === "home");
  if (addOn) requireAddOn(addOn, plan.venueId, address.id);
  const card = pickOne(await savedCards(), paymentMethodId, "card", (c) => c.isDefault);
  const catalog = await catalogItems(plan.slug, plan.lines.map((l) => l.id), language);

  const items = plan.lines.map((line, i) => {
    const it = catalog.items.get(line.id);
    if (!it) throw new Error(`${line.name || line.id} is no longer in the venue's catalog; remove it from the basket`);
    if (it.disabled_info) throw new Error(`${it.name || line.id} is currently unavailable; remove it from the basket`);
    const weighted = orderWeight(line, it);
    const count = weighted ? 1 : (line.count > 0 ? line.count : 1);
    if (it.price !== line.price) throw new Error(`the price of ${it.name || line.id} changed since it was added (${line.price} -> ${it.price}); re-add it and quote again`);
    const options = purchaseOptions(line, it, catalog.options, language);
    if (weighted && options.length) throw new Error(`${it.name || line.id}: weighted items with options must be ordered on wolt.com`);
    const unit = it.price + optionsPrice(options);
    const endAmount = itemAmount(unit, count, weighted);
    // The quote prices the same picks: the basket page carries no value
    // prices, so they are filled in from the catalog here.
    plan.menuItems[i].options = options.map((o) => ({ id: o.id, values: o.values.map((v) => ({ id: v.id, count: v.count, price: v.price })) }));
    plan.menuItems[i].count = count;
    plan.menuItems[i].end_amount = endAmount;
    if (weighted) plan.menuItems[i].weighted = weighted;
    if (it.original_price != null) plan.menuItems[i].original_price = it.original_price;
    return {
      id: line.id,
      configIndex: i,
      count,
      ...(weighted ? { weighted_item_info: weighted } : {}),
      name: [{ value: it.name || line.name || "", lang: language }],
      category: plan.menuItems[i].category_id,
      exclude_from_credits: !!it.exclude_from_credits,
      exclude_from_discounts: !!it.exclude_from_discounts,
      exclude_from_discounts_min_basket: !!it.exclude_from_discounts_min_basket,
      from_recommendation: false,
      alcohol_percentage: (it.alcohol_permille || 0) / 10,
      product_hierarchy_tags: it.product_hierarchy_tags || [],
      // The website sends the code and the decimal only when the catalog has
      // them; items without VAT data go out with the bare percentage.
      ...(it.vat_category_code != null ? { vat_category_code: it.vat_category_code } : {}),
      vat_percentage: it.vat_percentage || 0,
      ...(it.vat_percentage_decimal != null ? { vat_percentage_decimal: it.vat_percentage_decimal } : {}),
      baseprice: it.price,
      end_amount: endAmount,
      ...(it.original_price != null ? { original_price: it.original_price } : {}),
      restrictions: it.restrictions || [],
      ...(lowestPrice(it) != null ? { lowest_price: lowestPrice(it) } : {}),
      options: options.map(({ freeSelections, ...o }) => o),
      checksum: it.checksum,
      ...(line.substitution_settings ? { substitution_settings: line.substitution_settings } : {})
    };
  });
  if (items.some((it) => !it.checksum)) throw new Error("the catalog returned no checksum for an item; cannot build the purchase");

  const payload = {
    purchase_plan: {
      ...(addOn ? { parent_purchase_id: parentPurchaseId } : {}),
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
    expiresAt: Math.min(now + QUOTE_TTL_MS, addOn?.expiresAt ?? Infinity),
    ...(addOn ? { addOn } : {}),
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
  quote.browserContext = recentBrowserContext();
  if (paymentSetup) quote.paymentContextUrl = await paymentSetup(quote);
  writeQuote(quote);
  return summarize(quote);
}

export function summarize(quote) {
  return {
    quoteId: quote.id,
    repriceArguments: { venue_id: quote.venue.id, venue_slug: quote.venue.slug, tip: quote.tip, comment: quote.comment, payment_method_id: quote.card.id, address_id: quote.address.id, ...(quote.addOn ? { parent_purchase_id: quote.addOn.parentPurchaseId } : {}) },
    paymentContextReady: !!quote.browserContext,
    paymentContextSource: quote.browserContext?.source || null,
    ...(quote.paymentContextUrl ? { paymentContextUrl: quote.paymentContextUrl } : {}),
    expiresInSeconds: Math.max(0, Math.round((quote.expiresAt - Date.now()) / 1000)),
    venue: quote.venue.name || quote.venue.slug,
    items: quote.items.map((it) => ({ name: it.name[0].value, count: it.count, price: it.baseprice, endAmount: it.end_amount, ...(it.weighted_item_info ? { grams: it.weighted_item_info.purchased_weight_in_grams, pricePerKg: it.weighted_item_info.price_per_kg } : {}), ...(it.options.length ? { options: optionsText(it.options), priceWithOptions: it.end_amount / it.count } : {}) })),
    ...(quote.addOn ? { parentPurchaseId: quote.addOn.parentPurchaseId, addOnExpiresAt: quote.addOn.expiresAt, deliveryDisclaimer: quote.addOn.disclaimer } : {}),
    rows: quote.rows,
    payableAmount: quote.endAmount,
    currency: quote.venue.currency,
    total: minorToText(quote.endAmount, quote.venue.currency),
    deliveryTo: [quote.address.alias, quote.address.address].filter(Boolean).join(" — "),
    paidWith: [quote.card.title, quote.card.number].filter(Boolean).join(" "),
    eta: quote.estimate,
    tip: quote.tip,
    ...(quote.items.some(it => it.weighted_item_info) ? { warnings: ["The total includes Wolt's weight reserve. The final charge can change with the actual picked weight."] } : {}),
    next: `Show the total, address and card. The checkout card reuses recent device preparation or detects when preparation completes, and its Confirm and pay button submits this exact quote; the user does not need to type Done. Keep the prose brief and do not create another custom confirmation button below the checkout card. ${quote.paymentContextUrl ? "paymentContextUrl prepares the browser when the card requests it; completion is detected automatically. This is our local check, not a rejection by Wolt. " : ""}If the user explicitly confirms the total in chat, call place_order with quote_id "${quote.id}" and total ${quote.endAmount}.`
  };
}

// The consent check takes the purchase items with one difference the website
// makes: an option's values are a map of value id to count, not the spelled-out
// list the purchase carries. The list form is refused with "313 Invalid
// parameters".
function consentBasket(items) {
  return items.map((it) => ({ ...it, options: it.options.map((o) => ({ type: o.type, id: o.id, name: o.name, values: Object.fromEntries(o.values.map((v) => [v.id, v.count])) })) }));
}

// Pay. `total` is the minor-units total the user confirmed; `cap` an optional
// per-order ceiling in minor units from the grant.
export async function placeOrder({ quoteId, total, cap = null, now = Date.now() }) {
  const key = quoteFile();
  if (placing.has(key)) throw new Error("a payment is already in progress for this account; wait for its result and do not submit another order");
  placing.add(key);
  try { return await submitOrder({ quoteId, total, cap, now }); }
  finally { placing.delete(key); }
}

async function submitOrder({ quoteId, total, cap, now }) {
  const quote = readQuote();
  if (!quote || quote.id !== quoteId) throw new Error("that quote is unknown or was replaced; call prepare_order again");
  if (quote.declined) throw new PaymentRefusal({ quoteId: quote.id, checkoutUrl: quote.checkoutUrl || null, alreadyRefused: true });
  if (quote.orderId) throw new Error(`this quote was already submitted (order ${quote.orderId}); check it in Wolt instead of submitting it again`);
  if (quote.submittedAt && !quote.lastError) throw new Error("the previous payment attempt has an unknown outcome; check the order in Wolt before making another purchase; do not retry this quote");
  if (now > quote.expiresAt) { dropQuote(); throw new Error("the quote expired (two minutes); call prepare_order again and re-confirm the total with the user"); }
  if (total !== quote.endAmount) throw new Error(`the total you passed (${total}) is not the quoted ${quote.endAmount} ${quote.venue.currency}; show the user the quote and pass its payableAmount`);
  if (cap != null && quote.endAmount > cap) throw new Error(`this order (${minorToText(quote.endAmount, quote.venue.currency)}) is over the per-order limit set when this connection was approved (${minorToText(cap, quote.venue.currency)})`);
  const recentContext = recentBrowserContext();
  if (recentContext?.source === "browser" && quote.browserContext?.source !== "browser") quote.browserContext = recentContext;
  if (quote.paymentContextUrl && !quote.browserContext) {
    quote.browserContext = recentContext;
    if (!quote.browserContext) throw new Error(`Local device preparation is not ready; no purchase request was sent to Wolt. Open ${quote.paymentContextUrl}, then return to the checkout card and confirm. Completion is detected automatically; this is not a Wolt payment rejection.`);
  }

  if (quote.addOn) requireAddOn(await getAddOnOptions(quote.addOn.parentPurchaseId), quote.venue.id, quote.address.id);

  const cfg = await woltFetch(POST_CHECKOUT_CONFIG_URL, { method: "POST", body: { venue_id: quote.venue.id, country: quote.venue.country, basket: consentBasket(quote.items) } });
  if (!cfg.ok) throw new Error(`the pre-payment check failed, nothing was charged: HTTP ${cfg.status} ${cfg.text.slice(0, 200)}`);
  const consents = cfg.json?.required_consents || [];
  if (consents.length) throw new Error(`Wolt wants the user to accept something before this order (${consents.map((c) => c.id || c.type || JSON.stringify(c)).join(", ")}); order on wolt.com once`);

  const v = quote.validation;
  const body = {
    client_nonce: quote.id,
    // ravelin_device_id is optional. Only its browser SDK may generate it;
    // a quote UUID is not a device identity and must never be sent as one.
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
    ...(quote.addOn ? { parent_purchase_id: quote.addOn.parentPurchaseId } : {}),
    ...(quote.browserContext ? { browser_info: quote.browserContext.browserInfo, ravelin_device_id: quote.browserContext.deviceId } : {}),
    payment_links: { return_url: `https://wolt.com/${quote.language}` },
    delivery_info: { id: { $oid: quote.address.id }, use_last_100m_address_picker: true },
    delivery_price: quote.deliveryPrice,
    // The website echoes these from the quote's validation block when set; the
    // purchase recomputes the total, and a basket with a bag fee that does not
    // say so fails with "Purchase validation error".
    ...(v.bag_fee != null ? { bag_fee: v.bag_fee } : {}),
    ...(v.credits_amount != null ? { credits_amount: v.credits_amount } : {}),
    ...(v.end_amount_rounding != null ? { end_amount_rounding: v.end_amount_rounding } : {}),
    additional_checkout_options: { no_contact_delivery: quote.addOn?.noContactDelivery ?? false },
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
  const submittedAt = Math.max(now, Date.now());
  if (submittedAt >= quote.expiresAt) throw new Error("the quote expired during the pre-payment check; prepare a new quote and confirm its total");
  quote.submittedAt = submittedAt;
  delete quote.lastError;
  writeQuote(quote);
  recordPaymentAttempt(quote, { outcome: "submitted" });
  // A transport retry must not create a second financial operation. An
  // ambiguous outcome stays submitted until the user checks Wolt.
  let r;
  try { r = await woltFetch(PURCHASES_URL, { method: "POST", body, retry: false }); }
  catch (e) {
    recordPaymentAttempt(quote, { outcome: "unknown" });
    throw new Error("The payment response was lost. Its outcome is unknown; check your orders in Wolt before ordering again. Do not retry this quote.");
  }
  recordPaymentAttempt(quote, { outcome: r.ok ? "unconfirmed" : r.status >= 500 || r.status === 408 ? "unknown" : "http_error", response: r });
  if (!r.ok) {
    // Server errors can happen after a purchase was accepted.
    if (r.status >= 500 || r.status === 408) throw new Error(`Wolt returned HTTP ${r.status}; the payment outcome is unknown. Check your orders in Wolt before ordering again. Do not retry this quote.`);
    quote.lastError = `HTTP ${r.status} ${r.text.slice(0, 300)}`;
    writeQuote(quote);
    // Error 800 is opaque: it does not identify the bank, provider or risk
    // check that refused authorization. A new quote must not retry it.
    if (r.json?.error_code === 800 || /process card/i.test(r.json?.msg || "")) {
      recordPaymentAttempt(quote, { outcome: "authorization_refused", response: r });
      quote.declined = true;
      writeQuote(quote);
      // The basket survives a decline; the venue's own link opens it in the
      // Wolt app ("Continue order?"), where the payment usually goes through.
      let link = null;
      try { link = (await getVenue(quote.venue.slug)).shareUrl || null; } catch (e) { /* the message still stands without it */ }
      const refusal = new PaymentRefusal({ quoteId: quote.id, checkoutUrl: link, providerCode: r.json?.error_code ?? 800 });
      quote.checkoutUrl = link;
      quote.paymentResult = refusal.result;
      writeQuote(quote);
      throw refusal;
    }
    throw new Error(`Wolt refused the purchase: ${quote.lastError}. The same quote can be retried once if this looks transient; otherwise order on wolt.com`);
  }
  const res = r.json?.results || r.json || {};
  const orderId = res.id?.$oid || res.id || res.purchase_id || null;
  const payment = res.payment || r.json?.payment;
  const paymentStatus = payment?.status || res.payment_status || r.json?.payment_status;
  // The web client separately authorizes payment plans after creating the
  // purchase. An order status of "received" alone does not mean they paid.
  const paymentPlan = res.payment_plan || r.json?.payment_plan;
  const requiresAction = !!(payment?.authorization || payment?.authorization_url || res.authorization || r.json?.authorization || /authorization_required|authorization_started/i.test(paymentStatus || "") || (paymentPlan && paymentPlan.status !== "authorization_succeeded"));
  if (!orderId && !requiresAction) {
    recordPaymentAttempt(quote, { outcome: "unknown", response: r });
    throw new Error("Wolt returned no order id; the payment outcome is unknown. Check your orders in Wolt before ordering again. Do not retry this quote.");
  }
  quote.orderId = orderId || "unknown";
  quote.status = res.status || null;
  writeQuote(quote);
  if (requiresAction || !["received", "confirmed", "production", "ready", "delivered"].includes(res.status) || (paymentStatus && !/^(paid|authorized|authorised|authorization_succeeded|completed|success|succeeded)$/i.test(paymentStatus))) {
    recordPaymentAttempt(quote, { outcome: requiresAction ? "requires_action" : "unconfirmed", response: r });
    return { ok: false, orderId, status: res.status || null, requiresAction, note: "Payment is not confirmed. Open Wolt to check this order and complete any payment authentication. Do not place a second order." };
  }
  recordPaymentAttempt(quote, { outcome: "confirmed", response: r });
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
