// Order history + geocoding. Endpoints (live-verified):
//   GET consumer-api.wolt.com/order-tracking-api/v1/order_history/           (paginated)
//   GET consumer-api.wolt.com/order-tracking-api/v1/order_history/{purchaseId}
// Geocoding via Nominatim (OpenStreetMap) — requires a real
// User-Agent per their usage policy; Wolt-independent.
import { woltFetch } from "./http.js";

const ORDER_HISTORY_URL = "https://consumer-api.wolt.com/order-tracking-api/v1/order_history/";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

export async function getOrderHistory({ limit = 10, skip = 0 } = {}) {
  const r = await woltFetch(`${ORDER_HISTORY_URL}?limit=${limit}&skip=${skip}`);
  if (!r.ok) throw new Error(`order history failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
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
