# `.qdrant-required-version` — Qdrant Server Version

## What it is

A single-line file at the repository root containing the Qdrant server version
this package targets (semver `X.Y.Z`).

```
1.17.0
```

**Single source of truth** for everything Qdrant-version related — both the
embedded daemon version and the minimum accepted external server version.
Shipped with the npm package via `package.json` `files[]`, loaded eagerly at
module import by `src/core/infra/qdrant-version.ts`:

```ts
import { QDRANT_VERSION } from "./core/infra/qdrant-version.js";

console.log(QDRANT_VERSION); // "1.17.0"
```

## How it is used

1. **Embedded daemon.** `src/core/adapters/qdrant/embedded/download.ts`
   downloads exactly this version from
   `github.com/qdrant/qdrant/releases/v${QDRANT_VERSION}` and pins it on disk in
   `qdrant.version` next to the binary. `isBinaryUpToDate()` is a strict
   equality check against `QDRANT_VERSION`.

2. **External Qdrant validation.** When `QDRANT_URL` points at a user-managed
   Qdrant, `checkExternalQdrantVersion` fetches the server version and rejects
   anything strictly older than `QDRANT_VERSION` with
   `QdrantVersionTooOldError`.

3. **Downgrade guard.** If the installed binary reports a version newer than
   `QDRANT_VERSION` (user reinstalled an older tea-rags package on top of a
   newer one), `assertNoDowngrade()` throws `QdrantDowngradeNotSupportedError`
   before the old binary overwrites the new one — Qdrant storage is not
   backward-compatible.

4. **Stale-binary warning.** On the attach fast path, when the live daemon's
   binary does not match `QDRANT_VERSION`, `warnIfStaleBinary()` emits a stderr
   notice; upgrade is deferred to the next cold spawn (after all MCP clients
   disconnect and the idle watcher shuts the daemon down, ~30s).

## When to bump `.qdrant-required-version`

Bump when the MCP server starts using a Qdrant capability that did not exist in
the previously-pinned version. Concrete triggers:

- Calling a REST endpoint introduced in a newer Qdrant release.
- Adopting a new filter operator, rerank strategy, sparse-vector modifier,
  quantization mode, or vector config the old server rejects.
- Switching `@qdrant/js-client-rest` to a major that drops support for the old
  server range.

**Do NOT bump** for:

- Purely client-side changes (reranker, chunker, sparse generation).
- Performance tweaks that do not introduce new server APIs.
- Internal refactoring.

## Bump procedure

1. Edit `.qdrant-required-version` to the new semver.
2. Validate Qdrant forward-compat for the jump — storage migrates forward on
   `+1..+3` minor bumps, bigger jumps need verification.
3. Update `CHANGELOG` / release notes: this is **BREAKING** for users running
   external Qdrant below the new version — they will get
   `QdrantVersionTooOldError` on startup.
4. Commit with scope `config` (patch) or `feat(config)!` (breaking).

## Why not an env var

`.qdrant-required-version` is a **compile-time contract**, not user config.
Users cannot relax it at runtime — if the MCP code paths rely on a server
feature, running against an older server is broken by definition. Keeping the
constant in a git-tracked file (vs buried in TypeScript) makes bumps visible in
the diff and lets `npm`/IDE tools show the target version without parsing
compiled JS.

## Anti-pattern

Never hardcode the version in multiple places or introduce a parallel "min" vs
"embedded" split — there is only one version, one file, one export. If you need
the value, import `QDRANT_VERSION` from `src/core/infra/qdrant-version.ts`. Do
not duplicate the string literal.
