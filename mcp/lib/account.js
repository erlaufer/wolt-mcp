// Order history + geocoding. Endpoints (live-verified):
//   GET consumer-api.wolt.com/order-tracking-api/v1/order_history/           (paginated)
//   GET consumer-api.wolt.com/order-tracking-api/v1/order_history/{purchaseId}
// Geocoding via Nominatim (OpenStreetMap) — requires a real
// User-Agent per their usage policy; Wolt-independent.
import { woltFetch } from "./http.js";

const ORDER_HISTORY_URL = "https://consumer-api.wolt.com/order-tracking-api/v1/order_history/";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

export async function getOrderHistory({ limit = 10, skip = 0, pageToken = null } = {}) {
  limit ??= 10;
  skip ??= 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("order history limit must be an integer from 1 to 100");
  if (!Number.isInteger(skip) || skip < 0 || skip > 1000) throw new Error("order history skip must be an integer from 0 to 1000; use page_token for later pages");
  if (pageToken != null && (typeof pageToken !== "string" || !pageToken.trim())) throw new Error("order history page_token must be a non-empty cursor from nextPageToken");
  if (pageToken && skip) throw new Error("use either page_token or skip for order history, not both");
  let cursor = pageToken, remaining = skip;
  const seen = new Set();
  for (;;) {
    // Wolt ignores skip. Walk its opaque cursor, requesting just enough
    // records so next_page_token follows the last record we actually return.
    const query = new URLSearchParams({ limit: String(Math.min(100, remaining + limit)) });
    if (cursor) query.set("page_token", cursor);
    const r = await woltFetch(`${ORDER_HISTORY_URL}?${query}`);
    if (!r.ok) throw new Error(`order history failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    if (r.json?.error_code != null) throw new Error(`order history failed: Wolt ${r.json.error_code}`);
    if (!Array.isArray(r.json?.orders)) throw new Error("order history returned no orders list; try again later");
    const j = r.json;
    if (!remaining || remaining < j.orders.length) return { ...j, orders: j.orders.slice(remaining, remaining + limit) };
    remaining -= j.orders.length;
    if (!j.orders.length || !j.next_page_token) return { ...j, orders: [], next_page_token: null };
    if (seen.has(j.next_page_token) || j.next_page_token === cursor) throw new Error("order history cursor did not advance; use a fresh first page");
    cursor = j.next_page_token;
    seen.add(cursor);
  }
}

export async function getOrder(purchaseId) {
  // GET order_history/purchase/{id}?tips_use_percentage=true (live-verified)
  const r = await woltFetch(`${ORDER_HISTORY_URL}purchase/${encodeURIComponent(purchaseId)}?tips_use_percentage=true`);
  if (!r.ok) throw new Error(`order fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

export async function geocodeAddress(address, { fetchImpl = fetch } = {}) {
  const url = `${NOMINATIM_URL}?format=json&limit=3&q=${encodeURIComponent(address)}`;
  const res = await fetchImpl(url, { headers: { "user-agent": "wolt-mcp/0.1 (+https://github.com/erlaufer/wolt-mcp)" } });
  if (!res.ok) throw new Error(`geocoding failed: HTTP ${res.status}`);
  const rows = await res.json();
  return rows.map((row) => ({
    lat: parseFloat(row.lat),
    lon: parseFloat(row.lon),
    label: row.display_name
  })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}
