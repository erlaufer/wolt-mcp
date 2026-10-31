// Private, bounded records for diagnosing payment outcomes. Never retain
// request/response bodies, account/card/address data, tokens or fingerprints.
// These records are evidence only: no payment decision or retry reads them.
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { currentStateDir } from "./context.js";

export const PAYMENT_DIAGNOSTIC_LIMIT = 20;
const outcomes = new Set(["submitted", "unknown", "http_error", "authorization_refused", "requires_action", "unconfirmed", "confirmed"]);
const requestHeaders = new Set(["x-request-id", "x-correlation-id", "x-wolt-request-id", "x-amzn-requestid", "x-amz-cf-id", "cf-ray"]);
const statuses = new Set(["authorization_required", "authorization_started", "authorization_succeeded", "authorization_failed", "paid", "authorized", "authorised", "completed", "success", "succeeded", "pending", "received", "confirmed", "production", "ready", "delivered", "deferred_payment_failed"]);
const safeStatus = value => value == null ? null : statuses.has(value) ? value : "other";

export function recordPaymentAttempt(quote, { outcome, response = null }, now = Date.now()) {
  if (!outcomes.has(outcome)) return;
  const path = join(currentStateDir(), "payment-attempts.json"), temp = `${path}.${process.pid}.tmp`;
  try {
    let records;
    try { records = JSON.parse(readFileSync(path, "utf8")); } catch { records = []; }
    if (!Array.isArray(records)) records = [];
    const root = response?.json || {}, purchase = root.results || root;
    const authorization = purchase.payment?.authorization || purchase.authorization || root.authorization || purchase.payment_plan?.authorization;
    const requestIds = {};
    for (const [key, value] of Object.entries(response?.requestIds || {})) {
      if (requestHeaders.has(key) && typeof value === "string" && /^[A-Za-z0-9_.:/+=-]{1,256}$/.test(value)) requestIds[key] = value;
    }
    const record = {
      quoteId: quote.id,
      submittedAt: quote.submittedAt,
      recordedAt: now,
      outcome,
      httpStatus: Number.isInteger(response?.status) ? response.status : null,
      errorCode: Number.isSafeInteger(root.error_code) ? root.error_code : null,
      requestIds,
      browserInfoPresent: !!quote.browserContext?.browserInfo,
      sdkDeviceIdPresent: !!quote.browserContext?.deviceId,
      browserContextSource: ["browser", "inline"].includes(quote.browserContext?.source) ? quote.browserContext.source : "unknown",
      orderPresent: !!(purchase.id || purchase.purchase_id),
      orderStatus: safeStatus(purchase.status),
      paymentStatus: safeStatus(purchase.payment?.status || purchase.payment_status || root.payment?.status || root.payment_status),
      paymentPlanPresent: !!purchase.payment_plan,
      paymentPlanStatus: safeStatus(purchase.payment_plan?.status),
      authorizationPresent: !!authorization,
      authorizationProvider: !authorization ? null : ["adyen", "adyen_v2", "fondy", "processout", "juspay"].includes(authorization.provider) ? authorization.provider : "other",
      authorizationAction: !authorization ? null : ["identify", "challenge", "redirect", "authorize", "mfa"].includes(authorization.action || authorization.type) ? authorization.action || authorization.type : "other",
      refusalReasonPresent: !!(root.refusal_reason || purchase.refusal_reason || purchase.payment?.refusal_reason || purchase.payment_plan?.refusal_reason)
    };
    records = records.filter(row => row?.quoteId !== quote.id).concat(record).slice(-PAYMENT_DIAGNOSTIC_LIMIT);
    mkdirSync(currentStateDir(), { recursive: true });
    writeFileSync(temp, JSON.stringify(records), { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Diagnostics failing after authorization must never change its outcome.
    try { unlinkSync(temp); } catch { /* no temporary file */ }
  }
}
