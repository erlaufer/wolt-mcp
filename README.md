# wolt-mcp

**Use Wolt from your favorite AI tool.** An open-source MCP server that lets Claude Desktop, Claude Code, Cursor, or any MCP client search Wolt, plan a grocery cart from a recipe, browse restaurant menus, and fill your Wolt basket. By default you review and check out on wolt.com yourself. **Ordering is opt-in, per connection:** a connection you switch it on for can place and pay for an order with your saved card, after you confirm the exact total in the chat.

> "Add the ingredients for carbonara to my cart" · "Order my usual from that burger place" · "What's good and open near me right now?" · "How much will my basket cost with delivery?"

![Demo: Claude plans 4 high-protein dinners, fills a Wolt grocery cart at one store via wolt-mcp, and shows a checkout preview with the real total](docs/wolt-mcp-demo.gif)

## Install

**Claude Desktop** — download the `.mcpb` bundle from [Releases](../../releases/latest) and double-click it.

**Claude Code** — `claude mcp add wolt-mcp -- npx -y wolt-mcp`

**Other MCP clients** — stdio config `{ "command": "npx", "args": ["-y", "wolt-mcp"] }`, or clone this repo, `cd mcp && npm install`, and point your client at `mcp/server.mjs`.

**Remote / ChatGPT / Claude on your phone** — run it as an HTTPS endpoint behind OAuth with `node server.mjs --http` (a Dockerfile and compose file with a Cloudflare Tunnel are in `deploy/`), then add `https://your-host/mcp` as a custom MCP server in ChatGPT or a custom connector in Claude.ai. See [docs/remote.md](docs/remote.md).

Requires Node 22+.

Then in chat: *"Connect my Wolt account"* (a browser window opens in a separate profile; log in) → *"use my saved Wolt address"* → shop. Login needs a Chromium-based browser (Chrome, Edge, Brave, Chromium); Firefox/Safari users paste a token instead.

Full walkthrough in [docs/setup.md](docs/setup.md); internals in [docs/architecture.md](docs/architecture.md).

## What it does

Tools across:

- **Find** — grocery products, restaurant dishes, venues, a filtered "what's good and open near me" ranking, the discovery feed, and item lookup by name or wolt.com URL.
- **Browse** — venue details and opening hours, category trees, full menus (including large grocery catalogs), and dish option groups with required/conditional choices.
- **Cart** — recipe → single-store plan, merge-safe basket writes with dish options, line editing, and a checkout preview showing your real total including delivery and fees.
- **Account** — saved addresses, order history (so "order my usual" works), favorites, payment methods, geocoding.
- **Order** (off by default) — `prepare_order` quotes the basket with your saved address and card, `place_order` pays once you confirm that total. Compatible checkout cards run Ravelin's official SDK automatically and offer **Confirm and pay**, with an external browser link as fallback. Recent genuine device data is reused for 30 minutes across refreshed quotes. Supports multiple quantities and products sold in grams, including Wolt's weight reserve in the confirmed total; the final charge can change with the picked weight. `get_order_add_on_options` checks time-limited add-on venues; pass `parent_purchase_id` to quote a second order at the same address. Wolt decides the deadline and fees, and combined delivery is not guaranteed. Enabled per connection on the approve page (or `WOLT_ALLOW_ORDERS=1` locally), optionally with a per-order limit. Saved card only; Apple Pay, cash and interactive bank authentication still go through Wolt.
- **Pictures and ratings** — product and venue images and venue scores come with every result, and in ChatGPT and Claude the checkout preview renders as an inline card (MCP Apps) and any shortlist the model recommends ends in one `show_picks` card set with the photos, so you can shop by looking rather than by reading JSON.

## How it works

Wolt's own web-client APIs, spoken politely: search is unauthenticated; account actions use a refresh-token chain harvested once from your logged-in browser session and auto-renewed forever. Tokens live only on your machine (`~/.wolt-mcp/`, mode 600) and are sent nowhere except wolt.com.

Every tool above has been exercised against a live account — token refresh, basket writes verified to persist server-side, dish options, checkout totals, order history.

## Status & disclaimers

Early but working — **unofficial**, built on private consumer APIs that can change without notice. Personal use; ordering is off unless you switch it on for a connection. MIT license.

**Automating access may violate Wolt's Terms of Service.** You run this against your own account, at your own risk, and Wolt could restrict or block that account. This project places and pays for an order only on a connection you approved for ordering, only after you confirm the exact total, and backs off when Wolt asks it to — but that is a design choice, not permission. When ordering is on, real money moves on the say-so of a language model through private endpoints: keep the per-order limit on and the permission off for any client you do not trust.

Your Wolt credentials go only to wolt.com. Geocoding (`resolve_address`) sends the address text to OpenStreetMap's Nominatim service. Rendering an order quote in a compatible checkout card (or opening its fallback preparation page) runs Ravelin's browser SDK, which sends device data to Ravelin for payment protection. The page cannot place an order or charge your card, and sends no Wolt token or card number to Ravelin.

Not affiliated with, endorsed by, or sponsored by Wolt. Wolt is a trademark of Wolt Enterprises Oy.
