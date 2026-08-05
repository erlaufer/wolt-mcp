import assert from "node:assert";
import { parseRecipe, parseIngredientLine } from "../mcp/lib/recipe.js";

const html = `
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Recipe","name":"Test Bolognese",
 "recipeIngredient":["800 g crushed tomatoes","500 g ground beef","2 cloves garlic","1 onion","olive oil"]}
</script>
</head><body></body></html>`;

const r = parseRecipe(html);
assert(r, "should parse a recipe");
assert.equal(r.title, "Test Bolognese");
assert.equal(r.ingredients.length, 5);
assert.equal(r.ingredients[0], "800 g crushed tomatoes");

// @graph wrapping
const graphHtml = `<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Recipe"],"name":"G","recipeIngredient":["1 cup flour"]}]}</script>`;
const g = parseRecipe(graphHtml);
assert(g && g.ingredients[0] === "1 cup flour", "should find Recipe inside @graph");

// no recipe
assert.equal(parseRecipe("<html>nope</html>"), null);

// ingredient line parsing
assert.deepEqual(parseIngredientLine("800 g crushed tomatoes"), { quantity: 800, unit: "g", name: "crushed tomatoes", raw: "800 g crushed tomatoes" });
assert.deepEqual(parseIngredientLine("2 cloves garlic"), { quantity: 2, unit: "cloves", name: "garlic", raw: "2 cloves garlic" });
const half = parseIngredientLine("1/2 cup olive oil");
assert.equal(half.quantity, 0.5); assert.equal(half.name, "olive oil");
const plain = parseIngredientLine("olive oil");
assert.equal(plain.quantity, null); assert.equal(plain.name, "olive oil");

// Units across Wolt's markets: the unit must be stripped off the query, or the
// in-venue search runs on "grams tomatoes" and matches junk.
const cases = [
  ["500 g jauhelihaa", 500, "g", "jauhelihaa"],              // Finnish
  ["2 rkl oliiviöljyä", 2, "rkl", "oliiviöljyä"],            // Finnish abbreviation
  ["2 msk olivolja", 2, "msk", "olivolja"],                  // Swedish
  ["1 pk pasta", 1, "pk", "pasta"],                          // Danish/Norwegian
  ["2 EL Olivenöl", 2, "el", "Olivenöl"],                    // German, uppercase
  ["2 łyżki oliwy", 2, "łyżki", "oliwy"],                    // Polish
  ["3 stroužky česneku", 3, "stroužky", "česneku"],          // Czech
  ["2 gerezd fokhagyma", 2, "gerezd", "fokhagyma"],          // Hungarian
  ["2 κ.σ. ελαιόλαδο", 2, "κσ", "ελαιόλαδο"],                // Greek, dots inside the abbreviation
  ["500 г говядины", 500, "г", "говядины"],                  // Russian
  ["2 ст.л. оливкового масла", 2, "стл", "оливкового масла"],// Russian abbreviation
  ["2 cucharadas de aceite de oliva", 2, "cucharadas", "aceite de oliva"], // Spanish, "de" stripped
  ["800 גרם עגבניות", 800, "גרם", "עגבניות"],                 // Hebrew
  ["1 ק\"ג בשר טחון", 1, "ק\"ג", "בשר טחון"]                  // Hebrew abbreviation with gershayim
];
for (const [line, quantity, unit, name] of cases) {
  const got = parseIngredientLine(line);
  assert.equal(got.quantity, quantity, `quantity of "${line}"`);
  assert.equal(got.unit, unit, `unit of "${line}"`);
  assert.equal(got.name, name, `name of "${line}"`);
}

// A unit word with no quantity in front of it is part of the product name —
// otherwise "lata de tomate" would search for "tomate" via a stripped "lata",
// and "burk krossade tomater" would lose its "burk".
assert.equal(parseIngredientLine("lata de tomate").name, "lata de tomate");
assert.equal(parseIngredientLine("burk krossade tomater").name, "burk krossade tomater");

console.log("recipe.test.mjs: all assertions passed");
