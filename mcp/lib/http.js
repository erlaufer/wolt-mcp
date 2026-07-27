// Authed fetch against Wolt's APIs with production-grade recovery
// behavior: refresh-and-retry once on 401, and honor Retry-After on 429/5xx with a
// single delayed retry. All authed MCP tools go through this.
import { getAccessToken, refreshAccessToken } from "./auth.js";
import { woltHeaders } from "./headers.js";

const MAX_RETRY_AFTER_MS = 15000;

function retryAfterMs(res) {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { ok, status, json, text }. Throws only on missing-token (with the
// user-facing setup guidance from auth.js) or network-level failure.
export async function woltFetch(url, { method = "GET", body = null, lang = "en", fetchImpl = fetch } = {}) {
  const doFetch = async (token) => fetchImpl(url, {
    method,
    headers: woltHeaders({ token, json: body != null, lang }),
    body: body != null ? JSON.stringify(body) : undefined
  });

  let token = await getAccessToken();
  let res = await doFetch(token);

  if (res.status === 401) {
    token = await refreshAccessToken(); // throws with paste guidance if the chain is dead
    res = await doFetch(token);
  }

  if (res.status === 429 || res.status >= 500) {
    const wait = retryAfterMs(res);
    if (wait != null) {
      await sleep(wait);
      res = await doFetch(token);
    }
  }

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { ok: res.ok, status: res.status, json, text };
}
