// Plans a whole shopping list against recorded catalogs — no account, no
// network, no catalog churn. This is the first coverage the planning path has
// that isn't gated on a live session: store racing, in-venue matching,
// catalog-language handling, currency resolution and basket assembly all run
// end to end here.
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
  const tape = replay(join(HERE, "fixtures", `${name}.cassette.json`), { strict: true });
  const out = await runPlanFlow(MARKETS[name]);
  assert.deepEqual(tape.misses, [], `${name}: requests not in the cassette — re-record`);
  tape.uninstall();
  return out;
};

// --- a Latin-script EUR market, English list ---
{
  const out = await play("helsinki");
  assert.equal(out.marketLanguage, "fi", "market language comes off the front feed");
  assert(out.shortlist.length >= 1, "at least one store raced");
  assert(out.best, "a winning plan");
  assert.equal(out.best.venue.catalogLanguage, "fi");
  assert(out.best.coverageCount >= 2, `covered ${out.best.coverageCount}/5`);
  assert.equal(out.best.venue.currency, "EUR", "currency resolved from the venue, not a default");
  assert.equal(out.best.basket.currency, "EUR");
  assert(isVenueObjectId(out.best.basket.venue_id), "basket carries a real venue id, never a slug");
  assert.equal(out.best.basket.items.length, out.best.coverageCount);
  // Latin-script list against a Latin-script catalog: no off-script warning.
  assert.equal(out.best.languageNote, undefined);
}

// --- a non-Latin catalog, list written in the catalog's language ---
{
  const out = await play("athens");
  assert.equal(out.marketLanguage, "el");
  assert.equal(out.best.venue.catalogLanguage, "el");
  assert.equal(out.best.coverageCount, 5, "a fully covered list");
  assert.equal(out.best.venue.currency, "EUR");
  assert.equal(out.best.basket.currency, "EUR");
  // In-language list, so no off-script warning and nothing to retranslate.
  assert.equal(out.best.languageNote, undefined);
  assert.equal(out.best.retryInLanguage, undefined);
  assert(out.weightConfigs instanceof Map && out.weightConfigs.size > 0, "weight configs resolved for the winning lines");
  for (const li of out.best.lineItems) assert(li.itemId && li.name && li.price > 0, `line looks real: ${JSON.stringify(li)}`);
}

// --- KNOWN DEFECT, pinned so a fix can't land unnoticed ---
// The same Helsinki list written the way Finnish is actually spoken —
// partitive ("2 sipulia"), not dictionary form ("sipuli") — finds NOTHING.
// Wolt's index matches prefixes, and match.js compares tokens for equality, so
// an inflected line misses on both sides. Live check behind these numbers:
// "sipuli" -> 198 items, "sipulia" -> 1. It affects every inflecting market
// (Finnish, Estonian, Hungarian, Polish, Czech, Greek…), i.e. most of Wolt.
//
// When query normalization or prefix-tolerant matching lands, these three
// assertions FAIL — that is the signal to flip them to the fixed numbers.
{
  const out = await play("helsinki-fi");
  assert.deepEqual(out.globalCandidates, [0, 0, 0, 0, 0], "inflected lines score no candidates anywhere");
  assert.deepEqual(out.shortlist, [], "so no store can even be raced");
  assert.equal(out.best, null, "and there is no plan to write");
}

// --- determinism: same cassette in, same plan out ---
{
  const a = await play("athens");
  const b = await play("athens");
  assert.equal(a.best.venue.slug, b.best.venue.slug);
  assert.deepEqual(a.best.lineItems.map((li) => li.itemId), b.best.lineItems.map((li) => li.itemId));
}

console.log("replay.test.mjs: planning replayed against 3 recorded markets");
