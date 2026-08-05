// Confirms buildBasketBody produces the exact shape Wolt accepted (HTTP 200) in
// the spike. Guards the cart-write payload without needing a live session.
import assert from "node:assert";
import { buildBasketBody, snapGrams, reconcileWeightedItems, resolveCurrency, currencyForCountry } from "../mcp/lib/wolt.js";

// Two candidates: a packaged item and a by-weight item (like the spike's beef).
const packaged = { itemId: "5dab92633e2a06d6d9ffc9fb", name: "Crushed tomatoes, 800 g", price: 1450, currency: "EUR", isWeighted: false };
const weighted = { itemId: "5dcfbc56e12e702ee5e712e4", name: "Fresh Ground Beef", price: 9490, currency: "EUR", isWeighted: true, unitSizeText: "500 g" };

const body = buildBasketBody(
  [{ candidate: packaged, count: 1 }, { candidate: weighted, count: 1, grams: 1000 }],
  "64cf7c577c4d494d88fc0dba",
  "EUR"
);

// top-level shape
assert.deepEqual(Object.keys(body).sort(), ["currency", "items", "venue_id"]);
assert.equal(body.venue_id, "64cf7c577c4d494d88fc0dba");
assert.equal(body.currency, "EUR");
assert.equal(body.items.length, 2);

// packaged item — matches spike schema exactly
assert.deepEqual(body.items[0], {
  id: "5dab92633e2a06d6d9ffc9fb",
  count: 1,
  name: "Crushed tomatoes, 800 g",
  price: 1450,
  options: [],
  substitution_settings: { is_allowed: true }
});

// weighted item — carries weighted_item_info like the spike's ground beef
assert.deepEqual(body.items[1].weighted_item_info, {
  count: 1,
  purchased_weight_in_grams: 1000,
  weighted_item_input_type: "grams"
});
assert.equal(body.items[1].id, "5dcfbc56e12e702ee5e712e4");

// grams defaulting: no explicit grams -> derive from unit size text
const defaulted = buildBasketBody([{ candidate: weighted, count: 1 }], "v", "EUR");
assert.equal(defaulted.items[0].weighted_item_info.purchased_weight_in_grams, 500);

// currency is never invented: no currency in, no basket out.
assert.throws(() => buildBasketBody([{ candidate: packaged, count: 1 }], "v", null), /currency/i, "missing currency must fail loudly");

// currencyForCountry covers Wolt's markets, in either case, and admits
// ignorance rather than guessing.
assert.equal(currencyForCountry("FIN"), "EUR");
assert.equal(currencyForCountry("swe"), "SEK");
assert.equal(currencyForCountry("JPN"), "JPY");
assert.equal(currencyForCountry("POL"), "PLN");
assert.equal(currencyForCountry("GEO"), "GEL");
assert.equal(currencyForCountry("ISR"), "ILS");
assert.equal(currencyForCountry("XXX"), null, "unknown market -> null");
assert.equal(currencyForCountry(null), null);

// resolveCurrency prefers the caller, then the venue, then a candidate item,
// then the market — and returns null when nothing knows.
assert.equal(resolveCurrency({ currency: "SEK", venue: { currency: "EUR" } }), "SEK", "explicit wins");
assert.equal(resolveCurrency({ venue: { currency: "CZK", country: "swe" } }), "CZK", "venue beats its own country");
assert.equal(resolveCurrency({ candidates: [{}, { currency: "HUF" }] }), "HUF", "first candidate carrying one");
assert.equal(resolveCurrency({ country: "nor" }), "NOK", "market map as last resort");
assert.equal(resolveCurrency({ venue: { country: "dnk" } }), "DKK", "venue country counts as the market");
assert.equal(resolveCurrency({ candidates: [{}], country: "zzz" }), null, "nothing known -> null");
assert.equal(resolveCurrency(), null);

// snapGrams: valid weights are multiples of grams_per_step, min one step,
// always rounded UP (undershooting gets silently dropped by Wolt).
assert.equal(snapGrams(350, 500), 500, "below one step -> one step");
assert.equal(snapGrams(500, 500), 500, "exact step passes");
assert.equal(snapGrams(501, 500), 1000, "off-step rounds up");
assert.equal(snapGrams(1000, 500), 1000, "exact multiple passes");
assert.equal(snapGrams(350, 200), 400, "rounds to nearest step above");
assert.equal(snapGrams(null, 500), 500, "no request -> one step");
assert.equal(snapGrams(350, null), 350, "no step known -> untouched");
assert.equal(snapGrams(null, null), null, "nothing known -> untouched");

// reconcileWeightedItems: the catalog decides how an item is sold, not the
// caller's guess — both mismatch directions get corrected, unknowns untouched.
{
  const items = [
    { id: "pack", name: "onion pack ~900g", weighted: true, grams: 900 },   // count item flagged weighted
    { id: "loose", name: "loose onions", weighted: false, grams: null },    // weighted item flagged count
    { id: "offstep", name: "peppers", weighted: true, grams: 350 },         // weighted, off-step grams
    { id: "fine", name: "beef", weighted: true, grams: 1000 },              // weighted, already valid
    { id: "ghost", name: "delisted", weighted: true, grams: 250 }           // unknown to the catalog
  ];
  const configs = new Map([
    ["pack", { gramsPerStep: null }],
    ["loose", { gramsPerStep: 500 }],
    ["offstep", { gramsPerStep: 500 }],
    ["fine", { gramsPerStep: 500 }]
  ]);
  const adj = reconcileWeightedItems(items, configs);
  assert.equal(items[0].weighted, false, "count item loses the weight payload");
  assert.equal(items[0].grams, null);
  assert.equal(items[1].weighted, true, "weighted item gains the weight payload");
  assert.equal(items[1].grams, 500);
  assert.equal(items[2].grams, 500, "off-step grams snapped");
  assert.equal(items[3].grams, 1000, "valid line untouched");
  assert.equal(items[4].weighted, true, "unknown item left as the caller sent it");
  assert.equal(items[4].grams, 250);
  assert.equal(adj.length, 3, "only real corrections reported");
  assert.equal(reconcileWeightedItems(items, null).length, 0, "failed lookup changes nothing");
}

console.log("basket.test.mjs: basket body matches the accepted schema");
