// Canonical Wolt web-client header set.
//
// Mirrors what wolt.com's own web app sends. Live-verified: Wolt accepts plain
// server-side HTTP with exactly these headers — no Origin, Referer, or
// User-Agent spoofing needed.
//   - "w-wolt-session-id: no-analytics-consent" is the literal sentinel the web
//     app sends when analytics consent is declined; it's a static, always-valid
//     session id.
//   - "x-wolt-web-clientid" is a random UUIDv4, generated once per process.
import { randomUUID } from "node:crypto";

const CLIENT_VERSION = "1.16.79";
const webClientId = process.env.WOLT_CLIENT_ID || randomUUID();

export function woltHeaders({ token = null, json = false, lang = "en" } = {}) {
  const h = {
    "app-language": lang,
    "platform": "Web",
    "client-version": CLIENT_VERSION,
    "clientversionnumber": CLIENT_VERSION,
    "w-wolt-session-id": process.env.WOLT_SESSION_ID || "no-analytics-consent",
    "x-wolt-web-clientid": webClientId,
    "accept": "application/json"
  };
  if (json) h["content-type"] = "application/json";
  if (token) h["authorization"] = `Bearer ${String(token).replace(/^Bearer /i, "")}`;
  return h;
}
