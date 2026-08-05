// Unit tests for the pure planning rules in lib/plan.js: winner ranking with
// degraded-plan disqualification, and the translation preflight. Seeds a fake
// state dir so importing the module chain never touches real credentials.
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WOLT_STATE_DIR = mkdtempSync(join(tmpdir(), "wolt-plan-test-"));
const { rankPlans, translationPreflight, offScriptCount, planResponse } = await import("../mcp/lib/plan.js");

const plan = (over = {}) => ({
  venue: { venueId: "x", slug: "s", name: "n", currency: "EUR", catalogLanguage: "el" },
  coverageCount: 0, cost: 0, searchErrors: 0, lineItems: [], missing: [], unmatched: [], basket: null,
  ...over
});

// --- rankPlans: coverage beats cost; degraded plans can't win ---
let { best, allDegraded } = rankPlans([plan({ coverageCount: 5, cost: 900 }), plan({ coverageCount: 7, cost: 2000 })], 10);
assert.equal(best.coverageCount, 7, "coverage beats cost");
assert.equal(allDegraded, false);

// a half-degraded plan is disqualified even with the best coverage
({ best } = rankPlans([
  plan({ coverageCount: 9, searchErrors: 5 }), // 5 >= ceil(10/2) -> disqualified
  plan({ coverageCount: 6, searchErrors: 0 })
], 10));
assert.equal(best.coverageCount, 6, "degraded plan must not win");

// errors below the threshold don't disqualify
({ best } = rankPlans([
  plan({ coverageCount: 9, searchErrors: 4 }), // 4 < ceil(10/2) -> qualified
  plan({ coverageCount: 6 })
], 10));
assert.equal(best.coverageCount, 9, "sub-threshold errors keep a plan eligible");

// every plan degraded -> allDegraded, best still returned for inspection
({ best, allDegraded } = rankPlans([
  plan({ coverageCount: 2, searchErrors: 8 }),
  plan({ coverageCount: 1, searchErrors: 9, rateLimited: true })
], 10));
assert.equal(allDegraded, true, "all-degraded must be flagged");
assert(best, "best is still returned when all are degraded");

assert.deepEqual(rankPlans([], 10), { best: null, allDegraded: false }, "no plans");

// --- translationPreflight: hard stop only for mostly-off-script lists ---
const el = ["800 γρ. ντομάτες", "κρεμμύδι"];
const en = ["800 g tomatoes", "1 onion"];
assert.equal(translationPreflight(el, "el"), null, "on-script list passes");
assert.equal(translationPreflight(en, "de"), null, "latin catalog never preflights");
assert.equal(translationPreflight(en, null), null, "unknown language fails open");

const stop = translationPreflight(en, "el");
assert(stop?.needsTranslation, "off-script list is stopped");
assert.equal(stop.catalogLanguage, "el");
assert.equal(stop.offLanguageCount, 2);
assert.equal(stop.totalIngredients, 2);
assert(!("lineItems" in stop) && !("basket" in stop), "hard stop carries no plan payload");

// exactly half off-script is allowed through (threshold is >50%)
assert.equal(translationPreflight(["quinoa", "κρεμμύδι"], "el"), null, "50% mixed list plans normally");

assert.equal(offScriptCount(["MUTTI ντομάτες", "olive oil"], "el"), 1, "mixed-script line counts by any non-Latin run");

// --- planResponse: degraded plans say so; clean plans stay lean ---
let resp = planResponse(plan({ coverageCount: 9, searchErrors: 3, rateLimited: true, lineItems: Array(9).fill({}) }), 10);
assert.equal(resp.searchErrors, 3);
assert(resp.degradedNote.includes("rate-limited"), "degradedNote names the cause");
resp = planResponse(plan({ coverageCount: 9, lineItems: Array(9).fill({}) }), 10);
assert(!("searchErrors" in resp) && !("degradedNote" in resp), "clean plan carries no error fields");
resp = planResponse(plan({ coverageCount: 9, lineItems: Array(9).fill({}), languageNote: "x", retryInLanguage: "el" }), 10);
assert.equal(resp.retryInLanguage, "el", "structured retry language surfaces");

console.log("plan.test.mjs: all assertions passed");
