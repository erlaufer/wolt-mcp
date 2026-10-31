// Recent data collected by the real SDK, shared across repriced quotes for
// this account. Pricing/confirmation expiry remains separate from this cache.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { currentStateDir } from "./context.js";

export const BROWSER_CONTEXT_TTL_MS = 30 * 60 * 1000;
const file = () => join(currentStateDir(), "payment-browser.json");

export function validateBrowserContext({ browserInfo, deviceId }) {
  if (typeof deviceId !== "string" || !deviceId.length || deviceId.length > 512) throw new Error("missing SDK device id");
  const b = browserInfo || {};
  if (![b.color_depth, b.screen_height, b.screen_width, b.time_zone_offset].every(Number.isSafeInteger) || b.color_depth <= 0 || b.screen_height <= 0 || b.screen_width <= 0 || Math.abs(b.time_zone_offset) > 1440 || typeof b.java_enabled !== "boolean" || typeof b.language !== "string" || !b.language || b.language.length > 80 || typeof b.user_agent !== "string" || !b.user_agent || b.user_agent.length > 2000) throw new Error("incomplete browser payment information");
  return { deviceId, browserInfo: { color_depth: b.color_depth, java_enabled: b.java_enabled, language: b.language, screen_height: b.screen_height, screen_width: b.screen_width, time_zone_offset: b.time_zone_offset, user_agent: b.user_agent } };
}

export function rememberBrowserContext(value, now = Date.now(), source = "inline") {
  const context = { ...validateBrowserContext(value), source: source === "browser" ? "browser" : "inline" };
  mkdirSync(currentStateDir(), { recursive: true });
  writeFileSync(file(), JSON.stringify({ ...context, capturedAt: now, expiresAt: now + BROWSER_CONTEXT_TTL_MS }), { mode: 0o600 });
  return context;
}

export function recentBrowserContext(now = Date.now()) {
  try {
    const c = JSON.parse(readFileSync(file(), "utf8"));
    if (!Number.isFinite(c.capturedAt) || c.capturedAt > now || c.expiresAt <= now || c.expiresAt - c.capturedAt !== BROWSER_CONTEXT_TTL_MS) return null;
    return { ...validateBrowserContext(c), source: ["browser", "inline"].includes(c.source) ? c.source : "unknown" };
  } catch { return null; }
}
