// Which state directory the current request works in.
//
// stdio has one user and one ~/.wolt-mcp. The remote transport can hold a
// separate Wolt account per OAuth grant (a refresh token pasted on the approve
// page), each in <state dir>/accounts/<id>/ with its own tokens.json and
// config.json. The HTTP handler runs each request inside withStateDir(), and
// auth.js / config.js ask currentStateDir() instead of reading a constant, so
// the tool code never knows which account it is serving.
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_STATE_DIR = process.env.WOLT_STATE_DIR || join(homedir(), ".wolt-mcp");
const ACCOUNT_ID = /^[A-Za-z0-9_-]{8,64}$/;

const store = new AsyncLocalStorage();

export function currentStateDir() {
  return store.getStore()?.stateDir || DEFAULT_STATE_DIR;
}

export function withStateDir(stateDir, fn) {
  return store.run({ stateDir }, fn);
}

// The directory for one account slot under a base state dir; the base itself
// when there is no account (the operator's own connection). Ids are generated
// by us, but they come back from a file, so the shape is checked anyway.
export function accountStateDir(baseDir, accountId) {
  if (!accountId) return baseDir;
  if (!ACCOUNT_ID.test(accountId)) throw new Error("malformed account id");
  return join(baseDir, "accounts", accountId);
}
