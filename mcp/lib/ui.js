// Inline cards for hosts that render MCP Apps (ChatGPT, Claude): pictures,
// prices and ratings instead of a JSON dump, for the tools whose results are
// things to look at — products, dishes, venues, a planned cart, a basket, a
// checkout total.
//
// How it fits together: one HTML resource (ui/cards.html) is registered under
// a ui:// URI, and each "render" tool points at it from _meta.ui.resourceUri
// (plus ChatGPT's older alias, openai/outputTemplate). Those tools return
// their usual JSON as text AND the same object as structuredContent with a
// `view` field; the host hands structuredContent to the iframe, which draws
// the matching view. Hosts without MCP Apps ignore all of it and see exactly
// what they saw before. Nothing here is required for the tools to work.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UI_RESOURCE_URI = "ui://wolt-mcp/cards.html";
export const UI_MIME = "text/html;profile=mcp-app";
// Where the pictures come from. Wolt serves every product, venue and brand
// image through imageproxy.wolt.com without auth, so a host that enforces the
// widget's CSP needs that origin on its image allowlist.
export const IMAGE_HOSTS = ["https://imageproxy.wolt.com", "https://wolt.com", "https://*.wolt.com"];

const HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "cards.html");
let html = null;
export function widgetHtml() {
  if (html === null) html = readFileSync(HTML_PATH, "utf8");
  return html;
}

// The tools that render, with the status lines ChatGPT shows while and after
// the call. Only the two results that end a turn are on the list: the
// checkout total and the shortlist. Everything the model calls on the way
// (searches, the feed, venue ranking, venue detail, menus, the planned cart,
// the baskets it reads before adding or clearing) stays text-only although
// it carries pictures: a host draws one frame per call, and ChatGPT has been
// seen to hydrate only the last frame of a turn, leaving the earlier ones
// blank; a basket card on every basket lookup also made "add X" answers
// twice as long as they needed to be. The answer's own cards come from one
// show_picks call at the end instead. A tool that changes something stays
// text-only too; it should read as a sentence from the model, not as a card.
export const RENDER_TOOLS = {
  checkout_preview: ["Pricing the basket…", "Checkout preview"],
  show_picks: ["Laying out the picks…", "Picks"]
};

// show_picks takes URLs from the model, so only Wolt's own hosts get through:
// a picture from anywhere else, or a link off wolt.com, is dropped.
export function woltImageUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" && (u.hostname === "imageproxy.wolt.com" || u.hostname === "wolt.com" || u.hostname.endsWith(".wolt.com")) ? u.href : null;
  } catch { return null; }
}
export function woltLinkUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" && (u.hostname === "wolt.com" || u.hostname.endsWith(".wolt.com")) ? u.href : null;
  } catch { return null; }
}

// Appended to every render tool's description. Hosts that don't draw the
// cards still have a model writing the answer, and a model with a picture
// slot to fill reaches for an image search unless told the photo is already
// in hand.
export const IMAGE_HINT = " Where a result carries imageUrl, that is Wolt's own photo of the item or venue on a public CDN, embeddable as-is: when you show pictures, use those URLs and never substitute stock or web-search images for them.";

export function describe(toolName, description) {
  return RENDER_TOOLS[toolName] ? description + IMAGE_HINT : description;
}

export function uiMeta(toolName) {
  const status = RENDER_TOOLS[toolName];
  if (!status) return undefined;
  return {
    ui: { resourceUri: UI_RESOURCE_URI },
    "openai/outputTemplate": UI_RESOURCE_URI,
    "openai/toolInvocation/invoking": status[0],
    "openai/toolInvocation/invoked": status[1]
  };
}

const resourceMeta = {
  ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: IMAGE_HOSTS } },
  "openai/widgetDescription": "Wolt products, dishes, venues and your cart, with pictures, prices and ratings.",
  "openai/widgetPrefersBorder": true,
  "openai/widgetCSP": { connect_domains: [], resource_domains: IMAGE_HOSTS }
};

export function registerUi(server) {
  server.registerResource(
    "wolt-cards",
    UI_RESOURCE_URI,
    { title: "Wolt cards", description: "Inline cards for wolt-mcp results.", mimeType: UI_MIME, _meta: resourceMeta },
    async () => ({ contents: [{ uri: UI_RESOURCE_URI, mimeType: UI_MIME, text: widgetHtml(), _meta: resourceMeta }] })
  );
}

// A render tool's result: the JSON the model has always read, plus the same
// object as structuredContent tagged with the view the iframe should draw.
export function rich(view, obj) {
  const tagged = { view, ...obj };
  return {
    // The same object in both places: a host that hands the iframe only the
    // text block (seen in ChatGPT) still lets it find the view.
    content: [{ type: "text", text: JSON.stringify(tagged, null, 2) }],
    structuredContent: tagged
  };
}

// Stamped on a render tool's result: the template again plus the status
// lines, the way ChatGPT's own examples do it, so a host that reads the
// result rather than the descriptor still finds the card.
export function resultMeta(toolName) {
  const status = RENDER_TOOLS[toolName];
  if (!status) return undefined;
  return {
    ui: { resourceUri: UI_RESOURCE_URI },
    "openai/outputTemplate": UI_RESOURCE_URI,
    "openai/toolInvocation/invoking": status[0],
    "openai/toolInvocation/invoked": status[1]
  };
}

// Wolt image references come as a URL string or as {url, blurhash}; a few
// records carry an array of those. One accessor for all of them.
export function imageUrlOf(ref) {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  if (Array.isArray(ref)) return imageUrlOf(ref[0]);
  return typeof ref.url === "string" ? ref.url : null;
}
