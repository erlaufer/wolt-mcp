# Architecture

How the server talks to Wolt, and the non-obvious things that make it work. Everything here is verified against live traffic.

## Layout

```
mcp/server.mjs     tool definitions (thin — one try/catch per tool)
mcp/lib/
  http.js          authed fetch: 401 refresh-retry, Retry-After backoff
  auth.js          token store, wauth2 refresh, rotation strategy
  headers.js       the Wolt web-client header set
  wolt.js          search normalization, basket build/merge
  venue.js         venue detail, menu browsing, option groups, slug cache
  checkout.js      checkout preview payload + category enrichment
  account.js       order history, geocoding
  cdp-login.js     zero-paste browser login over the DevTools Protocol
  config.js        saved location
```

## Requests

Everything goes through `woltFetch`, which attaches the web app's own client headers:

```
platform: Web
client-version: 1.16.79
clientversionnumber: 1.16.79
w-wolt-session-id: no-analytics-consent    # sentinel the web app sends when analytics are declined
x-wolt-web-clientid: <uuid v4, per process>
app-language: en
authorization: Bearer <jwt>                # authed calls only
```

No `Origin`, `Referer`, or User-Agent spoofing is needed — plain server-side HTTP is accepted. Search is unauthenticated; everything account- or basket-related needs the bearer token.

## Auth

Wolt's web session issues a short-lived (~30 min) access JWT plus a refresh token, exchanged at `POST authentication.wolt.com/v1/wauth2/access_token` with `grant_type=refresh_token` — no client_id, no cookies.

Three things are easy to get wrong:

- **The `__wtoken` cookie is not an API token.** It's an opaque session value that Wolt's API rejects as a Bearer. Only `__wrtoken` (the refresh cookie) is useful; the login flow harvests it and immediately exchanges it for a real JWT, which doubles as validation.
- **Cookie values arrive wrapped** — URL-encoded and JSON-quoted (`%22abc%22`), sometimes several layers deep. `unwrapToken()` peels them.
- **Refresh tokens rotate, and your browser shares the chain.** Persisting our rotation over the bootstrap token forks the chain from the browser's copy and produces a session-expired loop; keeping rotations only in memory breaks across short-lived processes. So the user's bootstrap token stays pinned in `refreshToken` and rotations are persisted separately in `rotatedRefreshToken`, tried first with the bootstrap as fallback.

Tokens live in `~/.wolt-mcp/tokens.json`, mode 600.

## Baskets

`POST /order-xp/v1/baskets` is a **wholesale replace** keyed by `venue_id`, not an append. Every write therefore reads the current basket (`GET /order-xp/web/v1/pages/baskets`), merges lines (summing counts for a repeated item id, preserving options and substitution settings), and posts the full set. Removing a line means posting the set without it; removing the last line means deleting the basket via `POST /baskets/bulk/delete`, since Wolt has no empty-basket state.

**Phantom baskets:** posting a venue *slug* as `venue_id` returns a success-shaped response and bumps the basket count, but the basket never persists. Only 24-hex ObjectIDs are real venue ids, and `add_to_cart` refuses anything else rather than reporting a false success.

Weighted grocery items carry `weighted_item_info` with `purchased_weight_in_grams`, parsed from the item's unit size when the caller doesn't specify.

## Menus and options

Two catalog shapes, distinguished by `loading_strategy` on the assortment payload:

- **`full`** (restaurants, small stores) — every item is in the top-level `items` array.
- **`partial`** (large groceries) — the payload carries a nested category tree and **zero** items. Items come from per-category fetches (`/assortment/categories/slug/{slug}`, leaf categories only) or server-side search (`POST /assortment/items/search`). `get_venue_menu` picks the right strategy automatically; `get_venue_categories` exposes the tree for browsing.

Option groups need a join: an item's `options[]` are *bindings* (`{id, option_id, multi_choice_config}`) that reference the assortment's top-level `options[]` *definitions* (`{id, name, values[]}`). The basket write wants the **binding** id as the group id and definition value ids inside it.

`prerequisite_values` gate a group behind a selection in another group — a party-pizza combo can expose 80 groups of which only two apply until you pick a base. Those are surfaced as `conditional: true` with the prerequisite named, and excluded from `required`, so the model asks in a sane order instead of demanding 80 answers.

## Checkout preview

`POST /order-xp/web/v2/pages/checkout` prices a basket without ordering. Each menu item must carry a `category_id`, resolved from the venue assortment, then per-item venue pages, and finally falling back to the item id itself (which Wolt accepts). Response rows nest amounts as `{amount, formatted_amount}`.

## Currency

Every basket write and checkout preview carries an explicit currency, and
search payloads carry a country but not always a currency. `resolveCurrency()`
in `mcp/lib/wolt.js` walks the sources in order of reliability — the caller's
value, the venue record, any search candidate that has one, then a
country → currency table covering Wolt's markets — and returns `null` when none
of them knows. Callers then refuse the write with a message asking for a
currency. Nothing defaults to a particular market's money: a wrong currency is
a silent pricing bug, not a recoverable one.

## Testing

- `npm test` — offline unit tests (no network, no credentials), including a release guard that package.json, manifest.json and the lockfile carry the same version.
- `node test/replay.test.mjs` (part of `npm test`) — plans a full shopping list against **recorded catalogs** in three markets, with global `fetch` disabled so a pass can't depend on Wolt being up. Covers store racing, in-venue matching, catalog language, currency resolution and basket assembly. Cassettes are recorded by `node test/record-cassette.mjs`; recording refuses any non-catalog endpoint, so a fixture can never contain account, order or auth traffic. Both the recorder and the test drive the same flow (`test/plan-flow.mjs`), so they cannot silently diverge.
- `node test/mcp.live.mjs` — lower-level live check of the lib layer directly (refresh → search → basket write → merge/persist verification → cleanup), bypassing the MCP protocol. Needs real credentials and writes a temporary basket to your account.
- `node mcp/test/tools.live.mjs` — drives every tool through a real stdio MCP client against a live account. Cart tests use a temporary basket and clean up; favorites tests are self-reversing; `set_wolt_token` round-trips the tokens already on disk rather than writing a dummy. A coverage guard compares the tools actually called against `listTools()` and fails the run on any gap, so a newly added tool can't go untested. Only `login_via_chrome` is skipped, being interactive.

Release steps (version bump, `.mcpb` build, publish, post-publish verification) live in [releasing.md](releasing.md).

## Known limitations

- Unofficial private APIs: they can change without notice.
- Restaurant menus vary by hour — item ids fetched earlier may be unavailable later.
- Weighted-item support is grocery-focused; unusual unit formats fall back to 1 kg.
- Multi-day behavior of the shared browser/MCP refresh chain is still being observed.
