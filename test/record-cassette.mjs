// Records the cassettes that test/replay.test.mjs plays back.
//
//   node test/record-cassette.mjs            # all markets
//   node test/record-cassette.mjs helsinki   # one
//
// Needs network but NO account: every call it makes is unauthenticated catalog
// traffic. Markets are public city centres, never the machine's own location,
// so the fixtures carry nothing about whoever recorded them. Re-record when
// Wolt's payload shapes change — not to chase catalog churn, since the
// assertions in the replay test are written to survive that.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// A throwaway state dir: the venue/language caches would otherwise satisfy
// lookups from disk and leave holes in the recording.
process.env.WOLT_STATE_DIR = mkdtempSync(join(tmpdir(), "wolt-cassette-"));

const { record } = await import("./cassette.mjs");
const { MARKETS, runPlanFlow } = await import("./plan-flow.mjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const wanted = process.argv.slice(2);
const markets = Object.keys(MARKETS).filter((m) => !wanted.length || wanted.includes(m));

for (const name of markets) {
  const market = MARKETS[name];
  const file = join(HERE, "fixtures", `${name}.cassette.json`);
  // Two markets can share a location bucket (helsinki / helsinki-fi), and the
  // venue+language caches live in one file keyed by slug — so without a wipe
  // the second market's lookups are served from disk and never recorded,
  // leaving holes that only surface as cassette misses much later.
  rmSync(join(process.env.WOLT_STATE_DIR, "slug-cache.json"), { force: true });

  const save = record(file, { market: name, note: market.note });
  const out = await runPlanFlow(market);
  const { count, bytes } = save();

  console.log(`${name}: ${count} requests, ${(bytes / 1024).toFixed(0)} KB -> ${file}`);
  console.log(`  market language: ${out.marketLanguage || "?"}  global candidates per ingredient: [${out.globalCandidates.join(", ")}]`);
  console.log(`  raced: ${out.shortlist.join(", ") || "none"}`);
  console.log(`  best: ${out.best?.venue.slug || "none"} coverage ${out.best?.coverageCount ?? 0}/${market.ingredients.length} currency ${out.best?.venue.currency || "?"}`);
}
