// Recipe ingredient extraction. Pure functions (no DOM) so they run in the
// content script (pass document HTML) and in Node tests alike.

// Pull all JSON-LD blocks from an HTML string.
export function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      blocks.push(JSON.parse(m[1].trim()));
    } catch (e) {
      // Some sites emit invalid JSON-LD; skip.
    }
  }
  return blocks;
}

// Walk a JSON-LD value (object, array, or @graph) and collect Recipe nodes.
function collectRecipes(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) collectRecipes(n, out);
    return;
  }
  if (node["@graph"]) collectRecipes(node["@graph"], out);
  const type = node["@type"];
  const isRecipe = type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"));
  if (isRecipe) out.push(node);
}

// Returns { title, ingredients: string[] } or null if no Recipe found.
export function parseRecipe(html) {
  const blocks = extractJsonLdBlocks(html);
  const recipes = [];
  for (const b of blocks) collectRecipes(b, recipes);
  if (!recipes.length) return null;
  const r = recipes[0];
  const raw = r.recipeIngredient || r.ingredients || [];
  const ingredients = (Array.isArray(raw) ? raw : [raw])
    .map((s) => String(s).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!ingredients.length) return null;
  return { title: String(r.name || "").trim() || null, ingredients };
}

// Very rough heuristic parse of a "2 cups flour" style line into
// { quantity, unit, name }. The LLM matcher does the real work; this is a
// fallback + a normalization the LLM prompt can build on.
const UNITS = new Set([
  "g", "gram", "grams", "kg", "kilogram", "kilograms",
  "ml", "l", "liter", "liters", "litre", "litres",
  "cup", "cups", "tbsp", "tablespoon", "tablespoons",
  "tsp", "teaspoon", "teaspoons", "oz", "ounce", "ounces",
  "lb", "lbs", "pound", "pounds", "clove", "cloves",
  "can", "cans", "package", "packages", "pinch", "slice", "slices"
]);

export function parseIngredientLine(line) {
  const tokens = String(line).trim().split(/\s+/);
  let i = 0;
  let quantity = null;
  // leading number (incl. fractions like 1/2 or 1½)
  const numMatch = tokens[0] && tokens[0].match(/^(\d+([.,]\d+)?|\d+\/\d+|[½¼¾⅓⅔])$/);
  if (numMatch) {
    quantity = parseQuantity(tokens[0]);
    i = 1;
    // handle "1 1/2"
    if (tokens[1] && /^\d+\/\d+$/.test(tokens[1])) {
      quantity += parseQuantity(tokens[1]);
      i = 2;
    }
  }
  let unit = null;
  if (tokens[i] && UNITS.has(tokens[i].toLowerCase().replace(/[.,]$/, ""))) {
    unit = tokens[i].toLowerCase().replace(/[.,]$/, "");
    i++;
  }
  const name = tokens.slice(i).join(" ").replace(/^of\s+/i, "").trim();
  return { quantity, unit, name: name || line.trim(), raw: line.trim() };
}

function parseQuantity(tok) {
  const frac = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
  if (frac[tok] != null) return frac[tok];
  if (tok.includes("/")) {
    const [a, b] = tok.split("/").map(Number);
    return b ? a / b : Number(a);
  }
  return Number(tok.replace(",", "."));
}
