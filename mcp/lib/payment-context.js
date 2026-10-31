// A short-lived, single-use browser capability. It can attach device data to
// one quote, never place an order or read Wolt credentials.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { currentStateDir, withStateDir } from "./context.js";
import { attachPaymentContext, readQuote } from "./order.js";
import { rememberBrowserContext } from "./browser-context.js";

export const SETUP_LINK_TTL_MS = 10 * 60 * 1000;

const require = createRequire(import.meta.url);
export const paymentPage = () => readFileSync(new URL("../ui/payment-context.html", import.meta.url), "utf8");
export const paymentSdk = () => readFileSync(require.resolve("ravelinjs/core"), "utf8");

export class PaymentContextService {
  constructor({ stateDir, publicUrl, publicKey = null, fetchImpl = fetch }) {
    this.stateDir = stateDir;
    this.publicUrl = publicUrl;
    this.publicKey = publicKey;
    this.fetch = fetchImpl;
    this.dir = join(stateDir, "payment-context-sessions");
  }

  issue(quote) {
    if (!this.publicUrl) return null;
    const token = randomBytes(32).toString("base64url");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // Remove expired capabilities while issuing a new one (bounded lifetime).
    for (const file of readdirSync(this.dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      try {
        const path = join(this.dir, file);
        if (JSON.parse(readFileSync(path, "utf8")).expiresAt <= Date.now()) unlinkSync(path);
      } catch { /* another request may already have consumed it */ }
    }
    writeFileSync(this.file(token), JSON.stringify({ stateDir: currentStateDir(), quoteId: quote.id, expiresAt: Date.now() + SETUP_LINK_TTL_MS }), { mode: 0o600 });
    return `${this.publicUrl}/payment-context#${token}`;
  }

  file(token) {
    return join(this.dir, `${createHash("sha256").update(token).digest("hex")}.json`);
  }

  async config() {
    if (!this.publicKey) {
      // This is Wolt's publishable browser key, never an account credential.
      // Discover it from their public page instead of freezing it in source.
      const r = await this.fetch("https://wolt.com/en/discovery", { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error("Wolt's payment SDK configuration is unavailable");
      this.publicKey = /"RAVELIN_PK"\s*:\s*"(publishable_key_[A-Za-z0-9_]+)"/.exec(await r.text())?.[1];
      if (!this.publicKey) throw new Error("Wolt's payment SDK configuration changed; use Wolt checkout");
    }
    return { publicKey: this.publicKey };
  }

  complete({ token, browserInfo, deviceId }) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("invalid or expired payment link");
    let session;
    try { session = JSON.parse(readFileSync(this.file(token), "utf8")); }
    catch { throw new Error("invalid or expired payment link"); }
    if (session.expiresAt <= Date.now()) { unlinkSync(this.file(token)); throw new Error("payment link expired; prepare a new quote"); }
    const rel = relative(this.stateDir, session.stateDir);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid payment account");
    const result = withStateDir(session.stateDir, () => {
      const quote = readQuote();
      if (quote?.id === session.quoteId && quote.submittedAt) throw new Error("quote already submitted; check the order in Wolt");
      if (quote?.id === session.quoteId && quote.expiresAt > Date.now()) return attachPaymentContext({ quoteId: session.quoteId, browserInfo, deviceId, source: "browser" });
      // A reprice must not make the user repeat device preparation. Save the
      // real context, while leaving the expired quote unpayable.
      rememberBrowserContext({ browserInfo, deviceId }, Date.now(), "browser");
      return { ok: true, needsFreshQuote: true };
    });
    unlinkSync(this.file(token));
    return result;
  }
}
