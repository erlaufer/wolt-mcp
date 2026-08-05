// Token matching has to survive inflection without swallowing compounds:
// "2 sipulia" must reach "Sipuli", while "tomaatti" must NOT reach
// "tomaattisose" (paste). Those two pulls are in tension, so both directions
// are pinned here.
import assert from "node:assert";
import { tokensMatch, scoreMatch, rankCandidates, differentForm } from "../mcp/lib/match.js";

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

// --- form words: the flag that catches confident-and-wrong picks ---
// Scoring can't separate these from the real product, so they get named.
for (const [ingredient, candidate, word] of [
  ["parmesaani", "Mutti parmesaani pastakastike 400g", "kastike"],
  ["spagettia", "Piltti Spagettia ja jauhelihakastiketta 190g", "kastike"],
  ["parmezan", "Chipsy ziemniaczane o smaku sera parmezan, 90 g", "Chipsy"],
  ["ντομάτες", "Πέστο από Λιαστές Ντομάτες Bio 120gr", "Πέστο"],
  ["κρεμμύδια", "Τραγανά Κρεμμύδια σε βάζο 75gr", "Τραγανά"],
  ["tomato", "Tomato paste 200g", "paste"],
  ["onion", "Sourcream & Onion crisps 275g", "crisps"]
]) {
  const got = differentForm(ingredient, candidate);
  assert(got, `"${candidate}" should be flagged for "${ingredient}" (expected around "${word}")`);
}

// ...but a plain product, however wordy its packaging, must not be flagged:
// a flag that fires on everything trains the model to ignore it.
for (const [ingredient, candidate] of [
  ["sipuli", "Sipuli kotimainen pussi, 500g"],
  ["oliiviöljy", "Borges Classic oliiviöljy 500ml"],
  ["tomaattimurska", "Eldorado tomaattimurska 390g"],
  ["makaron", "Lubella Makaron spaghetti, 400 g"],
  ["ελαιόλαδο", "Ελαιόλαδο 250ml Γέρας"],
  // The line asked for the form itself, so naming it is not a surprise.
  ["tomato paste", "Mutti tomato paste 200g"],
  ["jauheliha", "Naudan jauheliha 400g"]
]) {
  assert.equal(differentForm(ingredient, candidate), null, `"${candidate}" must not be flagged for "${ingredient}"`);
}

console.log("match.test.mjs: inflection tolerated, compounds rejected, wrong forms flagged");
