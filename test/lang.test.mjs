// Unit tests for the language/script helpers (pure logic, no network).
import { langOf, sameScript, isNonLatinLang } from "../mcp/lib/lang.js";

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// langOf: script -> app-language header
if (langOf("crushed tomatoes") !== "en") fail("latin -> en");
if (langOf("עגבניות מרוסקות") !== "he") fail("hebrew -> he");
if (langOf("طماطم مهروسة") !== "ar") fail("arabic -> ar");
if (langOf("томатная паста") !== "ru") fail("cyrillic -> ru");
if (langOf("ντομάτες") !== "el") fail("greek -> el");
if (langOf("პომიდორი") !== "ka") fail("georgian -> ka");
if (langOf("トマト") !== "ja") fail("japanese -> ja");
if (langOf("") !== "en") fail("empty -> en");
if (langOf("800 גרם עגבניות") !== "he") fail("mixed digits+hebrew -> he");

// isNonLatinLang: which catalog languages warrant off-script warnings
if (!isNonLatinLang("he") || !isNonLatinLang("ka") || !isNonLatinLang("el") || !isNonLatinLang("ja")) fail("non-latin catalogs");
if (!isNonLatinLang("kk")) fail("kazakh is cyrillic-script");
if (isNonLatinLang("en") || isNonLatinLang("de") || isNonLatinLang("fi") || isNonLatinLang(null) || isNonLatinLang("")) fail("latin/unknown catalogs");

// sameScript: is the text written in the catalog language's script?
if (sameScript("crushed tomatoes", "el")) fail("english text vs greek catalog");
if (!sameScript("ντομάτες", "el")) fail("greek text vs greek catalog");
if (!sameScript("עגבניות מרוסקות", "he")) fail("hebrew text vs hebrew catalog");
if (!sameScript("crushed tomatoes", "de")) fail("latin text vs latin catalog");
if (!sameScript("crushed tomatoes", "en")) fail("latin text vs english catalog");
if (sameScript("томат", "ka")) fail("cyrillic text vs georgian catalog");
if (!sameScript("томат", "kk")) fail("cyrillic text vs kazakh catalog (same script)");
if (sameScript("トマト", "de")) fail("japanese text vs latin catalog");
if (!sameScript("1 kg tomatoes", null)) fail("latin text vs unknown catalog language");

console.log("✓ lang tests passed");
