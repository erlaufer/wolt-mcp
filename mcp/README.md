# wolt-mcp — local MCP server for Wolt

Exposes Wolt as MCP tools, so you can tell Claude Desktop, Claude Code, Cursor, or any MCP client:

> "Search my local Wolt for the ingredients in this carbonara recipe and add them to my cart."

Your client's own model does the reasoning — no hosted LLM, no API key here. Nothing is ever ordered: you review and check out on wolt.com.

**Model requirements:** the client model carries all the judgment — translating your list into the store's catalog language, telling real products from lookalike junk matches, and reviewing the cart before writing it. Use a frontier-tier model (any current Sonnet/Opus-class model works well). Small "fast" models produced unreliable results in testing — including confidently reporting available products as unavailable — so reserve them for browsing, not cart building.

## Install

```sh
npx -y wolt-mcp install      # registers with Claude Desktop, prints config for other clients
```

Or for Claude Code:

```sh
claude mcp add wolt-mcp -- npx -y wolt-mcp
```

From a clone: `cd mcp && npm install && node server.mjs`.

Requires **Node 22+** (the browser login relies on Node's global `WebSocket`).

See [docs/setup.md](../docs/setup.md) for the full setup guide and tool reference, and [docs/architecture.md](../docs/architecture.md) for how it works internally.

## Connect your account

Ask your AI: **"Connect my Wolt account."** It opens a browser window; log into wolt.com and you're done (`login_via_chrome`). Fallback: paste a Wolt refresh token in chat (`set_wolt_token`).

This needs a **Chromium-based browser** — Chrome, Edge, Brave, Vivaldi, or Chromium — because it works over the Chrome DevTools Protocol; Firefox and Safari users should use the `set_wolt_token` fallback. Chrome is auto-detected; point `CHROME_BIN` at the binary for anything else. The window uses a **separate, empty profile** (`~/.wolt-mcp/chrome-profile`), so you log into Wolt fresh and your everyday profile is never touched.

Tokens are stored only on your machine (`~/.wolt-mcp/tokens.json`, mode 600) and auto-renew forever. Env vars `WOLT_BEARER_TOKEN` / `WOLT_REFRESH_TOKEN` work as initial seeds; `WOLT_LAT` / `WOLT_LON` seed the default location (or just say "use my saved Wolt address").

Searching stores needs no login — only basket writes do.

## Tools

**Find things** — `search_products` (groceries), `search_restaurant_dishes`, `search_venues`, `top_venues` (open-now / rating / fee filters), `get_feed`, `find_item` (by name or wolt.com URL).

**Explore a venue** — `get_venue` (details, hours), `get_venue_categories`, `get_venue_menu`, `get_dish_options`.

**Cart** — `plan_cart` (recipe → single-store plan), `add_to_cart` (merge-safe, supports dish options), `get_baskets`, `update_cart_item`, `clear_basket`, `checkout_preview` (real total incl. fees; never orders).

**Account** — `get_wolt_profile`, `use_saved_address`, `get_order_history`, `get_order`, `get_payment_methods`, `get_favorites`, `add_favorite`, `remove_favorite`, `resolve_address`, `set_location`, `wolt_status`.

## Try it

- *"Is my Wolt set up?"* → `wolt_status`
- *"Add the ingredients for a bolognese to my cart."* → searches per ingredient, picks one store, writes the basket
- *"What's good and open near me?"* → `top_venues`
- *"How much with delivery?"* → `checkout_preview`

## Notes

- Unofficial: built on Wolt's private consumer APIs, which can change without notice. Payment is never automated.
- Everything talks to wolt.com only, with one exception: `resolve_address` sends the address text you ask it to look up (and nothing else) to OpenStreetMap's Nominatim geocoder.
- **Automating access may violate Wolt's Terms of Service.** You run this against your own account, at your own risk, and Wolt could restrict or block that account.
- Not affiliated with, endorsed by, or sponsored by Wolt. Wolt is a trademark of Wolt Enterprises Oy.
