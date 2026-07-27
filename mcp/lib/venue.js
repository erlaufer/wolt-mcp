// Venue detail, menu browsing, and dish options — the in-venue layer
// ("venue / menu / item"). Live-verified shapes:
//   static page: venue { id, name, rating, opening_times_schedule[{day,
//     formatted_times}], currency, country, timezone, product_line, address … }
//   assortment: { categories[{id,name,slug,items|item_ids}], items[{id,name,
//     price, description, options[{id, option_id, name, multi_choice_config}]}],
//     options[{id,name,type,values[{id,name,price}]}] }
// Required option group: multi_choice_config.total_range.min > 0.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { woltFetch } from "./http.js";
import { rankCandidates } from "./match.js";

const VENUE_STATIC_BASE = "https://consumer-api.wolt.com/order-xp/web/v1/pages/venue/slug/";
const ASSORTMENT_BASE = "https://consumer-api.wolt.com/consumer-api/consumer-assortment/v1/venues/slug/";

// --- slug cache: 24h TTL, big win on warm repeat venue lookups ---
const CACHE_FILE = join(process.env.WOLT_STATE_DIR || join(homedir(), ".wolt-mcp"), "slug-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheGet(slug) {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    const hit = c[slug];
    return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.venue : null;
  } catch (e) { return null; }
}

function cachePut(slug, venue) {
  let c = {};
  try { c = JSON.parse(readFileSync(CACHE_FILE, "utf8")); } catch (e) {}
  c[slug] = { at: Date.now(), venue };
  try {
    mkdirSync(join(CACHE_FILE, ".."), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch (e) {}
}

// Venue detail from the static page (cached 24h).
export async function getVenue(slug) {
  const cached = cacheGet(slug);
  if (cached) return cached;
  const r = await woltFetch(`${VENUE_STATIC_BASE}${slug}/static`);
  if (!r.ok) throw new Error(`venue fetch failed for "${slug}": HTTP ${r.status}`);
  const v = r.json?.venue || {};
  const venue = {
    venueId: v.id,
    slug,
    name: v.name,
    description: v.description || null,
    rating: v.rating?.rating ?? v.rating ?? null,
    address: [v.address, v.city].filter(Boolean).join(", ") || null,
    country: v.country || null,
    currency: v.currency || null,
    timezone: v.timezone || null,
    productLine: v.product_line || null,
    deliveryMethods: v.delivery_methods || null,
    deliveryBasePrice: v.delivery_base_price ?? null,
    openingTimes: (v.opening_times_schedule || []).map((d) => ({ day: d.day, times: d.formatted_times })),
    website: v.website || null,
    phone: v.phone || null
  };
  cachePut(slug, venue);
  return venue;
}

async function getAssortment(slug) {
  const r = await woltFetch(`${ASSORTMENT_BASE}${slug}/assortment`);
  if (!r.ok) throw new Error(`menu fetch failed for "${slug}": HTTP ${r.status}`);
  return r.json || {};
}

// Parse a Wolt item URL: .../venue/<slug>/itemid-<id>, menuitem-<id>, or
// ?itemid=<id>. Returns { slug, itemId } with nulls for missing parts.
export function parseItemUrl(input) {
  const s = String(input || "");
  if (!s.includes("wolt.com")) return { slug: null, itemId: null };
  const slug = s.match(/\/venue\/([^/?#]+)/)?.[1] || null;
  const itemId =
    s.match(/(?:itemid|menuitem)-([a-f0-9]{24})/i)?.[1] ||
    new URL(s.startsWith("http") ? s : `https://${s}`).searchParams.get("itemid") ||
    null;
  return { slug, itemId };
}

// Resolve an item within a venue by id, URL, or name. Exact (case-insensitive)
// name matches beat substring hits; ambiguous substrings throw with candidates.
export async function resolveItem(slug, ref) {
  const fromUrl = parseItemUrl(ref);
  const wantedId = /^[a-f0-9]{24}$/.test(String(ref)) ? String(ref) : fromUrl.itemId;
  const venueSlug = slug || fromUrl.slug;
  if (!venueSlug) throw new Error("no venue slug: pass venue_slug, or an item URL containing /venue/<slug>/");
  const { items } = await getMenu(venueSlug, { limit: Infinity });
  if (wantedId) {
    const hit = items.find((it) => it.itemId === wantedId);
    if (!hit) throw new Error(`item ${wantedId} not found in "${venueSlug}" (it may be unavailable at this hour)`);
    return hit;
  }
  if (String(ref).includes("wolt.com")) {
    throw new Error(`that Wolt link has no item id in it — open the specific item on wolt.com and copy the URL containing "itemid-…", or search by name with get_venue_menu`);
  }
  const q = String(ref || "").toLowerCase().trim();
  if (!q) throw new Error("provide an item id, item URL, or name");
  const exact = items.filter((it) => (it.name || "").toLowerCase() === q);
  const matches = exact.length ? exact : items.filter((it) => (it.name || "").toLowerCase().includes(q));
  if (!matches.length) {
    // Descriptive names ("fresh chicken breast fillet") rarely substring-match
    // a catalog. Fall back to token scoring and hand back the best candidates
    // so the caller can pick by id instead of guessing new phrasings.
    const fuzzy = rankCandidates(q, items, { topK: 5, minScore: 0.3 });
    if (fuzzy.length) {
      const top = fuzzy.map((m) => `${m.name} (${m.itemId})`).join("; ");
      throw new Error(`no exact item matching "${ref}" in "${venueSlug}" — closest: ${top}. Pass one of these ids to pick it.`);
    }
    throw new Error(`no item matching "${ref}" in "${venueSlug}" (tip: query in the store's own language — catalogs are indexed in it)`);
  }
  if (matches.length > 1) {
    const top = matches.slice(0, 5).map((m) => `${m.name} (${m.itemId})`).join("; ");
    throw new Error(`matched ${matches.length} items in "${venueSlug}" — be more specific or pass an item id. Top: ${top}`);
  }
  return matches[0];
}

function normalizeMenuItem(it) {
  const groups = it.options || [];
  return {
    itemId: it.id,
    name: it.name,
    price: it.price ?? null,
    description: it.description || null,
    optionGroups: groups.length,
    requiredOptions: groups.some((g) => (g.multi_choice_config?.total_range?.min ?? 0) > 0)
  };
}

// Flatten the (possibly nested) category tree.
function flattenCategories(cats, depth = 0, parent = null, out = []) {
  for (const c of cats || []) {
    out.push({
      id: c.id, name: c.name, slug: c.slug, depth, parent,
      itemCount: (c.item_ids || []).length,
      subcategories: (c.subcategories || []).map((s) => (typeof s === "string" ? s : s.slug))
    });
    flattenCategories(c.subcategories, depth + 1, c.slug, out);
  }
  return out;
}

// Category listing for a venue — the top of a browse flow (big grocery stores
// have dozens of nested categories; restaurants have a handful).
export async function getCategories(slug) {
  const a = await getAssortment(slug);
  return {
    loadingStrategy: a.loading_strategy || null,
    categories: flattenCategories(a.categories),
    note: a.loading_strategy === "partial"
      ? "Large catalog: items load per category or via search, not all at once."
      : null
  };
}

// Fetch one category's items (works for the leaf categories of a partial
// assortment, where the top-level payload carries categories but no items).
async function fetchCategoryItems(slug, categorySlug) {
  const r = await woltFetch(`${ASSORTMENT_BASE}${slug}/assortment/categories/slug/${encodeURIComponent(categorySlug)}`);
  if (!r.ok) throw new Error(`category "${categorySlug}" fetch failed: HTTP ${r.status}`);
  return r.json || {};
}

// In-venue item search (server-side; the only way to reach every item of a
// large "partial" grocery assortment).
async function searchAssortmentItems(slug, query, lang = "en") {
  const r = await woltFetch(`${ASSORTMENT_BASE}${slug}/assortment/items/search`, { method: "POST", body: { q: query }, lang });
  if (!r.ok) throw new Error(`in-venue search failed: HTTP ${r.status}`);
  return r.json?.items || [];
}

// Lean in-venue search for batch flows: just the matching items, no category
// tree, no assortment fetch. Catalogs are indexed in the store's own language,
// so a query in that language finds what an English one misses — and lang must
// match the query's language, or Wolt translates the result names and token
// scoring can never line them up with the query.
export async function searchVenueItems(slug, query, { lang = "en" } = {}) {
  return (await searchAssortmentItems(slug, query, lang)).map(normalizeMenuItem);
}

// Browse a venue's menu; optional free-text query and/or category slug filter.
// Big grocery venues return loading_strategy "partial" with NO items at the top
// level — those resolve through per-category fetches or server-side search.
export async function getMenu(slug, { query = null, categorySlug = null, limit = 50 } = {}) {
  const a = await getAssortment(slug);
  const categories = flattenCategories(a.categories);
  const partial = a.loading_strategy === "partial";
  let items = a.items || [];
  let source = "assortment";

  if (categorySlug) {
    const cat = categories.find((c) => c.slug === categorySlug || c.id === categorySlug);
    if (!cat) throw new Error(`category "${categorySlug}" not found; available: ${categories.slice(0, 30).map((c) => c.slug).join(", ")}`);
    if (cat.subcategories.length && !cat.itemCount) {
      return { categories, loadingStrategy: a.loading_strategy || null, items: [], source: "category-index",
        note: `"${categorySlug}" is a parent category — pick a subcategory: ${cat.subcategories.join(", ")}` };
    }
    const payload = await fetchCategoryItems(slug, cat.slug);
    items = payload.items || [];
    source = "category";
  } else if (query && (partial || !items.length)) {
    items = await searchAssortmentItems(slug, query);
    source = "search";
  }

  if (query && source !== "search") {
    const q = query.toLowerCase();
    items = items.filter((it) => (it.name || "").toLowerCase().includes(q) || (it.description || "").toLowerCase().includes(q));
  }

  return {
    // A query call is a search, not a browse — repeating the category tree on
    // every lookup is what made per-item resolution so token-expensive.
    ...(query ? {} : { categories: categorySlug || !partial ? categories : categories.filter((c) => c.depth === 0) }),
    loadingStrategy: a.loading_strategy || null,
    source,
    totalItems: items.length,
    items: (Number.isFinite(limit) ? items.slice(0, limit) : items).map(normalizeMenuItem),
    note: partial && source === "assortment"
      ? "Large catalog: pass a query (server-side search) or a category slug to see items."
      : null
  };
}

// Full option groups for one dish, joined with the assortment's option defs.
// The basket write wants options: [{id: <binding id>, values: [{id, count, price}]}].
export async function getItemOptions(slug, itemId) {
  const a = await getAssortment(slug);
  let item = (a.items || []).find((it) => it.id === itemId);
  if (!item && a.loading_strategy === "partial") {
    // partial catalogs carry no top-level items — fetch this one by id
    const r = await woltFetch(`${ASSORTMENT_BASE}${slug}/assortment/items`, { method: "POST", body: { item_ids: [itemId] } });
    item = r.ok ? (r.json?.items || [])[0] : null;
  }
  if (!item) throw new Error(`item ${itemId} not found in "${slug}" menu`);
  const defs = new Map((a.options || []).map((o) => [o.id, o]));
  const byGroupId = new Map((item.options || []).map((b) => [b.id, b.name || defs.get(b.option_id)?.name]));
  const valueNames = new Map();
  for (const def of a.options || []) for (const v of def.values || []) valueNames.set(v.id, v.name);
  const groups = (item.options || []).map((binding) => {
    const def = defs.get(binding.option_id) || {};
    const range = binding.multi_choice_config?.total_range || {};
    // prerequisite_values gate a group behind selections in ANOTHER group
    // (e.g. "Right Half Toppings" only applies once you pick a half-and-half
    // base). Surfaced so the model can ask in the right order.
    const prerequisites = (binding.prerequisite_values || []).map((p) => {
      const valueId = typeof p === "string" ? p : (p.value_id || p.id);
      const groupId = typeof p === "string" ? null : (p.option_id || p.group_id || null);
      return { valueId, valueName: valueNames.get(valueId) || null, groupId, groupName: groupId ? byGroupId.get(groupId) || null : null };
    });
    return {
      groupId: binding.id, // use THIS id in add_to_cart options
      name: binding.name || def.name,
      type: def.type || null,
      required: (range.min ?? 0) > 0 && !prerequisites.length, // gated groups aren't required up front
      conditional: prerequisites.length > 0,
      prerequisites,
      min: range.min ?? 0,
      max: range.max ?? null,
      values: (def.values || []).map((v) => ({ valueId: v.id, name: v.name, price: v.price ?? 0 }))
    };
  });
  return { itemId, name: item.name, price: item.price ?? null, groups };
}
