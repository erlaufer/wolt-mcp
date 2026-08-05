# Releasing

A release ships three artifacts that must agree with each other: the npm
package, the git tag, and the `.mcpb` bundle attached to the GitHub release
(the root README points Claude Desktop users at `releases/latest`, so a release
without that asset breaks the Desktop install path).

## 1. Pre-flight

```sh
cd mcp && npm ci              # clean install: the same tree CI and the bundle get
cd mcp && npm test            # offline suite: parsing, basket shape, currency,
                              # language, planning, and the version guard
node mcp/test/tools.live.mjs  # every registered tool against a live account;
                              # needs tokens, cleans up after itself
cd mcp && npm audit           # see below — the bundle ships node_modules
```

`npm audit` matters more here than for a normal library: the `.mcpb` bundle
packs `node_modules`, so whatever versions are installed when it is built are
distributed to every Claude Desktop user, reachable code or not. Clear what is
fixable inside the declared ranges (`npm update --package-lock-only`, then
re-run `npm ci`) before building, and note anything left over in the release
notes rather than letting a scanner find it first.

The live suite has a coverage guard that fails if any registered tool goes
uncalled — a new tool cannot ship untested. Only the interactive login tool is
skipped, so exercise `login_via_chrome` by hand when the auth path changed.

## 2. Bump the version

Set the same version in **both** `mcp/package.json` and `mcp/manifest.json`,
then refresh `mcp/package-lock.json` (`npm install --package-lock-only`).
`test/version.test.mjs` fails the build if the three drift apart.

## 3. Build the bundle

```sh
npx @anthropic-ai/mcpb pack mcp        # writes ./mcp.mcpb at the repo root
mv mcp.mcpb wolt-mcp-<version>.mcpb
```

`npx @anthropic-ai/mcpb pack mcp` from the repo root and `cd mcp && npx
@anthropic-ai/mcpb pack .` write to *different* paths (`./mcp.mcpb` vs
`mcp/mcp.mcpb`), so a stale bundle from the other invocation is easy to grab by
mistake. Always confirm what is actually inside the file you are about to
upload:

```sh
unzip -p wolt-mcp-<version>.mcpb manifest.json | grep '"version"'
```

## 4. Publish

```sh
cd mcp && npm publish                                  # npm
git tag v<version> && git push origin main --tags      # tag
gh release create v<version> wolt-mcp-<version>.mcpb \
  -t "v<version> — <headline>" -n "<notes>"            # release + asset
```

## 5. Verify from the outside

Check the published artifacts, not the working copy:

```sh
npx -y wolt-mcp@<version>            # boots, lists tools, search works logged-out
npx -y wolt-mcp@<version> install    # registers in the Claude Desktop config
curl -sL <release asset url> -o /tmp/dl.mcpb && shasum -a 256 /tmp/dl.mcpb wolt-mcp-<version>.mcpb
```

The two hashes must match. Finish by installing the downloaded `.mcpb` in
Claude Desktop once by hand — the automated suite drives the same server, but
not Desktop's installer UI.
