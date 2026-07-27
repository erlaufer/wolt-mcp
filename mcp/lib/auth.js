// Wolt auth: persistent token store + auto-refresh.
//
// Wolt's web app uses OAuth-style rotating tokens: a short-lived (~30 min) JWT
// access token and a refresh token. POST authentication.wolt.com/v1/wauth2/
// access_token with grant_type=refresh_token returns a fresh pair.
//
// Refresh-token strategy (learned the hard way): the
// refresh token ROTATES on every use, but the user's BROWSER shares the same
// chain via its __wrtoken cookie and keeps rotating its own copy. Persisting
// our rotated token forks the chain from the browser's and produces an hourly
// "session expired" loop. So the pasted "bootstrap" refresh token is pinned on
// disk, and rotated tokens are held in memory only (preferred while this
// process lives, falling back to the bootstrap token if they go stale).
// Tokens live in ~/.wolt-mcp/tokens.json (0600).
//
// Sources of truth, in order: the state file, then WOLT_BEARER_TOKEN /
// WOLT_REFRESH_TOKEN env (seed on first run, e.g. from the .mcpb settings form).
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { woltHeaders } from "./headers.js";

const AUTH_URL = "https://authentication.wolt.com/v1/wauth2/access_token";
const STATE_DIR = process.env.WOLT_STATE_DIR || join(homedir(), ".wolt-mcp");
const STATE_FILE = join(STATE_DIR, "tokens.json");
const EXPIRY_MARGIN_MS = 2 * 60 * 1000; // refresh when <2 min left

// Shown (via a tool error) the first time an authed action is attempted with no
// usable token. Written as an instruction to the client model so it relays a
// warm, non-technical setup prompt to the user rather than dumping an error.
export const NEEDS_TOKEN_MESSAGE = (hadExpired) =>
  `SETUP NEEDED — relay this to the user warmly, don't show it as an error:\n\n` +
  `${hadExpired ? "Your Wolt sign-in expired and I can't refresh it." : "To use your Wolt cart, I need to connect to your Wolt account once."} ` +
  `The easy way (no technical steps): I'll run login_via_chrome — a browser window opens on wolt.com, ` +
  `you log in normally, and that's it. You only do this once; it renews itself afterwards. ` +
  `Note the window uses a separate, empty browser profile, so you'll sign into Wolt fresh there — ` +
  `your everyday profile isn't touched. Needs Chrome, Edge, Brave or another Chromium browser.\n\n` +
  `On Firefox or Safari, they can instead open a logged-in wolt.com tab, go to DevTools → Network, ` +
  `find a POST to authentication.wolt.com/v1/wauth2/access_token, copy "refresh_token" from the request ` +
  `payload, and paste it here — I'll store it with set_wolt_token.\n\n` +
  `(Searching stores works without this — it's only needed for your cart and account.)`;

export function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).replace(/^Bearer /i, "").split(".")[1], "base64url").toString());
    return payload.exp ? payload.exp * 1000 : null;
  } catch (e) { return null; }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch (e) { return {}; }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  try { chmodSync(STATE_FILE, 0o600); } catch (e) {}
}

// Merge env seeds into the store (env never overwrites a NEWER stored pair —
// a rotated refresh token in the file beats a stale one in the settings form).
function currentState() {
  const state = loadState();
  const envAccess = (process.env.WOLT_BEARER_TOKEN || "").replace(/^Bearer /i, "") || null;
  const envRefresh = process.env.WOLT_REFRESH_TOKEN || null;
  if (envAccess && !state.accessToken) state.accessToken = envAccess;
  if (envRefresh && !state.refreshToken) state.refreshToken = envRefresh;
  // env access token newer than the stored one (user pasted a fresh one) → take it
  const envExp = jwtExpiryMs(envAccess), storedExp = jwtExpiryMs(state.accessToken);
  if (envAccess && envExp && (!storedExp || envExp > storedExp)) state.accessToken = envAccess;
  return state;
}

// Cookie-sourced tokens arrive wrapped: URL-encoded and/or JSON-quoted (e.g.
// %22abc%22), sometimes several layers deep. Unwrap all layers.
export function unwrapToken(raw) {
  let t = String(raw ?? "").trim();
  for (let i = 0; i < 6; i++) {
    const prev = t;
    t = t.replace(/^Bearer /i, "").trim();
    if (t.startsWith('"') && t.endsWith('"') && t.length > 1) t = t.slice(1, -1);
    if (/%[0-9A-Fa-f]{2}/.test(t)) { try { t = decodeURIComponent(t); } catch (e) {} }
    if (t === prev) break;
  }
  return t;
}

// Rotation strategy: Wolt rotates the refresh token on every use. We persist
// the latest rotation in a SEPARATE field (state.rotatedRefreshToken) while
// keeping the user's bootstrap paste pinned in state.refreshToken as fallback.
// Memory-only rotation (the first design) broke across short-lived processes:
// each new process re-used the bootstrap, discarding rotations until Wolt
// invalidated the chain. Persisting into a separate slot survives processes
// without overwriting the bootstrap (which would fork the browser's chain).

// Store tokens pasted via the set_wolt_token tool. A newly pasted refresh
// token becomes the new bootstrap and supersedes any in-memory rotation.
export function setTokens({ accessToken, refreshToken }) {
  const state = currentState();
  if (accessToken) state.accessToken = unwrapToken(accessToken);
  if (refreshToken) { state.refreshToken = unwrapToken(refreshToken); state.rotatedRefreshToken = null; }
  delete state.refreshRotated; // legacy field from the persist-rotation era
  saveState(state);
  return describeTokens();
}

async function postRefresh(refreshToken) {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { ...woltHeaders(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken })
  });
  const body = await res.text();
  if (!res.ok) {
    // Carry the status: callers need to tell "Wolt refused this token" (4xx,
    // the token is dead) from "the request didn't get through" (5xx/network,
    // worth retrying with the same token).
    const err = new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = JSON.parse(body);
  const access = json.access_token || json.accessToken;
  if (!access) throw new Error("token refresh returned no access_token");
  return { access, refresh: json.refresh_token || json.refreshToken || null };
}

export async function refreshAccessToken() {
  const state = currentState();
  // Latest rotation first (freshest for our chain), pinned bootstrap second.
  const candidates = [...new Set([state.rotatedRefreshToken, state.refreshToken].filter(Boolean))];
  if (!candidates.length) throw new Error("no refresh token stored");
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const { access, refresh } = await postRefresh(candidate);
      if (refresh) state.rotatedRefreshToken = refresh; // separate slot — bootstrap stays pinned
      state.accessToken = access;
      saveState(state);
      return access;
    } catch (e) { lastErr = e; }
  }
  const err = new Error(`token refresh failed: ${lastErr.message} — paste a fresh token with set_wolt_token`);
  if (lastErr.status) err.status = lastErr.status;
  throw err;
}

// Valid access token, refreshing if needed. Throws with guidance if impossible.
export async function getAccessToken() {
  const state = currentState();
  const exp = jwtExpiryMs(state.accessToken);
  if (state.accessToken && exp && exp - Date.now() > EXPIRY_MARGIN_MS) return state.accessToken;
  // Wolt's __wtoken is opaque (not a JWT) so its expiry can't be read. Use it
  // optimistically rather than forcing a refresh that may fail — a stale token
  // surfaces as a 401, which the caller retries with forceRefresh.
  if (state.accessToken && !exp) return state.accessToken;
  if (state.refreshToken) return refreshAccessToken();
  if (state.accessToken && exp && exp > Date.now()) return state.accessToken; // inside margin but alive
  throw new Error(NEEDS_TOKEN_MESSAGE(!!state.accessToken));
}

// Snapshot/restore the whole token store. Used by the browser login: a stale
// cookie harvested from the profile must not replace tokens that still work.
export function snapshotTokens() {
  return JSON.stringify(loadState());
}

// Restores the snapshot WITHOUT discarding anything newer that landed while it
// was held: another tool call can refresh in parallel, and Wolt invalidates a
// refresh token the moment it's used, so writing a rotated one back would break
// the very chain the snapshot exists to protect. Returns false if the store
// couldn't be written (a full or unwritable ~/.wolt-mcp) — the caller is then
// holding tokens it must tell the user about, not swallow.
export function restoreTokens(snapshot) {
  try {
    const before = JSON.parse(snapshot);
    const now = loadState();
    const state = { ...before };
    if (now.rotatedRefreshToken && now.rotatedRefreshToken !== before.rotatedRefreshToken) {
      state.rotatedRefreshToken = now.rotatedRefreshToken; // rotated since the snapshot — it's the live one
    }
    const nowExp = jwtExpiryMs(now.accessToken), beforeExp = jwtExpiryMs(before.accessToken);
    if (now.accessToken && nowExp && (!beforeExp || nowExp > beforeExp)) state.accessToken = now.accessToken;
    saveState(state);
    return true;
  } catch (e) { return false; }
}

export function describeTokens() {
  const state = currentState();
  const exp = jwtExpiryMs(state.accessToken);
  return {
    accessTokenStored: !!state.accessToken,
    accessTokenMinutesLeft: exp ? Math.round((exp - Date.now()) / 60000) : null,
    refreshTokenStored: !!(state.refreshToken || state.rotatedRefreshToken),
    autoRefresh: !!(state.refreshToken || state.rotatedRefreshToken),
    stateFile: STATE_FILE
  };
}
