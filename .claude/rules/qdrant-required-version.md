# `.qdrant-required-version` — Minimum Qdrant Server Version

## What it is

A single-line file at the repository root containing the **minimum Qdrant server
version** (semver `X.Y.Z`) required for all features of the MCP server to work
correctly.

```
1.17.0
```

Shipped with the npm package via `package.json` `files[]`. Read at runtime by
`src/bootstrap/config/qdrant-compat.ts`:

```ts
import { readMinQdrantVersion } from "./bootstrap/config/qdrant-compat.js";

const min = readMinQdrantVersion(); // "1.17.0"
```

## Purpose

Single source of truth for the minimum server version contract. Consumed in two
places:

1. **External Qdrant validation.** When `QDRANT_URL` points at a user-managed
   Qdrant (not the embedded daemon), `checkExternalQdrantVersion` fetches the
   server version and compares against `readMinQdrantVersion()`. Mismatch →
   `QdrantVersionTooOldError` with hint to upgrade.

2. **Embedded binary invariant.** `EMBEDDED_QDRANT_VERSION` (in
   `src/core/adapters/qdrant/embedded/download.ts`) is the version the embedded
   daemon downloads and runs. It MUST always satisfy
   `compareSemver(EMBEDDED_QDRANT_VERSION, readMinQdrantVersion()) >= 0`.
   Enforced by unit test — CI blocks downgrades below the minimum.

## When to bump `.qdrant-required-version`

Bump when the MCP server starts using a Qdrant server capability that did not
exist in the previously-pinned minimum. Concrete triggers:

- Adding a call to a REST endpoint introduced in a newer Qdrant release.
- Adopting a new filter operator, rerank strategy, sparse-vector modifier,
  quantization mode, or vector config that the old server does not accept.
- Switching `@qdrant/js-client-rest` to a major that drops support for the old
  server range.

**Do NOT bump** for:

- Purely client-side changes (reranker, chunker, sparse generation).
- Performance tweaks that do not introduce new server APIs.
- Internal refactoring.

## Bump procedure

1. Edit `.qdrant-required-version` to the new minimum semver.
2. Verify the embedded invariant still holds — if the new minimum exceeds
   `EMBEDDED_QDRANT_VERSION`, bump `EMBEDDED_QDRANT_VERSION` in `download.ts` to
   match (and verify Qdrant storage forward-compat for the jump — see
   `docs/plans/2026-03-09-embedded-qdrant-design.md`).
3. Update `CHANGELOG` / release notes: this is a **BREAKING** change for users
   running external Qdrant below the new minimum — they will get
   `QdrantVersionTooOldError` on startup.
4. Commit with scope `config` (patch) or `feat(config)!` (breaking).

## Why not an env var

`.qdrant-required-version` is a **compile-time contract**, not user config.
Users cannot relax it at runtime — if the MCP code paths depend on a server
feature, running against an older server is broken by definition. Keeping the
constant in a git-tracked file (vs `src/`) makes bumps visible in the diff and
lets `npm`/IDE tools show the required version without parsing TypeScript.

## Anti-pattern

Never hardcode the minimum in multiple places. If you need the value, import
`readMinQdrantVersion()` — do not duplicate the string literal. The file is the
only source of truth; grep for `.qdrant-required-version` before adding a new
reference to find the canonical reader.
