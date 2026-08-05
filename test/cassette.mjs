// HTTP cassettes: record Wolt's real responses once, replay them forever.
//
// Why this exists: every test that touches a catalog is otherwise gated on a
// live account, a network round trip, and a catalog that changes hourly — so
// the planning path (the part that decides which store wins and which product
// matches) has no deterministic coverage at all. A cassette turns it into a
// pure function of a JSON file, which is also the substrate the agent evals
// need: hand-edit a recorded catalog to plant an imitation product next to the
// real one and you have a repeatable trap to grade a model against.
//
// Two safety rules, both enforced here rather than by convention:
//
//  1. RECORDING IS CATALOG-ONLY. Account endpoints (profile, baskets, orders,
//     auth, geocoding, IP lookup) are refused outright, so a cassette can
//     never contain someone's name, address, order history or tokens. There is
//     nothing to redact if it was never recorded.
//  2. NOTHING PERSONAL IN, NOTHING PERSONAL OUT. save() scans the serialized
//     cassette for bearer tokens, token fields and email addresses, and throws
//     rather than write a file that carries them.
//
// Replay is strict: an unmatched request throws instead of falling through to
// the network, so a new code path can't quietly start making live calls in CI.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { setFetchImpl } from "../mcp/lib/http.js";

// Catalog surface: venue metadata, assortments, in-venue search, global
// search, feed. Everything else is refused while recording.
const RECORDABLE = [
  /^https:\/\/restaurant-api\.wolt\.com\/v1\/pages\/search$/,
  /^https:\/\/consumer-api\.wolt\.com\/consumer-api\/consumer-assortment\/v1\/venues\/slug\//,
  /^https:\/\/consumer-api\.wolt\.com\/order-xp\/web\/v1\/pages\/venue\//,
  /^https:\/\/consumer-api\.wolt\.com\/v1\/pages\/front/
];

const isRecordable = (url) => RECORDABLE.some((re) => re.test(String(url).split("?")[0]));

// Stable request key: method + path + sorted query + a hash of the body, so
// the same logical call matches regardless of key or param ordering.
const stableStringify = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
};

export function keyOf(url, init = {}) {
  const u = new URL(String(url));
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const method = (init.method || "GET").toUpperCase();
  let bodyPart = "";
  if (init.body) {
    let parsed = null;
    try { parsed = JSON.parse(init.body); } catch (e) { parsed = String(init.body); }
    bodyPart = createHash("sha256").update(stableStringify(parsed)).digest("hex").slice(0, 12);
  }
  return `${method} ${u.origin}${u.pathname}?${params.map(([k, v]) => `${k}=${v}`).join("&")}|${bodyPart}`;
}

// Full grocery assortments run to megabytes of catalog that no test reads —
// only the language and a sample of the tree matter. Pruned on the way in so
// fixtures stay small enough to commit and readable enough to hand-edit.
// Presentation and telemetry fields the client never reads: ~95% of the bytes
// in a raw Wolt payload, and blurhashes in particular ("…-@NGbckCoJax.AR*…")
// read as email addresses to the leak scan. Dropping them keeps fixtures small
// enough to commit and small enough to hand-edit, which is the point — an
// adversarial catalog is a fixture with one product changed.
const DROP_KEYS = new Set([
  "blurhash", "image", "images", "photo", "photos", "icon", "banner", "background_image",
  "description", "advertising_metadata", "advertising", "tracking_id", "analytics",
  "telemetry", "template", "overlay", "badges", "sorting", "filtering"
]);
const TRUNCATE_ARRAYS = new Set(["items", "results", "sections", "categories"]);
const MAX_ARRAY = 25; // wide enough that venue ranking sees the real candidate set

function prune(node) {
  if (Array.isArray(node)) { node.forEach(prune); return node; }
  if (!node || typeof node !== "object") return node;
  for (const [k, v] of Object.entries(node)) {
    if (DROP_KEYS.has(k)) { delete node[k]; continue; }
    if (Array.isArray(v) && TRUNCATE_ARRAYS.has(k) && v.length > MAX_ARRAY) node[k] = v.slice(0, MAX_ARRAY);
    prune(node[k]);
  }
  return node;
}

function shrink(url, json) {
  if (!json || typeof json !== "object") return json;
  const path = String(url).split("?")[0];
  // The city front page is 700 KB of homepage carousel, of which the server
  // reads two fields: the first non-restaurant venue's slug, to learn the
  // market's catalog language. Projected rather than pruned.
  if (/\/v1\/pages\/front$/.test(path)) {
    return {
      _projected: "venue slug + product_line only (getMarketLanguage reads nothing else)",
      sections: (json.sections || []).map((s) => ({
        items: (s.items || [])
          .filter((it) => it.venue?.slug)
          .map((it) => ({ venue: { slug: it.venue.slug, product_line: it.venue.product_line } }))
      })).filter((s) => s.items.length)
    };
  }
  prune(json);
  // Venue pages carry the shop's own contact details. Public business info,
  // but no test reads it and it trips the leak scan below — drop it.
  if (/\/pages\/venue\//.test(path)) {
    for (const v of [json.venue, ...(Array.isArray(json.venues) ? json.venues : [])]) {
      if (v && typeof v === "object") { delete v.email; delete v.phone; delete v.contact_email; delete v.contact_phone; }
    }
  }
  if (!/\/assortment$/.test(path)) return json;
  const out = { ...json, _pruned: "items/categories truncated by test/cassette.mjs" };
  if (Array.isArray(out.items)) out.items = out.items.slice(0, 40);
  if (Array.isArray(out.categories)) out.categories = out.categories.slice(0, 40);
  return out;
}

const mkResponse = (entry) => ({
  ok: entry.status >= 200 && entry.status < 300,
  status: entry.status,
  headers: { get: (h) => (h.toLowerCase() === "content-type" ? entry.contentType || "application/json" : null) },
  text: async () => (typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body)),
  json: async () => (typeof entry.body === "string" ? JSON.parse(entry.body) : entry.body)
});

// --- recording -------------------------------------------------------------

// Installs a recording fetch and returns save(). Real requests still go out;
// their responses are captured on the way back.
export function record(file, { market = null, note = null, paceMs = 150 } = {}) {
  const entries = new Map();
  let nextAt = 0;
  setFetchImpl(async (url, init = {}) => {
    if (!isRecordable(url)) {
      throw new Error(`cassette: refusing to record ${String(url).split("?")[0]} — cassettes are catalog-only, never account data`);
    }
    // Installing a hook disables the server's own pacing, and a recording run
    // is exactly the wide fan-out that trips Wolt's limits — so pace it here.
    const wait = nextAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextAt = Date.now() + paceMs;
    const res = await fetch(url, init);
    const text = await res.text();
    const contentType = res.headers.get("content-type") || "";
    let body = text;
    if (contentType.includes("json")) { try { body = shrink(url, JSON.parse(text)); } catch (e) {} }
    entries.set(keyOf(url, init), { key: keyOf(url, init), method: (init.method || "GET").toUpperCase(), url: String(url), status: res.status, contentType, body });
    return mkResponse({ status: res.status, contentType, body });
  });

  return function save() {
    setFetchImpl(null);
    const cassette = { market, note, recordedBy: "test/cassette.mjs", entries: [...entries.values()] };
    const json = JSON.stringify(cassette, null, 1);
    // Secrets are reported by name only; the email rule shows a masked sample
    // because that one is usually a shop's public address and the operator
    // needs to see which field to prune.
    const leaks = [];
    for (const [re, what, sample] of [
      [/Bearer\s+[A-Za-z0-9._-]{20,}/, "a bearer token", false],
      [/"(access|refresh)_token"/, "a token field", false],
      // Lowercase TLD required: uppercase-looking "@…" runs are base64 noise,
      // not addresses (see stripBlurhashes above).
      [/[\w.+-]+@[\w-]+\.[a-z]{2,24}\b/, "an email address", true]
    ]) {
      const m = json.match(re);
      if (!m) continue;
      // Context for the email rule only: it catches base64-ish blobs too, and
      // without the surrounding field name there's no way to tell a real
      // address from a false positive.
      const ctx = sample ? ` in …${json.slice(Math.max(0, m.index - 60), m.index + m[0].length + 10).replace(/^[^@]*?([\w".:/-]{0,60})$/, "$1")}…` : "";
      leaks.push(sample ? `${what} (${m[0].replace(/^[^@]+/, "***")})${ctx}` : what);
    }
    if (leaks.length) throw new Error(`cassette: refusing to write ${file} — it contains ${leaks.join(", ")}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, json);
    return { file, count: entries.size, bytes: json.length };
  };
}

// --- replay ----------------------------------------------------------------

// Installs a replaying fetch. Returns { misses, unused, uninstall }.
export function replay(file, { strict = true } = {}) {
  const cassette = JSON.parse(readFileSync(file, "utf8"));
  const byKey = new Map(cassette.entries.map((e) => [e.key, e]));
  const seen = new Set();
  const misses = [];
  setFetchImpl(async (url, init = {}) => {
    const key = keyOf(url, init);
    const entry = byKey.get(key);
    if (!entry) {
      misses.push(key);
      if (strict) throw new Error(`cassette miss: ${key}\n  (re-record with: node test/record-cassette.mjs)`);
      return mkResponse({ status: 599, contentType: "application/json", body: { error: "cassette miss" } });
    }
    seen.add(key);
    return mkResponse(entry);
  });
  return {
    market: cassette.market,
    misses,
    unused: () => [...byKey.keys()].filter((k) => !seen.has(k)),
    uninstall: () => setFetchImpl(null)
  };
}
