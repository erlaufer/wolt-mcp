// Guards how normalizeSearchResponse splits Wolt's item search by product_line.
// Only "restaurant" entries are dishes; every other line (pharmacy,
// health_and_beauty, alcohol, electronics, general_merchandise, grocery, or
// none at all) is a store product. Observed live: a hand sanitizer sold by a
// pharmacy came back with product_line "pharmacy" and used to be filtered out
// of search_products and surfaced as a restaurant dish instead.
import assert from "node:assert";
import { normalizeSearchResponse } from "../mcp/lib/wolt.js";

const entry = (id, productLine) => ({
  menu_item: { id, venue_id: `venue-${id}`, name: `item ${id}`, price: 1000, currency: "EUR", is_available: true },
  link: { menu_item_details: productLine === undefined ? {} : { product_line: productLine } }
});

const json = {
  sections: [{
    items: [
      entry("grocery", "grocery"),
      entry("pharmacy", "pharmacy"),
      entry("beauty", "health_and_beauty"),
      entry("alcohol", "alcohol"),
      entry("electronics", "electronics"),
      entry("merch", "general_merchandise"),
      entry("none", undefined),
      entry("dish", "restaurant")
    ]
  }]
};

const ids = (items) => items.map((c) => c.itemId).sort();

assert.deepEqual(
  ids(normalizeSearchResponse(json)),
  ["alcohol", "beauty", "electronics", "grocery", "merch", "none", "pharmacy"]
);
assert.deepEqual(ids(normalizeSearchResponse(json, { mode: "restaurant" })), ["dish"]);

console.log("search.test.mjs: store products of every line kept, only restaurant dishes split off");