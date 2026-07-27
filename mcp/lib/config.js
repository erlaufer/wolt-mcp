// Persistent user settings (delivery location) in ~/.wolt-mcp/config.json.
// Precedence: stored config > WOLT_LAT/WOLT_LON env seeds > cached IP estimate.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.WOLT_STATE_DIR || join(homedir(), ".wolt-mcp");
const CONFIG_FILE = join(STATE_DIR, "config.json");

// This file holds the user's home coordinates — keep it owner-only, as tokens
// are. Applied on read too: a config.json written before this existed keeps its
// 0644 mode otherwise, since nothing rewrites it until the next set_location.
function harden() {
  try { if (statSync(CONFIG_FILE).mode & 0o077) chmodSync(CONFIG_FILE, 0o600); } catch (e) {}
}

function load() {
  let raw;
  try { raw = readFileSync(CONFIG_FILE, "utf8"); } catch (e) { return {}; }
  harden();
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

const IP_ESTIMATE_TTL_MS = 24 * 60 * 60 * 1000;

export function getLocation() {
  const cfg = load();
  if (cfg.location?.lat != null && cfg.location?.lon != null) return cfg.location;
  // The .mcpb host substitutes unset user_config as junk strings, so the env
  // seeds only count when they parse to real coordinates — otherwise searches
  // run on lat=NaN and silently return nothing.
  const envLat = Number(process.env.WOLT_LAT), envLon = Number(process.env.WOLT_LON);
  if (process.env.WOLT_LAT && process.env.WOLT_LON && Number.isFinite(envLat) && Number.isFinite(envLon)) {
    return { lat: envLat, lon: envLon, label: "from env" };
  }
  const est = cfg.ipEstimate;
  if (est?.lat != null && est?.lon != null && Date.now() - (est.at || 0) < IP_ESTIMATE_TTL_MS) {
    return { lat: est.lat, lon: est.lon, label: est.label };
  }
  return null;
}

// City-level guess from the machine's public IP, cached for a day so the
// lookup runs at most once per session-ish. Explicit set_location and saved
// Wolt addresses always win over this.
export async function estimateLocation(fetchImpl = fetch) {
  let r;
  try {
    r = await fetchImpl("https://ipapi.co/json/", { signal: AbortSignal.timeout(4000) });
  } catch (e) { return null; }
  if (!r.ok) return null;
  let j;
  try { j = await r.json(); } catch (e) { return null; }
  if (typeof j?.latitude !== "number" || typeof j?.longitude !== "number") return null;
  const label = [j.city, j.country_name].filter(Boolean).join(", ") + " (estimated from IP)";
  const cfg = load();
  cfg.ipEstimate = { lat: j.latitude, lon: j.longitude, label, at: Date.now() };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  harden();
  return { lat: j.latitude, lon: j.longitude, label };
}

export function setLocation({ lat, lon, label }) {
  const cfg = load();
  cfg.location = { lat, lon, label: label || null };
  mkdirSync(STATE_DIR, { recursive: true });
  // mode covers the create case, so the coordinates are never on disk
  // world-readable; harden() covers a file that already existed.
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  harden();
  return cfg.location;
}
