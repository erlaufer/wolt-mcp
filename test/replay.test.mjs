// Plans a whole shopping list against recorded catalogs — no account, no
// network, no catalog churn. This is the first coverage the planning path has
// that isn't gated on a live session: store racing, in-venue matching,
// catalog-language handling, currency resolution and basket assembly all run
// end to end here.
//
// Assertions are anchored on each market's PINNED store, whose request set
// depends only on the ingredient lines. The auto-race is exercised too, but
// not asserted item-by-item: a matching improvement legitimately changes which
// shops win, and a test that forbids that would just punish progress.
//
// Re-record with: node test/record-cassette.mjs
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.WOLT_STATE_DIR = mkdtempSync(join(tmpdir(), "wolt-replay-"));

// Proof, not intention: if any code path skipped the injected fetch and went
// out to the network, this throws instead of quietly making the suite depend
// on Wolt being up.
globalThis.fetch = () => { throw new Error("replay tests must not touch the network"); };

const { replay } = await import("./cassette.mjs");
const { MARKETS, runPlanFlow } = await import("./plan-flow.mjs");
const { isVenueObjectId } = await import("../mcp/lib/wolt.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const play = async (name) => {
  // Same reason as the recorder: a warm slug cache would skip requests and
  // make the second market's run diverge from what was recorded.
  rmSync(join(process.env.WOLT_STATE_DIR, "slug-cache.json"), { force: true });
  const tape = replay(join(HERE, "fixtures", `${name}.cassette.json`), { strict: false });
  const out = await runPlanFlow(MARKETS[name]);
  // A miss touching the pinned store means the cassette is genuinely
  // incomplete; a miss elsewhere is just the race visiting a different shop.
  const pinnedMisses = tape.misses.filter((k) => k.includes(MARKETS[name].pinnedVenue));
  assert.deepEqual(pinnedMisses, [], `${name}: pinned store not fully recorded — re-record`);
  tape.uninstall();
  return out;
};

// Every plan, in every market, must hold these regardless of catalog churn.
function assertPlanShape(name, plan, { language, ingredients }) {
  assert(plan, `${name}: a plan for the pinned store`);
  assert.equal(plan.venue.catalogLanguage, language, `${name}: catalog language`);
  assert.equal(plan.venue.currency, "EUR", `${name}: currency resolved from the venue, not a default`);
  if (plan.lineItems.length) {
    assert.equal(plan.basket.currency, "EUR");
    assert(isVenueObjectId(plan.basket.venue_id), `${name}: basket carries a real venue id, never a slug`);
    assert.equal(plan.basket.items.length, plan.lineItems.length);
    for (const li of plan.lineItems) assert(li.itemId && li.name && li.price > 0, `${name}: line looks real`);
  }
  assert.equal(plan.coverageCount + plan.missing.length + plan.unmatched.length, ingredients.length,
    `${name}: every requested line is accounted for as matched, missing or unmatched`);
}

// --- a Latin-script EUR market, English list ---
{
  const out = await play("helsinki");
  assert.equal(out.marketLanguage, "fi", "market language comes off the front feed");
  assert(out.shortlist.length >= 1, "at least one store raced");
  assertPlanShape("helsinki", out.pinnedPlan, { language: "fi", ingredients: MARKETS.helsinki.ingredients });
  // Latin-script list against a Latin-script catalog: no off-script warning.
  assert.equal(out.pinnedPlan.languageNote, undefined);
}

// --- a non-Latin catalog, list written in the catalog's language ---
{
  const out = await play("athens");
  assert.equal(out.marketLanguage, "el");
  assertPlanShape("athens", out.pinnedPlan, { language: "el", ingredients: MARKETS.athens.ingredients });
  assert.equal(out.pinnedPlan.coverageCount, 5, "an in-language list covers fully");
  // In-language, so nothing to warn about or retranslate.
  assert.equal(out.pinnedPlan.languageNote, undefined);
  assert.equal(out.pinnedPlan.retryInLanguage, undefined);
  assert(out.weightConfigs instanceof Map && out.weightConfigs.size > 0, "weight configs resolved for the winning lines");
}

// --- inflection: the same list, same store, two grammatical forms ---
// Both are Finnish and both are correct Finnish. The dictionary-form list is
// what a shelf label looks like; the inflected one is what a recipe says.
// Prefix-tolerant token matching closed most of the gap (this pairing scored
// 0/5 vs 5/5 before it), and what remains is what base-form guidance in the
// tool descriptions is there to close — Wolt's own index matches prefixes, so
// no amount of local scoring recovers a query the search never answered.
{
  const inflected = await play("helsinki-fi");
  const base = await play("helsinki-fi-base");
  assertPlanShape("helsinki-fi", inflected.pinnedPlan, { language: "fi", ingredients: MARKETS["helsinki-fi"].ingredients });
  assertPlanShape("helsinki-fi-base", base.pinnedPlan, { language: "fi", ingredients: MARKETS["helsinki-fi-base"].ingredients });
  assert.equal(base.pinnedPlan.coverageCount, 5, "dictionary form covers the whole list");
  assert(inflected.pinnedPlan.coverageCount >= 3,
    `inflected form must stay recoverable (was 1/5 before prefix matching, now ${inflected.pinnedPlan.coverageCount}/5)`);
  assert(inflected.pinnedPlan.coverageCount <= base.pinnedPlan.coverageCount,
    "dictionary form is never worse than the inflected form");
}

// --- determinism: same cassette in, same plan out ---
{
  const a = await play("athens");
  const b = await play("athens");
  assert.equal(a.pinnedPlan.venue.slug, b.pinnedPlan.venue.slug);
  assert.deepEqual(a.pinnedPlan.lineItems.map((li) => li.itemId), b.pinnedPlan.lineItems.map((li) => li.itemId));
}

console.log("replay.test.mjs: planning replayed against 4 recorded markets");
