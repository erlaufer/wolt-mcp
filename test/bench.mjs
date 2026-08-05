// Scores match quality against the recorded catalogs, and reports the delta
// against the last saved baseline.
//
//   node test/bench.mjs           # score, compare to test/benchmarks/baseline.json
//   node test/bench.mjs --save    # score and adopt the result as the new baseline
//
// Why a score and not a pass/fail: coverage is the number the tool reports,
// and coverage lies. A run can fill 5 of 5 lines while putting sun-dried
// tomato pesto where tomatoes belong. What matters to a user is how much of
// the list came back RIGHT, and how often the basket got something actively
// wrong — so those are what this measures.
//
//   coverage  lines the planner filled            (what plan_cart claims)
//   correct   filled lines that are the ingredient (accept, and not reject)
//   traps     filled lines that are the WRONG THING — a sauce, a snack, a
//             derivative, a non-food lookalike. Worse than a missing line,
//             because the user is told it's handled.
//   score     correct / requested — the honest fraction of the list
//
// Ground truth is by name pattern rather than item id so it survives
// re-recording: the rules encode "what counts as this ingredient", which
// doesn't change when a shop restocks.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.WOLT_STATE_DIR = mkdtempSync(join(tmpdir(), "wolt-bench-"));
globalThis.fetch = () => { throw new Error("bench must not touch the network"); };

const { replay } = await import("./cassette.mjs");
const { MARKETS, runPlanFlow } = await import("./plan-flow.mjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "benchmarks", "baseline.json");

// --- ground truth, in ingredient order per market -------------------------
// Applies to every line: a snack flavoured with the ingredient is never the
// ingredient. Onion crisps match "onion" perfectly on tokens, which is exactly
// the confident-and-wrong pick a user would find in their basket.
const JUNK = /(sipsi|lastu|crisps|chips|snack|popcorn|keksi|makeis|jäätel|ice.?cream|vauva|piltti|τσιπς|σνακ|παγωτ)/i;

const RULES = {
  helsinki: [
    { accept: /spag(h)?etti/i, reject: /(kastike|sauce|valmis|ateria|keitto|soup)/i },
    { accept: /(crushed tomato|chopped tomato|tomaattimurska|murskatut tomaatit)/i, reject: /(paste|sose|pyree|ketchup|ketsuppi|juice|mehu|pesto|kastike|sauce|soup|keitto)/i },
    { accept: /(parmesan|parmigiano|parmesaani|grana padano)/i, reject: /(kastike|sauce|pesto|sipsi|crisps|snack|popcorn)/i },
    { accept: /(onion|sipuli)/i, reject: /(fried|paistett|rapea|crispy|rings|renkaat|jauhe|powder|kastike|sauce|keitto|soup|säilyke|pickled|purkki|jar)/i },
    { accept: /(olive oil|oliiviöljy)/i, reject: /(glass|lasi|saippua|soap|levite|spread|snack|olives|oliivit)/i }
  ],
  // Held-out market — rules written from what the ingredients mean, before
  // looking at what the planner picked.
  warsaw: [
    { accept: /(makaron|spaghetti|spagetti|penne)/i, reject: /(sos|zupa|danie|krem)/i },
    { accept: /pomidor/i, reject: /(przecier|koncentrat|sos|ketchup|zupa|pesto|suszon|sok|krem)/i },
    { accept: /(parmezan|parmigiano|grana padano)/i, reject: /(sos|pesto|krem)/i },
    { accept: /cebul/i, reject: /(prażon|zupa|proszek|sos|marynowan|suszon|krem)/i },
    { accept: /oliw/i, reject: /(mydł|spray|krem)/i }
  ],
  athens: [
    { accept: /(ζυμαρικ|μακαρόν|σπαγγέτ)/i, reject: /(σάλτσα|πέστο|σούπα|έτοιμ)/i },
    { accept: /(ντομάτ|τομάτ)/i, reject: /(πέστο|σάλτσα|χυμ|κέτσαπ|λιαστ|σούπα|πουρέ|πελτέ)/i },
    { accept: /(παρμεζάν|parmigiano|grana padano)/i, reject: /(σάλτσα|πέστο|κρέμα|σνακ)/i },
    { accept: /κρεμμύδ/i, reject: /(τραγαν|τηγανητ|σκόνη|βάζο|crispy|fried|σούπα|μαρινά)/i },
    { accept: /ελαιόλαδο/i, reject: /(σαπούν|soap|σπρέι)/i }
  ]
};
// The two Finnish lists are the same products, so they share one rule set.
RULES["helsinki-fi"] = [
  { accept: /spagetti/i, reject: /(kastike|valmis|ateria|keitto|purkki)/i },
  { accept: /(tomaattimurska|murskatut tomaatit)/i, reject: /(sose|pyree|ketsuppi|mehu|kastike|keitto|pesto)/i },
  { accept: /(parmesaani|parmigiano|parmesan|grana padano)/i, reject: /(kastike|pesto|sipsi|snack)/i },
  { accept: /sipuli/i, reject: /(paistett|rapea|crispy|jauhe|kastike|keitto|säilyke|purkki|marinoi)/i },
  { accept: /oliiviöljy/i, reject: /(saippua|levite|spray|lasi)/i }
];
RULES["helsinki-fi-base"] = RULES["helsinki-fi"];

// --- run -------------------------------------------------------------------
const results = {};
const detail = [];

for (const [name, market] of Object.entries(MARKETS)) {
  rmSync(join(process.env.WOLT_STATE_DIR, "slug-cache.json"), { force: true });
  const tape = replay(join(HERE, "fixtures", `${name}.cassette.json`), { strict: true });
  const out = await runPlanFlow(market);
  tape.uninstall();

  const plan = out.pinnedPlan;
  const rules = RULES[name];
  const total = market.ingredients.length;
  let correct = 0, traps = 0, trapsFlagged = 0, falseAlarms = 0;

  for (const li of plan?.lineItems || []) {
    const i = market.ingredients.indexOf(li.ingredient);
    const rule = rules[i];
    const bad = rule.reject.test(li.name) || JUNK.test(li.name);
    const good = rule.accept.test(li.name) && !bad;
    const flagged = li.confidence === "low";
    if (good) correct++;
    if (bad) traps++;
    // Does the plan's own confidence flag find the wrong picks, and how often
    // does it cry wolf over a good one? A flag nobody can trust is worse than
    // no flag: it trains the model to ignore it.
    if (bad && flagged) trapsFlagged++;
    if (good && flagged) falseAlarms++;
    detail.push([name, li.ingredient, good ? "ok  " : bad ? "TRAP" : "miss", (flagged ? "[flagged] " : "") + li.name.slice(0, 46)]);
  }
  for (const m of plan?.missing || []) detail.push([name, m, "--  ", "(no match)"]);

  results[name] = {
    venue: market.pinnedVenue,
    requested: total,
    coverage: plan?.lineItems.length ?? 0,
    correct,
    traps,
    trapsFlagged,
    falseAlarms,
    unmatched: plan?.unmatched.length ?? 0,
    score: Number((correct / total).toFixed(3))
  };
}

const sum = (k) => Object.values(results).reduce((s, r) => s + r[k], 0);
const overall = {
  score: Number((Object.values(results).reduce((s, r) => s + r.score, 0) / Object.keys(results).length).toFixed(3)),
  traps: sum("traps"),
  trapsFlagged: sum("trapsFlagged"),
  falseAlarms: sum("falseAlarms")
};

// --- report ----------------------------------------------------------------
let base = null;
try { base = JSON.parse(readFileSync(BASELINE, "utf8")); } catch (e) {}
const delta = (now, then) => (then == null ? "" : now === then ? "  =" : `${now > then ? " +" : " "}${Number((now - then).toFixed(3))}`);

console.log("\nper-line picks");
for (const [market, ing, verdict, name] of detail) console.log(`  ${verdict}  ${market.padEnd(17)} ${ing.slice(0, 26).padEnd(27)} ${name}`);

console.log("\nmarket             store                        cover  correct  traps   score");
for (const [name, r] of Object.entries(results)) {
  const b = base?.markets?.[name];
  console.log(
    `  ${name.padEnd(17)} ${String(r.venue).slice(0, 27).padEnd(28)} ${String(r.coverage).padStart(2)}/${r.requested}` +
    `   ${String(r.correct).padStart(2)}/${r.requested}` +
    `   ${String(r.traps).padStart(2)}${delta(r.traps, b?.traps).padStart(5)}` +
    `   ${r.score.toFixed(2)}${delta(r.score, b?.score).padStart(7)}`
  );
}
console.log(`\n  OVERALL score ${overall.score.toFixed(3)}${delta(overall.score, base?.overall?.score)}   traps ${overall.traps}${delta(overall.traps, base?.overall?.traps)}`);
console.log(`  confidence flag: caught ${overall.trapsFlagged}/${overall.traps} wrong picks, cried wolf on ${overall.falseAlarms}/${sum("correct")} good ones`);
if (!base) console.log("  (no baseline yet — run with --save to record one)");

if (process.argv.includes("--save")) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify({ markets: results, overall }, null, 2) + "\n");
  console.log(`\n  saved baseline -> ${BASELINE}`);
}
