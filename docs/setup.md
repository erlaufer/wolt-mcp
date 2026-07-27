# Setup — use Wolt from your AI tool

This connects Wolt to any MCP-capable AI client. You review and check out on wolt.com yourself — nothing is ever ordered automatically.

## 1. Install

**Requirements:** Node 22 or newer. (The browser login needs `WebSocket`, which Node only exposes globally from 22 on; Node 18 and 20 are both past end-of-life.)

**Claude Desktop (easiest)**: download the `.mcpb` bundle from the releases page and double-click it. Leave both token fields in the settings form empty — you connect in chat, in step 2.

**Claude Code**:
```sh
claude mcp add wolt-mcp -- npx -y wolt-mcp
```

**Any other MCP client** (Cursor, Windsurf, etc.) — stdio server config:
```json
{ "command": "npx", "args": ["-y", "wolt-mcp"] }
```

## 2. Connect your Wolt account (one time)

Just ask your AI: **"Connect my Wolt account."** It will pick the easiest path:

1. **`login_via_chrome`** (zero paste): a browser window opens on wolt.com — log in normally and you're done.
   - Needs a **Chromium-based browser**: Chrome, Edge, Brave, Vivaldi, or plain Chromium. It works over the Chrome DevTools Protocol, so Firefox and Safari can't be used here — use the manual paste below instead.
   - Chrome is found automatically at its standard location on macOS/Windows/Linux. For any other browser (or a non-standard install path), set `CHROME_BIN` to the binary, e.g. `CHROME_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"`.
   - The window opens with a **separate, empty profile** (`~/.wolt-mcp/chrome-profile`) — not your everyday one. That means you'll log into Wolt fresh, and none of your normal cookies, extensions, or saved passwords are exposed to the server. This is intentional, not a bug.
2. **Manual paste** (always works): on a logged-in wolt.com tab, DevTools → Network → find a POST to `authentication.wolt.com/v1/wauth2/access_token` → copy `refresh_token` from the request payload → paste it in chat.

With a refresh token stored, the connection renews itself forever. Tokens are stored only on your machine (`~/.wolt-mcp/tokens.json`, mode 600) and are never sent anywhere except wolt.com.

Searching stores needs no login — it's only required to write your basket.

## 3. Set your delivery location

Easiest: say **"use my saved Wolt address"** — `use_saved_address` pulls the addresses from your Wolt account and defaults to the one labeled Home. Or say **"my delivery address is Aleksanterinkatu 1, Helsinki"** — the model resolves it and saves it via `set_location`. All searches default to it. If you set nothing, your location is estimated from your IP (city-level) on first search.

Note: the address at payment time is whatever you select on wolt.com — this location only scopes which stores you see and the delivery estimate.

## 4. Use it

- "Add the ingredients for carbonara to my Wolt cart."
- "Find me 2L of milk and a dozen eggs, cheapest decent store."
- "What's in my Wolt basket?" / "How much will it be with delivery?" (`checkout_preview`)
- "Remove the olives." (`update_cart_item`)

When your basket is ready, the AI gives you the wolt.com link — you review and pay there.

## Tool reference

| Tool | Auth | What it does |
|---|---|---|
| `search_products` | no | Search grocery products for one ingredient near you |
| `search_restaurant_dishes` | no | Search restaurant food (separate from groceries) |
| `search_venues` | no | Find stores/restaurants by name or cuisine |
| `get_feed` | no | Discovery feed: "Popular", "Order again", … |
| `top_venues` | no | Ranked venues with filters: open now, score, fee, Wolt+ |
| `get_venue` | no | Venue details, rating, opening hours |
| `get_venue_menu` | no | Browse/search a venue's menu (handles huge grocery catalogs) |
| `get_venue_categories` | no | Category tree for browsing a large store |
| `find_item` | no | Resolve an item by name or wolt.com URL |
| `get_dish_options` | no | Sizes/toppings/sides for a dish, with required flags |
| `resolve_address` | no | Geocode a free-form address (OpenStreetMap) |
| `use_saved_address` | yes | Pull your saved Wolt address and use it for searches |
| `get_order_history` / `get_order` | yes | Past orders — enables "reorder my usual" |
| `get_favorites` / `add_favorite` / `remove_favorite` | yes | Manage favorite venues |
| `get_payment_methods` | yes | List saved payment methods (read-only) |
| `plan_cart` | no | One-shot: search a list, pick best single store, return a plan |
| `add_to_cart` | yes | Write items to your basket (merge-safe, one venue per basket) |
| `get_baskets` | yes | List your baskets and line items |
| `update_cart_item` | yes | Change a line's count or remove it |
| `clear_basket` | yes | Delete a basket |
| `checkout_preview` | yes | Total incl. fees/delivery — read-only, never orders |
| `login_via_chrome` / `set_wolt_token` | — | Connect your account |
| `get_wolt_profile` | yes | Your Wolt profile (saved addresses) |
| `set_location` / `wolt_status` | no | Location default / connection status |

## Troubleshooting

- **"SETUP NEEDED" message** — your token expired and can't refresh; reconnect (step 2).
- **Item added but basket empty on wolt.com** — reload the page; Wolt rehydrates the basket from the server.
- **Search finds nothing** — check `wolt_status` shows the right location; Wolt search is location-scoped.

## Disclaimers

Unofficial project using Wolt's private consumer APIs — not affiliated with or endorsed by Wolt. Endpoints can change without notice. Personal use; never automates payment.
