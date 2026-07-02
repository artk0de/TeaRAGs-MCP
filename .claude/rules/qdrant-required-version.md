---
paths:
  - ".qdrant-required-version"
  - "src/core/infra/qdrant-version.ts"
  - "src/core/adapters/qdrant/embedded/**"
---

# `.qdrant-required-version` — Qdrant Server Version

## What it is

Single-line file at repo root = Qdrant server version this package targets
(semver `X.Y.Z`).

```
1.17.0
```

**Single source of truth** for all Qdrant-version matters — both embedded daemon
version AND minimum accepted external server version. Shipped with npm package
via `package.json` `files[]`, loaded eagerly at module import by
`src/core/infra/qdrant-version.ts`:

```ts
import { QDRANT_VERSION } from "./core/infra/qdrant-version.js";

console.log(QDRANT_VERSION); // "1.17.0"
```

## How it is used

1. **Embedded daemon.** `src/core/adapters/qdrant/embedded/download.ts`
   downloads exactly this version from
   `github.com/qdrant/qdrant/releases/v${QDRANT_VERSION}`, pins on disk in
   `qdrant.version` next to binary. `isBinaryUpToDate()` = strict equality vs
   `QDRANT_VERSION`.

2. **External Qdrant validation.** `QDRANT_URL` → user-managed Qdrant:
   `checkExternalQdrantVersion` fetches server version, rejects anything
   strictly older than `QDRANT_VERSION` with `QdrantVersionTooOldError`.

3. **Downgrade guard.** Installed binary newer than `QDRANT_VERSION` (user
   reinstalled older tea-rags package over newer) → `assertNoDowngrade()` throws
   `QdrantDowngradeNotSupportedError` before old binary overwrites new — Qdrant
   storage not backward-compatible.

4. **Stale-binary warning.** Attach fast path, live daemon's binary ≠
   `QDRANT_VERSION` → `warnIfStaleBinary()` emits stderr notice; upgrade
   deferred to next cold spawn (after all MCP clients disconnect + idle watcher
   shuts daemon down, ~30s).

## When to bump `.qdrant-required-version`

Bump when MCP server starts using a Qdrant capability absent in
previously-pinned version. Triggers:

- Calling REST endpoint introduced in newer Qdrant release.
- Adopting new filter operator, rerank strategy, sparse-vector modifier,
  quantization mode, or vector config old server rejects.
- Switching `@qdrant/js-client-rest` to a major dropping support for old server
  range.

**Do NOT bump** for:

- Purely client-side changes (reranker, chunker, sparse generation).
- Performance tweaks not introducing new server APIs.
- Internal refactoring.

## Bump procedure

1. Edit `.qdrant-required-version` to new semver.
2. Validate Qdrant forward-compat for jump — storage migrates forward on
   `+1..+3` minor bumps, bigger jumps need verification.
3. Update `CHANGELOG` / release notes: **BREAKING** for users running external
   Qdrant below new version — they get `QdrantVersionTooOldError` on startup.
4. Commit with scope `config` (patch) or `feat(config)!` (breaking).

## Why not an env var

`.qdrant-required-version` = **compile-time contract**, not user config. Users
cannot relax at runtime — if MCP code paths rely on server feature, older server
= broken by definition. Constant in git-tracked file (vs buried in TypeScript)
makes bumps visible in diff, lets `npm`/IDE show target version without parsing
compiled JS.

## Anti-pattern

Never hardcode version in multiple places or introduce parallel "min" vs
"embedded" split — one version, one file, one export. Need the value → import
`QDRANT_VERSION` from `src/core/infra/qdrant-version.ts`. Don't duplicate string
literal.
