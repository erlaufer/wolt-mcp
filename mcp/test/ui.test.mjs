// The inline-card layer, offline: the ui:// resource is registered and
// readable, exactly the render tools point at it, their results carry
// structuredContent tagged with a view, and image references of every shape
// Wolt uses resolve to a URL.
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.WOLT_STATE_DIR = mkdtempSync(join(tmpdir(), "wolt-ui-"));
const { buildServer } = await import("../server.mjs");
const { rich, imageUrlOf, woltImageUrl, woltLinkUrl, RENDER_TOOLS, UI_RESOURCE_URI, UI_MIME, IMAGE_HOSTS, PAYMENT_HOSTS, IMAGE_HINT } = await import("../lib/ui.js");

// show_picks takes URLs from the model: only Wolt's hosts pass.
assert.equal(woltImageUrl("https://imageproxy.wolt.com/assets/abc"), "https://imageproxy.wolt.com/assets/abc");
assert.equal(woltImageUrl("https://images.example.com/x.jpg"), null);
assert.equal(woltImageUrl("http://imageproxy.wolt.com/assets/abc"), null, "https only");
assert.equal(woltImageUrl("not a url"), null);
assert.equal(woltLinkUrl("https://wolt.com/en/geo/x/restaurant/y"), "https://wolt.com/en/geo/x/restaurant/y");
assert.equal(woltLinkUrl("https://evil.example/wolt.com"), null);
for (const t of ["get_venue", "get_venue_menu", "search_products", "search_restaurant_dishes", "search_venues", "top_venues", "get_feed", "plan_cart", "get_baskets"]) {
  assert(!RENDER_TOOLS[t], `${t} is a step on the way and stays text-only`);
}
for (const t of ["show_picks", "checkout_preview", "prepare_order"]) assert(RENDER_TOOLS[t], `${t} ends a turn and renders`);
assert.equal(Object.keys(RENDER_TOOLS).length, 3, "only the turn-ending results render");

assert.equal(imageUrlOf("https://imageproxy.wolt.com/a"), "https://imageproxy.wolt.com/a");
assert.equal(imageUrlOf({ url: "https://imageproxy.wolt.com/b", blurhash: "x" }), "https://imageproxy.wolt.com/b");
assert.equal(imageUrlOf([{ url: "https://imageproxy.wolt.com/c" }, { url: "https://imageproxy.wolt.com/d" }]), "https://imageproxy.wolt.com/c");
assert.equal(imageUrlOf([]), null);
assert.equal(imageUrlOf(null), null);
assert.equal(imageUrlOf({ nope: 1 }), null);

const r = rich("products", { query: "milk", items: [{ itemId: "1" }] });
assert.deepEqual(JSON.parse(r.content[0].text), { view: "products", query: "milk", items: [{ itemId: "1" }] }, "the text is the JSON the model always read, tagged with the view");
assert.deepEqual(r.structuredContent, { view: "products", query: "milk", items: [{ itemId: "1" }] }, "structuredContent is the same object");

// Through a real client, in memory.
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = buildServer({ remote: true });
await server.connect(serverTransport);
const client = new Client({ name: "ui-test", version: "1" }, { capabilities: {} });
await client.connect(clientTransport);

const { resources } = await client.listResources();
const res = resources.find((x) => x.uri === UI_RESOURCE_URI);
assert(res, "the cards resource is listed");
assert.equal(res.mimeType, UI_MIME);
assert.equal(res._meta?.ui?.prefersBorder, true);
assert.deepEqual(res._meta?.ui?.csp?.resourceDomains, IMAGE_HOSTS, "image hosts are allowlisted for the widget");
assert.deepEqual(res._meta?.["openai/widgetCSP"]?.resource_domains, IMAGE_HOSTS);
assert.deepEqual(res._meta.ui.csp.connectDomains, PAYMENT_HOSTS);

const read = await client.readResource({ uri: UI_RESOURCE_URI });
const html = read.contents[0].text;
assert.equal(read.contents[0].mimeType, UI_MIME);
assert.match(html, /^<!doctype html>/i);
assert.match(html, /ravelinjs 2\.3\.0/, "official SDK is bundled into the card without an external script fetch");
assert.match(html, /"ui\/initialize"/, "speaks the MCP Apps handshake");
assert.match(html, /ui\/notifications\/tool-result/);
assert.match(html, /window\.openai/, "and ChatGPT's globals as a fallback");
for (const view of ["picks", "products", "dishes", "menu", "venues", "venue", "plan", "baskets", "checkout"]) {
  assert.match(html, new RegExp(`case "${view}"`), `renders the ${view} view`);
}
assert.match(html, /prefers-color-scheme: dark/, "follows the host's dark mode");
// ChatGPT has window.openai.toolOutput set before the script runs, so the
// first render happens during setup: the root must exist by then, and the
// kick-off must come after every declaration it uses.
assert(html.indexOf('var root = document.getElementById("root")') < html.indexOf('request("ui/initialize"'), "root is looked up before the host handshake starts");
assert(html.lastIndexOf("fromOpenAI();") > html.indexOf("function draw("), "the first ChatGPT render runs after the drawing code is defined");
for (const shape of ["structuredContent", "toolResponseMetadata", "call_tool_result", "setInterval"]) {
  assert(html.includes(shape), `the bridge handles late or wrapped ChatGPT data (${shape})`);
}

// show_picks through the client: foreign hosts are stripped, Wolt's kept.
const picks = await client.callTool({ name: "show_picks", arguments: { title: "Dinner", items: [
  { name: "Soup", price: 1200, currency: "EUR", imageUrl: "https://imageproxy.wolt.com/assets/1", url: "https://wolt.com/en/geo/x/restaurant/y" },
  { name: "Cake", imageUrl: "https://cdn.example.com/cake.jpg", url: "https://example.com/" }
] } });
assert.equal(picks.structuredContent.view, "picks");
assert.equal(picks._meta?.["openai/outputTemplate"], UI_RESOURCE_URI, "the result itself names the card template");
assert.equal(picks._meta?.ui?.resourceUri, UI_RESOURCE_URI);
assert.equal(picks.structuredContent.items[0].imageUrl, "https://imageproxy.wolt.com/assets/1");
assert.equal(picks.structuredContent.items[0].url, "https://wolt.com/en/geo/x/restaurant/y");
assert.equal(picks.structuredContent.items[1].imageUrl, undefined, "a foreign picture is dropped");
assert.equal(picks.structuredContent.items[1].url, undefined, "a foreign link is dropped");

const { tools } = await client.listTools();
for (const t of tools) {
  const isRender = !!RENDER_TOOLS[t.name];
  assert.equal(t._meta?.ui?.resourceUri, isRender ? UI_RESOURCE_URI : undefined, `${t.name} ${isRender ? "renders cards" : "stays text-only"}`);
  assert.equal(t._meta?.["openai/outputTemplate"], isRender ? UI_RESOURCE_URI : undefined);
  assert.equal(t.description.endsWith(IMAGE_HINT), isRender, `${t.name}: ${isRender ? "tells the model the photos are Wolt's" : "carries no image hint"}`);
  if (isRender) {
    assert.equal(typeof t._meta["openai/toolInvocation/invoking"], "string");
    assert.equal(t.annotations.readOnlyHint, true, `${t.name}: only read-only tools render cards`);
  }
}
assert.equal(tools.find((t) => t.name === "get_wolt_profile")._meta["openai/profile"], true, "the profile marker survives the merge");
assert(!tools.find((t) => t.name === "add_to_cart")._meta, "writes carry no UI");

await client.close();
await server.close();
console.log(`ui.test.mjs: cards resource served, ${Object.keys(RENDER_TOOLS).length} render tools linked, image refs resolve`);
