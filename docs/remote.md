# Remote mode

By default wolt-mcp speaks stdio: your MCP client starts it as a child process on your own machine. Remote mode runs the same server as an HTTPS endpoint, so clients that can only talk to a URL — ChatGPT's custom MCP servers, Claude.ai connectors (and through them the Claude iPhone app), Claude Code on another machine — can use your Wolt account from anywhere.

```
node server.mjs --http          # or: WOLT_HTTP_PORT=3000 node server.mjs
```

What changes compared to stdio:

- **Transport** is Streamable HTTP at `/mcp`, stateless: every request builds a fresh server, nothing is kept between calls, and restarts are invisible to clients. There is no session to resume, so `GET /mcp` answers 405.
- **Auth** is OAuth 2.1, served by wolt-mcp itself (see below). Clients discover it from the 401 on `/mcp`, register themselves, send you to an approve page once, and hold a bearer token from then on.
- **Browser login is gone.** A server has no Chrome to drive, so `login_via_chrome` is not offered. The approve page asks for a Wolt refresh token instead: log in at wolt.com, open the browser's developer tools → Network, reload, find the request to `authentication.wolt.com/v1/wauth2/access_token` and copy `refresh_token` from its JSON. (From a checkout, `node mcp/server.mjs login` automates that in a separate browser profile; `npx -y wolt-mcp login` once a release ships it.)
- **Location is per account, never guessed.** Locally the first search falls back to a city-level guess from your IP. A server's IP says where the server is, so remotely there is no guess: each account starts with no location and the model asks, or pulls it with `use_saved_address`.
- **One consumer per Wolt refresh chain.** Wolt's refresh tokens rotate, and two processes refreshing from the same chain eventually trip over each other. Once the remote server works, point your desktop clients at the URL too instead of running stdio copies alongside it; different accounts, or separate logins of the same account, are independent chains and coexist fine.

## One Wolt account per connection

The server holds no Wolt account of its own: it is a public endpoint, and every connection brings its own. The approve page requires a **Wolt refresh token**. It is exchanged once right there (a bad paste fails on the page, not at the first tool call), the grant gets a private slot under `<state dir>/accounts/<id>/` with its own `tokens.json` and `config.json`, and every tool call made with that grant — including its refreshes — reads and writes only that slot. An authorization that somehow has no account is answered with 401 so the client re-authorizes.

So one server can serve several people in several countries, each with their own Wolt login, address and currency, as long as each of them can pass the approve-page guard. A fixed `WOLT_API_TOKENS` bearer gets a slot of its own too, connected by calling `set_wolt_token` through it. Only `WOLT_HTTP_AUTH=none`, the single-user private mode, keeps using the state directory root like stdio does.

## Ordering is opt-in, per connection

Below the token field, the approve page has an unticked box: *allow this connection to place and pay for orders*, with an optional per-order limit. Unticked, the connection fills and prices baskets and the user pays on wolt.com, as always. Ticked, the grant carries the `order` scope (and the limit, in minor units), and `prepare_order` / `place_order` work on it: a quote with the exact total, the saved address and the saved card, then a purchase once the user confirms that total in the chat. The permission survives token refreshes and ends with the grant; connect again to change it. Fixed API tokens and the no-auth mode have no approve page, so they take it from `WOLT_ALLOW_ORDERS` and `WOLT_ORDER_CAP` instead.

Compatible checkout cards prepare genuine browser context automatically using the pinned official Ravelin SDK. The app-only `set_order_payment_context` tool attaches it without placing an order. The user then clicks **Confirm and pay** with the displayed amount; that explicit action calls `place_order` and displays the result in the card. No Done message is needed. Only the user action submits payment, and a refreshed total needs a fresh confirmation. Hosts without inline preparation can use `paymentContextUrl`; opening it prepares automatically.

Device context is cached per account for 30 minutes, separately from the two-minute price quote. A reprice therefore does not demand another setup. Fallback links work once for ten minutes and remove their capability from the URL before telemetry starts; completing one after pricing expires stores device data but cannot extend or pay the expired quote. `/payment-context` and its SDK/config endpoints must be reachable without an Access login; completion requires the unguessable capability and a same-origin JSON request. Inline tools use the existing authenticated MCP connection. The SDK's publishable key is discovered from Wolt's public page; `WOLT_RAVELIN_PUBLIC_KEY` can override it. The widget CSP allows SDK connections to `https://*.ravelin.click`. No browser fingerprints or device IDs are invented.

Bank authentication remains interactive: a challenge, a pending payment or an authorization failure is never reported as paid. Complete those in Wolt. An interrupted payment response has an unknown outcome; purchase requests are not automatically retried, and the same quote cannot be resubmitted after an ambiguous response. Check Wolt before creating another order.

`get_order_add_on_options` checks the eligible venues, address and deadline for an existing order. Pass its order ID as `parent_purchase_id` to `prepare_order`. Eligibility is checked again before paying; the quote expires no later than the offer. Service fees and minimums can still apply, and Wolt may deliver the orders separately. Products sold in grams are priced using their catalog step and price per kg, and the quoted payable total includes Wolt's weight reserve. The final charge can change with the picked weight. Weighted products sold by piece and weighted products with options still use Wolt checkout.

## Configuration

All settings are environment variables.

| Variable | Meaning |
|---|---|
| `WOLT_HTTP_PORT`, `WOLT_HTTP_HOST` | Where to listen. Defaults `3000` and `127.0.0.1`; the Docker image sets `0.0.0.0`. |
| `WOLT_PUBLIC_URL` | The https origin clients use, e.g. `https://wolt.example.com`. Required in OAuth mode; it is the OAuth issuer and the resource identifier. |
| `WOLT_CF_ACCESS_TEAM`, `WOLT_CF_ACCESS_AUD` | Guard the approve page with Cloudflare Access: your team domain (`myteam.cloudflareaccess.com`) and the Access application's Audience tag. `WOLT_CF_ACCESS_EMAILS` optionally narrows who may approve. |
| `WOLT_OAUTH_APPROVE_SECRET` | The other guard: a secret (16+ characters) typed into the approve page. Use this when there is no Cloudflare in front. |
| `WOLT_OAUTH_CLIENT_ID`, `WOLT_OAUTH_CLIENT_SECRET` | Optional fixed client for ChatGPT's "static credentials" OAuth option. `WOLT_OAUTH_REDIRECT_URIS` lists its callbacks; the default covers ChatGPT and Claude. |
| `WOLT_API_TOKENS` | Optional comma-separated long-lived bearer tokens (32+ characters each) for clients that can only send a fixed `Authorization` header, such as a desktop agent's "bearer token" field or an iOS Shortcut. |
| `WOLT_HTTP_AUTH=none` | Disables auth entirely. Only for a private network you trust; it is announced loudly on stderr. |
| `WOLT_STATE_DIR` | Where tokens and the saved location live. `/data` in Docker. |
| `WOLT_ALLOW_ORDERS=1`, `WOLT_ORDER_CAP` | Ordering for connections without an approve page (fixed API tokens, `WOLT_HTTP_AUTH=none`, and the stdio server): allow it, and optionally cap each order (main currency unit, e.g. `50`). OAuth grants ignore these; their permission comes from the approve page. |

## How the OAuth flow works

wolt-mcp is both the authorization server and the protected resource. There is no identity provider to delegate to — the thing being protected is one person's Wolt account — so the "login" is whichever guard you configured, and the rest is standard OAuth 2.1:

1. A client POSTs `/mcp` without a token and gets a 401 whose `WWW-Authenticate` header points at `/.well-known/oauth-protected-resource`. That names this same origin as the authorization server, whose metadata at `/.well-known/oauth-authorization-server` lists the endpoints.
2. The client registers itself at `/register` (RFC 7591), or uses the static client you configured. Registration is open: it buys nothing without step 3.
3. The client opens `/authorize` in your browser with a PKCE challenge. With the Cloudflare Access guard, Access makes you log in (Google, one-time PIN, whatever your policy allows) and forwards its signed JWT; wolt-mcp verifies the signature, issuer, audience and expiry against your team's public keys. With the secret guard, the page asks for the secret. In both cases you click **Allow** — there is no silent approval, because any site could otherwise register a client and collect a code from a logged-in browser.
4. The client exchanges the code at `/token` (PKCE verifier checked, client secret checked if the client has one) for an opaque bearer token valid 7 days and a refresh token valid 90 days. Refresh tokens rotate; a superseded one keeps working for a minute so a lost response doesn't strand the client.
5. Every tool call carries `Authorization: Bearer …`. Tokens are stored hashed in `<state dir>/oauth.json`, mode 600.

Tool annotations are set so clients know what each tool does before calling it: every search and read tool is `readOnlyHint: true`, basket and account writes are not, and `clear_basket` and `place_order` are flagged destructive. ChatGPT, for one, asks for confirmation on every tool without the read-only hint.

## Deploying with Docker and Cloudflare Tunnel

`deploy/` has a Dockerfile, a compose file and `.env.example`. The compose file runs wolt-mcp next to a `cloudflared` connector, so nothing listens on the host; Cloudflare terminates TLS and forwards your hostname into the container network.

1. In Cloudflare Zero Trust, create an **Access application** for `wolt.example.com/authorize` (just that path) with a policy allowing your email. Note its Audience tag. Do this *before* the hostname exists, so the approve page is never reachable unguarded.
2. Create a **tunnel**, set its ingress to `wolt.example.com → http://wolt-mcp:3000`, and let it create the DNS record. Copy the connector token.
3. On the server:
   ```
   git clone https://github.com/erlaufer/wolt-mcp.git && cd wolt-mcp/deploy
   cp .env.example .env   # fill in WOLT_PUBLIC_URL, the Access team + AUD, the tunnel token
   docker compose up -d --build
   ```
4. Connect a client: on the approve page, paste a refresh token copied from a logged-in wolt.com tab (developer tools → Network → the `wauth2/access_token` request). Each client connection gets its own Wolt account that way; the server never holds one of its own.

Check it: `curl -i https://wolt.example.com/mcp -X POST` should return 401 with a `WWW-Authenticate` header, and an anonymous `curl -i https://wolt.example.com/authorize` should redirect to your `cloudflareaccess.com` login.

The access log (stderr, `docker compose logs wolt-mcp`) has one line per request: `POST /mcp tools/call search_products (openai-mcp/1.0.0) 200 412ms` — the JSON-RPC method, the tool or resource, the client's product token, status and time. Parameters, results and tokens are never logged. It is the quickest way to see what a host actually does: a host that renders the inline cards asks for `resources/read ui://wolt-mcp/cards.html` after the first render tool call; one that only shows text never does.

### Connecting clients

- **ChatGPT** — Settings → Plugins → Add custom MCP server: URL `https://wolt.example.com/mcp`, authentication **OAuth**. Leave the advanced settings alone (dynamic registration) or enter the static client id and secret you configured. ChatGPT copies the tool list when the connector is created and does not re-read it on its own: after upgrading the server, open the connector's settings and **Refresh** it, or new tools, descriptions and the inline cards stay invisible.
- **Claude.ai / Claude iPhone app** — Settings → Connectors → Add custom connector with the same URL; the connector syncs to the mobile app.
- **Claude Code** — `claude mcp add --transport http wolt https://wolt.example.com/mcp`, then `/mcp` to authenticate.
- **Anything with a fixed bearer header** — put a `WOLT_API_TOKENS` entry in its `Authorization: Bearer …` header.

## Running without Cloudflare

Any TLS reverse proxy works: terminate HTTPS, forward to `127.0.0.1:3000`, set `WOLT_PUBLIC_URL` to the public origin and `WOLT_OAUTH_APPROVE_SECRET` as the guard. The OAuth endpoints and `/mcp` must stay reachable without a login page in front of them — only `/authorize` may be gated by something else, and then the server must still be able to verify that gate (today that means Cloudflare Access).
