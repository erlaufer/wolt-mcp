// Language/script detection for queries and catalogs.
//
// Wolt indexes each venue's catalog in its primary language (reported as
// primary_language on the assortment payload). This server never translates —
// the MCP client's model does — so this module only answers two questions:
// (1) which app-language header matches the script a query is written in, and
// (2) is a query written in the same script as a catalog language.
//
// Script granularity is deliberate: Latin-script languages (German, Finnish,
// Danish …) can't be told apart by inspection, and don't need to be — Wolt
// keeps autotranslated English indexes that match Latin-script queries fine.
// It's cross-script mismatches (English lines against a Greek, Japanese,
// Kazakh, Hebrew or Georgian catalog) that produce garbage matches.
const SCRIPTS = [
  { re: /[֐-׿]/, lang: "he", written: ["he"] },
  { re: /[؀-ۿ]/, lang: "ar", written: ["ar"] },
  { re: /[Ѐ-ӿ]/, lang: "ru", written: ["ru", "uk", "be", "kk", "ky", "bg", "sr", "mk"] },
  { re: /[Ͱ-Ͽ]/, lang: "el", written: ["el"] },
  { re: /[Ⴀ-ჿ]/, lang: "ka", written: ["ka"] },
  { re: /[぀-ヿ㐀-鿿]/, lang: "ja", written: ["ja"] }
];

// The Wolt-market language a piece of text is written in, judged by script
// ("en" for anything Latin). Used as the app-language header so result names
// come back in the same language as the query instead of machine-translated.
export const langOf = (s) => SCRIPTS.find(({ re }) => re.test(String(s)))?.lang || "en";

// Is this catalog language written in a non-Latin script? (The only catalogs
// where off-script queries are worth warning about.)
export const isNonLatinLang = (lang) => SCRIPTS.some(({ written }) => written.includes(String(lang || "")));

// Is `text` written in the same script as language `lang`? Latin on both sides
// counts as a match.
export function sameScript(text, lang) {
  const textIdx = SCRIPTS.findIndex(({ re }) => re.test(String(text)));
  const langIdx = SCRIPTS.findIndex(({ written }) => written.includes(String(lang || "")));
  return textIdx === langIdx;
}
