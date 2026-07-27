// Confirms buildBasketBody produces the exact shape Wolt accepted (HTTP 200) in
// the spike. Guards the cart-write payload without needing a live session.
import assert from "node:assert";
import { buildBasketBody } from "../mcp/lib/wolt.js";

// Two candidates: a packaged item and a by-weight item (like the spike's beef).
const packaged = { itemId: "5dab92633e2a06d6d9ffc9fb", name: "Crushed tomatoes, 800 g", price: 1450, currency: "ILS", isWeighted: false };
const weighted = { itemId: "5dcfbc56e12e702ee5e712e4", name: "Fresh Ground Beef", price: 9490, currency: "ILS", isWeighted: true, unitSizeText: "500 g" };

const body = buildBasketBody(
  [{ candidate: packaged, count: 1 }, { candidate: weighted, count: 1, grams: 1000 }],
  "64cf7c577c4d494d88fc0dba",
  "ILS"
);

// top-level shape
assert.deepEqual(Object.keys(body).sort(), ["currency", "items", "venue_id"]);
assert.equal(body.venue_id, "64cf7c577c4d494d88fc0dba");
assert.equal(body.currency, "ILS");
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
const defaulted = buildBasketBody([{ candidate: weighted, count: 1 }], "v", "ILS");
assert.equal(defaulted.items[0].weighted_item_info.purchased_weight_in_grams, 500);

console.log("basket.test.mjs: basket body matches the accepted schema");
