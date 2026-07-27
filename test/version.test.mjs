// Release guard: the npm package version and the .mcpb manifest version are
// bumped by hand in two different files, and a mismatch ships a bundle whose
// reported version disagrees with the package it contains.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const pkg = read("mcp/package.json");
const manifest = read("mcp/manifest.json");
const lock = read("mcp/package-lock.json");

assert.strictEqual(
  manifest.version, pkg.version,
  `manifest.json version (${manifest.version}) != package.json version (${pkg.version}) — bump both`
);
assert.strictEqual(
  manifest.name, pkg.name,
  `manifest.json name (${manifest.name}) != package.json name (${pkg.name})`
);
assert.strictEqual(
  lock.version, pkg.version,
  `package-lock.json version (${lock.version}) != package.json version (${pkg.version}) — run npm install`
);
assert.strictEqual(
  lock.packages[""].engines.node, pkg.engines.node,
  `lockfile engines (${lock.packages[""].engines.node}) != package.json engines (${pkg.engines.node})`
);

// server.mjs must not reintroduce a hardcoded version string. Slice out the
// actual `new McpServer(...)` argument and check that: a flat regex over the
// file can't see past a nested option object, and matching only `version: "`
// would wave through a single-quoted or templated literal.
const server = readFileSync(join(root, "mcp/server.mjs"), "utf8");
const start = server.indexOf("new McpServer(");
assert.ok(start !== -1, "server.mjs no longer constructs an McpServer — update this guard");
let depth = 0, end = -1;
for (let i = server.indexOf("(", start); i < server.length; i++) {
  if ("({[".includes(server[i])) depth++;
  else if (")}]".includes(server[i]) && --depth === 0) { end = i; break; }
}
assert.ok(end !== -1, "could not find the end of the new McpServer(...) call");
const ctor = server.slice(start, end + 1);
assert.ok(/version:/.test(ctor), `new McpServer({...}) declares no version: ${ctor}`);
assert.ok(
  !/version:\s*['"`]/.test(ctor),
  `server.mjs hardcodes a version — it should read package.json instead: ${ctor}`
);

console.log(`version.test.mjs: package, manifest and lockfile all at ${pkg.version}`);
