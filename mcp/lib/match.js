// Heuristic ingredient→product matching. This is the offline fallback; the
// backend LLM matcher (backend/server.js) produces higher-quality matches,
// especially for non-English names and quantity→package reasoning. Both return the
// same shape: a ranked candidate list per ingredient.

const STOP = new Set(["of", "the", "a", "an", "and", "or", "fresh", "large", "small", "medium", "to", "for", "with"]);

export function tokens(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

const commonPrefixLen = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

// Do two tokens refer to the same thing? Exact equality is not enough outside
// English: a recipe line is inflected ("2 sipulia", "500 g spagettia") while
// the catalog lists dictionary forms ("Sipuli", "spagetti"), and most of
// Wolt's markets speak languages that inflect — Finnish, Estonian, Hungarian,
// Polish, Czech, Greek. Measured: token equality scored 0 of 5 lines for a
// natural Finnish list.
//
// So tokens match when they share a long prefix and differ only by a short
// tail. The tail limits are what keep it from swallowing compounds, which is
// where the wrong-product traps live: "tomaatti" must not reach
// "tomaattisose" (paste), "juusto" not "juustokastike" (cheese sauce).
//
// Two characters of slack, not three, and that is a measured choice rather
// than a taste: three lets a query reach a word derived from it across
// languages ("parmesan" -> "parmesaani"), and on test/bench.mjs that bought no
// extra correct lines while adding a wrong one — it found the Finnish
// parmesan PASTA SAUCE for an English "parmesan". Loosening here buys reach
// into shelves the query was never really asking about.
export function tokensMatch(a, b) {
  if (a === b) return true;
  const n = commonPrefixLen(a, b);
  return n >= 4 && a.length - n <= 2 && b.length - n <= 2;
}

// Words that name a FORM of a food rather than the food: a sauce, a paste, a
// powder, a snack, a juice, something fried or dried. When a product name
// carries one the ingredient never asked for, the match is usually a
// confident-and-wrong one — parmesan cheese matched to parmesan PASTA SAUCE,
// tomatoes to sun-dried tomato PESTO, onions to CRISPY fried onions in a jar.
// Token scoring cannot see this: "Mutti parmesaani pastakastike" and "Sipuli
// kotimainen pussi" score identically, and only one of them is the thing the
// user asked for.
//
// This never filters or re-ranks. It only flags, so a wrong guess costs the
// client model one look at the alternatives instead of costing the user a jar
// of pesto. Substrings rather than whole words on purpose: the compounding
// languages hide the form word inside another word
// ("jauhelihakastiketta"), which is exactly where the trap sits.
const FORM_HINTS = [
  /\bsauces?\b/i, /\bpastes?\b/i, /\bpowder\b/i, /\bjuice\b/i, /\bsnack/i, /\bcrisps?\b/i, /\bchips\b/i,
  /\bspread\b/i, /\bflavou?red?\b/i, /\bdried\b/i, /\bpickled\b/i, /\bsoup\b/i, /\bfried\b/i, /\bcrispy\b/i, /\bpesto\b/i,
  /kastike/i, /sose/i, /jauhe/i, /mehu/i, /sipsi/i, /lastu/i, /levite/i, /keitto/i, /maustett/i, /paistett/i, /rapea/i,
  /\bsås\b/i, /soppa/i, /torkad/i,
  /σάλτσ/i, /πέστο/i, /πελτ/i, /σκόν/i, /χυμ/i, /τσιπς/i, /σούπ/i, /τραγαν/i, /τηγανητ/i,
  /соус/i, /пюре/i, /порошок/i, /чипсы/i, /\bсуп\b/i,
  /\bsos\b/i, /przecier/i, /chipsy/i, /zupa/i,
  /omáčk/i, /pyré/i, /polévk/i, /szósz/i, /püré/i, /leves/i,
  /רוטב/, /מחית/, /אבקת/, /חטיף/, /ממרח/, /מרק/,
  /\bsalsa\b/i, /\bpuré/i, /\bsopa\b/i
];

// Does the candidate name a form the ingredient line didn't ask for? Returns
// the offending word, or null.
export function differentForm(ingredientName, candidateName) {
  for (const re of FORM_HINTS) {
    const m = String(candidateName).match(re);
    if (m && !re.test(String(ingredientName))) return m[0];
  }
  return null;
}

// 0..1 similarity, plus the parts it was built from so callers can tell a
// whole-ingredient match from a partial one.
export function matchDetail(ingredientName, candidateName) {
  const a = tokens(ingredientName);
  const b = [...new Set(tokens(candidateName))];
  if (!a.length || !b.length) return { score: 0, recall: 0, precision: 0 };
  let hits = 0;
  for (const t of a) if (b.some((x) => tokensMatch(t, x))) hits++;
  const recall = hits / a.length; // how much of the ingredient is covered
  // Precision keeps flavored lookalikes below the plain product: "onion" is
  // fully contained in "Bisli snack onion flavor 70g" too, but the plain
  // "onion, packed" wastes far fewer words on being something else.
  const precision = hits / b.length;
  const substr = String(candidateName).toLowerCase().includes(String(ingredientName).toLowerCase()) ? 0.1 : 0;
  return { score: Math.min(1, recall * 0.7 + precision * 0.2 + substr), recall, precision };
}

export const scoreMatch = (ingredientName, candidateName) => matchDetail(ingredientName, candidateName).score;

// Rank candidates for one ingredient, best first. Filters out non-matches.
// Each survivor carries the evidence for its rank — score, how much of the
// ingredient matched, and any form word it adds — so the planner can say how
// sure it is instead of just asserting a pick.
export function rankCandidates(ingredientName, candidates, { topK = 6, minScore = 0.15 } = {}) {
  return candidates
    .map((c) => {
      const { score, recall } = matchDetail(ingredientName, c.name);
      return { ...c, score, recall, addedForm: differentForm(ingredientName, c.name) };
    })
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score || a.price - b.price)
    .slice(0, topK);
}
