import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withStateDir } from "../lib/context.js";
import { recordPaymentAttempt, PAYMENT_DIAGNOSTIC_LIMIT } from "../lib/payment-diagnostics.js";

const dir = mkdtempSync(join(tmpdir(), "wolt-diagnostics-"));
const privateValue = "PRIVATE_FIXTURE_MUST_NOT_BE_RECORDED";
const quote = { id: "fixture-quote", submittedAt: 1234, card: privateValue, address: privateValue, items: [privateValue], browserContext: { deviceId: privateValue, browserInfo: { user_agent: privateValue }, source: "browser" } };
const response = { status: 400, requestIds: { "x-amz-cf-id": "support-id==", "set-cookie": privateValue, "x-request-id": "bad\nheader" }, text: privateValue, json: { error_code: 800, msg: privateValue, params: { token: privateValue }, refusal_reason: privateValue, results: { payment: { authorization: { provider: "adyen_v2", action: "identify", data: { token: privateValue } } } } } };
const read = () => JSON.parse(readFileSync(join(dir, "payment-attempts.json"), "utf8"));
try {
  withStateDir(dir, () => {
    recordPaymentAttempt(quote, { outcome: "submitted" });
    recordPaymentAttempt(quote, { outcome: "authorization_refused", response }, 2345);
    assert.equal(read().length, 1, "an attempt is updated rather than duplicated per phase");
    const last = read()[0];
    assert.equal(last.httpStatus, 400);
    assert.equal(last.errorCode, 800);
    assert.equal(last.submittedAt, 1234);
    assert.equal(last.recordedAt, 2345);
    assert.equal(last.browserContextSource, "browser");
    assert.equal(last.authorizationPresent, true);
    assert.equal(last.authorizationProvider, "adyen_v2");
    assert.equal(last.refusalReasonPresent, true);
    assert.deepEqual(last.requestIds, { "x-amz-cf-id": "support-id==" });
    assert(!readFileSync(join(dir, "payment-attempts.json"), "utf8").includes(privateValue), "no bodies, tokens, fingerprint or personal data");
    assert.equal(statSync(join(dir, "payment-attempts.json")).mode & 0o077, 0, "only the account owner can read diagnostic records");
    for (let i = 0; i < PAYMENT_DIAGNOSTIC_LIMIT + 5; i++) recordPaymentAttempt({ ...quote, id: `quote-${i}` }, { outcome: "confirmed" });
    assert.equal(read().length, PAYMENT_DIAGNOSTIC_LIMIT);
    assert.equal(read()[0].quoteId, "quote-5", "old records are discarded");
    assert.equal(read().at(-1).quoteId, `quote-${PAYMENT_DIAGNOSTIC_LIMIT + 4}`);
  });
  withStateDir(join(dir, "other-account"), () => recordPaymentAttempt(quote, { outcome: "unknown" }));
  assert.equal(read().length, PAYMENT_DIAGNOSTIC_LIMIT, "accounts are isolated");
  const blocked = join(dir, "not-a-directory");
  writeFileSync(blocked, "fixture");
  assert.doesNotThrow(() => withStateDir(blocked, () => recordPaymentAttempt(quote, { outcome: "confirmed" })), "a diagnostic write failure cannot turn a paid order into an error");
  assert(!existsSync(join(dir, `payment-attempts.json.${process.pid}.tmp`)));
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log("payment-diagnostics.test.mjs: privacy, retention, isolation and write failure checks pass");
