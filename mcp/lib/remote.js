// Remote transport: Streamable HTTP on plain node:http, stateless, behind the
// OAuth server in oauth.js. `node server.mjs --http` (or WOLT_HTTP_PORT) runs
// it; docs/remote.md covers deployment.
//
// Stateless means every /mcp request gets its own McpServer and transport,
// which live exactly as long as the response. There is no session id to lose
// across restarts or replicas, and nothing a client could leave behind. The
// per-request cost is registering 29 tools, about a millisecond.
//
// Env (all WOLT_-prefixed):
//   HTTP_PORT, HTTP_HOST        where to listen (3000, 127.0.0.1; 0.0.0.0 in Docker)
//   HTTP_AUTH                   "oauth" (default) or "none" — none is for a trusted
//                               private network only and is announced on stderr
//   PUBLIC_URL                  the origin clients use, e.g. https://wolt.example.com
//   CF_ACCESS_TEAM + CF_ACCESS_AUD   guard /authorize with Cloudflare Access
//   CF_ACCESS_EMAILS            optional comma list narrowing who may approve
//   OAUTH_APPROVE_SECRET        the other guard: a secret typed into the approve page
//   OAUTH_CLIENT_ID/_SECRET     optional static client (ChatGPT's "static credentials")
//   OAUTH_REDIRECT_URIS         the static client's redirect URIs, comma-separated
//   API_TOKENS                  optional comma list of long-lived bearer tokens for
//                               clients that can only send a fixed header (a desktop
//                               agent's "bearer token" field, an iOS Shortcut); each
//                               gets its own account slot, connected via set_wolt_token
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { OAuthProvider, OAuthError, newAccountId } from "./oauth.js";
import { setRemoteMode, validateRefreshToken, adoptTokens } from "./auth.js";
import { withStateDir, accountStateDir } from "./context.js";
import { orderingFromEnv } from "./order.js";
import { PaymentContextService, paymentPage, paymentSdk } from "./payment-context.js";

const DEFAULT_STATIC_REDIRECTS = [
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chat.openai.com/connector_platform_oauth_redirect",
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback"
];
const BODY_LIMIT = 64 * 1024;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const FAILURES_ALLOWED = 10;

// `--http [port]` on the command line, or WOLT_HTTP_PORT in the environment.
// Returns null for the stdio default.
export function parseHttpArgs(argv, env = process.env) {
  const i = argv.indexOf("--http");
  if (i === -1 && !env.WOLT_HTTP_PORT) return null;
  const fromArg = i !== -1 && /^\d+$/.test(argv[i + 1] || "") ? argv[i + 1] : null;
  const port = Number(fromArg ?? env.WOLT_HTTP_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid HTTP port ${fromArg ?? env.WOLT_HTTP_PORT}`);
  return { port, host: env.WOLT_HTTP_HOST || "127.0.0.1" };
}

// Reads and validates the remote configuration. Throws a message meant to be
// read by whoever is deploying, not by a model.
export function remoteConfig(env = process.env) {
  const auth = (env.WOLT_HTTP_AUTH || "oauth").toLowerCase();
  if (!["oauth", "none"].includes(auth)) throw new Error(`WOLT_HTTP_AUTH must be "oauth" or "none", not "${env.WOLT_HTTP_AUTH}"`);
  const stateDir = env.WOLT_STATE_DIR || join(homedir(), ".wolt-mcp");
  const apiTokens = (env.WOLT_API_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const t of apiTokens) if (t.length < 32) throw new Error("each WOLT_API_TOKENS entry must be at least 32 characters (try: openssl rand -base64 32)");
  if (auth === "none") return { auth, stateDir, apiTokens, publicUrl: (env.WOLT_PUBLIC_URL || "").replace(/\/+$/, "") || null, guard: null, staticClient: null };

  const publicUrl = (env.WOLT_PUBLIC_URL || "").replace(/\/+$/, "");
  let u;
  try { u = new URL(publicUrl); } catch (e) { throw new Error("WOLT_PUBLIC_URL is required in OAuth mode (the https origin clients will use, e.g. https://wolt.example.com)"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error("WOLT_PUBLIC_URL must be https (plain http is allowed on localhost only)");
  if (u.pathname !== "/" || u.search || u.hash) throw new Error("WOLT_PUBLIC_URL must be a bare origin, without a path");

  let guard;
  if (env.WOLT_CF_ACCESS_TEAM || env.WOLT_CF_ACCESS_AUD) {
    const teamDomain = (env.WOLT_CF_ACCESS_TEAM || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(teamDomain)) throw new Error("WOLT_CF_ACCESS_TEAM must be your Access team domain, e.g. myteam.cloudflareaccess.com");
    if (!/^[0-9a-f]{64}$/i.test(env.WOLT_CF_ACCESS_AUD || "")) throw new Error("WOLT_CF_ACCESS_AUD must be the Access application's Audience tag (64 hex chars)");
    const emails = (env.WOLT_CF_ACCESS_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    guard = { type: "cf-access", teamDomain, aud: env.WOLT_CF_ACCESS_AUD, emails };
  } else if (env.WOLT_OAUTH_APPROVE_SECRET) {
    if (env.WOLT_OAUTH_APPROVE_SECRET.length < 16) throw new Error("WOLT_OAUTH_APPROVE_SECRET must be at least 16 characters");
    guard = { type: "secret", secret: env.WOLT_OAUTH_APPROVE_SECRET };
  } else {
    throw new Error("OAuth mode needs a guard for /authorize: set WOLT_CF_ACCESS_TEAM + WOLT_CF_ACCESS_AUD (Cloudflare Access) or WOLT_OAUTH_APPROVE_SECRET (a secret typed into the approve page)");
  }

  let staticClient = null;
  if (env.WOLT_OAUTH_CLIENT_ID || env.WOLT_OAUTH_CLIENT_SECRET) {
    if (!env.WOLT_OAUTH_CLIENT_ID || !env.WOLT_OAUTH_CLIENT_SECRET) throw new Error("WOLT_OAUTH_CLIENT_ID and WOLT_OAUTH_CLIENT_SECRET go together");
    if (env.WOLT_OAUTH_CLIENT_SECRET.length < 16) throw new Error("WOLT_OAUTH_CLIENT_SECRET must be at least 16 characters");
    const redirectUris = (env.WOLT_OAUTH_REDIRECT_URIS || DEFAULT_STATIC_REDIRECTS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
    staticClient = { clientId: env.WOLT_OAUTH_CLIENT_ID, clientSecret: env.WOLT_OAUTH_CLIENT_SECRET, redirectUris, name: "configured client" };
  }
  return { auth, stateDir, apiTokens, publicUrl, guard, staticClient };
}

// Starts the HTTP server. Resolves once listening with { port, url, close }.
export async function serveHttp({ buildServer, version, port, host, env = process.env, log = (line) => console.error(line), fetchImpl = fetch }) {
  const cfg = remoteConfig(env);
  setRemoteMode(true);
  const provider = cfg.auth === "oauth"
    ? new OAuthProvider({ issuer: cfg.publicUrl, resource: `${cfg.publicUrl}/mcp`, stateDir: cfg.stateDir, guard: cfg.guard, staticClient: cfg.staticClient, fetchImpl })
    : null;
  const failures = new Map(); // ip → { count, resetAt }
  const paymentContext = new PaymentContextService({ stateDir: cfg.stateDir, publicUrl: cfg.publicUrl, publicKey: env.WOLT_RAVELIN_PUBLIC_KEY || null, fetchImpl });

  const server = createServer((req, res) => {
    const started = Date.now();
    const path = (req.url || "/").split("?")[0];
    res.on("finish", () => log(`${req.method} ${path}${req.rpcLabel ? ` ${req.rpcLabel}` : ""} ${res.statusCode} ${Date.now() - started}ms`));
    handle(req, res, path).catch((e) => {
      if (e instanceof OAuthError) return sendJson(res, e.status === 302 ? 400 : e.status, e.body());
      log(`error on ${req.method} ${path}: ${e?.stack || e}`);
      if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
      else res.end();
    });
  });

  async function handle(req, res, path) {
    if (path === "/payment-context" || path.startsWith("/payment-context/")) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (path === "/payment-context" && req.method === "GET") {
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' https://*.ravelin.click; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(paymentPage());
      }
      if (path === "/payment-context/sdk.js" && req.method === "GET") { res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" }); return res.end(paymentSdk()); }
      if (path === "/payment-context/config" && req.method === "GET") {
        try { return sendJson(res, 200, await paymentContext.config()); }
        catch (e) { return sendJson(res, 503, { error: e.message }); }
      }
      if (path === "/payment-context" && req.method === "POST") {
        if (req.headers.origin !== cfg.publicUrl || !/^application\/json\b/i.test(req.headers["content-type"] || "")) return sendJson(res, 403, { error: "same-origin browser request required" });
        try { return sendJson(res, 200, paymentContext.complete(await readBody(req))); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    cors(res);
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    const url = new URL(req.url || "/", cfg.publicUrl || `http://${req.headers.host || "localhost"}`);

    if (path === "/healthz") return sendJson(res, 200, { ok: true, version, auth: cfg.auth });
    if (path === "/" && req.method === "GET") return sendText(res, 200, `wolt-mcp ${version}: MCP endpoint at /mcp (Streamable HTTP). See https://github.com/erlaufer/wolt-mcp/blob/main/docs/remote.md`);

    if (path === "/mcp") return mcp(req, res);

    if (!provider) return sendJson(res, 404, { error: "not_found" });
    if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") return sendJson(res, 200, provider.protectedResourceMetadata());
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp") return sendJson(res, 200, provider.authorizationServerMetadata());
    if (path === "/register" && req.method === "POST") return sendJson(res, 201, provider.registerClient(await readBody(req)));
    if (path === "/authorize" && (req.method === "GET" || req.method === "POST")) return authorize(req, res, url);
    if (path === "/token" && req.method === "POST") return token(req, res);
    return sendJson(res, 404, { error: "not_found" });
  }

  // Static tokens are compared by hash so the comparison is constant-time and
  // the plain values never sit next to each other in memory longer than needed.
  const apiTokenHashes = cfg.apiTokens.map((t) => createHash("sha256").update(t).digest());
  const isApiToken = (t) => {
    const h = createHash("sha256").update(t).digest();
    return apiTokenHashes.some((k) => timingSafeEqual(h, k));
  };

  async function mcp(req, res) {
    // Stateless: there is no session to resume or end, and a GET would only
    // open an SSE stream nothing ever writes to. POST is the whole protocol.
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST" }, id: null });
    }
    let grant = null; // the OAuth token record; null for a fixed API token
    let presentedToken = null;
    if (provider || cfg.apiTokens.length) {
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
      const presented = m ? m[1].trim() : null;
      if (presented && !isApiToken(presented) && provider) grant = provider.verifyBearer(presented);
      const ok = presented && (isApiToken(presented) || grant);
      presentedToken = presented;
      if (!ok) {
        if (!provider) {
          res.setHeader("WWW-Authenticate", 'Bearer realm="wolt-mcp"');
          return sendJson(res, 401, { error: "unauthorized", error_description: "This MCP server needs a bearer token." });
        }
        const meta = `resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource"`;
        res.setHeader("WWW-Authenticate", m ? `Bearer error="invalid_token", error_description="token is unknown or expired", ${meta}` : `Bearer ${meta}`);
        return sendJson(res, 401, { error: m ? "invalid_token" : "unauthorized", error_description: "This MCP server needs an OAuth bearer token." });
      }
    }
    // Everything the tools read or write (Wolt tokens, saved location) is
    // resolved against the caller's own account directory for the whole
    // request. There is no shared account: a grant approved without a Wolt
    // token (an older one) is sent back through authorization, and a fixed
    // API token gets a slot of its own, connected via set_wolt_token in chat.
    let stateDir;
    try {
      // WOLT_HTTP_AUTH=none is a single-user private deployment: it keeps the
      // state dir root, like stdio does.
      const accountId = grant ? grant.accountId
        : presentedToken ? `api-${createHash("sha256").update(presentedToken).digest("base64url").slice(0, 16)}`
        : null;
      if (!accountId && (provider || cfg.apiTokens.length)) {
        res.setHeader("WWW-Authenticate", `Bearer error="invalid_token", error_description="this authorization has no Wolt account; authorize again", resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource"`);
        return sendJson(res, 401, { error: "invalid_token", error_description: "This authorization has no Wolt account attached. Authorize again and paste a Wolt refresh token." });
      }
      stateDir = accountId ? accountStateDir(cfg.stateDir, accountId) : cfg.stateDir;
    } catch (e) { return sendJson(res, 401, { error: "invalid_token", error_description: "token refers to an unknown account" }); }
    // The body is read here rather than by the transport so the access log
    // can name the JSON-RPC method, the tool or the resource — which is how
    // you tell "the host never asked for the card template" from "the card
    // broke" — and the client. Parameters and results are never logged.
    const body = await readBody(req);
    req.rpcLabel = `${rpcLabel(body)} (${clientName(req)})`;
    // May this connection pay? An OAuth grant carries the answer from its
    // approve page (scope "order" and the cap); fixed API tokens and the
    // no-auth mode fall back to the operator's environment.
    const ordering = grant ? { allowed: /\border\b/.test(grant.scope || ""), cap: grant.orderCap ?? null } : orderingFromEnv(env);
    if (cfg.publicUrl) {
      ordering.paymentSetup = (quote) => paymentContext.issue(quote);
      ordering.paymentSdkConfig = () => paymentContext.config();
    }
    await withStateDir(stateDir, async () => {
      const mcpServer = buildServer({ remote: true, ordering });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { mcpServer.close().catch(() => {}); });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    });
  }

  async function authorize(req, res, url) {
    const body = req.method === "POST" ? await readBody(req) : {};
    const q = req.method === "POST" ? body : Object.fromEntries(url.searchParams);
    let request;
    try {
      request = provider.validateAuthorizeRequest(q);
    } catch (e) {
      if (e.redirectTo) return redirect(res, e.redirectTo);
      throw e;
    }
    const ip = clientIp(req);
    if (tooManyFailures(ip)) return page(res, 429, "Too many attempts", "<p>Too many failed attempts from your address. Try again in a few minutes.</p>");

    // The Allow click (and the secret, when that's the guard) must come from
    // our own page: a cross-site form post could otherwise approve a client
    // the user never saw. Sec-Fetch-Site is the reliable signal; Origin is the
    // fallback for browsers without it, and it can legitimately be "null"
    // (a strict referrer policy does that), which is treated as unknown.
    if (req.method === "POST") {
      const site = req.headers["sec-fetch-site"];
      const origin = req.headers.origin;
      const sameOrigin = site ? site === "same-origin" : (origin && origin !== "null" ? origin === cfg.publicUrl : false);
      if (!sameOrigin) return page(res, 403, "Blocked", "<p>This approval did not come from the approve page itself.</p>");
    }

    let verdict;
    try {
      verdict = await provider.checkGuard({ headers: req.headers, body: req.method === "POST" ? body : null });
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      if (e.error === "access_denied" && cfg.guard.type === "secret") {
        recordFailure(ip);
        return consentPage(res, request, q, e.description);
      }
      return page(res, e.status, "Not allowed", `<p>${esc(e.description || e.error)}</p>`);
    }
    // GET under Cloudflare Access: the human is verified, now ask them.
    // GET with the secret guard: the form is the question.
    if (req.method === "GET" || !verdict.ok || !body.approve) return consentPage(res, request, q, null);

    // Every grant brings its own Wolt account — the server has none to lend.
    // The pasted refresh token is exchanged once right here, so a bad paste is
    // caught on the page rather than at the first tool call, and the rotation
    // Wolt hands back is stored alongside it.
    const pasted = String(body.wolt_token || "").trim();
    if (!pasted) return consentPage(res, request, q, "A Wolt refresh token is required: this connection gets its own Wolt account.");
    let validated;
    try {
      validated = await validateRefreshToken(pasted);
    } catch (e) {
      recordFailure(ip);
      return consentPage(res, request, q, `Wolt did not accept that refresh token (${e.message}). Copy a fresh one from a logged-in wolt.com tab and try again.`);
    }
    const accountId = newAccountId();
    withStateDir(accountStateDir(cfg.stateDir, accountId), () => adoptTokens(validated));
    // Ordering is off unless the box was ticked here, whatever scope the
    // client asked for; the optional cap is typed in major units.
    const allowOrders = body.allow_orders === "1";
    const capMajor = Number(String(body.order_cap || "").trim().replace(",", "."));
    const orderCap = allowOrders && String(body.order_cap || "").trim() && Number.isFinite(capMajor) && capMajor > 0 ? Math.round(capMajor * 100) : null;
    return redirect(res, provider.issueCode({ ...request, scope: allowOrders ? "wolt order" : "wolt", who: verdict.who, accountId, orderCap }));
  }

  async function token(req, res) {
    const ip = clientIp(req);
    if (tooManyFailures(ip)) return sendJson(res, 429, { error: "slow_down" });
    const params = await readBody(req);
    try {
      return sendJson(res, 200, provider.token(params, req.headers.authorization), { "Cache-Control": "no-store", Pragma: "no-cache" });
    } catch (e) {
      if (e instanceof OAuthError) {
        recordFailure(ip);
        if (e.error === "invalid_client") res.setHeader("WWW-Authenticate", 'Basic realm="wolt-mcp"');
      }
      throw e;
    }
  }

  function consentPage(res, request, q, error) {
    const hidden = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
      .filter((k) => q[k] != null)
      .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k])}">`)
      .join("\n");
    const host = new URL(request.redirectUri).host;
    const field = `<input type="hidden" name="approve" value="1">` + (cfg.guard.type === "secret"
      ? `<label>Approve secret<br><input type="password" name="secret" autocomplete="current-password" autofocus required></label>`
      : "");
    // The connection's own Wolt account. The server holds none to share, so
    // the token is required — the page is the whole account setup.
    const account = `<label>Your Wolt refresh token<br><input type="password" name="wolt_token" autocomplete="off" spellcheck="false" required></label>` +
      `<ol class="muted"><li>Log in at <a href="https://wolt.com" target="_blank" rel="noopener">wolt.com</a>.</li>` +
      `<li>Open the browser's developer tools (F12 or ⌥⌘I), Network tab, and reload the page.</li>` +
      `<li>Find the request to <code>authentication.wolt.com/v1/wauth2/access_token</code> and copy the <code>refresh_token</code> value from its JSON.</li></ol>` +
      `<p class="muted">The token is exchanged once now and renews itself afterwards; this connection uses only the account it belongs to.</p>` +
      `<details><summary class="muted">For developers</summary><p class="muted">From a checkout of wolt-mcp, <code>node mcp/server.mjs login</code> opens the Wolt login in a separate browser profile and prints the token (<code>npx -y wolt-mcp login</code> once a release ships it).</p></details>`;
    // Ordering is opt-in per connection. Unticked, the connection can fill
    // baskets and price them but never pay; ticked, place_order may charge
    // the account's saved card, up to the cap if one is given.
    const ordering = `<fieldset><legend>Ordering</legend>` +
      `<label class="row"><input type="checkbox" name="allow_orders" value="1"> Allow this connection to place and pay for orders</label>` +
      `<p class="muted">Off by default: the assistant can fill and price your basket but you pay on wolt.com. On, it can place an order with your saved card after you confirm the total in the chat. Real money, through a language model, on private Wolt endpoints: tick it only for a client you trust.</p>` +
      `<label>Per-order limit, optional (in your currency's main unit, e.g. 50)<br><input type="text" name="order_cap" inputmode="decimal" autocomplete="off" pattern="[0-9]+([.,][0-9]{1,2})?"></label></fieldset>`;
    // form-action also governs where a form POST may be *redirected*, so the
    // client's callback origin has to be allowed or the browser drops the code.
    return page(res, error ? 403 : 200, "Allow access to your Wolt account?",
      `<p><b>${esc(request.client.name)}</b> <span class="muted">(${esc(host)})</span> wants to use this wolt-mcp server: search, your baskets, order history and favourites on the Wolt account you connect here.</p>` +
      (error ? `<p class="err">${esc(error)}</p>` : "") +
      `<form method="post" action="/authorize">${hidden}${field}${account}${ordering}<p><button type="submit">Allow</button></p></form>`,
      { formAction: new URL(request.redirectUri).origin });
  }

  function tooManyFailures(ip) {
    const f = failures.get(ip);
    if (!f) return false;
    if (f.resetAt <= Date.now()) { failures.delete(ip); return false; }
    return f.count >= FAILURES_ALLOWED;
  }
  function recordFailure(ip) {
    const f = failures.get(ip);
    if (f && f.resetAt > Date.now()) f.count += 1;
    else failures.set(ip, { count: 1, resetAt: Date.now() + FAILURE_WINDOW_MS });
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const bound = server.address().port;
  log(`wolt-mcp ${version} listening on http://${host}:${bound}/mcp (auth: ${cfg.auth}${cfg.guard ? `, authorize guard: ${cfg.guard.type}` : ""}${cfg.publicUrl ? `, public: ${cfg.publicUrl}` : ""})`);
  if (cfg.auth === "none") log("WARNING: WOLT_HTTP_AUTH=none — anyone who can reach this port can use the connected Wolt account");
  return {
    port: bound,
    url: `http://${host}:${bound}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })
  };
}

// --- plumbing ---

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, obj, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extra });
  res.end(JSON.stringify(obj));
}
function sendText(res, status, s) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(s);
}
function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}
function page(res, status, title, bodyHtml, { formAction } = {}) {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formAction ? ` ${formAction}` : ""}; frame-ancestors 'none'`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY", "Content-Security-Policy": csp });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — wolt-mcp</title>` +
    `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111;background:#fff}h1{font-size:1.4rem}button{font:inherit;padding:.6rem 1.4rem;cursor:pointer}input{font:inherit;padding:.5rem;width:100%;box-sizing:border-box}label{display:block;margin:1rem 0}.muted{color:#666}.err{color:#b00020}code{font-size:.9em}ol{padding-left:1.2rem}details{margin:1rem 0}summary{cursor:pointer}a{color:inherit}fieldset{border:1px solid #ddd;border-radius:6px;padding:.5rem 1rem;margin:1.5rem 0}legend{padding:0 .3rem;color:#666}input[type=checkbox]{width:auto;margin-right:.5rem}.row{display:flex;align-items:center}</style></head>` +
    `<body><h1>${esc(title)}</h1>${bodyHtml}<p class="muted">wolt-mcp</p></body></html>`);
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function clientIp(req) {
  return String(req.headers["cf-connecting-ip"] || req.socket?.remoteAddress || "unknown");
}

// "tools/call search_products", "resources/read ui://…", "initialize"; a
// batch joins its members, a bare response or notification reads as such.
function rpcLabel(body) {
  const msgs = (Array.isArray(body) ? body : [body]).filter((m) => m && typeof m === "object");
  const names = msgs.map((m) => {
    if (typeof m.method !== "string") return "response";
    const p = m.params || {};
    const what = m.method === "tools/call" ? p.name : m.method === "resources/read" ? p.uri : null;
    return typeof what === "string" ? `${m.method} ${what.slice(0, 80)}` : m.method;
  });
  return names.join(",") || "empty";
}

// The product token of the User-Agent, e.g. "openai-mcp/1.0.0" or "Claude-User".
function clientName(req) {
  return String(req.headers["user-agent"] || "-").trim().split(/\s+/)[0].slice(0, 40);
}

// Form or JSON body, capped: these endpoints only ever see a few hundred bytes.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new OAuthError(413, "invalid_request", "body too large")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const type = (req.headers["content-type"] || "").toLowerCase();
      try {
        if (type.includes("application/json")) resolve(raw ? JSON.parse(raw) : {});
        else resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch (e) { reject(new OAuthError(400, "invalid_request", "body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}
