// The remote transport end to end, offline: discovery, dynamic client
// registration, the approve page, PKCE code exchange, bearer-protected MCP
// calls, refresh rotation, static API tokens, and the Cloudflare Access JWT
// check against a key pair generated here. No network, no credentials — the
// server runs in-process on a loopback port with a throwaway state dir.
import assert from "node:assert";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The lib modules resolve their default state dir from the environment at
// import time, so it is pointed at a scratch directory BEFORE they load: this
// test must never read or write the real ~/.wolt-mcp.
const stateDir = mkdtempSync(join(tmpdir(), "wolt-remote-"));
process.env.WOLT_STATE_DIR = stateDir;
const { buildServer, VERSION, TOOL_ANNOTATIONS, woltProfile } = await import("../server.mjs");

// The identity shape from Wolt's user record, old and new name formats.
assert.deepEqual(woltProfile({ user: { _id: { $oid: "5f1a2b3c4d5e6f7a8b9c0d1e" }, name: { first_name: "Nikita", last_name: "N" }, email: "n@example.com", phone_number: "+1" } }), { id: "5f1a2b3c4d5e6f7a8b9c0d1e", name: "Nikita N", email: "n@example.com", nickname: "Nikita" }, "the live shape: Mongo-style id, name object");
assert.deepEqual(woltProfile({ user: { _id: "u2", name: "Plain Name" } }), { id: "u2", name: "Plain Name" });
assert.equal(woltProfile({ user: { name: "no id" } }), null, "no id → no profile, never an invented one");
const { serveHttp, remoteConfig, parseHttpArgs } = await import("../lib/remote.js");
const { verifyAccessJwt, isAcceptableRedirectUri } = await import("../lib/oauth.js");

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const noLog = () => {};

// --- argument / config parsing ---
assert.equal(parseHttpArgs([], {}), null, "no flag, no env → stdio");
assert.deepEqual(parseHttpArgs(["--http"], {}), { port: 3000, host: "127.0.0.1" });
assert.deepEqual(parseHttpArgs(["--http", "4010"], { WOLT_HTTP_HOST: "0.0.0.0" }), { port: 4010, host: "0.0.0.0" });
assert.deepEqual(parseHttpArgs([], { WOLT_HTTP_PORT: "8080" }), { port: 8080, host: "127.0.0.1" });
assert.throws(() => remoteConfig({ WOLT_PUBLIC_URL: "https://x.example" }), /guard/, "OAuth mode without a guard is refused");
assert.throws(() => remoteConfig({ WOLT_OAUTH_APPROVE_SECRET: "a".repeat(20) }), /WOLT_PUBLIC_URL/, "OAuth mode needs the public URL");
assert.throws(() => remoteConfig({ WOLT_PUBLIC_URL: "http://wolt.example", WOLT_OAUTH_APPROVE_SECRET: "a".repeat(20) }), /https/, "plain http only on loopback");
assert.throws(() => remoteConfig({ WOLT_PUBLIC_URL: "https://x.example", WOLT_CF_ACCESS_TEAM: "nope", WOLT_CF_ACCESS_AUD: "a".repeat(64) }), /team domain/);
assert.equal(remoteConfig({ WOLT_HTTP_AUTH: "none" }).auth, "none");
assert.equal(remoteConfig({ WOLT_PUBLIC_URL: "https://x.example", WOLT_CF_ACCESS_TEAM: "https://team.cloudflareaccess.com/", WOLT_CF_ACCESS_AUD: "b".repeat(64) }).guard.teamDomain, "team.cloudflareaccess.com");

assert(isAcceptableRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect"));
assert(isAcceptableRedirectUri("http://localhost:51234/callback"));
assert(!isAcceptableRedirectUri("http://evil.example/callback"), "plain http off loopback is rejected");
assert(!isAcceptableRedirectUri("https://x.example/cb#frag"));

// --- a server in OAuth mode with the approve-secret guard ---
const port = await freePort();
const publicUrl = `http://127.0.0.1:${port}`;
const SECRET = ["correct", "horse", "battery", "staple"].join("-"); // the approve-page secret for this test
const API_TOKEN = b64url(randomBytes(32));
const realFetch = globalThis.fetch;
const logLines = [];
const srv = await serveHttp({
  buildServer, version: VERSION, port, host: "127.0.0.1", log: (l) => logLines.push(l),
  env: { WOLT_STATE_DIR: stateDir, WOLT_PUBLIC_URL: publicUrl, WOLT_OAUTH_APPROVE_SECRET: SECRET, WOLT_API_TOKENS: API_TOKEN,
    WOLT_OAUTH_CLIENT_ID: "static-client", WOLT_OAUTH_CLIENT_SECRET: "static-secret-with-enough-length" }
});
try {
  const get = (p, init) => fetch(publicUrl + p, { redirect: "manual", ...init });
  const postForm = (p, form, init = {}) => get(p, { method: "POST", body: new URLSearchParams(form), headers: { "content-type": "application/x-www-form-urlencoded", ...(init.headers || {}) }, ...init });
  const mcpPost = (headers = {}) => get("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });

  // Discovery.
  const health = await (await get("/healthz")).json();
  assert.deepEqual(health, { ok: true, version: VERSION, auth: "oauth" });
  const prm = await (await get("/.well-known/oauth-protected-resource")).json();
  assert.equal(prm.resource, `${publicUrl}/mcp`);
  assert.deepEqual(prm.authorization_servers, [publicUrl]);
  const asm = await (await get("/.well-known/oauth-authorization-server")).json();
  assert.equal(asm.issuer, publicUrl);
  assert.equal(asm.token_endpoint, `${publicUrl}/token`);
  assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);

  // Unauthenticated /mcp: the 401 must point at the metadata.
  let r = await mcpPost();
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);
  r = await mcpPost({ authorization: "Bearer not-a-token" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /invalid_token/);
  // No session, so no GET stream and no DELETE.
  r = await get("/mcp", { headers: { accept: "text/event-stream" } });
  assert.equal(r.status, 405);
  r = await get("/mcp", { method: "DELETE" });
  assert.equal(r.status, 405);

  // Dynamic client registration — a public client with a loopback redirect,
  // the shape Claude Code uses.
  const redirectUri = "http://localhost:43123/callback";
  r = await get("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "test client", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }) });
  assert.equal(r.status, 201);
  const reg = await r.json();
  assert(reg.client_id && !reg.client_secret, "public clients get no secret");
  r = await get("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
  assert.equal(r.status, 400, "non-loopback http redirect is refused at registration");

  // Authorization request.
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authz = { client_id: reg.client_id, redirect_uri: redirectUri, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${publicUrl}/mcp` };
  r = await get(`/authorize?${new URLSearchParams(authz)}`);
  assert.equal(r.status, 200, "GET /authorize renders the approve page");
  const html = await r.text();
  let html2;
  assert.match(html, /test client/);
  // The browser enforces form-action on the redirect that follows the POST,
  // so the client's callback origin must be allowed alongside 'self'.
  assert.match(r.headers.get("content-security-policy"), /form-action 'self' http:\/\/localhost:43123;/);
  assert.match(html, /name="secret"/);
  // Unknown client / foreign redirect: shown, never redirected.
  r = await get(`/authorize?${new URLSearchParams({ ...authz, client_id: "nope" })}`);
  assert.equal(r.status, 400);
  r = await get(`/authorize?${new URLSearchParams({ ...authz, redirect_uri: "http://localhost:1/other" })}`);
  assert.equal(r.status, 400);
  // Bad PKCE method: reported back to the client via redirect.
  r = await get(`/authorize?${new URLSearchParams({ ...authz, code_challenge_method: "plain" })}`);
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /error=invalid_request/);
  assert.match(r.headers.get("location"), /state=xyz/);
  // Every approval carries a Wolt refresh token (the server has no account of
  // its own). Wolt's token endpoint is stubbed: it rotates the refresh token
  // and returns an access JWT valid for an hour.
  const fakeJwt = `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
  const woltCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://authentication.wolt.com/")) {
      const refresh = new URLSearchParams(String(init.body)).get("refresh_token");
      woltCalls.push(refresh);
      if (refresh === "pasted-refresh-token") return new Response(JSON.stringify({ access_token: fakeJwt, refresh_token: "rotated-by-wolt" }), { status: 200 });
      return new Response("invalid_grant", { status: 401 });
    }
    return realFetch(url, init);
  };
  const approval = { ...authz, approve: "1", secret: SECRET, wolt_token: "pasted-refresh-token" };
  // Wrong secret: back to the form with an error, no code.
  r = await postForm("/authorize", { ...approval, secret: "wrong" }, { headers: { origin: publicUrl } });
  assert.equal(r.status, 403);
  assert.match(await r.text(), /wrong/);
  // Cross-site post: blocked even with the right secret, whichever signal says so.
  r = await postForm("/authorize", approval, { headers: { origin: "https://evil.example" } });
  assert.equal(r.status, 403);
  r = await postForm("/authorize", approval, { headers: { origin: publicUrl, "sec-fetch-site": "cross-site" } });
  assert.equal(r.status, 403, "Sec-Fetch-Site wins over a spoofable Origin");
  r = await postForm("/authorize", approval, { headers: { origin: "null", "sec-fetch-site": "none" } });
  assert.equal(r.status, 403, "a direct navigation is not an approval");
  // What a real browser sends: Origin may be "null" under a strict referrer
  // policy, Sec-Fetch-Site says same-origin — that must pass.
  r = await postForm("/authorize", approval, { headers: { origin: "null", "sec-fetch-site": "same-origin" } });
  assert.equal(r.status, 302, "browser-shaped same-origin post is accepted");
  // The real thing.
  r = await postForm("/authorize", approval, { headers: { origin: publicUrl } });
  assert.equal(r.status, 302, "right secret → redirect with code");
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, redirectUri);
  assert.equal(loc.searchParams.get("state"), "xyz");
  const code = loc.searchParams.get("code");
  assert(code, "code issued");

  // Token exchange: a wrong verifier burns the code, so get a fresh one first.
  r = await postForm("/token", { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: "not-the-verifier" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "invalid_grant");
  r = await postForm("/token", { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier });
  assert.equal(r.status, 400, "a code is single use even after a failed attempt");

  r = await postForm("/authorize", approval, { headers: { origin: publicUrl } });
  const code2 = new URL(r.headers.get("location")).searchParams.get("code");
  r = await postForm("/token", { grant_type: "authorization_code", code: code2, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier });
  assert.equal(r.status, 200, `token exchange: ${await r.clone().text()}`);
  const tokens = await r.json();
  assert.equal(tokens.token_type, "bearer");
  assert(tokens.access_token && tokens.refresh_token);
  assert.equal(statSync(join(stateDir, "oauth.json")).mode & 0o077, 0, "oauth.json is owner-only");
  assert(!readFileSync(join(stateDir, "oauth.json"), "utf8").includes(tokens.access_token), "tokens are stored hashed");

  // MCP over the bearer, through the real client transport.
  const client = new Client({ name: "remote-test", version: "1" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
  const { tools } = await client.listTools();
  assert(tools.length >= 25, `full tool surface, got ${tools.length}`);
  assert(!tools.some((t) => t.name === "login_via_chrome"), "the browser login is not offered remotely");
  for (const t of tools) {
    assert(TOOL_ANNOTATIONS[t.name], `${t.name} is missing from TOOL_ANNOTATIONS`);
    assert.equal(typeof t.annotations?.readOnlyHint, "boolean", `${t.name} carries readOnlyHint`);
  }
  assert.equal(tools.find((t) => t.name === "search_products").annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "add_to_cart").annotations.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === "clear_basket").annotations.destructiveHint, true);
  // ChatGPT labels the linked account from the tool marked as the profile
  // source; it must advertise the exact {id, name, email, nickname} shape.
  const profileTool = tools.find((t) => t.name === "get_wolt_profile");
  assert.equal(profileTool._meta?.["openai/profile"], true, "get_wolt_profile is the profile source");
  assert.deepEqual(Object.keys(profileTool.outputSchema.properties).sort(), ["email", "id", "name", "nickname"]);
  assert.deepEqual(profileTool.outputSchema.required, ["id"]);
  assert.equal(profileTool.outputSchema.additionalProperties, false);
  assert.match(client.getInstructions(), /wauth2\/access_token/, "remote instructions explain where the refresh token comes from");
  assert.equal(client.getServerVersion()?.version, VERSION);
  await client.close();

  // Refresh: rotates, the old one keeps working briefly, the new one works.
  r = await postForm("/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id });
  assert.equal(r.status, 200);
  const rotated = await r.json();
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  r = await postForm("/token", { grant_type: "refresh_token", refresh_token: rotated.refresh_token, client_id: reg.client_id });
  assert.equal(r.status, 200);
  r = await postForm("/token", { grant_type: "refresh_token", refresh_token: "garbage", client_id: reg.client_id });
  assert.equal(r.status, 400);
  // A refresh token can't be used by another client.
  r = await postForm("/token", { grant_type: "refresh_token", refresh_token: rotated.refresh_token, client_id: "static-client", client_secret: "static-secret-with-enough-length" });
  assert.equal(r.status, 400);
  // The static client authenticates with Basic and a bad secret is refused.
  r = await postForm("/token", { grant_type: "refresh_token", refresh_token: "x" }, { headers: { authorization: "Basic " + Buffer.from("static-client:wrong").toString("base64") } });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "invalid_client");

  // Static API token.
  r = await mcpPost({ authorization: `Bearer ${API_TOKEN}` });
  assert.equal(r.status, 200, "configured API token is accepted");
  r = await mcpPost({ authorization: `Bearer ${API_TOKEN.slice(0, -1)}x` });
  assert.equal(r.status, 401);

  // --- per-connection Wolt accounts ---
  // wolt_status through a bearer, parsed. getAccessToken() is exercised for
  // real: with no token it fails with the remote setup message (no network),
  // with a stored unexpired JWT it returns it (no network either).
  const statusVia = async (bearer) => {
    const c = new Client({ name: "remote-test", version: "1" }, { capabilities: {} });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
    const out = await c.callTool({ name: "wolt_status", arguments: {} });
    await c.close();
    return JSON.parse(out.content[0].text);
  };
  // A fixed API token has a slot of its own, not connected until set_wolt_token;
  // remotely the IP is never used as a location guess either.
  let st = await statusVia(API_TOKEN);
  assert.equal(st.loginNeeded, true);
  assert.match(st.loginDetail, /developer tools/, "remote setup message explains the DevTools route");
  assert.match(st.stateFile, /\/accounts\/api-[A-Za-z0-9_-]{16}\/tokens\.json$/, "API tokens get their own slot");
  assert.equal(st.location.label, "not set (estimated from IP on first search)");
  assert(!existsSync(join(stateDir, "tokens.json")), "the state dir root never holds an account");
  // The approve page requires a Wolt token; an approval without one is refused.
  r = await get(`/authorize?${new URLSearchParams(authz)}`);
  html2 = await r.text();
  assert.match(html2, /name="wolt_token"[^>]*required/);
  assert.match(html2, /authentication\.wolt\.com\/v1\/wauth2\/access_token/, "the page explains the DevTools route");
  assert.match(html2, /<details>.*For developers.*server\.mjs login/s, "the CLI route is folded away");
  r = await postForm("/authorize", { ...authz, approve: "1", secret: SECRET }, { headers: { origin: publicUrl } });
  assert.equal(r.status, 403, "no Wolt token, no grant");
  assert.match(await r.text(), /refresh token is required/);

  {
    r = await postForm("/authorize", { ...authz, approve: "1", secret: SECRET, wolt_token: "%22bad-token%22" }, { headers: { origin: publicUrl } });
    assert.equal(r.status, 403, "a refresh token Wolt rejects is caught on the page");
    assert.match(await r.text(), /did not accept that refresh token/);
    assert.equal(woltCalls.at(-1), "bad-token", "cookie wrapping is peeled before the exchange");

    r = await postForm("/authorize", { ...authz, approve: "1", secret: SECRET, wolt_token: "pasted-refresh-token" }, { headers: { origin: publicUrl } });
    assert.equal(r.status, 302, "a working refresh token is accepted");
    const code3 = new URL(r.headers.get("location")).searchParams.get("code");
    r = await postForm("/token", { grant_type: "authorization_code", code: code3, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier });
    assert.equal(r.status, 200);
    const own = await r.json();

    st = await statusVia(own.access_token);
    assert.equal(st.loginNeeded, false, "the pasted account is connected");
    assert.match(st.stateFile, new RegExp(`^${stateDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/accounts/[A-Za-z0-9_-]+/tokens\.json$`), "its tokens live in an account slot");
    assert.equal(statSync(st.stateFile).mode & 0o077, 0, "slot tokens are owner-only");
    const slot = JSON.parse(readFileSync(st.stateFile, "utf8"));
    assert.equal(slot.refreshToken, "pasted-refresh-token", "the paste stays pinned as bootstrap");
    assert.equal(slot.rotatedRefreshToken, "rotated-by-wolt", "the rotation from validation is kept");
    assert.equal(st.location.label, "not set (estimated from IP on first search)", "a new account has no location until it sets one");
    // Unaffected: the API token's slot.
    st = await statusVia(API_TOKEN);
    assert.equal(st.loginNeeded, true);
    // The account survives a refresh of the OAuth grant.
    r = await postForm("/token", { grant_type: "refresh_token", refresh_token: own.refresh_token, client_id: reg.client_id });
    assert.equal(r.status, 200);
    st = await statusVia((await r.json()).access_token);
    assert.equal(st.loginNeeded, false, "refreshed grant keeps its account");

    // Ordering: off on that grant, on for a grant approved with the box
    // ticked, with the cap carried in the record and across refreshes.
    const orderVia = async (bearer) => {
      const c = new Client({ name: "remote-test", version: "1" }, { capabilities: {} });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
      const out = await c.callTool({ name: "place_order", arguments: { quote_id: "6f1e0d8e-0e7a-4f1c-9a4e-2b6c7d8e9f00", total: 1 } });
      await c.close();
      return out.content[0].text;
    };
    assert.match(await orderVia(own.access_token), /not allowed to place orders/, "an ordinary grant cannot pay");
    assert.match(html2, /name="allow_orders"/, "the approve page offers ordering");
    assert.match(html2, /name="order_cap"/);
    assert(!/name="allow_orders"[^>]*checked/.test(html2), "and it is off by default");
    r = await postForm("/authorize", { ...authz, approve: "1", secret: SECRET, wolt_token: "pasted-refresh-token", allow_orders: "1", order_cap: "50" }, { headers: { origin: publicUrl } });
    assert.equal(r.status, 302);
    const code4 = new URL(r.headers.get("location")).searchParams.get("code");
    r = await postForm("/token", { grant_type: "authorization_code", code: code4, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier });
    const ordered = await r.json();
    assert.equal(ordered.scope, "wolt order", "the box, not the client's request, sets the scope");
    const recs = Object.values(JSON.parse(readFileSync(join(stateDir, "oauth.json"), "utf8")).tokens).filter((t) => t.scope === "wolt order");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].orderCap, 5000, "the cap is stored in minor units");
    assert.match(await orderVia(ordered.access_token), /unknown or was replaced/, "the gate is open; only the quote is missing");
    r = await postForm("/token", { grant_type: "refresh_token", refresh_token: ordered.refresh_token, client_id: reg.client_id });
    const refreshedOrder = await r.json();
    assert.equal(refreshedOrder.scope, "wolt order");
    assert.match(await orderVia(refreshedOrder.access_token), /unknown or was replaced/, "the permission survives a refresh");
  }
} finally {
  globalThis.fetch = realFetch;
  // The access log names the JSON-RPC method and the client, never parameters.
  assert(logLines.some((l) => /^POST \/mcp tools\/list \(\S+\) 200 \d+ms$/.test(l)), `a tools/list line is logged: ${logLines.filter((l) => l.includes("/mcp")).slice(-3).join(" | ")}`);
  assert(!logLines.some((l) => l.includes(API_TOKEN)), "tokens never reach the log");
  await srv.close();
}

// --- auth: none, for a trusted network ---
const port2 = await freePort();
const srv2 = await serveHttp({ buildServer, version: VERSION, port: port2, host: "127.0.0.1", log: noLog, env: { WOLT_STATE_DIR: stateDir, WOLT_HTTP_AUTH: "none" } });
try {
  const r = await fetch(`http://127.0.0.1:${port2}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port2}/.well-known/oauth-authorization-server`)).status, 404, "no OAuth metadata when auth is off");
} finally {
  await srv2.close();
}

// --- Cloudflare Access JWT verification against a local key pair ---
{
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const team = "team.cloudflareaccess.com", aud = "c".repeat(64);
  let certFetches = 0;
  const fetchImpl = async (url) => { certFetches++; assert.equal(url, `https://${team}/cdn-cgi/access/certs`); return { ok: true, json: async () => ({ keys: [jwk] }) }; };
  const mint = (claims, kid = "k1") => {
    const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const p = b64url(JSON.stringify(claims));
    return `${h}.${p}.${b64url(sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey))}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: `https://${team}`, aud: [aud], exp: now + 600, iat: now, nbf: now - 10, email: "me@example.com", sub: "sub1" };
  assert.deepEqual(await verifyAccessJwt(mint(good), { teamDomain: team, aud }, fetchImpl), { email: "me@example.com", sub: "sub1" });
  await assert.rejects(verifyAccessJwt(mint({ ...good, aud: ["d".repeat(64)] }), { teamDomain: team, aud }, fetchImpl), /audience/);
  await assert.rejects(verifyAccessJwt(mint({ ...good, exp: now - 120 }), { teamDomain: team, aud }, fetchImpl), /expired/);
  await assert.rejects(verifyAccessJwt(mint({ ...good, iss: "https://other.cloudflareaccess.com" }), { teamDomain: team, aud }, fetchImpl), /issuer/);
  const [h, p] = mint(good).split(".");
  await assert.rejects(verifyAccessJwt(`${h}.${p}.${b64url(randomBytes(256))}`, { teamDomain: team, aud }, fetchImpl), /signature/);
  await assert.rejects(verifyAccessJwt(mint(good, "k2"), { teamDomain: team, aud }, fetchImpl), /key not found/);
  assert(certFetches <= 3, `certs are cached, fetched ${certFetches} times`);
}

console.log("remote.test.mjs: HTTP transport, OAuth flow, API tokens and Access JWT check pass");
