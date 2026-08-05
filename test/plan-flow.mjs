// The plan_cart flow, in one place, so the cassette recorder and the replay
// test drive exactly the same sequence of requests. If they drift apart the
// replay hits a cassette miss, which is the point — a silent divergence would
// be a test that no longer tests the shipped path.
import { searchItems, rankVenues } from "../mcp/lib/wolt.js";
import { planAtVenue, mapPool } from "../mcp/lib/plan.js";
import { getWeightConfigs, getMarketLanguage } from "../mcp/lib/venue.js";
import { parseIngredientLine } from "../mcp/lib/recipe.js";
import { rankCandidates } from "../mcp/lib/match.js";

// Public city centres, never the recording machine's own location.
export const MARKETS = {
  helsinki: {
    lat: 60.1699,
    lon: 24.9384,
    note: "Latin-script EUR market, English shopping list",
    ingredients: ["500 g spaghetti", "400 g crushed tomatoes", "200 g parmesan", "2 onions", "olive oil"]
  },
  // Same market and list as `helsinki`, written the way a Finnish speaker
  // actually writes a recipe line: partitive, not dictionary form. It is a
  // deliberate regression fixture for the inflection defect — see the
  // assertions in replay.test.mjs.
  "helsinki-fi": {
    lat: 60.1699,
    lon: 24.9384,
    note: "same market, inflected (partitive) Finnish — documents the inflection defect",
    ingredients: ["500 g spagettia", "400 g tomaattimurskaa", "200 g parmesaania", "2 sipulia", "oliiviöljyä"]
  },
  athens: {
    lat: 37.9838,
    lon: 23.7275,
    note: "non-Latin catalog language (el), list in the catalog's language",
    ingredients: ["500 γρ ζυμαρικά", "ντομάτες", "παρμεζάνα", "2 κρεμμύδια", "ελαιόλαδο"]
  }
};

// Runs auto-mode planning end to end and returns what a caller would judge it
// by: which stores were raced, which won, and what the winning basket says.
export async function runPlanFlow({ lat, lon, ingredients }) {
  const marketLanguage = await getMarketLanguage({ lat, lon });
  const perIngredient = await mapPool(ingredients, 3, async (raw) => {
    const q = parseIngredientLine(raw).name;
    let candidates = [];
    try { candidates = await searchItems(q, { lat, lon }); } catch (e) { candidates = []; }
    return { ingredient: raw, candidates: rankCandidates(q, candidates) };
  });
  const shortlist = rankVenues(perIngredient).slice(0, 3).filter((r) => r.venue.venueSlug);
  const plans = [];
  for (const r of shortlist) {
    try { plans.push(await planAtVenue(r.venue.venueSlug, ingredients)); } catch (e) { /* recorded as absent */ }
  }
  const best = plans.slice().sort((a, b) => b.coverageCount - a.coverageCount || a.cost - b.cost)[0] || null;
  const weightConfigs = best?.lineItems.length
    ? await getWeightConfigs(best.venue.slug, best.lineItems.map((li) => li.itemId))
    : null;
  return {
    marketLanguage,
    globalCandidates: perIngredient.map((p) => p.candidates.length),
    shortlist: shortlist.map((s) => s.venue.venueSlug),
    plans,
    best,
    weightConfigs
  };
}
