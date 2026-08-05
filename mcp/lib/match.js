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

// 0..1 similarity between an ingredient name and a candidate product name.
export function scoreMatch(ingredientName, candidateName) {
  const a = tokens(ingredientName);
  const b = [...new Set(tokens(candidateName))];
  if (!a.length || !b.length) return 0;
  let hits = 0;
  for (const t of a) if (b.some((x) => tokensMatch(t, x))) hits++;
  const recall = hits / a.length; // how much of the ingredient is covered
  // Precision keeps flavored lookalikes below the plain product: "onion" is
  // fully contained in "Bisli snack onion flavor 70g" too, but the plain
  // "onion, packed" wastes far fewer words on being something else.
  const precision = hits / b.length;
  const substr = candidateName.toLowerCase().includes(ingredientName.toLowerCase()) ? 0.1 : 0;
  return Math.min(1, recall * 0.7 + precision * 0.2 + substr);
}

// Rank candidates for one ingredient, best first. Filters out non-matches.
export function rankCandidates(ingredientName, candidates, { topK = 6, minScore = 0.15 } = {}) {
  return candidates
    .map((c) => ({ ...c, score: scoreMatch(ingredientName, c.name) }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score || a.price - b.price)
    .slice(0, topK);
}
