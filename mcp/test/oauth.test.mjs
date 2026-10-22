// The OAuth client store under registration pressure, offline: an approved
// client (one with live tokens or a code waiting to be exchanged) survives any
// number of idle registrations; only registrations nobody authorized are
// capped, oldest first.
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { OAuthProvider, MAX_PENDING_CLIENTS } from "../lib/oauth.js";

let clock = 1_700_000_000_000;
const provider = new OAuthProvider({
  issuer: "https://wolt.example.com",
  resource: "https://wolt.example.com/mcp",
  stateDir: mkdtempSync(join(tmpdir(), "wolt-oauth-")),
  guard: { type: "secret", secret: "s" },
  now: () => clock
});
const redirectUri = "https://claude.ai/api/mcp/auth_callback";
const register = (name) => provider.registerClient({ client_name: name, redirect_uris: [redirectUri], token_endpoint_auth_method: "none" });
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

// A host registers and the user approves it: it now holds tokens.
const host = register("Claude");
clock += 1000;
const codeUrl = provider.issueCode({ client: provider.getClient(host.client_id), redirectUri, codeChallenge: challenge, state: null, scope: "wolt", who: "me", accountId: "acc1" });
const code = new URL(codeUrl).searchParams.get("code");
const tokens = provider.token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: host.client_id, redirect_uri: redirectUri });
assert(tokens.refresh_token, "the host is approved and holds a refresh token");

// A second host registered and got as far as a code, not yet exchanged.
const pendingHost = register("ChatGPT");
provider.issueCode({ client: provider.getClient(pendingHost.client_id), redirectUri, codeChallenge: challenge, state: null, scope: "wolt", who: "me", accountId: "acc2" });

// Then a flood of registrations nobody will ever authorize.
const junk = [];
for (let i = 0; i < MAX_PENDING_CLIENTS + 50; i++) { clock += 1000; junk.push(register(`junk ${i}`).client_id); }

assert(provider.getClient(host.client_id), "the approved client is never evicted");
assert(provider.getClient(pendingHost.client_id), "a client mid-authorization is never evicted");
const kept = junk.filter((id) => provider.getClient(id));
assert.equal(kept.length, MAX_PENDING_CLIENTS, "idle registrations are capped");
assert.deepEqual(kept, junk.slice(50), "the oldest idle registrations go first");
assert.equal(Object.keys(provider.state.clients).length, MAX_PENDING_CLIENTS + 2);

// The approved host's refresh still works after the flood.
clock += 1000;
const refreshed = provider.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: host.client_id });
assert(refreshed.access_token && refreshed.refresh_token !== tokens.refresh_token, "refresh rotates as before");

// Once the host's tokens are gone (expired and swept), it is idle again and
// may be evicted like any other registration.
clock += 91 * 24 * 3600 * 1000;
provider.save();
for (let i = 0; i < MAX_PENDING_CLIENTS + 1; i++) { clock += 1000; register(`later ${i}`); }
assert.equal(provider.getClient(host.client_id), null, "a client whose grants all expired is idle and can go");

console.log(`oauth.test.mjs: approved clients survive ${MAX_PENDING_CLIENTS + 50} idle registrations, idle ones are capped at ${MAX_PENDING_CLIENTS}`);
