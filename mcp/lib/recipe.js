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
// Units in the languages people write shopping lists in. An unrecognized unit
// leaks into the in-venue search query ("800 גרם עגבניות" searching as
// "גרם עגבניות", "2 łyżki oliwy" as "łyżki oliwy"), which is exactly the kind
// of query that comes back with garbage matches — so the list spans Wolt's
// markets rather than just English. Recipe sources are global even where Wolt
// isn't, hence Spanish too. Japanese is absent on purpose: 大さじ1 carries no
// space to split on, so a word list can't reach it.
const UNITS = new Set([
  // English / metric
  "g", "gram", "grams", "kg", "kilogram", "kilograms",
  "ml", "cl", "dl", "l", "liter", "liters", "litre", "litres",
  "cup", "cups", "tbsp", "tablespoon", "tablespoons",
  "tsp", "teaspoon", "teaspoons", "oz", "ounce", "ounces",
  "lb", "lbs", "pound", "pounds", "clove", "cloves",
  "can", "cans", "tin", "tins", "jar", "jars", "package", "packages", "packet", "pack",
  "pinch", "slice", "slices", "bunch", "sprig", "sprigs", "handful",
  // German
  "el", "tl", "prise", "packung", "dose", "scheibe", "scheiben",
  "zehe", "zehen", "stück", "bund", "tasse", "tassen",
  // Finnish
  "rkl", "kpl", "pkt", "prk", "tlk", "ripaus", "kynsi", "kynttä", "nippu", "pussi",
  // Swedish / Norwegian / Danish
  "msk", "tsk", "krm", "st", "stk", "spsk", "pk", "burk", "boks",
  "klyfta", "klyftor", "fed", "nypa", "knivsudd", "skiva", "skivor",
  // Polish
  "łyżka", "łyżki", "łyżek", "łyżeczka", "łyżeczki", "szklanka", "szklanki",
  "ząbek", "ząbki", "opakowanie", "puszka", "słoik", "szczypta", "plaster", "plastry", "szt",
  // Czech / Slovak
  "lžíce", "lžička", "lyžica", "lyžička", "hrnek", "stroužek", "stroužky", "strúčik",
  "balení", "konzerva", "špetka", "plátek", "ks",
  // Hungarian
  "dkg", "evőkanál", "teáskanál", "csésze", "gerezd", "csomag", "konzerv",
  "csipet", "szelet", "db",
  // Greek
  "γρ", "γραμμάρια", "κιλό", "κιλά", "λίτρο", "κούπα", "κούπες", "φλιτζάνι",
  "κουταλιά", "κουταλιές", "κουταλάκι", "κσ", "κγ", "σκελίδα", "σκελίδες",
  "συσκευασία", "κονσέρβα", "πρέζα", "φέτα", "φέτες", "τεμάχιο", "τεμάχια",
  // Russian and the other Cyrillic-script markets
  "г", "гр", "грамм", "граммов", "кг", "мл", "стл", "чл", "стакан", "стакана",
  "зубчик", "зубчика", "упаковка", "банка", "щепотка", "ломтик", "шт", "дана",
  // Spanish
  "cucharada", "cucharadas", "cucharadita", "cucharaditas", "taza", "tazas",
  "diente", "dientes", "paquete", "lata", "pizca", "rebanada", "rebanadas",
  "unidad", "unidades",
  // Hebrew, stored with gershayim/geresh normalized to " (see normUnit) so
  // ק״ג, ק"ג and ק'ג all resolve
  "גרם", "ג\"", "קילו", "ק\"ג", "מ\"ל", "ליטר",
  "כוס", "כוסות", "כפית", "כפיות", "כף", "כפות",
  "יחידה", "יחידות", "חבילה", "חבילות", "קופסה", "שן", "שיני"
]);

// Lowercase, drop the dots inside and after abbreviations (ст.л., κ.σ., spsk.,
// tbsp.), strip a trailing comma, and normalize Hebrew gershayim (״) and
// geresh (׳/') to a plain double quote for unit lookup.
const normUnit = (tok) => tok.toLowerCase().replace(/[״׳"']/g, "\"").replace(/\./g, "").replace(/,$/, "");

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
  // A unit is only consumed when a quantity introduced it. Across this many
  // languages, plenty of unit words double as the first word of a product
  // ("lata de tomate", "burk krossade tomater") — dropping that word from an
  // unquantified line would search for half an ingredient.
  let unit = null;
  if (quantity != null && tokens[i] && UNITS.has(normUnit(tokens[i]))) {
    unit = normUnit(tokens[i]);
    i++;
  }
  const name = tokens.slice(i).join(" ").replace(/^(of|de|di)\s+/i, "").trim();
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
