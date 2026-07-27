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

// 0..1 similarity between an ingredient name and a candidate product name.
export function scoreMatch(ingredientName, candidateName) {
  const a = tokens(ingredientName);
  const b = new Set(tokens(candidateName));
  if (!a.length || !b.size) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits++;
  const recall = hits / a.length; // how much of the ingredient is covered
  const substr = candidateName.toLowerCase().includes(ingredientName.toLowerCase()) ? 0.2 : 0;
  return Math.min(1, recall * 0.9 + substr);
}

// Rank candidates for one ingredient, best first. Filters out non-matches.
export function rankCandidates(ingredientName, candidates, { topK = 6, minScore = 0.15 } = {}) {
  return candidates
    .map((c) => ({ ...c, score: scoreMatch(ingredientName, c.name) }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score || a.price - b.price)
    .slice(0, topK);
}
