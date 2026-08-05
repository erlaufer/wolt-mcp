// Token matching has to survive inflection without swallowing compounds:
// "2 sipulia" must reach "Sipuli", while "tomaatti" must NOT reach
// "tomaattisose" (paste). Those two pulls are in tension, so both directions
// are pinned here.
import assert from "node:assert";
import { tokensMatch, scoreMatch, rankCandidates } from "../mcp/lib/match.js";

// --- inflected forms must match their dictionary form ---
for (const [a, b, why] of [
  ["sipulia", "sipuli", "Finnish partitive"],
  ["spagettia", "spagetti", "Finnish partitive"],
  ["tomaattimurskaa", "tomaattimurska", "Finnish partitive, compound"],
  ["oliiviöljyä", "oliiviöljy", "Finnish partitive, non-ASCII"],
  ["sipulin", "sipuli", "Finnish genitive"],
  ["oliwy", "oliwa", "Polish, differing tails"],
  ["говядины", "говядина", "Russian genitive"],
  ["ζυμαρικών", "ζυμαρικά", "Greek genitive"],
  ["onions", "onion", "English plural"]
]) {
  assert(tokensMatch(a, b), `${why}: "${a}" should match "${b}"`);
  assert(tokensMatch(b, a) || tokensMatch(a, b), `${why}: at least one direction matches`);
}

// --- compounds and lookalikes must NOT match ---
for (const [a, b, why] of [
  ["tomaatti", "tomaattisose", "tomato vs tomato paste"],
  ["juusto", "juustokastike", "cheese vs cheese sauce"],
  ["riisi", "riisipiirakka", "rice vs rice pastry"],
  ["kerma", "kermaviili", "cream vs sour cream"],
  ["voi", "voide", "butter vs ointment (too short to guess)"],
  ["kala", "kalja", "fish vs beer"],
  ["maito", "maissi", "milk vs corn"],
  ["oil", "oliivi", "below the prefix floor"],
  // Deliberately out of reach: crossing languages this way was measured to
  // add wrong picks rather than right ones (see tokensMatch).
  ["parmesan", "parmesaani", "cross-language derivation is not attempted"]
]) {
  assert(!tokensMatch(a, b), `${why}: "${a}" must not match "${b}"`);
}

// --- scoring still prefers the plain product over a derivative ---
const plain = scoreMatch("parmesaani", "Parmesaani raaste 150g");
const sauce = scoreMatch("parmesaani", "Mutti parmesaani pastakastike 400g");
assert(plain > sauce, `plain product must outrank the sauce (${plain} vs ${sauce})`);

const realOnion = scoreMatch("sipuli", "Sipuli kotimainen pussi, 500g");
const onionCrisps = scoreMatch("sipuli", "Estrella sourcream & onion sipsipussi 275g");
assert(realOnion > onionCrisps, `real onions must outrank onion crisps (${realOnion} vs ${onionCrisps})`);

// --- an inflected line now finds its product at all ---
const hits = rankCandidates("sipulia", [
  { name: "Sipuli kotimainen pussi, 500g", price: 199 },
  { name: "Banaani", price: 99 }
]);
assert.equal(hits.length, 1, "the onion is found, the banana is not");
assert.match(hits[0].name, /Sipuli/);

console.log("match.test.mjs: inflection tolerated, compounds still rejected");
