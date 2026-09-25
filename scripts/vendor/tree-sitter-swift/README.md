# @artk0de/tree-sitter-swift

TeaRAGs depends on tree-sitter-swift **0.7.3** through the npm alias
`"tree-sitter-swift": "npm:@artk0de/tree-sitter-swift@0.7.3-prebuild.1"`, the
same pattern as `"tree-sitter": "npm:@artk0de/tree-sitter@…"`. Upstream
(`alex-pinkus/tree-sitter-swift`) tagged 0.7.3 and attached a release asset, but
never published it to npm; the registry stops at 0.7.1, which fails to parse
`@unchecked Sendable`, `#if` inside a type body and `nonisolated(unsafe)`.

This directory rebuilds that release as a prebuilt N-API package. It does not
publish anything — the owner does.

## What differs from upstream

`prepare.js` downloads
`https://github.com/alex-pinkus/tree-sitter-swift/releases/download/0.7.3/tree-sitter-swift.tar.gz`,
checks it against a pinned sha256, and rewrites two files:

- `package.json`: name `@artk0de/tree-sitter-swift`, version `0.7.3-prebuild.1`.
  `tree-sitter-cli` and `which` are dropped from `dependencies` (only the parser
  generator needs them), scripts are reduced to `install: node-gyp-build`, and
  the `tree-sitter` peer is made optional.
- `binding.gyp`: the `actions` block is removed. It ran `tree-sitter generate`
  on every native build, and the asset already ships the generated `src/`.

`src/`, `grammar.js`, `queries/` and `bindings/node/` are byte-identical to the
release asset. The asset carries a parser generated at ABI 15. Tree-sitter 0.25
reads it, and it is the build TeaRAGs was measured against. The
`0.7.3-with-generated-files` git tag carries an older ABI 14 generation of the
same grammar, so do not build from the tag.

## Targets

The same six prebuilds `@artk0de/tree-sitter` and tree-sitter-swift 0.7.1 ship:
`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`,
`win32-x64`. Node-API (`--napi`), so a single binary serves every Node version.

## Build and publish

1. **Build all six prebuilds in CI.** Copy the workflow template into a branch
   of this repo and dispatch it:

   ```bash
   cp scripts/vendor/tree-sitter-swift/prebuild.workflow.yml \
      .github/workflows/prebuild-tree-sitter-swift.yml
   git add .github/workflows/prebuild-tree-sitter-swift.yml
   git commit -m "ci: prebuild tree-sitter-swift 0.7.3"
   git push origin HEAD
   gh workflow run prebuild-tree-sitter-swift.yml --ref "$(git branch --show-current)"
   gh run watch
   ```

2. **Download the packed tarball** (the `package` artifact):

   ```bash
   gh run download --name package --dir /tmp/ts-swift-pkg
   TGZ=/tmp/ts-swift-pkg/artk0de-tree-sitter-swift-0.7.3-prebuild.1.tgz
   tar tzf "$TGZ" | grep prebuilds/
   ```

   Expect six `prebuilds/<platform>-<arch>/@artk0de+tree-sitter-swift.node`
   entries.

3. **Publish that exact tarball** (never re-pack locally — a local pack only
   holds the macOS prebuilds):

   ```bash
   npm publish "$TGZ" --access public
   ```

4. **Fill the lock integrity.** The committed `package-lock.json` entry for
   `node_modules/tree-sitter-swift` carries `resolved` but no `integrity`,
   because the digest is only known once the CI tarball exists. After
   publishing:

   ```bash
   npm install
   git diff package-lock.json   # adds the integrity line, nothing else
   ```

5. Drop the workflow file from the branch (it is a one-off).

## Local build (macOS only, for validation)

```bash
sh scripts/vendor/tree-sitter-swift/build-local.sh /tmp/ts-swift
# -> /tmp/ts-swift/artk0de-tree-sitter-swift-0.7.3-prebuild.1.tgz
#    (darwin-arm64 + darwin-x64 only)
```

To test TeaRAGs against it before publishing, install that tarball over the
alias without saving it (`npm install --no-save <tgz>`), or extract it into
`node_modules/tree-sitter-swift`. Do not commit a `file:` spec.

## Next grammar release

Bump `UPSTREAM_VERSION`, `ASSET_SHA256` (`shasum -a 256` of the new asset) and
the `-prebuild.N` suffix in `prepare.js`. Then re-measure with
`scripts/codegraph-chain-tally.ts` and bump swift `chunking` / `walker` in
`src/core/domains/language/swift/capability.ts` if the chunk set or the edges
move.
