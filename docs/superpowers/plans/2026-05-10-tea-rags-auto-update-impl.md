# tea-rags auto-update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use `dinopowers:Y` wrappers for every sub-skill chain (TDD, verification, code-review) — direct `superpowers:Y` calls skip tea-rags enrichment.

**Goal:** Add `tea-rags update` CLI subcommand that runs `npm install -g tea-rags@latest`, plus a new `## tea-rags package` section in `tea-rags prime` digest when a newer version is available.

**Architecture:** Two channels share a GRASP-aligned core in `src/cli/update-check/` (7 files behind interfaces) and an on-disk cache at `~/.tea-rags/update-check.json`. `tea-rags update` does live HTTP and bypasses the cache; `tea-rags prime` reads cache-first with a bounded 1500 ms HTTP fallback running parallel to the existing Qdrant queries. `UpdateCheckService` orchestrator depends only on `RegistryClient`, `VersionSource`, `CacheStore` interfaces — fully testable with object-literal mocks.

**Tech Stack:** TypeScript ESM, yargs CLI, `node:https` via `globalThis.fetch` (mirror `qdrant-ping.ts`), vitest, atomic file writes (`tmp + rename`, mirror `qdrant-version.ts` style).

**Spec:** `docs/superpowers/specs/2026-05-10-tea-rags-auto-update-design.md` (committed `751776ea`).

**Branch:** `feature/auto-update-cli` in worktree `/Users/artk0re/Dev/Tools/tea-rags-mcp-auto-update`. All commits stay on this branch.

---

## File Structure

### New files

```
src/cli/update-check/
  types.ts              UpdateStatus discriminated union + factories
  semver.ts             compareSemver / isValidSemver
  registry-client.ts    interface RegistryClient + NpmRegistryClient
  version-source.ts     interface VersionSource + PackageJsonVersionSource
  cache-store.ts        interface CacheStore + FileCacheStore
  check-service.ts      class UpdateCheckService (orchestrator)
  format.ts             formatForCli + formatForPrime

src/cli/commands/update.ts      new: yargs CommandModule

tests/cli/update-check/
  types.test.ts
  semver.test.ts
  registry-client.test.ts
  version-source.test.ts
  cache-store.test.ts
  check-service.test.ts
  format.test.ts

tests/cli/commands/update.test.ts

website/docs/usage/updating.md   new: keeping-up-to-date doc page
```

### Modified files

```
src/cli/create-cli.ts                  register updateCommand
src/cli/prime/types.ts                 add `update: UpdateStatus | null` to PrimeData
src/cli/prime/run-prime.ts             checkForUpdate in Promise.allSettled
src/cli/prime/format.ts                formatUpdateSection in digest

tests/cli/prime/run-prime.test.ts      add update integration cases
tests/cli/prime/format.test.ts         add `## tea-rags package` section cases

website/docs/quickstart/installation.md  short pointer to `tea-rags update`
```

### Dependency order

```
Task 1 (types)     ──┐
Task 2 (semver)    ──┤
Task 3 (version)   ──┤
Task 4 (registry)  ──┼──► Task 6 (check-service) ──┐
Task 5 (cache)     ──┘                              ├──► Task 8 (command)  ──► Task 9 (create-cli)
                                                    │
Task 7 (format)    ─────────────────────────────────┴──► Task 10 (prime integration)

Task 11 (website docs) — independent, can run any time
```

Tasks 1-5, 7 are pure / leaf modules — runnable in parallel.
Task 6 needs 1-5.
Task 8 needs 1, 2, 3, 4, 5, 6, 7.
Task 9 needs 8.
Task 10 needs 1, 2, 6, 7.
Task 11 — independent.

---

## Conventions used throughout

- **Test runner:** `npx vitest run <path/to/test.test.ts>` for a single file, `npx vitest run` for the whole suite.
- **Type-check:** `npm run type-check`.
- **Lint:** `npm run lint` (uses ESLint with `--max-warnings 0` per `lint-staged`).
- **Commit type:** `feat(cli)` for new functionality, `improve(cli)` for prime modifications, `test(cli)` for test-only commits, `docs(website)` for website docs. Always use a scope per `commit-rules.md`.
- **Commit signature footer** (per harness instruction):
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **No `throw new Error`** except for programming invariants (typed-errors.md exemption) — `update-check/` exclusively returns `UpdateStatus.unavailable(reason)` for expected failures; only `package-version.ts` throws (broken package = invariant violation).
- **Imports:** ESM with `.js` extension (TypeScript ESM convention used throughout the repo).
- **Hidden directory:** runtime cache lives in `~/.tea-rags/update-check.json`. The repo's `~/.tea-rags/` convention already used for daemon files; no new top-level directory in user's home.

---

## Task 1: `update-check/types.ts` — UpdateStatus + factories

**GRASP role:** Creator. Defines the discriminated union and constructor functions used by every other module.

**Files:**
- Create: `src/cli/update-check/types.ts`
- Test: `tests/cli/update-check/types.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `tests/cli/update-check/types.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  available,
  buildChangelogUrl,
  unavailable,
  upToDate,
} from "../../../src/cli/update-check/types.js";

describe("update-check types — factories", () => {
  it("available() produces kind='available' with all fields", () => {
    const s = available("1.23.1", "1.24.0");
    expect(s).toEqual({
      kind: "available",
      current: "1.23.1",
      latest: "1.24.0",
      changelogUrl: "https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0",
    });
  });

  it("upToDate() produces kind='up-to-date' with current only", () => {
    const s = upToDate("1.23.1");
    expect(s).toEqual({ kind: "up-to-date", current: "1.23.1" });
  });

  it.each(["network", "timeout", "malformed", "cache-miss"] as const)(
    "unavailable('%s') carries the reason verbatim",
    (reason) => {
      const s = unavailable(reason);
      expect(s).toEqual({ kind: "unavailable", reason });
    },
  );

  it("buildChangelogUrl() points at the GitHub release tag", () => {
    expect(buildChangelogUrl("1.24.0")).toBe(
      "https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0",
    );
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `npx vitest run tests/cli/update-check/types.test.ts`
Expected: FAIL with "Cannot find module" or similar.

- [ ] **Step 1.3: Write the implementation**

Create `src/cli/update-check/types.ts`:

```typescript
/**
 * Discriminated union describing the result of a package-version check.
 *
 * `unavailable` is NOT an error — it is a valid domain state meaning "we
 * could not determine status this time". Callers render it (or skip it)
 * accordingly; they never need a try/catch around the service call.
 */
export type UpdateStatus =
  | { kind: "available"; current: string; latest: string; changelogUrl: string }
  | { kind: "up-to-date"; current: string }
  | { kind: "unavailable"; reason: UnavailableReason };

export type UnavailableReason = "network" | "timeout" | "malformed" | "cache-miss";

/** Cached on-disk envelope around UpdateStatus. */
export interface CacheEntry {
  status: UpdateStatus;
  fetchedAt: number; // epoch ms
  ttlMs: number; // 86_400_000 positive / 300_000 negative
}

/** Options consumed by UpdateCheckService.checkForUpdate. */
export interface CheckOptions {
  allowNetwork: boolean;
  timeoutMs?: number;
  preferCache: boolean;
}

/** GitHub release URL for a given tea-rags version tag. */
export function buildChangelogUrl(version: string): string {
  return `https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v${version}`;
}

export function available(current: string, latest: string): UpdateStatus {
  return {
    kind: "available",
    current,
    latest,
    changelogUrl: buildChangelogUrl(latest),
  };
}

export function upToDate(current: string): UpdateStatus {
  return { kind: "up-to-date", current };
}

export function unavailable(reason: UnavailableReason): UpdateStatus {
  return { kind: "unavailable", reason };
}
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `npx vitest run tests/cli/update-check/types.test.ts`
Expected: PASS — 6 tests pass (4 from `it.each` + 3 standalone).

- [ ] **Step 1.5: Type-check and commit**

```bash
npm run type-check
cd /Users/artk0re/Dev/Tools/tea-rags-mcp-auto-update
git add src/cli/update-check/types.ts tests/cli/update-check/types.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add UpdateStatus discriminated union for auto-update

UpdateStatus + factories (available, upToDate, unavailable) and the
CacheEntry / CheckOptions shapes that the rest of the update-check
module consumes. buildChangelogUrl points at the GitHub release tag
for the latest semver.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `update-check/semver.ts` — pure semver compare

**GRASP role:** Information Expert on semver semantics.

**Files:**
- Create: `src/cli/update-check/semver.ts`
- Test: `tests/cli/update-check/semver.test.ts`

Mirrors the algorithm in `src/core/infra/qdrant-version.ts:40-56` (`compareSemver`/`isSemver`) but lives independently to avoid coupling the CLI module to the Qdrant infra module.

- [ ] **Step 2.1: Write the failing test**

Create `tests/cli/update-check/semver.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { compareSemver, isValidSemver } from "../../../src/cli/update-check/semver.js";

describe("compareSemver", () => {
  it("returns 0 when versions are equal", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns -1 when a < b (patch)", () => {
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
  });

  it("returns 1 when a > b (patch)", () => {
    expect(compareSemver("1.2.4", "1.2.3")).toBe(1);
  });

  it("returns -1 when a < b (minor)", () => {
    expect(compareSemver("1.2.9", "1.3.0")).toBe(-1);
  });

  it("returns -1 when a < b (major)", () => {
    expect(compareSemver("1.99.99", "2.0.0")).toBe(-1);
  });

  it("normalises sign to -1 / 0 / 1 (never raw subtraction)", () => {
    // 1.0.0 vs 5.0.0 — raw subtraction would yield -4, the function must clamp.
    expect(compareSemver("1.0.0", "5.0.0")).toBe(-1);
    expect(compareSemver("5.0.0", "1.0.0")).toBe(1);
  });

  it("throws on invalid semver in either argument", () => {
    expect(() => compareSemver("1.2", "1.2.3")).toThrow();
    expect(() => compareSemver("1.2.3", "v1.2.3")).toThrow();
    expect(() => compareSemver("not-semver", "1.2.3")).toThrow();
  });
});

describe("isValidSemver", () => {
  it.each(["0.0.0", "1.2.3", "1.23.456", "10.20.30"])(
    "accepts X.Y.Z form: %s",
    (v) => {
      expect(isValidSemver(v)).toBe(true);
    },
  );

  it.each(["1.2", "1.2.3.4", "v1.2.3", "1.2.3-rc.1", "", "abc"])(
    "rejects non X.Y.Z form: %s",
    (v) => {
      expect(isValidSemver(v)).toBe(false);
    },
  );
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `npx vitest run tests/cli/update-check/semver.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 2.3: Write the implementation**

Create `src/cli/update-check/semver.ts`:

```typescript
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Strict X.Y.Z semver check. Prerelease tags (-rc.1, -beta) and build
 * metadata (+sha) are intentionally rejected — npm registry's `latest`
 * dist-tag never points at a prerelease, so accepting them would mask
 * a malformed response rather than help.
 */
export function isValidSemver(value: string): boolean {
  return SEMVER_RE.test(value);
}

/**
 * Returns -1, 0, or 1 depending on whether a is less than, equal to, or
 * greater than b. Throws on non-semver inputs — programming invariant.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  if (!isValidSemver(a)) throw new Error(`compareSemver: invalid semver a=${a}`);
  if (!isValidSemver(b)) throw new Error(`compareSemver: invalid semver b=${b}`);
  const [a1, a2, a3] = a.split(".").map((n) => parseInt(n, 10));
  const [b1, b2, b3] = b.split(".").map((n) => parseInt(n, 10));
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  if (a3 !== b3) return a3 < b3 ? -1 : 1;
  return 0;
}
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `npx vitest run tests/cli/update-check/semver.test.ts`
Expected: PASS.

- [ ] **Step 2.5: Type-check and commit**

```bash
npm run type-check
git add src/cli/update-check/semver.ts tests/cli/update-check/semver.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add semver compare helper for update-check

compareSemver returns -1/0/1; isValidSemver enforces strict X.Y.Z.
Prerelease tags are rejected — npm `latest` dist-tag never points at
prereleases, so accepting them would mask malformed registry responses.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `update-check/version-source.ts` — current version from package.json

**GRASP role:** Information Expert + Protected Variations.

**Files:**
- Create: `src/cli/update-check/version-source.ts`
- Test: `tests/cli/update-check/version-source.test.ts`

- [ ] **Step 3.1: Write the failing test**

Create `tests/cli/update-check/version-source.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  PackageJsonVersionSource,
  type VersionSource,
} from "../../../src/cli/update-check/version-source.js";

describe("PackageJsonVersionSource", () => {
  it("reads the version field from the package's package.json", () => {
    const src = new PackageJsonVersionSource();
    const v = src.getCurrent();
    // The test runs inside the tea-rags package itself — package.json must
    // exist and carry a semver. Anything else is a broken installation.
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("satisfies the VersionSource interface", () => {
    const src: VersionSource = new PackageJsonVersionSource();
    expect(typeof src.getCurrent).toBe("function");
    expect(typeof src.getCurrent()).toBe("string");
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `npx vitest run tests/cli/update-check/version-source.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3.3: Write the implementation**

Create `src/cli/update-check/version-source.ts`:

```typescript
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isValidSemver } from "./semver.js";

/** Reads the tea-rags package version from disk. */
export interface VersionSource {
  /**
   * Returns the currently-installed tea-rags version (e.g. "1.23.1").
   * Throws if the package is malformed (programming invariant: every
   * installed npm package must have a parseable package.json with a
   * semver `version`).
   */
  getCurrent(): string;
}

/**
 * Resolves package.json by walking up from this file. Works for both:
 *  - `src/cli/update-check/version-source.ts` (dev via tsx/vitest), and
 *  - `build/cli/update-check/version-source.js` (published layout),
 * because in both cases the file is exactly three levels below the
 * package root. Mirrors `src/core/infra/qdrant-version.ts:resolveVersionFilePath`.
 */
function resolvePackageJsonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "package.json");
}

export class PackageJsonVersionSource implements VersionSource {
  getCurrent(): string {
    const path = resolvePackageJsonPath();
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    const version = parsed.version;
    if (typeof version !== "string" || !isValidSemver(version)) {
      throw new Error(
        `PackageJsonVersionSource: package.json at ${path} has invalid version: ${String(version)}`,
      );
    }
    return version;
  }
}
```

- [ ] **Step 3.4: Run test to verify it passes**

Run: `npx vitest run tests/cli/update-check/version-source.test.ts`
Expected: PASS.

- [ ] **Step 3.5: Type-check and commit**

```bash
npm run type-check
git add src/cli/update-check/version-source.ts tests/cli/update-check/version-source.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add VersionSource for current tea-rags semver

PackageJsonVersionSource walks up from import.meta.url to the package's
own package.json and reads `version`. Mirrors qdrant-version.ts:
resolveVersionFilePath three-levels-up convention so it works in both
the dev source layout and the published `build/` layout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `update-check/registry-client.ts` — npm registry HTTP

**GRASP role:** Pure Fabrication + Protected Variations.

**Files:**
- Create: `src/cli/update-check/registry-client.ts`
- Test: `tests/cli/update-check/registry-client.test.ts`

Uses `globalThis.fetch` to match the existing `src/cli/prime/qdrant-ping.ts` pattern (project convention). Timeout via `AbortController`. Test pattern mirrors `tests/cli/prime/qdrant-ping.test.ts`.

- [ ] **Step 4.1: Write the failing test**

Create `tests/cli/update-check/registry-client.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NpmRegistryClient } from "../../../src/cli/update-check/registry-client.js";

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("NpmRegistryClient.fetchLatestVersion", () => {
  it("returns the version string on a 200 with a well-formed payload", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: "1.24.0" }),
    });
    const client = new NpmRegistryClient();
    const v = await client.fetchLatestVersion("tea-rags");
    expect(v).toBe("1.24.0");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://registry.npmjs.org/tea-rags/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns null on a non-OK HTTP status (4xx/5xx)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ version: "1.24.0" }),
    });
    const client = new NpmRegistryClient();
    expect(await client.fetchLatestVersion("tea-rags")).toBeNull();
  });

  it("returns null when the response body is malformed JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("invalid json")),
    });
    const client = new NpmRegistryClient();
    expect(await client.fetchLatestVersion("tea-rags")).toBeNull();
  });

  it("returns null when the `version` field is missing", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    const client = new NpmRegistryClient();
    expect(await client.fetchLatestVersion("tea-rags")).toBeNull();
  });

  it("returns null when `version` is not a valid semver", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: "not-semver" }),
    });
    const client = new NpmRegistryClient();
    expect(await client.fetchLatestVersion("tea-rags")).toBeNull();
  });

  it("returns null on network/abort error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new NpmRegistryClient();
    expect(await client.fetchLatestVersion("tea-rags")).toBeNull();
  });

  it("passes an AbortController signal when timeoutMs is set", async () => {
    fetchMock.mockImplementation(async (_url, init: { signal: AbortSignal }) => {
      // Simulate a fetch that respects abort.
      return new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => rej(new Error("aborted")));
      });
    });
    const client = new NpmRegistryClient();
    const result = await client.fetchLatestVersion("tea-rags", { timeoutMs: 10 });
    expect(result).toBeNull(); // aborted → null
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `npx vitest run tests/cli/update-check/registry-client.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 4.3: Write the implementation**

Create `src/cli/update-check/registry-client.ts`:

```typescript
import { isValidSemver } from "./semver.js";

export interface RegistryClient {
  /**
   * Returns the `latest` dist-tag version for the given package name.
   * Returns `null` for any expected failure (network error, non-OK
   * response, malformed JSON, non-semver version) so callers can map
   * the result to a domain status without try/catch.
   */
  fetchLatestVersion(packageName: string, opts?: { timeoutMs?: number }): Promise<string | null>;
}

const REGISTRY_BASE = "https://registry.npmjs.org";

export class NpmRegistryClient implements RegistryClient {
  async fetchLatestVersion(
    packageName: string,
    opts?: { timeoutMs?: number },
  ): Promise<string | null> {
    const controller = new AbortController();
    const timer = opts?.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), opts.timeoutMs)
      : null;

    try {
      const url = `${REGISTRY_BASE}/${packageName}/latest`;
      const res = await globalThis.fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: unknown };
      const version = body.version;
      if (typeof version !== "string" || !isValidSemver(version)) return null;
      return version;
    } catch {
      // DNS, connect, abort, json parse — all treated as "unavailable".
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4.4: Run test to verify it passes**

Run: `npx vitest run tests/cli/update-check/registry-client.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 4.5: Type-check and commit**

```bash
npm run type-check
git add src/cli/update-check/registry-client.ts tests/cli/update-check/registry-client.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add NpmRegistryClient for fetching latest tea-rags version

GET registry.npmjs.org/tea-rags/latest with optional AbortController
timeout. Returns null for any expected failure (network, non-OK,
malformed JSON, non-semver version) so the caller maps result to a
domain UpdateStatus without try/catch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `update-check/cache-store.ts` — atomic file cache

**GRASP role:** Pure Fabrication for persistence.

**Files:**
- Create: `src/cli/update-check/cache-store.ts`
- Test: `tests/cli/update-check/cache-store.test.ts`

Cache lives at `~/.tea-rags/update-check.json`. Atomic write via tmp + rename (mirrors `qdrant-version.ts:writeInstalledVersion` convention). Corrupted file → delete and return null.

- [ ] **Step 5.1: Write the failing test**

Create `tests/cli/update-check/cache-store.test.ts`:

```typescript
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileCacheStore } from "../../../src/cli/update-check/cache-store.js";
import type { CacheEntry } from "../../../src/cli/update-check/types.js";

let tmpRoot: string;
let cachePath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "tea-rags-cache-test-"));
  cachePath = join(tmpRoot, "update-check.json");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function sampleEntry(): CacheEntry {
  return {
    status: { kind: "available", current: "1.0.0", latest: "1.1.0", changelogUrl: "https://x" },
    fetchedAt: 1_700_000_000_000,
    ttlMs: 86_400_000,
  };
}

describe("FileCacheStore", () => {
  it("read() returns null when the file does not exist", () => {
    const store = new FileCacheStore(cachePath);
    expect(store.read()).toBeNull();
  });

  it("write() then read() round-trips an entry", () => {
    const store = new FileCacheStore(cachePath);
    const entry = sampleEntry();
    store.write(entry);
    expect(store.read()).toEqual(entry);
  });

  it("write() creates parent directory if missing", () => {
    const nested = join(tmpRoot, "deep", "nested", "update-check.json");
    const store = new FileCacheStore(nested);
    store.write(sampleEntry());
    expect(existsSync(nested)).toBe(true);
  });

  it("read() returns null AND deletes the file when JSON is corrupt", () => {
    writeFileSync(cachePath, "{ not valid json", "utf-8");
    const store = new FileCacheStore(cachePath);
    expect(store.read()).toBeNull();
    expect(existsSync(cachePath)).toBe(false);
  });

  it("read() returns null AND deletes the file when schema is wrong", () => {
    writeFileSync(cachePath, JSON.stringify({ foo: "bar" }), "utf-8");
    const store = new FileCacheStore(cachePath);
    expect(store.read()).toBeNull();
    expect(existsSync(cachePath)).toBe(false);
  });

  it("write() uses tmp+rename so file is never partially written", () => {
    const store = new FileCacheStore(cachePath);
    store.write(sampleEntry());
    // The temp file used during write must NOT remain on disk after a successful write.
    const stray = readFileSync(cachePath, "utf-8");
    expect(stray).toContain(`"kind":"available"`);
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `npx vitest run tests/cli/update-check/cache-store.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 5.3: Write the implementation**

Create `src/cli/update-check/cache-store.ts`:

```typescript
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CacheEntry, UpdateStatus } from "./types.js";

export interface CacheStore {
  /** Returns the cached entry or null if missing/corrupt. Never throws. */
  read(): CacheEntry | null;
  /** Atomically replaces the cache contents. Silent on EACCES / disk full. */
  write(entry: CacheEntry): void;
}

/** Default cache file location: `~/.tea-rags/update-check.json`. */
export function defaultCachePath(): string {
  return join(homedir(), ".tea-rags", "update-check.json");
}

export class FileCacheStore implements CacheStore {
  constructor(private readonly path: string = defaultCachePath()) {}

  read(): CacheEntry | null {
    if (!existsSync(this.path)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.tryDelete();
      return null;
    }

    if (!isCacheEntry(parsed)) {
      this.tryDelete();
      return null;
    }
    return parsed;
  }

  write(entry: CacheEntry): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(entry), "utf-8");
      renameSync(tmp, this.path);
    } catch {
      // Silent fail per design — caller does not need to know.
    }
  }

  private tryDelete(): void {
    try {
      rmSync(this.path, { force: true });
    } catch {
      // Ignore.
    }
  }
}

function isCacheEntry(v: unknown): v is CacheEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return isUpdateStatus(o.status) && typeof o.fetchedAt === "number" && typeof o.ttlMs === "number";
}

function isUpdateStatus(v: unknown): v is UpdateStatus {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.kind === "available") {
    return (
      typeof o.current === "string" &&
      typeof o.latest === "string" &&
      typeof o.changelogUrl === "string"
    );
  }
  if (o.kind === "up-to-date") return typeof o.current === "string";
  if (o.kind === "unavailable") {
    return o.reason === "network" || o.reason === "timeout" || o.reason === "malformed" || o.reason === "cache-miss";
  }
  return false;
}
```

- [ ] **Step 5.4: Run test to verify it passes**

Run: `npx vitest run tests/cli/update-check/cache-store.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 5.5: Type-check and commit**

```bash
npm run type-check
git add src/cli/update-check/cache-store.ts tests/cli/update-check/cache-store.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add FileCacheStore for ~/.tea-rags/update-check.json

Atomic write via tmp+rename (mirrors qdrant-version.ts pattern). Read
returns null on missing/corrupt/wrong-schema and deletes corrupt files
to self-heal. Schema validated with a structural type guard.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `update-check/check-service.ts` — orchestrator

**GRASP role:** Controller + Low Coupling. Depends only on the three interfaces.

**Files:**
- Create: `src/cli/update-check/check-service.ts`
- Test: `tests/cli/update-check/check-service.test.ts`

- [ ] **Step 6.1: Write the failing test**

Create `tests/cli/update-check/check-service.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import type { CacheStore } from "../../../src/cli/update-check/cache-store.js";
import { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import type { RegistryClient } from "../../../src/cli/update-check/registry-client.js";
import type { CacheEntry, UpdateStatus } from "../../../src/cli/update-check/types.js";
import type { VersionSource } from "../../../src/cli/update-check/version-source.js";

const NOW = 1_700_000_000_000;

function mockSource(current: string): VersionSource {
  return { getCurrent: () => current };
}
function mockRegistry(latest: string | null): RegistryClient {
  return { fetchLatestVersion: vi.fn().mockResolvedValue(latest) };
}
function mockCache(initial: CacheEntry | null = null): CacheStore & { reads: number; writes: CacheEntry[] } {
  const state = { entry: initial, reads: 0, writes: [] as CacheEntry[] };
  return {
    read: () => {
      state.reads++;
      return state.entry;
    },
    write: (e) => {
      state.writes.push(e);
      state.entry = e;
    },
    get reads() {
      return state.reads;
    },
    get writes() {
      return state.writes;
    },
  };
}

describe("UpdateCheckService.checkForUpdate", () => {
  it("returns available when current < latest (live HTTP, preferCache=false)", async () => {
    const cache = mockCache();
    const registry = mockRegistry("1.24.0");
    const svc = new UpdateCheckService(mockSource("1.23.1"), registry, cache, () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: false });
    expect(status).toEqual<UpdateStatus>({
      kind: "available",
      current: "1.23.1",
      latest: "1.24.0",
      changelogUrl: "https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0",
    });
    expect(registry.fetchLatestVersion).toHaveBeenCalled();
    expect(cache.writes).toHaveLength(1);
    expect(cache.writes[0].ttlMs).toBe(86_400_000);
  });

  it("returns up-to-date when current == latest", async () => {
    const svc = new UpdateCheckService(
      mockSource("1.23.1"),
      mockRegistry("1.23.1"),
      mockCache(),
      () => NOW,
    );
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: false });
    expect(status).toEqual<UpdateStatus>({ kind: "up-to-date", current: "1.23.1" });
  });

  it("returns up-to-date when current > latest (downgrade edge: treat as up-to-date)", async () => {
    const svc = new UpdateCheckService(
      mockSource("2.0.0"),
      mockRegistry("1.99.99"),
      mockCache(),
      () => NOW,
    );
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: false });
    expect(status.kind).toBe("up-to-date");
  });

  it("returns unavailable('network') and writes negative cache on registry null", async () => {
    const cache = mockCache();
    const svc = new UpdateCheckService(mockSource("1.0.0"), mockRegistry(null), cache, () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: false });
    expect(status).toEqual<UpdateStatus>({ kind: "unavailable", reason: "network" });
    expect(cache.writes[0].ttlMs).toBe(300_000);
  });

  it("returns cached value when fresh and preferCache=true (no HTTP)", async () => {
    const fresh: CacheEntry = {
      status: { kind: "available", current: "1.0.0", latest: "1.1.0", changelogUrl: "https://x" },
      fetchedAt: NOW - 1000,
      ttlMs: 86_400_000,
    };
    const registry = mockRegistry("1.2.0");
    const cache = mockCache(fresh);
    const svc = new UpdateCheckService(mockSource("1.0.0"), registry, cache, () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: true });
    expect(status).toEqual(fresh.status);
    expect(registry.fetchLatestVersion).not.toHaveBeenCalled();
  });

  it("bypasses fresh cache when preferCache=false (always live HTTP)", async () => {
    const fresh: CacheEntry = {
      status: { kind: "up-to-date", current: "1.0.0" },
      fetchedAt: NOW - 1000,
      ttlMs: 86_400_000,
    };
    const registry = mockRegistry("1.5.0");
    const svc = new UpdateCheckService(mockSource("1.0.0"), registry, mockCache(fresh), () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: false });
    expect(status.kind).toBe("available");
    expect(registry.fetchLatestVersion).toHaveBeenCalled();
  });

  it("re-fetches when cache is stale (past TTL)", async () => {
    const stale: CacheEntry = {
      status: { kind: "up-to-date", current: "1.0.0" },
      fetchedAt: NOW - 100_000_000, // way past 24h
      ttlMs: 86_400_000,
    };
    const registry = mockRegistry("1.5.0");
    const svc = new UpdateCheckService(mockSource("1.0.0"), registry, mockCache(stale), () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: true });
    expect(status.kind).toBe("available");
    expect(registry.fetchLatestVersion).toHaveBeenCalled();
  });

  it("returns unavailable('cache-miss') when allowNetwork=false and no fresh cache", async () => {
    const svc = new UpdateCheckService(
      mockSource("1.0.0"),
      mockRegistry("1.1.0"),
      mockCache(),
      () => NOW,
    );
    const status = await svc.checkForUpdate({ allowNetwork: false, preferCache: true });
    expect(status).toEqual<UpdateStatus>({ kind: "unavailable", reason: "cache-miss" });
  });

  it("passes timeoutMs to the registry client", async () => {
    const registry = mockRegistry("1.0.0");
    const svc = new UpdateCheckService(mockSource("1.0.0"), registry, mockCache(), () => NOW);
    await svc.checkForUpdate({ allowNetwork: true, preferCache: false, timeoutMs: 1500 });
    expect(registry.fetchLatestVersion).toHaveBeenCalledWith("tea-rags", { timeoutMs: 1500 });
  });
});
```

- [ ] **Step 6.2: Run test to verify it fails**

Run: `npx vitest run tests/cli/update-check/check-service.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 6.3: Write the implementation**

Create `src/cli/update-check/check-service.ts`:

```typescript
import type { CacheStore } from "./cache-store.js";
import type { RegistryClient } from "./registry-client.js";
import { compareSemver } from "./semver.js";
import {
  available,
  type CacheEntry,
  type CheckOptions,
  type UpdateStatus,
  unavailable,
  upToDate,
} from "./types.js";
import type { VersionSource } from "./version-source.js";

const PACKAGE_NAME = "tea-rags";
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

/**
 * Orchestrates the update check. Depends only on three interfaces so the
 * whole class is testable with plain object literals (see check-service.test.ts).
 */
export class UpdateCheckService {
  constructor(
    private readonly versionSource: VersionSource,
    private readonly registry: RegistryClient,
    private readonly cache: CacheStore,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async checkForUpdate(opts: CheckOptions): Promise<UpdateStatus> {
    const now = this.clock();

    if (opts.preferCache) {
      const cached = this.cache.read();
      if (cached !== null && now - cached.fetchedAt < cached.ttlMs) {
        return cached.status;
      }
    }

    if (!opts.allowNetwork) {
      return unavailable("cache-miss");
    }

    const current = this.versionSource.getCurrent();
    const latest = await this.registry.fetchLatestVersion(
      PACKAGE_NAME,
      opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined,
    );

    const status = this.deriveStatus(current, latest);
    this.persist(status, now);
    return status;
  }

  private deriveStatus(current: string, latest: string | null): UpdateStatus {
    if (latest === null) return unavailable("network");
    const cmp = compareSemver(current, latest);
    if (cmp < 0) return available(current, latest);
    return upToDate(current);
  }

  private persist(status: UpdateStatus, now: number): void {
    const ttlMs = status.kind === "unavailable" ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
    const entry: CacheEntry = { status, fetchedAt: now, ttlMs };
    this.cache.write(entry);
  }
}
```

- [ ] **Step 6.4: Run test to verify it passes**

Run: `npx vitest run tests/cli/update-check/check-service.test.ts`
Expected: PASS — all 9 tests.

- [ ] **Step 6.5: Type-check and commit**

```bash
npm run type-check
git add src/cli/update-check/check-service.ts tests/cli/update-check/check-service.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add UpdateCheckService orchestrator

Cache-first read controlled by CheckOptions.preferCache, live HTTP
controlled by CheckOptions.allowNetwork. Positive cache 24h, negative
cache 5min. Service depends only on VersionSource / RegistryClient /
CacheStore interfaces — testable with plain object-literal mocks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `update-check/format.ts` — render functions

**GRASP role:** Information Expert on rendering.

**Files:**
- Create: `src/cli/update-check/format.ts`
- Test: `tests/cli/update-check/format.test.ts`

- [ ] **Step 7.1: Write the failing test**

Create `tests/cli/update-check/format.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { formatForCli, formatForPrime } from "../../../src/cli/update-check/format.js";
import { available, unavailable, upToDate } from "../../../src/cli/update-check/types.js";

describe("formatForCli", () => {
  it("renders the 'available' variant with current, latest, changelog", () => {
    const out = formatForCli(available("1.23.1", "1.24.0"));
    expect(out).toContain("1.23.1");
    expect(out).toContain("1.24.0");
    expect(out).toContain("https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0");
  });

  it("renders 'up-to-date' with the current version", () => {
    const out = formatForCli(upToDate("1.23.1"));
    expect(out).toContain("1.23.1");
    expect(out).toContain("up to date");
  });

  it.each(["network", "timeout", "malformed"] as const)(
    "renders 'unavailable' with reason: %s",
    (reason) => {
      const out = formatForCli(unavailable(reason));
      expect(out.toLowerCase()).toContain("couldn't check");
    },
  );
});

describe("formatForPrime", () => {
  it("renders the section for 'available' with header, fields, and footer hint", () => {
    const lines = formatForPrime(available("1.23.1", "1.24.0"));
    const joined = lines.join("\n");
    expect(joined).toContain("## tea-rags package");
    expect(joined).toContain("current:");
    expect(joined).toContain("1.23.1");
    expect(joined).toContain("available:");
    expect(joined).toContain("1.24.0");
    expect(joined).toContain("changelog:");
    expect(joined).toContain("https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0");
    expect(joined).toContain("run `tea-rags update`");
  });

  it("returns an empty array for 'up-to-date' (section omitted)", () => {
    expect(formatForPrime(upToDate("1.23.1"))).toEqual([]);
  });

  it.each(["network", "timeout", "malformed", "cache-miss"] as const)(
    "returns an empty array for 'unavailable(%s)' (section omitted)",
    (reason) => {
      expect(formatForPrime(unavailable(reason))).toEqual([]);
    },
  );
});
```

- [ ] **Step 7.2: Run test to verify it fails**

Run: `npx vitest run tests/cli/update-check/format.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 7.3: Write the implementation**

Create `src/cli/update-check/format.ts`:

```typescript
import type { UpdateStatus } from "./types.js";

/** Plain text for `tea-rags update` stdout / stderr. */
export function formatForCli(status: UpdateStatus): string {
  switch (status.kind) {
    case "available":
      return [
        `tea-rags ${status.current} → ${status.latest} available.`,
        `changelog: ${status.changelogUrl}`,
      ].join("\n");
    case "up-to-date":
      return `tea-rags ${status.current} is up to date.`;
    case "unavailable":
      return `Couldn't check for updates (reason: ${status.reason}). Try again later.`;
  }
}

/**
 * Markdown lines for the prime digest. Returns an empty array unless the
 * status is "available" — `up-to-date` and `unavailable` are intentionally
 * omitted from the digest to avoid noise.
 */
export function formatForPrime(status: UpdateStatus): string[] {
  if (status.kind !== "available") return [];
  return [
    "## tea-rags package",
    `current:   ${status.current}`,
    `available: ${status.latest}`,
    `changelog: ${status.changelogUrl}`,
    "",
    "→ run `tea-rags update` to upgrade",
  ];
}
```

- [ ] **Step 7.4: Run test to verify it passes**

Run: `npx vitest run tests/cli/update-check/format.test.ts`
Expected: PASS — all 7 tests pass.

- [ ] **Step 7.5: Type-check and commit**

```bash
npm run type-check
git add src/cli/update-check/format.ts tests/cli/update-check/format.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add formatForCli/formatForPrime for update-check

formatForCli renders plain text for the `tea-rags update` command;
formatForPrime returns markdown lines for the prime digest, intentionally
returning [] for up-to-date / unavailable to keep the digest noise-free.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `commands/update.ts` — yargs command + npm install

**GRASP role:** Controller + Creator (assembly root for the CLI channel).

**Files:**
- Create: `src/cli/commands/update.ts`
- Test: `tests/cli/commands/update.test.ts`

Wires concrete `PackageJsonVersionSource`, `NpmRegistryClient`, `FileCacheStore` into `UpdateCheckService`. On `available`, spawns `npm install -g tea-rags@latest` with `stdio: 'inherit'` and forwards the exit code. The handler accepts dependency-injected overrides so tests can mock the service and the spawn function.

- [ ] **Step 8.1: Write the failing test**

Create `tests/cli/commands/update.test.ts`:

```typescript
import EventEmitter from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runUpdateCommand } from "../../../src/cli/commands/update.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { available, unavailable, upToDate } from "../../../src/cli/update-check/types.js";

const stdoutMock = vi.fn();
const stderrMock = vi.fn();
const exitMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);
const stderrOriginal = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  stdoutMock.mockReset();
  stderrMock.mockReset();
  exitMock.mockReset();
  process.stdout.write = stdoutMock as unknown as typeof process.stdout.write;
  process.stderr.write = stderrMock as unknown as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = stdoutOriginal;
  process.stderr.write = stderrOriginal;
});

function makeService(status: ReturnType<typeof available>): UpdateCheckService {
  return {
    checkForUpdate: vi.fn().mockResolvedValue(status),
  } as unknown as UpdateCheckService;
}

function makeSpawn(behavior: { exitCode?: number | null; errorEvent?: Error }) {
  return vi.fn().mockImplementation(() => {
    const ee = new EventEmitter() as EventEmitter & { kill?: () => void };
    setImmediate(() => {
      if (behavior.errorEvent) {
        ee.emit("error", behavior.errorEvent);
        return;
      }
      ee.emit("exit", behavior.exitCode ?? 0);
    });
    return ee;
  });
}

describe("runUpdateCommand", () => {
  it("prints up-to-date message and exits 0", async () => {
    await runUpdateCommand({
      service: makeService(upToDate("1.23.1") as unknown as ReturnType<typeof available>),
      spawn: makeSpawn({}),
      exit: exitMock,
    });
    expect(stdoutMock).toHaveBeenCalled();
    expect(stdoutMock.mock.calls[0][0]).toContain("up to date");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("on 'available', prints upgrade message and spawns npm install -g tea-rags@latest", async () => {
    const spawn = makeSpawn({ exitCode: 0 });
    await runUpdateCommand({
      service: makeService(available("1.23.1", "1.24.0")),
      spawn,
      exit: exitMock,
    });
    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "tea-rags@latest"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("forwards non-zero npm exit code", async () => {
    await runUpdateCommand({
      service: makeService(available("1.23.1", "1.24.0")),
      spawn: makeSpawn({ exitCode: 7 }),
      exit: exitMock,
    });
    expect(exitMock).toHaveBeenCalledWith(7);
  });

  it("on 'unavailable', prints to stderr and exits 1", async () => {
    await runUpdateCommand({
      service: makeService(unavailable("network") as unknown as ReturnType<typeof available>),
      spawn: makeSpawn({}),
      exit: exitMock,
    });
    expect(stderrMock).toHaveBeenCalled();
    expect(stderrMock.mock.calls[0][0].toLowerCase()).toContain("couldn't check");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("on spawn 'error' event (npm not in PATH), prints helpful stderr and exits 127", async () => {
    await runUpdateCommand({
      service: makeService(available("1.23.1", "1.24.0")),
      spawn: makeSpawn({ errorEvent: new Error("ENOENT") }),
      exit: exitMock,
    });
    expect(stderrMock).toHaveBeenCalled();
    expect(stderrMock.mock.calls.some((c) => String(c[0]).includes("npm not found"))).toBe(true);
    expect(exitMock).toHaveBeenCalledWith(127);
  });

  it("calls service with allowNetwork=true and preferCache=false (live HTTP)", async () => {
    const svc = makeService(upToDate("1.23.1") as unknown as ReturnType<typeof available>);
    await runUpdateCommand({
      service: svc,
      spawn: makeSpawn({}),
      exit: exitMock,
    });
    expect(svc.checkForUpdate).toHaveBeenCalledWith({
      allowNetwork: true,
      preferCache: false,
    });
  });
});
```

- [ ] **Step 8.2: Run test to verify it fails**

Run: `npx vitest run tests/cli/commands/update.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 8.3: Write the implementation**

Create `src/cli/commands/update.ts`:

```typescript
import { spawn as nodeSpawn } from "node:child_process";

import type { CommandModule } from "yargs";

import { FileCacheStore } from "../update-check/cache-store.js";
import { UpdateCheckService } from "../update-check/check-service.js";
import { formatForCli } from "../update-check/format.js";
import { NpmRegistryClient } from "../update-check/registry-client.js";
import type { UpdateStatus } from "../update-check/types.js";
import { PackageJsonVersionSource } from "../update-check/version-source.js";

type SpawnFn = typeof nodeSpawn;
type ExitFn = (code: number) => void;

export interface RunUpdateDeps {
  service: Pick<UpdateCheckService, "checkForUpdate">;
  spawn: SpawnFn;
  exit: ExitFn;
}

function defaultDeps(): RunUpdateDeps {
  const service = new UpdateCheckService(
    new PackageJsonVersionSource(),
    new NpmRegistryClient(),
    new FileCacheStore(),
  );
  return {
    service,
    spawn: nodeSpawn,
    exit: (code) => process.exit(code),
  };
}

/**
 * Pure handler — accepts injected deps so tests can mock the service and
 * the spawn function without touching node:child_process or the real
 * registry.
 */
export async function runUpdateCommand(depsOverride?: Partial<RunUpdateDeps>): Promise<void> {
  const deps = { ...defaultDeps(), ...depsOverride };
  const status = await deps.service.checkForUpdate({ allowNetwork: true, preferCache: false });

  switch (status.kind) {
    case "up-to-date":
      process.stdout.write(`${formatForCli(status)}\n`);
      deps.exit(0);
      return;
    case "unavailable":
      process.stderr.write(`${formatForCli(status)}\n`);
      deps.exit(1);
      return;
    case "available":
      runNpmInstall(status, deps);
      return;
  }
}

function runNpmInstall(status: Extract<UpdateStatus, { kind: "available" }>, deps: RunUpdateDeps): void {
  process.stdout.write(`Updating tea-rags ${status.current} → ${status.latest}...\n`);
  const child = deps.spawn("npm", ["install", "-g", "tea-rags@latest"], { stdio: "inherit" });

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || /ENOENT|not found/i.test(err.message)) {
      process.stderr.write(
        "npm not found in PATH. Install Node.js or update tea-rags manually.\n",
      );
      deps.exit(127);
      return;
    }
    process.stderr.write(`Failed to spawn npm: ${err.message}\n`);
    deps.exit(1);
  });

  child.on("exit", (code) => {
    deps.exit(code ?? 1);
  });
}

export const updateCommand: CommandModule<object, object> = {
  command: "update",
  describe: "Check for a newer tea-rags version and install it via npm.",
  handler: async () => {
    await runUpdateCommand();
  },
};
```

- [ ] **Step 8.4: Run test to verify it passes**

Run: `npx vitest run tests/cli/commands/update.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 8.5: Type-check and commit**

```bash
npm run type-check
git add src/cli/commands/update.ts tests/cli/commands/update.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add `tea-rags update` subcommand

Live registry HTTP (preferCache=false), then switch on UpdateStatus:
spawn `npm install -g tea-rags@latest` for available, plain message for
up-to-date / unavailable. Handler accepts injected service+spawn deps
for test isolation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: register `updateCommand` in `create-cli.ts`

**Files:**
- Modify: `src/cli/create-cli.ts` (insert `.command(updateCommand)` at line 14)

- [ ] **Step 9.1: Update create-cli.ts**

The current file (worktree head):

```typescript
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { primeCommand } from "./commands/prime.js";
import { serverCommand } from "./commands/server.js";
import { tuneCommand } from "./commands/tune.js";

export function createCli(argv?: string[]): ReturnType<typeof yargs> {
  return yargs(argv ?? hideBin(process.argv))
    .scriptName("tea-rags")
    .command(serverCommand)
    .command(tuneCommand)
    .command(primeCommand)
    .demandCommand(1, "Please specify a command. Run with --help to see available commands.")
    .strict()
    .help();
}
```

Apply two edits.

Edit 1 — add import alphabetically after `primeCommand`:

```typescript
import { primeCommand } from "./commands/prime.js";
import { serverCommand } from "./commands/server.js";
import { tuneCommand } from "./commands/tune.js";
import { updateCommand } from "./commands/update.js";
```

Edit 2 — register the command in the yargs chain:

```typescript
    .command(serverCommand)
    .command(tuneCommand)
    .command(primeCommand)
    .command(updateCommand)
    .demandCommand(1, "Please specify a command. Run with --help to see available commands.")
```

- [ ] **Step 9.2: Smoke-test the registration**

Run:
```bash
npm run build
node build/cli/index.js update --help
```
Expected: yargs prints the description "Check for a newer tea-rags version and install it via npm." plus the standard `--help`, `--version` flags.

- [ ] **Step 9.3: Run the full vitest suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — all existing + new tests.

- [ ] **Step 9.4: Type-check and commit**

```bash
npm run type-check
git add src/cli/create-cli.ts
git commit -m "$(cat <<'EOF'
feat(cli): register update subcommand in createCli

Wires updateCommand into the yargs chain alongside server, tune, prime.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: integrate update check into `tea-rags prime`

**Coordinated change** — `prime/types.ts`, `prime/run-prime.ts`, `prime/format.ts` must change together because they share the `PrimeData` contract.

**Files:**
- Modify: `src/cli/prime/types.ts`
- Modify: `src/cli/prime/run-prime.ts`
- Modify: `src/cli/prime/format.ts`
- Modify: `tests/cli/prime/run-prime.test.ts`
- Modify: `tests/cli/prime/format.test.ts`

The plan modifies tests first (RED), then types/run-prime/format together (GREEN), to keep the change atomic.

- [ ] **Step 10.1: Add failing tests for prime integration**

Edit `tests/cli/prime/format.test.ts` — append a new describe block after the existing tests (do NOT modify existing assertions):

```typescript
import { available, unavailable, upToDate } from "../../../src/cli/update-check/types.js";

describe("formatPrime — tea-rags package section", () => {
  it("includes the `## tea-rags package` section when update.kind === 'available'", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "indexed", chunksCount: 1, collectionName: "c" }),
      metrics: monolingualMetricsFixture(),
      drift: null,
      update: available("1.23.1", "1.24.0"),
    });
    expect(out).toContain("## tea-rags package");
    expect(out).toContain("current:   1.23.1");
    expect(out).toContain("available: 1.24.0");
    expect(out).toContain("changelog: https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0");
  });

  it("omits the section when update.kind === 'up-to-date'", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "indexed", chunksCount: 1, collectionName: "c" }),
      metrics: monolingualMetricsFixture(),
      drift: null,
      update: upToDate("1.23.1"),
    });
    expect(out).not.toContain("## tea-rags package");
  });

  it("omits the section when update.kind === 'unavailable'", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "indexed", chunksCount: 1, collectionName: "c" }),
      metrics: monolingualMetricsFixture(),
      drift: null,
      update: unavailable("timeout"),
    });
    expect(out).not.toContain("## tea-rags package");
  });

  it("omits the section when update is null", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "indexed", chunksCount: 1, collectionName: "c" }),
      metrics: monolingualMetricsFixture(),
      drift: null,
      update: null,
    });
    expect(out).not.toContain("## tea-rags package");
  });
});
```

Edit `tests/cli/prime/run-prime.test.ts` — append after existing tests:

```typescript
import { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { available, upToDate } from "../../../src/cli/update-check/types.js";

describe("runPrime — update-check integration", () => {
  function buildFullCtx(checkForUpdate: ReturnType<typeof vi.fn>) {
    return {
      app: {
        getIndexStatus: vi.fn().mockResolvedValue({
          isIndexed: true,
          status: "indexed",
          collectionName: "c",
          chunksCount: 100,
        }),
        getIndexMetrics: vi.fn().mockResolvedValue({
          collection: "c",
          totalChunks: 100,
          totalFiles: 10,
          distributions: { language: { typescript: 100 } },
          signals: {},
        }),
        checkSchemaDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup: vi.fn(),
      updateService: { checkForUpdate } as unknown as UpdateCheckService,
    };
  }

  it("includes the update section in stdout when available", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const ctx = buildFullCtx(vi.fn().mockResolvedValue(available("1.0.0", "1.1.0")));
    createAppContextMock.mockResolvedValue(ctx);

    await runPrime("/some/project");

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("## tea-rags package");
  });

  it("omits the update section when up-to-date", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const ctx = buildFullCtx(vi.fn().mockResolvedValue(upToDate("1.0.0")));
    createAppContextMock.mockResolvedValue(ctx);

    await runPrime("/some/project");

    expect(writeMock.mock.calls[0][0]).not.toContain("## tea-rags package");
  });

  it("does not stall the digest if checkForUpdate rejects (rejections still resolve allSettled)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const ctx = buildFullCtx(vi.fn().mockRejectedValue(new Error("boom")));
    createAppContextMock.mockResolvedValue(ctx);

    await runPrime("/some/project");

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("# tea-rags prime");
  });

  it("calls checkForUpdate with allowNetwork=true, timeoutMs=1500, preferCache=true", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const checkForUpdateMock = vi.fn().mockResolvedValue(upToDate("1.0.0"));
    const ctx = buildFullCtx(checkForUpdateMock);
    createAppContextMock.mockResolvedValue(ctx);

    await runPrime("/some/project");

    expect(checkForUpdateMock).toHaveBeenCalledWith({
      allowNetwork: true,
      timeoutMs: 1500,
      preferCache: true,
    });
  });
});
```

- [ ] **Step 10.2: Run tests to verify they fail (RED)**

Run: `npx vitest run tests/cli/prime/format.test.ts tests/cli/prime/run-prime.test.ts`
Expected: New tests FAIL — `formatPrime` doesn't accept `update`; `createAppContext` mock doesn't return `updateService`. Existing tests still PASS.

- [ ] **Step 10.3: Modify `src/cli/prime/types.ts`**

Final contents:

```typescript
import type { IndexMetrics, IndexStatus } from "../../core/api/public/dto/index.js";
import type { UpdateStatus } from "../update-check/types.js";

/**
 * Successful prime data — index reachable, status fetched.
 * `metrics` is null when the project is not yet indexed (status !== "indexed").
 * `update` is null when the prime path did not request an update check
 *   (e.g. degraded path) or the field was never populated.
 */
export interface PrimeData {
  path: string;
  status: IndexStatus;
  metrics: IndexMetrics | null;
  drift: string | null;
  update: UpdateStatus | null;
}

/**
 * Degraded outputs that exit the runPrime pipeline early without a full digest.
 * Each variant produces a short markdown placeholder via formatPrime.
 */
export type PrimeFailureReason = { kind: "path-not-found"; path: string } | { kind: "qdrant-cold"; path: string };
```

- [ ] **Step 10.4: Modify `src/cli/prime/format.ts`**

Two edits.

Edit 1 — add an import at the top after the existing imports:

```typescript
import { formatForPrime } from "../update-check/format.js";
```

Edit 2 — inside `formatDigest`, append the update section before the existing closing `return`. The exact insertion point is right before the final `return \`${lines.join("\n")}\n\`;`, after the language / thresholds blocks but before the closing return:

Locate this existing block at the end of `formatDigest`:

```typescript
  if (data.metrics && languages.length > 0) {
    const primary = languages[0];
    if (primary && data.metrics.signals[primary]) {
      lines.push("");
      lines.push(...formatThresholdsSection(primary, data.metrics.signals[primary]));
    }
  }
```

Insert immediately after it (and before any final `→ run ...` refresh-hint footer if present):

```typescript
  if (data.update !== null) {
    const updateLines = formatForPrime(data.update);
    if (updateLines.length > 0) {
      lines.push("");
      lines.push(...updateLines);
    }
  }
```

Note: if the file already has a trailing refresh-hint line like ``→ run `tea-rags prime "$CLAUDE_PROJECT_DIR"` to refresh this digest after re-indexing``, place the update section BEFORE it so the refresh hint remains the last line of the digest.

- [ ] **Step 10.5: Modify `src/cli/prime/run-prime.ts`**

Replace the file with:

```typescript
import { existsSync } from "node:fs";

import { parseAppConfig } from "../../bootstrap/config/index.js";
import { createAppContext } from "../../bootstrap/factory.js";
import { FileCacheStore } from "../update-check/cache-store.js";
import { UpdateCheckService } from "../update-check/check-service.js";
import { NpmRegistryClient } from "../update-check/registry-client.js";
import type { UpdateStatus } from "../update-check/types.js";
import { PackageJsonVersionSource } from "../update-check/version-source.js";
import { formatPrime } from "./format.js";
import { discoverQdrantUrl } from "./qdrant-discovery.js";
import { pingQdrant } from "./qdrant-ping.js";
import type { PrimeData } from "./types.js";

function buildUpdateService(): UpdateCheckService {
  return new UpdateCheckService(
    new PackageJsonVersionSource(),
    new NpmRegistryClient(),
    new FileCacheStore(),
  );
}

/**
 * Run prime: emit a markdown digest of index state to stdout.
 * Always exits 0 — degrades to placeholder when path missing or Qdrant cold.
 */
export async function runPrime(path: string): Promise<void> {
  if (!existsSync(path)) {
    process.stdout.write(formatPrime({ kind: "path-not-found", path }));
    return;
  }

  const config = parseAppConfig();
  const qdrantUrl = discoverQdrantUrl(config);
  const reachable = await pingQdrant(qdrantUrl);
  if (!reachable) {
    process.stdout.write(formatPrime({ kind: "qdrant-cold", path }));
    return;
  }

  const ctx = await createAppContext(config);
  const updateService = (ctx as { updateService?: UpdateCheckService }).updateService ?? buildUpdateService();

  try {
    const [status, metricsResult, drift, update] = await Promise.allSettled([
      ctx.app.getIndexStatus(path),
      ctx.app.getIndexMetrics(path),
      ctx.app.checkSchemaDrift({ path }),
      updateService.checkForUpdate({
        allowNetwork: true,
        timeoutMs: 1500,
        preferCache: true,
      }),
    ]);

    if (status.status !== "fulfilled") {
      process.stdout.write(formatPrime({ kind: "qdrant-cold", path }));
      return;
    }

    const data: PrimeData = {
      path,
      status: status.value,
      metrics: metricsResult.status === "fulfilled" ? metricsResult.value : null,
      drift: drift.status === "fulfilled" ? drift.value : null,
      update: update.status === "fulfilled" ? (update.value as UpdateStatus) : null,
    };
    process.stdout.write(formatPrime(data));
  } finally {
    ctx.cleanup?.();
  }
}
```

(The `(ctx as { updateService?: ... }).updateService ?? buildUpdateService()` trick lets `run-prime.test.ts` inject a mock service via the `createAppContext` mock without changing `createAppContext`'s real signature.)

- [ ] **Step 10.6: Run prime tests (GREEN)**

Run: `npx vitest run tests/cli/prime/format.test.ts tests/cli/prime/run-prime.test.ts`
Expected: PASS — both old and new tests.

- [ ] **Step 10.7: Full suite regression**

Run: `npx vitest run`
Expected: PASS — entire suite.

- [ ] **Step 10.8: Type-check, lint, and commit**

```bash
npm run type-check
npm run lint
git add src/cli/prime/types.ts src/cli/prime/run-prime.ts src/cli/prime/format.ts \
        tests/cli/prime/run-prime.test.ts tests/cli/prime/format.test.ts
git commit -m "$(cat <<'EOF'
improve(cli): surface tea-rags package updates in prime digest

PrimeData carries an optional UpdateStatus that runPrime populates via
UpdateCheckService.checkForUpdate({allowNetwork: true, timeoutMs: 1500,
preferCache: true}) inside the existing Promise.allSettled block.
formatPrime appends a `## tea-rags package` section only when an update
is available — up-to-date and unavailable are intentionally hidden to
keep the digest noise-free.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: website/docs documentation

**Files:**
- Create: `website/docs/usage/updating.md`
- Modify: `website/docs/quickstart/installation.md` (short pointer)

This task is independent of the code tasks and can be run in parallel. It does not have an associated automated test — verification is by reading the rendered Docusaurus output if a preview server is desired (`npm run docs:dev`).

- [ ] **Step 11.1: Create the usage doc**

Create `website/docs/usage/updating.md`:

```markdown
---
title: Keeping tea-rags up to date
description: How tea-rags notifies you about new versions and how to upgrade.
---

# Keeping tea-rags up to date

tea-rags is published to npm as `tea-rags`. New releases land automatically
through `semantic-release` on every merge to `main`, so the version gap
between an installed copy and the published one can grow without you
noticing. The CLI helps you spot and close that gap.

## `tea-rags update`

Run this command at any time:

```bash
tea-rags update
```

It does three things:

1. Reads your installed `tea-rags` version from the package's own
   `package.json`.
2. Asks the npm registry for the current `latest` dist-tag of `tea-rags`.
3. If a newer version exists, runs `npm install -g tea-rags@latest`
   (output is streamed live — you see the same thing you would running
   `npm` yourself). If you are already on the latest version, the command
   prints a confirmation and exits.

The command always performs a fresh registry check — it does not use the
cache described below.

Exit codes:

| Code | Meaning |
| ---- | --- |
| 0 | Up to date, or upgrade completed |
| 1 | Registry unreachable or response malformed |
| 127 | `npm` is not in `PATH` |
| _other_ | Forwarded from `npm install` |

### Other package managers

The command always invokes `npm`. If you installed tea-rags with another
manager (`pnpm`, `yarn`, `bun`), running `npm install -g tea-rags@latest`
will still update the binary on most setups, but you can also run the
manager-specific equivalent yourself.

## Update notice in `tea-rags prime`

The `tea-rags prime` command (used by SessionStart hooks in agent
integrations) checks for updates as part of its digest. When a newer
version is available, it appends a section like this to the digest:

```markdown
## tea-rags package
current:   1.23.1
available: 1.24.0
changelog: https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0

→ run `tea-rags update` to upgrade
```

When you are already on the latest version, or when the check could not
complete (offline, registry slow), the section is omitted entirely — the
digest stays compact.

### How prime avoids slowing down

`prime` is called at the start of every session, so it must stay fast.
The update check:

- Reads a cached result from `~/.tea-rags/update-check.json` first.
  Positive cache lives 24 hours, negative cache (after a failed check)
  lives 5 minutes.
- Issues an HTTPS request to the npm registry only when the cache is
  empty or stale, with a 1.5-second timeout.
- Runs in parallel with the other Qdrant queries `prime` already makes,
  so when the registry responds promptly the added wall-time is
  effectively zero.

If the registry is slow or unreachable, `prime` writes a 5-minute
negative cache entry and continues — subsequent `prime` invocations
within that window skip the network call entirely.

## Disabling the check (not yet supported)

There is no opt-out flag today. If you need one, please file an issue
describing your use case; the design reserves space for an environment
variable like `TEA_RAGS_DISABLE_UPDATE_CHECK=1` but it is not wired up
until there is a concrete need.
```

- [ ] **Step 11.2: Add a pointer in the installation quickstart**

Open `website/docs/quickstart/installation.md` and append (or insert into the existing "Next steps" section if one exists) a paragraph like:

```markdown
## Keeping up to date

When a newer version of tea-rags is published, run:

```bash
tea-rags update
```

This pulls the latest version from npm. The `tea-rags prime` command also
surfaces a notice when a new version is available — see [Keeping tea-rags
up to date](../usage/updating.md) for the full mechanics.
```

Be careful to insert this block at the end of the existing content, not modifying any unrelated section.

- [ ] **Step 11.3: Lint the markdown (if available)**

Run: `npx markdownlint-cli website/docs/usage/updating.md website/docs/quickstart/installation.md 2>&1 || true`

If `markdownlint` is not configured locally, skip this step — no commit gate depends on it.

- [ ] **Step 11.4: Commit**

```bash
git add website/docs/usage/updating.md website/docs/quickstart/installation.md
git commit -m "$(cat <<'EOF'
docs(website): document tea-rags update and prime update notice

Adds usage/updating.md describing the explicit `tea-rags update` command
and the prime digest section that surfaces newer versions. Adds a short
pointer from quickstart/installation.md so users discover the workflow
right after first install.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

After all tasks complete, run the full quality gate in the worktree.

- [ ] **Step F.1: Full test suite**

```bash
npx vitest run
```

Expected: ALL pass.

- [ ] **Step F.2: Type-check**

```bash
npm run type-check
```

Expected: no errors.

- [ ] **Step F.3: Lint**

```bash
npm run lint
```

Expected: no warnings.

- [ ] **Step F.4: Build**

```bash
npm run build
```

Expected: clean build into `build/`.

- [ ] **Step F.5: End-to-end smoke**

```bash
node build/cli/index.js update --help
node build/cli/index.js prime "$PWD"
```

Expected:
- `update --help` shows the description and standard yargs flags.
- `prime` outputs a markdown digest; the `## tea-rags package` section may or may not appear depending on whether the current installed version is latest.

---

## Self-Review

- **Spec coverage:** Sections 1-7 of the spec map to Tasks 1-11. Section 8 (open questions) is intentionally not implemented (deferred per spec). Cache 24h/5min TTL → Task 6. Atomic write → Task 5. preferCache flag → Task 6. Plain-text-no-ANSI rule → Task 7. NPM exit code forwarding → Task 8. `update` field in PrimeData → Task 10. ✓
- **Placeholders:** No "TBD", no "implement later", no "similar to Task N" cross-references. All code is concrete. ✓
- **Type consistency:** `UpdateStatus.kind` values consistent across all tasks (`"available" | "up-to-date" | "unavailable"`). `CheckOptions` field names match between Tasks 1, 6, 8, 10. Factory names (`available`, `upToDate`, `unavailable`, `buildChangelogUrl`) match between Tasks 1, 7, 8, 10. `CacheStore.read` / `write` signatures match between Tasks 5, 6. `RegistryClient.fetchLatestVersion(packageName, opts?)` signature matches between Tasks 4, 6. `VersionSource.getCurrent()` matches between Tasks 3, 6. ✓
- **Test placement:** all under `tests/cli/update-check/` mirroring `src/cli/update-check/`, plus `tests/cli/commands/update.test.ts` mirroring `src/cli/commands/update.ts`. Convention matches existing `tests/cli/prime/` layout. ✓
- **Linter rules respected:** No `eslint-disable`. No threshold lowering. Plain Error only inside `version-source.ts` and `semver.ts` (programming invariants, allowed by typed-errors.md exception). ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-10-tea-rags-auto-update-impl.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task with two-stage review between tasks. Use `superpowers:subagent-driven-development` (or its dinopowers wrapper if it exists).

**2. Inline Execution** — execute tasks in the current session with batch checkpoints. Use `dinopowers:executing-plans`.

The user explicitly instructed: write the plan only, do NOT auto-execute. Wait for an explicit "execute" / "выполни" before chaining to either execution skill.
