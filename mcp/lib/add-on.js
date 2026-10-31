// Wolt's time-limited multi-venue offer, scoped to an existing purchase.
import { woltFetch } from "./http.js";

export async function getAddOnOptions(purchaseId, now = Date.now()) {
  const r = await woltFetch(`https://consumer-api.wolt.com/order-xp/v1/pages/multi-venue-ordering/${encodeURIComponent(purchaseId)}`);
  if (!r.ok) throw new Error(`could not check add-on eligibility: HTTP ${r.status}`);
  const j = r.json || {};
  const expiresAt = Number(j.expiry?.expiry_timestamp) * 1000;
  const context = j.purchase_context || {};
  return {
    parentPurchaseId: purchaseId,
    eligible: Number.isFinite(expiresAt) && expiresAt > now && !!context.delivery_drop_off_id && (j.venues || []).length > 0,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    secondsRemaining: Number.isFinite(expiresAt) ? Math.max(0, Math.floor((expiresAt - now) / 1000)) : 0,
    addressId: context.delivery_drop_off_id || null,
    parentVenueId: context.venue_id || null,
    noContactDelivery: !!context.is_ncd,
    title: j.banner?.title || null,
    terms: (j.bottom_sheet?.sections || []).map((s) => s.body).filter(Boolean),
    disclaimer: j.bottom_sheet?.footer || null,
    venues: (j.venues || []).map((v) => ({ venueId: v.id, name: v.name, slug: v.slug, imageUrl: v.image?.url || null, productLine: v.product_line || null }))
  };
}

export function requireAddOn(options, venueId, addressId, now = Date.now()) {
  if (!options.eligible || options.expiresAt <= now) throw new Error("the add-on offer expired or is unavailable; request a fresh standalone quote and confirm its total");
  if (!options.venues.some((v) => v.venueId === venueId) || venueId === options.parentVenueId) throw new Error("this venue is not eligible for the parent order's add-on offer");
  if (addressId !== options.addressId) throw new Error("an add-on order must use the same saved address as the parent order");
}
