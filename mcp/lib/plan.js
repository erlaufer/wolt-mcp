// Whole-list planning against venue catalogs: the engine behind plan_cart.
// Lives outside server.mjs so the ranking/disqualification and preflight rules
// are plain functions a unit test can hit.
import { getVenue, getCatalogLanguage, searchVenueItems } from "./venue.js";
import { rankCandidates, tokens } from "./match.js";
import { parseIngredientLine } from "./recipe.js";
import { buildBasketBody, snapGrams, resolveCurrency } from "./wolt.js";
import { langOf, sameScript, isNonLatinLang } from "./lang.js";

// Map with bounded concurrency — per-ingredient searches are independent HTTP
// round-trips, and running them serially is what made planning slow. (The
// process-wide rate cap lives in http.js; these pools just bound memory and
// ordering.)
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// How many ingredient lines are NOT written in the catalog language's script.
export const offScriptCount = (ingredients, lang) =>
  ingredients.filter((raw) => !sameScript(parseIngredientLine(raw).name, lang)).length;

// Hard stop BEFORE any planning burst: when most of the list is in the wrong
// script for a non-Latin catalog, every downstream search is garbage-prone and
// ~100 requests get wasted. Returning this instead costs the model one cheap
// turn: translate, call again. The >50% threshold lets genuinely mixed lists
// (a few Latin brand names) through — those still get languageNote +
// retryInLanguage on the plan. No escape hatch: the only legitimate answer to
// this response is translating. Unknown language (null) skips the check.
export function translationPreflight(ingredients, catalogLanguage) {
  if (!catalogLanguage || !isNonLatinLang(catalogLanguage)) return null;
  const off = offScriptCount(ingredients, catalogLanguage);
  if (off * 2 <= ingredients.length) return null;
  return {
    needsTranslation: true,
    catalogLanguage,
    offLanguageCount: off,
    totalIngredients: ingredients.length,
    note: `This market's catalogs are indexed in '${catalogLanguage}'. Translate the ingredient lines to ${catalogLanguage} yourself — naming each product in dictionary form, singular nominative, the way a shelf label reads — and call plan_cart again. Planning them as-is produces wrong-category matches.`
  };
}

// Pick the winning plan. A plan whose searches half-failed cannot win — its
// coverage number is a lie, and crowning it turns a rate-limit blip into a
// wrong store choice. If EVERY plan is that degraded there is no honest winner
// at all (allDegraded) and the caller should say "rate limited, retry", never
// a fake 0-coverage plan.
export function rankPlans(plans, total) {
  const threshold = Math.ceil(total / 2);
  const qualified = plans.filter((p) => (p.searchErrors || 0) < threshold);
  const pool = [...(qualified.length ? qualified : plans)]
    .sort((a, b) => b.coverageCount - a.coverageCount || a.cost - b.cost);
  return { best: pool[0] || null, allDegraded: plans.length > 0 && !qualified.length };
}

// Plan a whole ingredient list against ONE venue's own catalog. Returns the
// same shape whether called for a pinned store or as one contestant of the
// multi-store race in plan_cart's auto mode.
// Catalogs indexed in a non-Latin language (Wolt reports each venue's
// primary_language): querying them off-script is the single biggest cause of
// garbage matches, so those plans carry a languageNote.
export async function planAtVenue(venue_slug, ingredients) {
  const [venue, catalogLanguage] = await Promise.all([getVenue(venue_slug), getCatalogLanguage(venue_slug)]);
  let searchErrors = 0, rateLimited = false;
  const lineItems = [], missing = [], unmatched = [];
  const resolved = await mapPool(ingredients, 4, async (raw) => {
    const name = parseIngredientLine(raw).name;
    const lang = langOf(name);
    let failed = false;
    const search = async (q) => {
      try { return await searchVenueItems(venue_slug, q, { lang }); }
      catch (e) { failed = true; if (e.status === 429) rateLimited = true; return []; }
    };
    let hits = await search(name);
    // Multi-word queries often miss; the store search wants short terms.
    if (!hits.length) {
      const longest = tokens(name).sort((a, b) => b.length - a.length)[0];
      if (longest && longest !== name) hits = await search(longest);
    }
    // A failed search is NOT evidence the store lacks the item — count it so
    // the plan can't silently report rate-limit blackouts as missing items.
    if (failed && !hits.length) searchErrors++;
    // Only auto-pick scored matches — the raw first hit of a missed query is
    // garbage (a "shrimp" miss once returned Sprite Zero). Unscorable hits
    // still go back as candidates for the model to judge — it matches by
    // meaning, which token overlap can't.
    return { raw, hits, ranked: rankCandidates(name, hits, { topK: 3, minScore: 0.15 }) };
  });
  for (const { raw, hits, ranked } of resolved) {
    const best = ranked[0];
    if (best) {
      lineItems.push({
        ingredient: raw, name: best.name, itemId: best.itemId, price: best.price,
        ...(best.isWeighted ? { isWeighted: true, sellByWeight: best.sellByWeight } : {}),
        alternatives: ranked.slice(1).map((c) => ({ name: c.name, itemId: c.itemId, price: c.price }))
      });
    } else if (hits.length) {
      unmatched.push({ ingredient: raw, candidates: hits.slice(0, 3).map((c) => ({ name: c.name, itemId: c.itemId, price: c.price })) });
    } else missing.push(raw);
  }
  // Weighted lines get a valid default weight (500g snapped up onto the item's
  // step) — an off-step weight would be silently dropped at write time.
  // No currency anywhere (venue record and market map both blank) -> no
  // prebuilt basket; add_to_cart then asks for one instead of guessing.
  const currency = resolveCurrency({ venue });
  const basket = lineItems.length && currency
    ? buildBasketBody(lineItems.map((li) => ({
        candidate: { itemId: li.itemId, name: li.name, price: li.price, isWeighted: !!li.isWeighted },
        count: 1,
        ...(li.isWeighted ? { grams: snapGrams(500, li.sellByWeight?.gramsPerStep) } : {})
      })), venue.venueId, currency)
    : null;
  // Warn only on cross-script mismatches: Latin-vs-Latin (English lines at a
  // German store) matches fine via Wolt's autotranslated indexes, and scripts
  // are all that text inspection can honestly tell apart.
  const offLanguage = catalogLanguage && isNonLatinLang(catalogLanguage)
    ? offScriptCount(ingredients, catalogLanguage)
    : 0;
  return {
    venue: { venueId: venue.venueId, slug: venue_slug, name: venue.name, currency: venue.currency, catalogLanguage },
    coverageCount: lineItems.length,
    cost: lineItems.reduce((s, li) => s + (li.price || 0), 0),
    searchErrors,
    ...(rateLimited ? { rateLimited: true } : {}),
    ...(offLanguage
      ? {
          retryInLanguage: catalogLanguage,
          languageNote: `${offLanguage} ingredient line(s) are not written in this store's catalog language ('${catalogLanguage}'). Scored matches for those lines can be wrong-category (e.g. 'brown rice' matching a ramen) — double-check them, and rewrite dubious lines in ${catalogLanguage} (translate them yourself) via plan_cart or search_products with venue_slug.`
        }
      : {}),
    lineItems, missing, unmatched, basket
  };
}

export function planResponse(plan, total) {
  const lowCoverage = plan.coverageCount < Math.ceil(total * 0.7);
  return {
    venue: plan.venue,
    coverage: `${plan.coverageCount}/${total}`,
    ...(plan.languageNote ? { languageNote: plan.languageNote, retryInLanguage: plan.retryInLanguage } : {}),
    ...(plan.searchErrors
      ? {
          searchErrors: plan.searchErrors,
          degradedNote: `${plan.searchErrors} ingredient search(es) failed${plan.rateLimited ? " (rate-limited)" : ""} — their absence is NOT evidence the store lacks them. Wait ~30s and retry those lines with venue_slug pinned.`
        }
      : {}),
    ...(lowCoverage ? { lowCoverage: true, coverageNote: "Coverage is LOW — tell the user what's missing and agree on a store or substitutions BEFORE writing any basket." } : {}),
    lineItems: plan.lineItems,
    missing: plan.missing,
    ...(plan.unmatched.length ? { unmatched: plan.unmatched, unmatchedNote: "The store returned these candidates but token scoring couldn't confirm them — judge each by meaning and add the good ones to the basket yourself (never a flavored/imitation substitute)." } : {}),
    basket: plan.basket,
    ...(!plan.basket && plan.lineItems.length
      ? { basketNote: "No currency on record for this venue — call add_to_cart with an explicit currency taken from search_products results." }
      : {}),
    ...(plan.missing.length ? { note: "Missing items may just be a phrasing miss — retry them in the store's catalog language and in dictionary form (singular nominative, as a shelf label reads; catalog search matches prefixes, so an inflected word finds little), or drop them." } : {})
  };
}
