// Zero-paste login via the Chrome DevTools Protocol (the same approach
// Wolt's web session itself allows): launch Chrome with remote debugging,
// let the user log into wolt.com normally, and poll the browser's cookies for
// the __wrtoken refresh cookie.
//
// Note: the __wtoken cookie is an opaque session token Wolt's API REJECTS as a
// Bearer (confirmed live) — only the __wrtoken refresh cookie is useful here.
// We store it and immediately exchange it via wauth2 for a real access JWT,
// which also validates the harvest end-to-end.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTokens, refreshAccessToken, describeTokens, snapshotTokens, restoreTokens } from "./auth.js";

const DEBUG_URL = process.env.WOLT_CHROME_DEBUG_URL || "http://127.0.0.1:9223";
const LOGIN_URL = "https://wolt.com/login";
const PROFILE_DIR = join(process.env.WOLT_STATE_DIR || join(homedir(), ".wolt-mcp"), "chrome-profile");
const CHROME_BIN = process.env.CHROME_BIN || (
  process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : "google-chrome"
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok ? r.json() : null;
  } catch (e) { return null; }
}

// Returns { launched } so the caller knows whether WE started this browser.
// If one was already listening we attach to it and must never close it —
// it may be a browser the user is actively using.
async function ensureChrome() {
  if (await fetchJson(`${DEBUG_URL}/json/version`)) return { launched: false };
  const port = new URL(DEBUG_URL).port;
  const child = spawn(CHROME_BIN, [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    LOGIN_URL
  ], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await fetchJson(`${DEBUG_URL}/json/version`)) return { launched: true, child };
  }
  // This throw escapes cdpLogin's try/finally, so clean up here or a browser
  // that comes up a moment later is orphaned with its debug port open — and
  // the next attempt would attach to it (launched:false) and never close it.
  await closeLoginBrowser(true, child);
  throw new Error(`The browser did not expose the debug port at ${DEBUG_URL}. Is a Chromium-based browser installed at ${CHROME_BIN}? Set CHROME_BIN to point at Chrome, Edge, Brave, Vivaldi or Chromium. (Firefox and Safari do not support the DevTools Protocol — use set_wolt_token instead.)`);
}

// One CDP round-trip over WebSocket (Node >= 22 has a global WebSocket).
function cdpCall(wsUrl, method, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === "undefined") return reject(new Error("global WebSocket unavailable — Node 22+ required for login_via_chrome"));
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("CDP call timed out")); }, timeoutMs);
    const finish = (fn, arg) => { clearTimeout(timer); try { ws.close(); } catch (e) {} fn(arg); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) finish(resolve, msg.result || {});
      } catch (e) { /* ignore non-JSON frames */ }
    };
    ws.onerror = () => finish(reject, new Error("CDP websocket error"));
  });
}

async function readWoltCookies() {
  // Prefer a page target (ideally a wolt.com tab), fall back to the browser target.
  const targets = (await fetchJson(`${DEBUG_URL}/json/list`)) || [];
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const preferred = pages.find((t) => (t.url || "").includes("wolt")) || pages[0];
  const candidates = [];
  if (preferred) candidates.push({ ws: preferred.webSocketDebuggerUrl, method: "Network.getAllCookies" });
  const version = await fetchJson(`${DEBUG_URL}/json/version`);
  if (version?.webSocketDebuggerUrl) candidates.push({ ws: version.webSocketDebuggerUrl, method: "Storage.getCookies" });
  for (const c of candidates) {
    try {
      const result = await cdpCall(c.ws, c.method);
      const cookies = (result.cookies || []).filter((k) => (k.domain || "").includes("wolt"));
      if (cookies.length) return cookies;
    } catch (e) { /* try next candidate */ }
  }
  return [];
}

const REFRESH_COOKIE_NAMES = ["__wrtoken", "refreshtoken", "refresh_token", "wrtoken", "refresh"];

// Launch/attach Chrome, open wolt.com login, and poll until the __wrtoken
// refresh cookie appears (user completes login), then exchange it for a JWT.
// Shut the login browser down once we're done with it. Leaving it up would
// keep an unauthenticated CDP port open on 127.0.0.1 in front of a profile
// holding a live Wolt session — any local process could attach and read it.
// Only ever closes a browser this module launched.
async function closeLoginBrowser(launched, child) {
  if (!launched) return;
  try {
    const version = await fetchJson(`${DEBUG_URL}/json/version`);
    if (version?.webSocketDebuggerUrl) await cdpCall(version.webSocketDebuggerUrl, "Browser.close", 3000);
  } catch (e) { /* fall through to the signal below */ }
  try { if (child?.pid) process.kill(child.pid, "SIGTERM"); } catch (e) { /* already gone */ }
}

// A cookie exchange can fail two ways. Wolt REFUSING the cookie (4xx) means
// that value is dead and we should wait for a different one. Anything else —
// a dropped connection, DNS hiccup, Wolt 5xx — says nothing about the cookie,
// so it stays retryable: the browser won't rotate __wrtoken on its own, and
// blacklisting it would strand a login that actually succeeded.
const isRefused = (e) => e?.status >= 400 && e?.status < 500;

export async function cdpLogin({ timeoutMs = 120000 } = {}) {
  const { launched, child } = await ensureChrome();
  // Set on the timeout path only: the user is most likely still mid-login
  // (fetching an emailed code), and killing the window there loses the login
  // and makes retrying hopeless — every retry would start from a blank profile.
  let leaveBrowserOpen = false;
  try {
    // Make sure a wolt tab exists even if Chrome was already running.
    const targets = (await fetchJson(`${DEBUG_URL}/json/list`)) || [];
    if (!targets.some((t) => (t.url || "").includes("wolt"))) {
      await fetch(`${DEBUG_URL}/json/new?${encodeURIComponent(LOGIN_URL)}`, { method: "PUT" }).catch(() => {});
    }

    // A profile can hold a STALE refresh cookie — the shared chain rotates, so
    // a cookie left from an earlier session is often already spent. Exchanging
    // it 401s. That isn't a failure to report; it just means "not signed in
    // yet". Remember which values we've already rejected and keep waiting for
    // a different one, which is what appears once the user logs in again.
    const spent = new Set();
    let lastRefusal = null; // Wolt rejected the cookie — it really was stale
    let lastFailure = null; // couldn't reach Wolt — the cookie may be fine
    let restoreFailed = false; // couldn't put the previous tokens back — must be said out loud
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cookies = await readWoltCookies();
      const refresh = cookies.find((c) => REFRESH_COOKIE_NAMES.includes((c.name || "").toLowerCase()))?.value;
      if (refresh && !spent.has(refresh)) {
        const before = snapshotTokens();
        try {
          setTokens({ refreshToken: refresh });
          await refreshAccessToken(); // validates the harvest and stores a real JWT
          return { via: "chrome-cdp", tokenState: describeTokens() };
        } catch (e) {
          // Don't leave the user's working tokens replaced by a dud harvest.
          if (!restoreTokens(before)) restoreFailed = true;
          if (isRefused(e)) { spent.add(refresh); lastRefusal = e; }
          else lastFailure = e; // retry this same cookie on the next poll
        }
      }
      await sleep(1500);
    }
    const detail = lastRefusal
      ? ` The session cookie in that window was already expired (${lastRefusal.message}) — signing out and back in on wolt.com there refreshes it.`
      : lastFailure
      ? ` A session cookie was found but exchanging it kept failing (${lastFailure.message}) — check your connection and try again.`
      : "";
    const warning = restoreFailed
      ? ` WARNING: your previously stored tokens could not be written back (${describeTokens().stateFile} is unwritable), so the account may be disconnected — reconnect with set_wolt_token.`
      : "";
    leaveBrowserOpen = true;
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a wolt.com login in the browser window that opened. That window is still open — finish signing in there and run login_via_chrome again.${detail}${warning}`);
  } finally {
    // Runs on success and on error — never leave an unauthenticated CDP port
    // open in front of a logged-in profile. The timeout path is the exception
    // (see leaveBrowserOpen): nothing was harvested there, so the profile isn't
    // known to hold a session, and the open window is what makes a retry work.
    if (!leaveBrowserOpen) await closeLoginBrowser(launched, child);
  }
}
