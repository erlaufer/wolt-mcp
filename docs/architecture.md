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
  remote.js        Streamable HTTP transport (stateless) and its routes
  oauth.js         the OAuth 2.1 server in front of it, Cloudflare Access JWT check
  context.js       per-request state directory (one Wolt account per OAuth grant)
deploy/            Dockerfile, compose file with a Cloudflare Tunnel connector
```

`server.mjs` collects the tools in a registry and `buildServer()` applies them: stdio builds one server for the life of the process, the HTTP transport builds one per request. Each tool carries annotations (`readOnlyHint` and friends) from a single table, and a test fails if a tool is missing from it.

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

`POST /order-xp/web/v2/pages/checkout` prices a basket without ordering. Each menu item must carry a `category_id`, resolved from the venue assortment, then the item records call (`assortment/items`, which names each item's categories; grocery markets list their categories without items, so this is where they resolve), then per-item venue pages, and finally falling back to the item id itself (which Wolt accepts). Response rows nest amounts as `{amount, formatted_amount}`.

## Ordering

`order.js` is the one module that moves money, and it is built from a captured card order on wolt.com. Two phases:

1. `prepareOrder()` loads the basket through `loadBasketPlan()` (the same lines and category ids the preview prices), picks the saved address (`/v2/delivery/info`, home by default) and the saved card (`/v3/user/me/payment_methods`, the default valid one), re-reads the items from the venue's assortment for their `checksum` and current price, and posts the website's own checkout quote: `pages/checkout` with `delivery_info_id`, the card under `payment_methods` and `use_credits_and_tokens: true`. The response carries the checkout `id`, `payable_amount` and a `purchase_validation` block. All of it is written to `order-quote.json` in the account's state dir (mode 600) under a fresh uuid, valid two minutes, and the model gets the total, address, card and ETA to show the user.
2. `placeOrder()` takes that uuid and the total the user confirmed. It refuses an unknown or expired quote, a different total, an amount over the grant's cap, and a quote already spent; posts `/v1/post-checkout-config` and stops if Wolt lists a consent it would show on the page (that call takes the same items, except that each option's values are a map of value id to count, and it answers the purchase's spelled-out list with 313 Invalid parameters); then posts `/v2/purchases`: the items with their checksums, `checkout_id`, `end_amount`, `delivery_price`, the validation block as `price_shadowing`, its `bag_fee`, `credits_amount` and `end_amount_rounding` at the top level when set (a grocery basket with a bag fee that omits it is refused as "Purchase validation error"), the saved address id and card id, and the quote's uuid as `client_nonce`. The quote file is marked before the request and updated with the order id after it, so an ambiguous response cannot be resubmitted using that quote. Purchase requests bypass HTTP retries; concurrent attempts for the same account are refused. Error 800 is an opaque authorization failure and is not retried. Challenges and pending or failed payments are never reported as paid.

The checkout resource bundles the official Ravelin core SDK and collects real device/browser context when no recent preparation exists. `set_order_payment_context` is an authenticated, app-only tool; collection never submits a purchase and cannot overwrite an existing quote's prepared context. The card's **Confirm and pay** button submits exactly its displayed quote and renders the result without asking the user to type Done. `browser-context.js` keeps genuine context and its source (browser or inline) per account for 30 minutes, independent of price expiry. Repricing still requires confirmation of its new total.

An authorization refusal is returned as a structured `payment_declined` outcome with `retryable: false` and a Wolt fallback link, rather than an MCP `isError` that a host may wrap in an internal exception. The quote retains that outcome. The card replaces confirmation controls with the result, persists widget state when supported, and updates model context for the next turn without submitting another order. Checkout rows identify the backend total so the card shows one populated total rather than a blank duplicate.

`payment-context.js` provides browser preparation. Embedded iPhone/iPad cards use this path when no recent browser preparation exists: first-party and iframe storage can differ, so inline collection is not assumed equivalent. The card polls the app-only `get_order_payment_context` local-state tool for up to five minutes, and also checks on focus/visibility changes. Completion enables confirmation, or a total refresh if pricing expired; it never submits an order. Its single-use capability is valid for ten minutes and is removed before telemetry starts. A same-origin JSON request attaches the data to an unsubmitted quote, or caches it for a fresh quote if the old price expired. It cannot read Wolt credentials or charge a card. The SDK publishable key is discovered from Wolt's public configuration. Neither device IDs nor browser fingerprints are invented.

`payment-diagnostics.js` retains the latest 20 submitted attempts per account in mode-600 `payment-attempts.json`, across quote replacements. It records timing, status/error codes, preparation source, authorization-action presence, and allowlisted support correlation IDs, including CloudFront's response ID. It excludes credentials, cookies, card/address/item data, browser fingerprints, and raw request/response bodies. Diagnostic write failures cannot alter payment outcomes. Pending or unknown payment plans are treated as unconfirmed even if the purchase status says `received`; the browser separately authorizes those plans.

`add-on.js` reads `/order-xp/v1/pages/multi-venue-ordering/{purchaseId}` for the eligible venues, saved address and expiry. A quote with `parent_purchase_id` inherits the parent address, expires no later than the offer, and rechecks eligibility before purchase. Both checkout and purchase carry the parent ID. Wolt still determines fees and may deliver the orders separately.

`weight.js` validates gram quantities against the catalog step and price per kg. Weighted checkout items carry `weighted`; purchase and consent items carry `weighted_item_info`, always with outer count one. Line totals use grams rather than the kilogram price times a count, while `payable_amount` remains Wolt's total including its weight reserve. Discounted items also echo `original_price`. Piece-based weighted items and weighted items with options remain unsupported.

Dishes with options are built the way the website builds them (captured from a second real order): the basket line names an option group by the item's *binding* id and its values by id; the purchase payload wants, per group, the binding id, the catalog definition's type (`choice` → `Choice`, `multi_choice` → `Multichoice`, `bool` → `Bool`), its name, and each chosen value with name, price and count. All of that comes from the same `assortment/items` call that supplies the checksums (bindings on the item, definitions at the top level), so a pick the catalog no longer offers is refused rather than guessed. `baseprice` stays the unit price; `end_amount` is the unit with its options times the count, where the dearest `free_selections` picks of a group cost nothing. The quote is sent the same value prices, since the basket page carries none. Refused on purpose: any payment method other than a saved card (Apple Pay, cash and redirect methods need Wolt's page), age-verified orders, and split payments. Whether a connection may order at all is decided outside the module: `buildServer({ ordering })` hands every handler `{ allowed, cap }`, which the remote transport derives from the grant (scope `order`, `orderCap`) and stdio from `WOLT_ALLOW_ORDERS` / `WOLT_ORDER_CAP`. Both order tools refuse before touching Wolt when it is not allowed; `place_order` is annotated destructive and non-idempotent so every host confirms it.

## Currency

Every basket write and checkout preview carries an explicit currency, and
search payloads carry a country but not always a currency. `resolveCurrency()`
in `mcp/lib/wolt.js` walks the sources in order of reliability — the caller's
value, the venue record, any search candidate that has one, then a
country → currency table covering Wolt's markets — and returns `null` when none
of them knows. Callers then refuse the write with a message asking for a
currency. Nothing defaults to a particular market's money: a wrong currency is
a silent pricing bug, not a recoverable one.

## Remote transport

`--http` serves the same tools over Streamable HTTP at `/mcp`, stateless: a fresh `McpServer` plus transport per request, torn down when the response closes. No session ids, so there is nothing to lose across restarts and `GET /mcp` is a 405. Only `login_via_chrome` is withheld — a server has no browser — and the token-setup message points at `npx -y wolt-mcp login` on the user's own machine instead.

Auth is OAuth 2.1 served by `oauth.js`: protected-resource and authorization-server metadata, open dynamic client registration, PKCE-only authorization codes (in memory, ten minutes, single use), opaque bearer and rotating refresh tokens stored hashed in `oauth.json`. The human check sits on `/authorize` and is one of two guards: Cloudflare Access in front of that path (the server verifies the `Cf-Access-Jwt-Assertion` RS256 JWT against the team's JWKS — signature, issuer, audience, expiry) or a shared approve secret. Either way the user clicks Allow on a same-origin form; auto-approval would let any registered client lift a code from a logged-in browser. `WOLT_API_TOKENS` adds fixed bearer tokens for header-only clients.

Every grant brings its own Wolt account; the server holds none to share. The refresh token pasted on the approve page is exchanged once, stored under `accounts/<id>/` in the state dir, and the id travels on the grant's tokens through every refresh. `context.js` holds the request's state directory in an `AsyncLocalStorage`; `auth.js` and `config.js` resolve their files through it instead of constants, so tokens and the saved location are per account without the tool code knowing. Remotely the IP-based location guess is off — it would point at the server. Details and deployment in [remote.md](remote.md).

## Rich results

Every item and venue carries an `imageUrl` (Wolt serves all images from `imageproxy.wolt.com` without auth; `?w=400` resizes) and venues carry `ratingScore` (out of 10) and `ratingVolume`. On top of that, `lib/ui.js` registers one HTML resource at `ui://wolt-mcp/cards.html` and marks the read-only "render" tools (search, menu, venues, plan, baskets, checkout) with `_meta.ui.resourceUri` — the MCP Apps extension that ChatGPT and Claude render as an inline iframe — plus ChatGPT's older `openai/outputTemplate` alias. Those tools return their JSON as text exactly as before and the same object as `structuredContent` with a `view` tag; `ui/cards.html` speaks the MCP Apps handshake (`ui/initialize`, `ui/notifications/tool-result`) and ChatGPT's `window.openai` globals, draws the view, and talks back only through follow-up messages (`ui/message`), so a card can ask for a menu or an add-to-cart without doing it behind the model's back. Hosts without MCP Apps ignore all of it.

Feed and venue search are `auth: "optional"`: personalised when the account is connected, public otherwise, so they work before any login.

The render tools' descriptions end with `IMAGE_HINT` (and the server instructions repeat it): the `imageUrl` values are Wolt's own photos and the model should show or link those rather than reach for an image search. That matters on hosts that don't draw the cards, where the model writes the whole answer and otherwise fills the picture slot with stock photos. ChatGPT's own message body never loads images from outside its storage (its `url_safe` filter strips them), so the iframe is the only place a Wolt photo shows up there.

Which tools render is a deliberate short list (`RENDER_TOOLS`): the checkout preview and `show_picks`, the two results that end a turn. Everything the model calls on the way (the searches, the feed, venue ranking, venue detail, menus, the planned cart, the baskets it reads before adding or clearing) is text-only although it carries pictures. Three observations forced that: a recommendation calls those tools once per candidate, and a host that draws a frame per call turned one answer into a dozen frames; ChatGPT has been seen to hydrate only the last frame of a turn, leaving the earlier ones blank with no tool input or output at all; and a basket card on every basket lookup made "add X" and "clear my basket" answers open with every basket the account holds. So the answer's own cards come from `show_picks`, a tool that does not touch Wolt: the model hands it the final shortlist (name, price, `imageUrl`, rating, venue, optional item id and wolt.com link) and gets one `picks` card set back. Because those URLs come from the model, `woltImageUrl`/`woltLinkUrl` keep only Wolt's hosts; anything else is dropped before it reaches the iframe.

The template looks up its root element and runs its first render only after every function it uses is defined. ChatGPT sets `window.openai.toolOutput` before the script runs, so that first render happens synchronously during setup; an earlier version rendered from inside the bridge, before `root` was assigned, and every ChatGPT card stayed on "Loading…". A render that throws now falls back to the raw data with the error on top, and a card that gets no data within a few seconds shows one line pointing at the reply and logs to the console which ChatGPT globals held anything.

ChatGPT has not been consistent about where the data is. The template therefore looks in `toolOutput` bare, wrapped as `{result: {structuredContent}}`, and in `toolResponseMetadata` (the whole tool-result envelope), and as a last resort parses the text content block, which `rich()` tags with the same `view` for exactly that reason; it also polls those globals for half a minute, because the data has been seen to appear without a `set_globals` event. Render tool results additionally carry the card `_meta` themselves (`resultMeta`), as ChatGPT's own example servers do.

## Testing

- `npm test` — offline unit tests (no network, no credentials), including a release guard that package.json, manifest.json and the lockfile carry the same version.
- `node test/replay.test.mjs` (part of `npm test`) — plans a full shopping list against **recorded catalogs** in three markets, with global `fetch` disabled so a pass can't depend on Wolt being up. Covers store racing, in-venue matching, catalog language, currency resolution and basket assembly. Cassettes are recorded by `node test/record-cassette.mjs`; recording refuses any non-catalog endpoint, so a fixture can never contain account, order or auth traffic. Both the recorder and the test drive the same flow (`test/plan-flow.mjs`), so they cannot silently diverge.
- `node test/mcp.live.mjs` — lower-level live check of the lib layer directly (refresh → search → basket write → merge/persist verification → cleanup), bypassing the MCP protocol. Needs real credentials and writes a temporary basket to your account.
- `node mcp/test/tools.live.mjs` — drives every tool through a real stdio MCP client against a live account. Cart tests use a temporary basket and clean up; favorites tests are self-reversing; `set_wolt_token` round-trips the tokens already on disk rather than writing a dummy. A coverage guard compares the tools actually called against `listTools()` and fails the run on any gap, so a newly added tool can't go untested. Only `login_via_chrome` is skipped, being interactive.

- `node mcp/test/remote.test.mjs` (part of `npm test`) — the HTTP transport in-process on a loopback port: discovery, client registration, the approve page (wrong secret, cross-site post, the real thing), PKCE exchange, bearer-protected `tools/list` through the SDK client, refresh rotation, static API tokens, and the Access JWT check against a key pair generated in the test.
- `node mcp/test/ui.test.mjs` (part of `npm test`) — the card layer through an in-memory client: the `ui://` resource is listed and readable with the MCP Apps mime type and image-host CSP, exactly the render tools link to it, the profile marker survives, and image references of every shape resolve.
- `node mcp/test/boot.test.mjs` (part of `npm test`) — starts the real server over stdio and lists its tools. The rest of the offline suite imports lib modules directly and never loads `server.mjs`, so a broken tool registration would otherwise surface on a user's first call.
- `npm run bench` (`node test/bench.mjs`) — scores match quality against the same recorded catalogs and prints the delta against `test/benchmarks/baseline.json` (`--save` adopts a new baseline). It deliberately does not report coverage, which lies: a run can fill every line while putting tomato pesto where tomatoes belong. It counts **correct** lines and **traps** — lines filled with the wrong thing, which is worse than a missing line because the user is told it's handled. Ground truth is per-market accept/reject name patterns, and each market scores against a pinned store so a matching change is measured on a fixed catalog rather than on whichever shop won that minute's race.

- `npm run timing` (`node mcp/test/timing.mjs`) — live latency of the main tools through a real MCP client, no login needed. Current shape: a 5-ingredient `plan_cart` is ~9 s, a 10-ingredient one ~20 s, because a plan costs roughly *stores raced × ingredients* in-venue searches and Wolt answers each in ~1–3 s. Our own rate limiter is a minor term — loosening it from 6 concurrent/80 ms to 12/30 ms moved a 10-line plan by about 12%.

CI (`.github/workflows/test.yml`) runs the offline suite and `node test/bench.mjs --check` on Node 22 and 24 for every push and pull request. The benchmark check fails the build if the overall score drops, if traps rise, or if any wrong pick goes unflagged — improving is free, regressing takes a deliberate `--save` and a committed baseline.

Release steps (version bump, `.mcpb` build, publish, post-publish verification) live in [releasing.md](releasing.md).

## Known limitations

- Unofficial private APIs: they can change without notice.
- Restaurant menus vary by hour — item ids fetched earlier may be unavailable later.
- Weighted-item support is grocery-focused; unusual unit formats fall back to 1 kg.
- Multi-day behavior of the shared browser/MCP refresh chain is still being observed.
- Ordering covers a saved card; Apple Pay, cash and interactive bank authentication still use Wolt. Real SDK device data does not guarantee authorization: error 800 does not identify the bank, provider or risk check that refused it. End-to-end authorization with browser preparation still needs a live purchase test. Gram-based and multiple-count payloads match captured successful browser orders; the final charge for produce can change with the picked weight.
