// Fetch against Wolt's APIs with production-grade recovery behavior:
// refresh-and-retry once on 401, honor Retry-After on 429/5xx, and a default
// backoff ladder for 429s that carry no Retry-After (Wolt often omits it).
// All MCP tools go through this; auth: false skips the token chain entirely
// for endpoints that don't need one (search, assortment, feed).
//
// A module-level limiter caps the whole process's request rate. Central beats
// per-call-site pool tuning because the fan-outs are nested (venues ×
// ingredients × retry-searches) and any future tool re-multiplies them. On any
// 429 the WHOLE fleet pauses (shared cooldown), not just the one request.
import { getAccessToken, refreshAccessToken } from "./auth.js";
import { woltHeaders } from "./headers.js";

// Tuning knobs — one-line adjustable after live observation.
const MAX_CONCURRENT = 6;      // in-flight request cap
const MIN_GAP_MS = 80;         // min gap between request starts (~12.5 rps)
const RETRY_429_MS = [1000, 2500]; // backoff ladder when Retry-After is absent
const JITTER_MS = 300;         // random 0..JITTER added to each backoff
const MAX_RETRY_AFTER_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let inFlight = 0;
let nextStartAt = 0;
let pausedUntil = 0;

// A process-wide fetch override, for cassette record/replay in tests. Every
// Wolt request in the server funnels through here, so installing one hook
// captures (or serves) all of them — no per-call-site plumbing. While a hook
// is installed the pacing sleeps are skipped: a replay talks to a JSON file,
// so real-world spacing would only add dead time and timer nondeterminism.
let injectedFetch = null;
export function setFetchImpl(fn) { injectedFetch = fn || null; }

async function acquire() {
  if (injectedFetch) { inFlight++; return; }
  for (;;) {
    const now = Date.now();
    const wait = Math.max(nextStartAt - now, pausedUntil - now, 0);
    if (wait === 0 && inFlight < MAX_CONCURRENT) {
      inFlight++;
      nextStartAt = Date.now() + MIN_GAP_MS;
      return;
    }
    await sleep(Math.max(wait, 15));
  }
}

function retryAfterMs(res) {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS) : null;
}

// Returns { ok, status, json, text }. Throws only on missing-token (with the
// user-facing setup guidance from auth.js) or network-level failure.
// retry429Ms is injectable so tests don't sleep through real backoffs.
export async function woltFetch(url, { method = "GET", body = null, lang = "en", auth = true, fetchImpl = null, retry429Ms = RETRY_429_MS } = {}) {
  const impl = fetchImpl || injectedFetch || fetch;
  const doFetch = async (token) => {
    await acquire();
    try {
      return await impl(url, {
        method,
        headers: woltHeaders({ token, json: body != null, lang }),
        body: body != null ? JSON.stringify(body) : undefined
      });
    } finally { inFlight--; }
  };

  let token = auth ? await getAccessToken() : null;
  let res = await doFetch(token);

  if (auth && res.status === 401) {
    token = await refreshAccessToken(); // throws with paste guidance if the chain is dead
    res = await doFetch(token);
  }

  // Retry-After (when present) is honored once, as before; 429s without it get
  // the default ladder. Past that, the honest failure beats silent waiting.
  let honoredRetryAfter = false;
  let attempt429 = 0;
  while (res.status === 429 || res.status >= 500) {
    const ra = retryAfterMs(res);
    let wait = null;
    if (ra != null && !honoredRetryAfter) { wait = ra; honoredRetryAfter = true; }
    else if (res.status === 429 && attempt429 < retry429Ms.length) {
      wait = retry429Ms[attempt429++] + Math.floor(Math.random() * JITTER_MS);
    }
    if (wait == null) break;
    pausedUntil = Math.max(pausedUntil, Date.now() + wait); // fleet-wide cooldown
    await sleep(wait);
    res = await doFetch(token);
  }
  // Exhausted retries on a 429: still hold the fleet briefly so sibling
  // requests don't keep hammering into the same limit.
  if (res.status === 429) pausedUntil = Math.max(pausedUntil, Date.now() + (retry429Ms[0] ?? 1000));

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { ok: res.ok, status: res.status, json, text };
}
