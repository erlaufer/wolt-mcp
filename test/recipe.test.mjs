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

console.log("recipe.test.mjs: all assertions passed");
