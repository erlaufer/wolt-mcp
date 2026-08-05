// Does the server start and present its tools? Offline, so CI can run it.
//
// The unit suite imports lib modules directly and never loads server.mjs, so
// a broken tool registration — a bad zod schema, a typo in a handler, an
// import that only resolves on one machine — would sail through everything
// else and fail on the user's first call instead.
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const { version } = createRequire(import.meta.url)("../package.json");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(HERE, "..", "server.mjs")],
  // A throwaway state dir: booting must never read or write the real one.
  env: { ...process.env, WOLT_STATE_DIR: mkdtempSync(join(tmpdir(), "wolt-boot-")) }
});
const client = new Client({ name: "boot", version: "1" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
assert(tools.length >= 25, `expected the full tool surface, got ${tools.length}`);

// The ones the documented flow depends on, by name.
for (const name of ["wolt_status", "search_products", "plan_cart", "add_to_cart", "checkout_preview", "use_saved_address"]) {
  assert(tools.some((t) => t.name === name), `missing tool: ${name}`);
}
// Every tool needs a description — they are the prompt the client model reads.
for (const t of tools) assert(t.description && t.description.length > 40, `${t.name} needs a real description`);

const info = client.getServerVersion();
assert.equal(info?.version, version, `server reports ${info?.version}, package.json says ${version}`);

await client.close();
console.log(`boot.test.mjs: server starts and serves ${tools.length} tools at v${version}`);
