# tea-rags auto-update — design

**Date:** 2026-05-10
**Status:** Approved (brainstorm), pending implementation plan
**Branch:** `feature/auto-update-cli`

## 1. Overview

tea-rags is published to npm as `tea-rags` and consumed primarily as an MCP
server via `npm i -g tea-rags` (or equivalent). Today there is no in-product
signal that a newer version exists; users discover it only by manually checking
the registry or by reading release notes elsewhere. semantic-release publishes
on every merge to main, so the gap between installed and latest can grow large
without the user knowing.

This design adds two coordinated capabilities:

1. **`tea-rags update`** — explicit CLI subcommand that performs the upgrade
   (`npm install -g tea-rags@latest`).
2. **`tea-rags prime`** — existing command, extended to surface a "new version
   available" notice plus a changelog link inside its markdown digest so the
   agent (and the human reading the digest) sees the signal at SessionStart.

The two channels share a single core (`src/cli/update-check/`) and a single
on-disk cache (`~/.tea-rags/update-check.json`).

## 2. Scope

**In scope**

- npm package `tea-rags` version-currency check against the public npm registry
- Markdown section inside prime digest when a newer version is available
- Explicit user-driven upgrade via `tea-rags update`
- 24 h positive cache and 5 min negative cache for prime latency hygiene
- Changelog URL pointing at the corresponding GitHub release

**Out of scope** (handled by other mechanisms or explicitly deferred)

- Embedded Qdrant binary version (handled by `isBinaryUpToDate`,
  `assertNoDowngrade`, `warnIfStaleBinary` in
  `src/core/adapters/qdrant/embedded/download.ts`)
- ONNX embedding model updates
- Qdrant payload schema migrations (handled by `SchemaMigrator`,
  `SnapshotMigrator`, `SparseMigrator`)
- Auto-installing the upgrade without explicit user action — the blast radius
  of `npm install -g` (PATH, permissions, package manager variance) is too
  large for an implicit action
- Background daemon-style update checks outside `prime` and `update`

## 3. Architecture

Two independent channels, one shared core, one shared cache.

```
                ┌────────────────────────┐
                │ npm registry            │
                │ /tea-rags/latest        │
                └──────────▲──────────────┘
                           │ HTTPS GET
                           │
                ┌──────────┴──────────────┐
                │ update-check core       │
                │ (DI: VersionSource +    │
                │  RegistryClient +       │
                │  CacheStore)            │
                └──────┬───────────┬──────┘
                       │           │
        ┌──────────────▼─┐       ┌─▼──────────────────────┐
        │ tea-rags update │       │ tea-rags prime         │
        │ live HTTP       │       │ Promise.allSettled +   │
        │ → npm install   │       │ bounded HTTP +         │
        │   -g latest     │       │ cache-first read       │
        └─────────────────┘       └────────────────────────┘
                       ▲           ▲
                       │           │
                       └─────┬─────┘
                             │
                  ┌──────────┴──────────────┐
                  │ ~/.tea-rags/             │
                  │ update-check.json        │
                  │ (TTL 24h pos / 5min neg) │
                  └──────────────────────────┘
```

Principles:

- **Single source of truth** — the on-disk cache. HTTP is performed by at most
  one actor per TTL window; other actors read the result.
- **Channel independence** — `tea-rags update` works without an MCP server
  attached; the prime notice works without any explicit user command.
- **Never block the primary flow** — analogous to `warnIfStaleBinary`. Prime
  must not stall SessionStart on a slow registry; `update` runs synchronously
  but only because the user is waiting for the action.
- **Explicit upgrade only** — no implicit `npm install` triggered by prime,
  cron, or daemon idle. The user must run `tea-rags update`.

## 4. Components

All paths relative to the repository root. Directory layout follows the
convention established by `src/cli/prime/` (flat, command-local).

```
src/cli/update-check/
  types.ts              UpdateStatus discriminated union + factories
  semver.ts             compareSemver / isValidSemver
  registry-client.ts    interface + NpmRegistryClient
  version-source.ts     interface + PackageJsonVersionSource
  cache-store.ts        interface + FileCacheStore
  check-service.ts      UpdateCheckService (orchestrator)
  format.ts             formatForCli + formatForPrime

src/cli/commands/update.ts          new: yargs CommandModule

src/cli/prime/run-prime.ts          modify: add checkForUpdate to allSettled
src/cli/prime/format.ts             modify: add formatUpdateSection
src/cli/prime/types.ts              modify: add update field to PrimeData
src/cli/create-cli.ts               modify: register updateCommand
```

### 4.1 GRASP responsibility assignment

| Module | GRASP role | Responsibility | Sole reason to change |
| --- | --- | --- | --- |
| `types.ts` | Creator | `UpdateStatus` discriminated union (`available` / `up-to-date` / `unavailable`) + factory functions | Add or modify status variants |
| `semver.ts` | Information Expert | `compareSemver(a, b): -1 \| 0 \| 1`, `isValidSemver(s): boolean` | Semver comparison rules change (e.g. prerelease handling) |
| `registry-client.ts` | Pure Fabrication + Protected Variations | `interface RegistryClient { fetchLatestVersion(pkg, opts): Promise<string \| null> }`; `NpmRegistryClient` implementation | HTTP transport, registry endpoint, or proxy support changes |
| `version-source.ts` | Information Expert + Protected Variations | `interface VersionSource { getCurrent(): string }`; `PackageJsonVersionSource` resolves `package.json` via `import.meta.url` (mirrors `qdrant-version.ts:loadVersion`) | The way the current version is embedded changes |
| `cache-store.ts` | Pure Fabrication | `interface CacheStore { read(): CacheEntry \| null; write(entry): void }`; `FileCacheStore` writes `~/.tea-rags/update-check.json` atomically (tmp + rename, mirrors `qdrant-version.ts:writeInstalledVersion`) | Cache location or serialization format changes |
| `check-service.ts` | Controller + Low Coupling | `UpdateCheckService(versionSource, registry, cache)`; `checkForUpdate(opts): Promise<UpdateStatus>` orchestrates cache-hit / live-HTTP / negative-cache logic. Depends only on the three interfaces. | Orchestration policy changes (TTL, fallback chain) |
| `format.ts` | Information Expert | `formatForCli(status): string` (plain text), `formatForPrime(status): string[]` (markdown lines). Exhaustive switch on `kind`. | Wording or markdown style changes |
| `commands/update.ts` | Controller + Creator | Wires concrete implementations into the service, calls `checkForUpdate({allowNetwork: true})`, switches on the result, spawns `npm install` for the `available` case | CLI surface or wiring changes |
| `prime/run-prime.ts` (mod) | Controller (reuse) | Same DI wiring, calls `checkForUpdate({allowNetwork: true, timeoutMs: 1500, preferCache: true})` inside the existing `Promise.allSettled` block | Prime data flow changes |

### 4.2 Dependency graph (interfaces only)

```
update.ts ─────┐
               ├──► UpdateCheckService ──► VersionSource    (interface)
run-prime.ts ──┘                       ──► RegistryClient   (interface)
                                       ──► CacheStore       (interface)
                                       └─► UpdateStatus + factories (types.ts)

format.ts ──► UpdateStatus (type only)
semver.ts ──► (pure, no imports)
```

`UpdateCheckService` never imports `node:https`, `node:fs`, or `node:path`. All
side-effecting modules live behind interfaces and are constructed by the
controller (`update.ts` or `run-prime.ts`).

### 4.3 Data shapes

```ts
type UpdateStatus =
  | { kind: "available"; current: string; latest: string; changelogUrl: string }
  | { kind: "up-to-date"; current: string }
  | { kind: "unavailable"; reason: "network" | "timeout" | "malformed" | "cache-miss" };

interface CacheEntry {
  status: UpdateStatus;
  fetchedAt: number; // epoch ms
  ttlMs: number;     // 86_400_000 for positive, 300_000 for negative
}

interface CheckOptions {
  allowNetwork: boolean;
  timeoutMs?: number;     // unset = no cap; only set in prime path
  preferCache: boolean;   // true = cache-first; false = bypass cache
}
```

`changelogUrl` is built as
`https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v${latest}` —
semantic-release publishes a release for each version tag.

## 5. Data flow

### 5.1 Scenario A — `tea-rags update`

1. `commands/update.ts:handler` wires `PackageJsonVersionSource`,
   `NpmRegistryClient`, `FileCacheStore` into `UpdateCheckService`.
2. Calls `service.checkForUpdate({ allowNetwork: true, preferCache: false })`.
   `preferCache: false` bypasses the cache — the user wants a live answer.
3. Service:
   1. `versionSource.getCurrent()` → e.g. `"1.23.1"`.
   2. `registry.fetchLatestVersion("tea-rags")` → e.g. `"1.24.0"`.
   3. `semver.compareSemver("1.23.1", "1.24.0")` → `-1`.
   4. Build `available({ current, latest, changelogUrl })`.
   5. `cache.write({ status, fetchedAt: now, ttlMs: 86_400_000 })` as a
      side-effect for the prime channel.
4. Handler switches on `status.kind`:
   - `up-to-date` → stdout `"tea-rags 1.23.1 is up to date."`, exit 0.
   - `unavailable` → stderr `formatForCli(status)`, exit 1.
   - `available` → stdout
     `"Updating tea-rags 1.23.1 → 1.24.0..."`, then
     `spawn('npm', ['install', '-g', 'tea-rags@latest'], { stdio: 'inherit' })`;
     forward the npm exit code.

### 5.2 Scenario B — `tea-rags prime`

1. `run-prime.ts` wires the same DI graph.
2. Inside the existing `Promise.allSettled` block (alongside `getIndexStatus`,
   `getIndexMetrics`, `checkSchemaDrift`), add:
   ```
   service.checkForUpdate({
     allowNetwork: true,
     timeoutMs: 1500,
     preferCache: true,
   })
   ```
   Because the existing Qdrant queries take 100-300 ms, the bounded HTTP call
   parallelises into the same wall-time envelope when the registry responds
   normally.
3. Service:
   1. `entry = cache.read()`; if `entry && now - entry.fetchedAt < entry.ttlMs`
      → return `entry.status` immediately (cache HIT, no HTTP).
   2. Else if `!opts.allowNetwork` → return `unavailable("cache-miss")`.
   3. Else `await registry.fetchLatestVersion("tea-rags", { timeoutMs })`.
      - Success → write positive cache (`ttlMs = 86_400_000`), return status.
      - Timeout / network / malformed → write negative cache
        (`ttlMs = 300_000`), return `unavailable(reason)`.
4. `formatPrime(data)` appends a `## tea-rags package` section **only when**
   `data.update?.kind === "available"`. `up-to-date` and `unavailable` hide
   the section to keep the digest noise-free.

Sample digest fragment for `available`:

```markdown
## tea-rags package
current:   1.23.1
available: 1.24.0
changelog: https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0

→ run `tea-rags update` to upgrade
```

### 5.3 Cache semantics

| Reader | Write triggers | Read policy |
| --- | --- | --- |
| `tea-rags update` | Always writes after a successful live HTTP | Never reads (`preferCache: false`) |
| `tea-rags prime` | Writes on HTTP success **and** on HTTP failure (negative cache) | Reads first, HTTP only on miss/stale |

Concurrency: two prime invocations from parallel sessions may both read stale
cache and both issue HTTP. Last writer wins via atomic `tmp + rename`. No
lock files, no mutexes. Acceptable cost: at most one extra HTTP per double
miss.

### 5.4 Latency budget for prime

| Case | Added wall time |
| --- | --- |
| Cache hit (fresh) | +0 ms |
| Cache miss, registry healthy | +50-200 ms (parallel with Qdrant ~200 ms — usually free) |
| Cache miss, registry slow / unreachable | +1500 ms (timeout cap), then 5 min of negative cache |

## 6. Error handling

Strategy: expected failures are domain states (`UpdateStatus.unavailable`);
programming invariants throw plain `Error`. This is consistent with
`.claude/rules/typed-errors.md` — `update-check/` lives in `src/cli/`, not
under `src/core/` or `src/core/adapters/`, so the typed `InfraError` hierarchy
does not apply. CLI siblings (`tune.ts`, `prime.ts`) follow the same
no-typed-errors convention.

| Source | Failure | Reaction |
| --- | --- | --- |
| `node:https` GET | DNS / connect / timeout / HTTP 4xx-5xx | `unavailable("network")` (timeout uses `"timeout"`); negative cache 5 min |
| Registry JSON | Malformed / missing `version` / non-semver `version` | `unavailable("malformed")`; negative cache 5 min |
| `cache.read` | File missing | Return `null` silently |
| `cache.read` | File corrupted / schema mismatch | Delete file, return `null`. No stderr noise. |
| `cache.write` | EACCES / disk full | Silent fail. Next invocation retries. |
| `package.json` resolve | Path resolution fails | `throw new Error("cannot locate tea-rags package.json")` — programming invariant; the package must always have its own `package.json` |
| `package.json` parse | Invalid JSON / missing `version` | `throw new Error(...)` — same reasoning |
| `commands/update.ts` | Service → `unavailable` | stderr `formatForCli(status)`, exit 1 |
| `commands/update.ts` | Service → `up-to-date` | stdout `"tea-rags <current> is up to date."`, exit 0 |
| `commands/update.ts` | `spawn` emits `error` (npm not in PATH) | stderr `"npm not found in PATH. Install Node.js or update tea-rags manually."`, exit 127 |
| `commands/update.ts` | npm install exits non-zero | npm's own stderr already streamed via `stdio: 'inherit'`; forward exit code unchanged |

What we explicitly do **not** add:

- No `UpdateCheckError extends InfraError`. The module lives in `src/cli/`
  and the discriminated union covers every expected failure.
- No retry loop with backoff. Negative cache (5 min) replaces retry without
  blocking prime.
- No debug log file. Diagnostics ride on `tea-rags update` stderr when the
  user runs it explicitly.

## 7. Testing

Test surface mirrors the GRASP boundaries. Vitest, plain DI mocks (object
literals implementing the interfaces), `createTempTestDir()` from
`tests/core/domains/ingest/__helpers__/test-helpers.ts` for the file-system
test.

| File | Type | Key cases |
| --- | --- | --- |
| `tests/cli/update-check/semver.test.ts` | Unit | `compareSemver` equal / less / greater; `isValidSemver` valid / invalid / prerelease |
| `tests/cli/update-check/types.test.ts` | Unit | Factories produce correct `kind`; `changelogUrl` format |
| `tests/cli/update-check/registry-client.test.ts` | Integration | Happy path; timeout via AbortController; 4xx / 5xx → null; malformed JSON → null; DNS failure → null. Mock via local `http.createServer` (cf. `tests/cli/prime/qdrant-ping.test.ts`) |
| `tests/cli/update-check/cache-store.test.ts` | Integration | Read missing → null; write+read roundtrip; corrupt JSON → null **and** file removed; expired entry → caller sees miss; atomic write keeps file intact under mid-write crash |
| `tests/cli/update-check/check-service.test.ts` | Unit | Cache hit fresh → no HTTP; cache miss + allowNetwork → HTTP → positive cache; cache miss + !allowNetwork → `unavailable("cache-miss")`; stale + preferCache → refresh; HTTP timeout → negative cache; HTTP up-to-date → positive cache |
| `tests/cli/update-check/format.test.ts` | Unit | `formatForCli` for each variant; `formatForPrime` for each variant; changelog URL present in `available` rendering |
| `tests/cli/commands/update.test.ts` | Integration | `up-to-date` → exit 0; `available` → `spawn` called with `['install', '-g', 'tea-rags@latest']` + forward exit code; `unavailable` → stderr + exit 1; `spawn` `error` event → exit 127 |
| `tests/cli/prime/run-prime.test.ts` (modify) | Integration | `update.kind === "available"` → digest contains `## tea-rags package`; `up-to-date` / `unavailable` → section absent; total wall time stays within `max(Qdrant, 1500 ms)` |
| `tests/cli/prime/format.test.ts` (modify) | Unit | `## tea-rags package` section format: exact lines, changelog URL, `→ run tea-rags update` footer |

Coverage strategy follows `.claude/rules/test-patterns.md`: prefer high-level
behavioral tests at the service / command boundary; never lower thresholds.
DI makes the service fully testable without `vi.mock` on `node:*` for the
service tests themselves.

Out of scope for tests:

- No end-to-end test that performs a real `npm install`.
- No test against the live npm registry.
- No tests for ANSI colors or boxen rendering (not used).

## 8. Open questions / future work

- **Package manager detection.** The current design always invokes `npm`. If
  the user installed via `pnpm` / `yarn` / `bun`, the upgrade command will
  still work in most cases (global npm modifies the npm prefix), but a more
  defensive implementation could read `process.env.npm_config_user_agent` and
  emit a warning. Deferred until a user reports the issue.
- **Multi-version changelog link.** Currently a single tag URL. Could be
  expanded to `releases?since=<current>` so the agent sees every release
  between installed and latest. Defer to v2; the single-tag link is enough
  for the first iteration.
- **Disable mechanism.** No environment variable to opt out yet. If users
  request it, the cleanest knob would be `TEA_RAGS_DISABLE_UPDATE_CHECK=1`
  short-circuiting `UpdateCheckService.checkForUpdate` to
  `unavailable("disabled")`. Deferred until requested.
