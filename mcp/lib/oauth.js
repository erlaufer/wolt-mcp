// OAuth 2.1 for the remote transport: this server is both the authorization
// server and the protected resource, because the thing being protected is a
// single person's Wolt account and there is no identity provider to delegate
// to. What a client goes through:
//
//   1. POST /mcp without a token → 401 pointing at the protected-resource
//      metadata, which names this same origin as the authorization server.
//   2. The client registers itself (RFC 7591) or uses the operator's static
//      client, then sends the user to /authorize with a PKCE challenge.
//   3. /authorize is where the human is checked. Two guards exist: Cloudflare
//      Access in front of the path (the server verifies Access's signed JWT
//      header), or a shared approve secret typed into the page. Either way the
//      user clicks Allow — an auto-approve would let any site that registered
//      a client silently take a code from a logged-in browser.
//   4. The code is exchanged at /token (PKCE S256 verified, client secret if
//      the client has one) for an opaque bearer plus a rotating refresh token.
//
// Tokens are stored hashed in <state dir>/oauth.json, mode 600. Codes live in
// memory only — ten minutes, single use — so a restart just means one more
// click. Nothing here is specific to Wolt; lib/remote.js wires it to HTTP.
import { createHash, randomBytes, timingSafeEqual, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";

export const ACCESS_TOKEN_TTL_S = 7 * 24 * 3600;
export const REFRESH_TOKEN_TTL_S = 90 * 24 * 3600;
const CODE_TTL_MS = 10 * 60 * 1000;
// A superseded refresh token keeps working this long, so a client that lost
// the response to its refresh (network blip, process killed) can retry instead
// of being bounced back to the browser.
const SUPERSEDED_GRACE_MS = 60 * 1000;
const MAX_CLIENTS = 100;
const AUTH_METHODS = new Set(["none", "client_secret_basic", "client_secret_post"]);

const sha256 = (s) => createHash("sha256").update(String(s)).digest("base64url");
const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
function safeEqual(a, b) {
  const A = Buffer.from(String(a ?? "")), B = Buffer.from(String(b ?? ""));
  return A.length === B.length && A.length > 0 && timingSafeEqual(A, B);
}

export const newAccountId = () => randomToken(12);

export class OAuthError extends Error {
  constructor(status, error, description) {
    super(description || error);
    this.status = status;
    this.error = error;
    this.description = description || null;
  }
  body() { return { error: this.error, ...(this.description ? { error_description: this.description } : {}) }; }
}

// A redirect URI a client may register: https anywhere, plain http only on
// loopback (Claude Code and other local clients listen on a random port).
export function isAcceptableRedirectUri(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return false; }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return false;
}

export class OAuthProvider {
  // issuer: the public origin, no trailing slash. resource: the MCP endpoint.
  // guard: { type: "cf-access", teamDomain, aud, emails? } | { type: "secret", secret }
  // staticClient: { clientId, clientSecret, redirectUris, name } | null
  constructor({ issuer, resource, stateDir, guard, staticClient = null, fetchImpl = fetch, now = () => Date.now() }) {
    this.issuer = issuer.replace(/\/+$/, "");
    this.resource = resource;
    this.file = join(stateDir, "oauth.json");
    this.guard = guard;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.staticClient = staticClient ? {
      clientId: staticClient.clientId,
      secretHash: sha256(staticClient.clientSecret),
      redirectUris: staticClient.redirectUris,
      name: staticClient.name || "configured client",
      authMethod: "client_secret_basic"
    } : null;
    this.codes = new Map();
    this.state = this.load();
  }

  load() {
    let s = {};
    try { s = JSON.parse(readFileSync(this.file, "utf8")); } catch (e) {}
    return { clients: s.clients || {}, tokens: s.tokens || {}, refreshTokens: s.refreshTokens || {} };
  }

  save() {
    const now = this.now();
    for (const [k, v] of Object.entries(this.state.tokens)) if (v.exp <= now) delete this.state.tokens[k];
    for (const [k, v] of Object.entries(this.state.refreshTokens)) {
      if (v.exp <= now || (v.supersededAt && now - v.supersededAt > SUPERSEDED_GRACE_MS)) delete this.state.refreshTokens[k];
    }
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    try { chmodSync(this.file, 0o600); } catch (e) {}
  }

  // --- discovery (RFC 8414 / RFC 9728) ---

  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      scopes_supported: ["wolt"],
      service_documentation: "https://github.com/erlaufer/wolt-mcp/blob/main/docs/remote.md"
    };
  }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["wolt"],
      resource_name: "wolt-mcp"
    };
  }

  // --- clients ---

  getClient(clientId) {
    if (!clientId) return null;
    if (this.staticClient && clientId === this.staticClient.clientId) return this.staticClient;
    return this.state.clients[clientId] || null;
  }

  // Dynamic client registration. Open by design: registering buys nothing
  // without passing /authorize, which is where the human is. The store is
  // capped so an abuser can't grow the file without bound.
  registerClient(body) {
    if (!body || typeof body !== "object") throw new OAuthError(400, "invalid_client_metadata", "JSON object expected");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new OAuthError(400, "invalid_redirect_uri", "redirect_uris must list 1-10 URIs");
    for (const u of uris) {
      if (typeof u !== "string" || !isAcceptableRedirectUri(u)) throw new OAuthError(400, "invalid_redirect_uri", `redirect URI not acceptable: ${String(u).slice(0, 200)}`);
    }
    const authMethod = body.token_endpoint_auth_method || "client_secret_basic";
    if (!AUTH_METHODS.has(authMethod)) throw new OAuthError(400, "invalid_client_metadata", `unsupported token_endpoint_auth_method ${authMethod}`);
    const grants = Array.isArray(body.grant_types) && body.grant_types.length ? body.grant_types : ["authorization_code", "refresh_token"];
    for (const g of grants) if (!["authorization_code", "refresh_token"].includes(g)) throw new OAuthError(400, "invalid_client_metadata", `unsupported grant_type ${g}`);
    if (!grants.includes("authorization_code")) throw new OAuthError(400, "invalid_client_metadata", "authorization_code grant is required");
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "unnamed client";

    const clientId = randomToken(16);
    const clientSecret = authMethod === "none" ? null : randomToken(32);
    const createdAt = this.now();
    this.state.clients[clientId] = { clientId, secretHash: clientSecret ? sha256(clientSecret) : null, redirectUris: uris, name, authMethod, createdAt };
    const ids = Object.keys(this.state.clients);
    if (ids.length > MAX_CLIENTS) {
      ids.sort((a, b) => this.state.clients[a].createdAt - this.state.clients[b].createdAt);
      for (const id of ids.slice(0, ids.length - MAX_CLIENTS)) delete this.state.clients[id];
    }
    this.save();
    return {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(createdAt / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: authMethod,
      grant_types: grants,
      response_types: ["code"]
    };
  }

  // --- authorization ---

  // Checks an /authorize request. Errors in the client identity or redirect
  // URI are fatal (shown to the user, never redirected — that would make us
  // an open redirector); everything else is reported back to the client.
  validateAuthorizeRequest(q) {
    const client = this.getClient(q.client_id);
    if (!client) throw new OAuthError(400, "invalid_client", "unknown client_id");
    const redirectUri = q.redirect_uri;
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) throw new OAuthError(400, "invalid_request", "redirect_uri is not registered for this client");
    const fail = (error, description) => {
      const e = new OAuthError(302, error, description);
      e.redirectTo = redirectWith(redirectUri, { error, error_description: description, ...(q.state ? { state: q.state } : {}) });
      throw e;
    };
    if (q.response_type !== "code") fail("unsupported_response_type", "only response_type=code is supported");
    if (!q.code_challenge) fail("invalid_request", "code_challenge is required (PKCE)");
    if ((q.code_challenge_method || "plain") !== "S256") fail("invalid_request", "code_challenge_method must be S256");
    if (q.resource && q.resource !== this.resource && q.resource !== this.issuer && q.resource !== `${this.issuer}/`) fail("invalid_target", `this server only issues tokens for ${this.resource}`);
    return { client, redirectUri, codeChallenge: q.code_challenge, state: q.state || null, scope: q.scope || "wolt" };
  }

  issueCode({ client, redirectUri, codeChallenge, state, scope, who, accountId = null }) {
    const code = randomToken(32);
    this.codes.set(code, { clientId: client.clientId, redirectUri, codeChallenge, scope, who: who || null, accountId, exp: this.now() + CODE_TTL_MS });
    for (const [k, v] of this.codes) if (v.exp <= this.now()) this.codes.delete(k);
    return redirectWith(redirectUri, { code, ...(state ? { state } : {}) });
  }

  // Human check behind /authorize. Returns { ok: true, who } or throws an
  // OAuthError the page renders.
  async checkGuard({ headers, body }) {
    const g = this.guard;
    if (g.type === "cf-access") {
      const jwt = headers["cf-access-jwt-assertion"];
      if (!jwt) throw new OAuthError(401, "access_denied", "This page must be reached through Cloudflare Access (no Cf-Access-Jwt-Assertion header).");
      let claims;
      try { claims = await verifyAccessJwt(jwt, g, this.fetchImpl, this.now()); } catch (e) { throw new OAuthError(401, "access_denied", `Cloudflare Access token rejected: ${e.message}`); }
      if (g.emails?.length && !g.emails.includes((claims.email || "").toLowerCase())) throw new OAuthError(403, "access_denied", "This Cloudflare Access identity is not allowed to connect.");
      return { ok: true, who: claims.email || claims.sub || "cf-access" };
    }
    if (g.type === "secret") {
      if (body?.secret == null) return { ok: false }; // first visit — render the form
      if (!safeEqual(body.secret, g.secret)) throw new OAuthError(403, "access_denied", "That approve secret is wrong.");
      return { ok: true, who: "approve-secret" };
    }
    throw new OAuthError(500, "server_error", "no authorize guard configured");
  }

  // --- tokens ---

  // The token endpoint. `params` is the parsed form/JSON body; `authorization`
  // the raw header, for client_secret_basic.
  token(params, authorization) {
    const { clientId, clientSecret } = clientCredentials(params, authorization);
    const client = this.getClient(clientId);
    if (!client) throw new OAuthError(401, "invalid_client", "unknown client");
    if (client.secretHash) {
      if (!clientSecret || !safeEqual(sha256(clientSecret), client.secretHash)) throw new OAuthError(401, "invalid_client", "client authentication failed");
    }
    const now = this.now();
    if (params.grant_type === "authorization_code") {
      const rec = this.codes.get(params.code);
      this.codes.delete(params.code); // single use, even when the exchange fails
      if (!rec || rec.exp <= now) throw new OAuthError(400, "invalid_grant", "authorization code is unknown or expired");
      if (rec.clientId !== client.clientId) throw new OAuthError(400, "invalid_grant", "authorization code was issued to another client");
      if (params.redirect_uri && params.redirect_uri !== rec.redirectUri) throw new OAuthError(400, "invalid_grant", "redirect_uri does not match the authorization request");
      if (!params.code_verifier || !safeEqual(sha256(params.code_verifier), rec.codeChallenge)) throw new OAuthError(400, "invalid_grant", "PKCE verification failed");
      return this.issueTokens(client, rec.scope, rec.who, rec.accountId);
    }
    if (params.grant_type === "refresh_token") {
      const h = sha256(params.refresh_token || "");
      const rec = this.state.refreshTokens[h];
      if (!rec || rec.exp <= now || rec.clientId !== client.clientId) throw new OAuthError(400, "invalid_grant", "refresh token is unknown, expired or belongs to another client");
      if (rec.supersededAt && now - rec.supersededAt > SUPERSEDED_GRACE_MS) {
        delete this.state.refreshTokens[h];
        this.save();
        throw new OAuthError(400, "invalid_grant", "refresh token was already rotated");
      }
      if (!rec.supersededAt) rec.supersededAt = now;
      return this.issueTokens(client, rec.scope, rec.who, rec.accountId);
    }
    throw new OAuthError(400, "unsupported_grant_type", "use authorization_code or refresh_token");
  }

  // accountId: which Wolt account slot this grant uses (null = the server's
  // own). It is fixed at approval time and survives every refresh.
  issueTokens(client, scope, who, accountId = null) {
    const access = randomToken(32), refresh = randomToken(32);
    const now = this.now();
    this.state.tokens[sha256(access)] = { clientId: client.clientId, scope, who, accountId, exp: now + ACCESS_TOKEN_TTL_S * 1000, issuedAt: now };
    this.state.refreshTokens[sha256(refresh)] = { clientId: client.clientId, scope, who, accountId, exp: now + REFRESH_TOKEN_TTL_S * 1000, issuedAt: now };
    this.save();
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope };
  }

  // The bearer check every /mcp request goes through. Returns the token record
  // or null; never throws, so a garbage header is just "not authenticated".
  verifyBearer(token) {
    if (!token) return null;
    const rec = this.state.tokens[sha256(token)];
    if (!rec || rec.exp <= this.now()) return null;
    return rec;
  }
}

function redirectWith(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

function clientCredentials(params, authorization) {
  const m = /^Basic\s+(.+)$/i.exec(authorization || "");
  if (m) {
    let decoded = "";
    try { decoded = Buffer.from(m[1], "base64").toString("utf8"); } catch (e) {}
    const i = decoded.indexOf(":");
    if (i > 0) {
      const dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
      return { clientId: dec(decoded.slice(0, i)), clientSecret: dec(decoded.slice(i + 1)) };
    }
  }
  return { clientId: params.client_id || null, clientSecret: params.client_secret || null };
}

// --- Cloudflare Access JWT (the cf-access guard) ---
//
// Access puts a signed RS256 JWT in Cf-Access-Jwt-Assertion on every request
// it lets through. Verifying it here means the guard holds even if someone
// reaches the origin by a path Access doesn't cover.
const jwksCache = new Map(); // teamDomain → { keys, at }
const JWKS_TTL_MS = 60 * 60 * 1000;

async function accessKeys(teamDomain, fetchImpl, force = false) {
  const cached = jwksCache.get(teamDomain);
  if (cached && !force && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
  const r = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`Access certs: HTTP ${r.status}`);
  const keys = (await r.json())?.keys || [];
  jwksCache.set(teamDomain, { keys, at: Date.now() });
  return keys;
}

export async function verifyAccessJwt(jwt, { teamDomain, aud }, fetchImpl = fetch, nowMs = Date.now()) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (e) { throw new Error("malformed token"); }
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);
  let keys = await accessKeys(teamDomain, fetchImpl);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await accessKeys(teamDomain, fetchImpl, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error("signing key not found");
  const ok = cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  if (!ok) throw new Error("bad signature");
  const now = Math.floor(nowMs / 1000);
  if (payload.iss !== `https://${teamDomain}`) throw new Error("issuer mismatch");
  if (!(payload.exp > now - 30)) throw new Error("token expired");
  if (payload.nbf && payload.nbf > now + 30) throw new Error("token not yet valid");
  const auds = [].concat(payload.aud || []);
  if (!auds.includes(aud)) throw new Error("audience mismatch");
  return { email: payload.email || null, sub: payload.sub || null };
}
