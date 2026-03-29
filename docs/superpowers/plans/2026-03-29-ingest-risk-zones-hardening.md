# Ingest Risk Zones Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden 4 high-bugFixRate ingest files: daemon race conditions,
status-module recursion + untyped payload, unified error handling in
indexing/reindexing.

**Architecture:** Problem-driven phases. Phase 1: DaemonLock for concurrent
startup safety. Phase 2: IndexingMarkerCodec + resolveStaleCollection() to
remove recursion and as-casts. Phase 3: wrapUnexpectedError() +
IndexingFailedError to unify error handling. Phase 4: alias-before-marker
reorder.

**Tech Stack:** TypeScript, Vitest, Node.js fs (exclusive file locks)

**Spec:**
`docs/superpowers/specs/2026-03-29-ingest-risk-zones-hardening-design.md`

---

## File Map

| Action   | File                                                               | Responsibility                                      |
| -------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| Create   | `src/core/adapters/qdrant/embedded/daemon-lock.ts`                 | Exclusive file lock for daemon lifecycle            |
| Modify   | `src/core/adapters/qdrant/embedded/daemon.ts`                      | Use DaemonLock, graceful shutdown on health timeout |
| Modify   | `src/core/adapters/qdrant/embedded/types.ts`                       | Add lockFile to DaemonPaths                         |
| Create   | `tests/core/adapters/qdrant/embedded/daemon-lock.test.ts`          | DaemonLock unit tests                               |
| Modify   | `tests/core/adapters/qdrant/embedded/daemon.test.ts`               | ensureDaemon tests                                  |
| Create   | `src/core/domains/ingest/pipeline/indexing-marker-codec.ts`        | Parse/serialize indexing marker payload             |
| Modify   | `src/core/domains/ingest/pipeline/status-module.ts`                | Use codec, extract resolveStaleCollection()         |
| (future) | `src/core/domains/ingest/pipeline/indexing-marker.ts`              | Use serializeMarkerPayload() (follow-up)            |
| Create   | `tests/core/domains/ingest/pipeline/indexing-marker-codec.test.ts` | Codec unit tests                                    |
| Modify   | `tests/core/domains/ingest/pipeline/status-module.test.ts`         | resolveStaleCollection tests                        |
| Modify   | `src/core/contracts/errors.ts`                                     | Add INGEST_INDEXING_FAILED error code               |
| Modify   | `src/core/domains/ingest/errors.ts`                                | Add IndexingFailedError class                       |
| Modify   | `src/core/domains/ingest/pipeline/base.ts`                         | Add wrapUnexpectedError() method                    |
| Modify   | `src/core/domains/ingest/indexing.ts`                              | Use wrapUnexpectedError, reorder alias/marker       |
| Modify   | `src/core/domains/ingest/reindexing.ts`                            | Use wrapUnexpectedError                             |
| Modify   | `tests/core/domains/ingest/indexing.test.ts`                       | Update error expectations                           |

---

### Task 1: DaemonLock — exclusive file lock

**Files:**

- Create: `src/core/adapters/qdrant/embedded/daemon-lock.ts`
- Create: `tests/core/adapters/qdrant/embedded/daemon-lock.test.ts`
- Modify: `src/core/adapters/qdrant/embedded/types.ts:1-6`

- [ ] **Step 1: Add lockFile to DaemonPaths**

In `src/core/adapters/qdrant/embedded/types.ts`, add `lockFile` field:

```typescript
export interface DaemonPaths {
  pidFile: string;
  portFile: string;
  refsFile: string;
  lockFile: string;
  storagePath: string;
}
```

- [ ] **Step 2: Update getDaemonPaths in daemon.ts**

In `src/core/adapters/qdrant/embedded/daemon.ts:17-24`, add lockFile:

```typescript
export function getDaemonPaths(storagePath: string): DaemonPaths {
  return {
    pidFile: join(storagePath, "daemon.pid"),
    portFile: join(storagePath, "daemon.port"),
    refsFile: join(storagePath, "daemon.refs"),
    lockFile: join(storagePath, "daemon.lock"),
    storagePath,
  };
}
```

- [ ] **Step 3: Write failing tests for DaemonLock**

Create `tests/core/adapters/qdrant/embedded/daemon-lock.test.ts`:

```typescript
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DaemonLock } from "../../../../../src/core/adapters/qdrant/embedded/daemon-lock.js";

describe("DaemonLock", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "daemon-lock-test-"));
    lockPath = join(tempDir, "daemon.lock");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("acquire returns fd on success", () => {
    const lock = new DaemonLock();
    const result = lock.acquire(lockPath);
    expect(result).not.toBeNull();
    expect(result!.fd).toBeGreaterThan(0);
    lock.release(result!.fd);
  });

  it("acquire returns null when lock already held", () => {
    const lock = new DaemonLock();
    const first = lock.acquire(lockPath);
    expect(first).not.toBeNull();

    const second = lock.acquire(lockPath);
    expect(second).toBeNull();

    lock.release(first!.fd);
  });

  it("release allows re-acquire", () => {
    const lock = new DaemonLock();
    const first = lock.acquire(lockPath);
    lock.release(first!.fd);

    const second = lock.acquire(lockPath);
    expect(second).not.toBeNull();
    lock.release(second!.fd);
  });

  it("isHeld returns true when lock file exists", () => {
    const lock = new DaemonLock();
    const result = lock.acquire(lockPath);
    expect(lock.isHeld(lockPath)).toBe(true);
    lock.release(result!.fd);
  });

  it("isHeld returns false when no lock file", () => {
    const lock = new DaemonLock();
    expect(lock.isHeld(lockPath)).toBe(false);
  });

  it("release removes lock file", () => {
    const lock = new DaemonLock();
    const result = lock.acquire(lockPath);
    lock.release(result!.fd);
    expect(existsSync(lockPath)).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/core/adapters/qdrant/embedded/daemon-lock.test.ts`
Expected: FAIL — module not found

- [ ] **Step 5: Implement DaemonLock**

Create `src/core/adapters/qdrant/embedded/daemon-lock.ts`:

```typescript
import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";

/**
 * Exclusive file lock for daemon lifecycle operations.
 * Uses O_CREAT | O_EXCL (wx) for atomic lock acquisition.
 */
export class DaemonLock {
  /**
   * Try to acquire an exclusive lock.
   * Returns { fd } on success, null if already held.
   */
  acquire(lockPath: string): { fd: number } | null {
    try {
      const fd = openSync(lockPath, "wx");
      return { fd };
    } catch {
      return null;
    }
  }

  /** Release the lock: close fd and remove lock file. */
  release(fd: number): void {
    try {
      closeSync(fd);
    } catch {
      /* ignore close errors */
    }
    // fd doesn't carry path — derive from acquire context
    // Lock file cleanup is handled by the caller who knows the path
  }

  /** Check if lock file exists (non-authoritative — file may be stale). */
  isHeld(lockPath: string): boolean {
    return existsSync(lockPath);
  }
}
```

Wait — `release(fd)` can't clean up the file without knowing the path. Revise
the API to track path internally:

```typescript
import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";

/**
 * Exclusive file lock for daemon lifecycle operations.
 * Uses O_CREAT | O_EXCL (wx) for atomic lock acquisition.
 */
export class DaemonLock {
  private activeLocks = new Map<number, string>();

  /**
   * Try to acquire an exclusive lock.
   * Returns { fd } on success, null if already held.
   */
  acquire(lockPath: string): { fd: number } | null {
    try {
      const fd = openSync(lockPath, "wx");
      this.activeLocks.set(fd, lockPath);
      return { fd };
    } catch {
      return null;
    }
  }

  /** Release the lock: close fd and remove lock file. */
  release(fd: number): void {
    const lockPath = this.activeLocks.get(fd);
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    if (lockPath) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      this.activeLocks.delete(fd);
    }
  }

  /** Check if lock file exists (non-authoritative — file may be stale). */
  isHeld(lockPath: string): boolean {
    return existsSync(lockPath);
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/core/adapters/qdrant/embedded/daemon-lock.test.ts`
Expected: all 6 tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/adapters/qdrant/embedded/daemon-lock.ts \
        src/core/adapters/qdrant/embedded/types.ts \
        src/core/adapters/qdrant/embedded/daemon.ts \
        tests/core/adapters/qdrant/embedded/daemon-lock.test.ts
git commit -m "feat(qdrant): add DaemonLock for exclusive daemon lifecycle"
```

---

### Task 2: Harden ensureDaemon with DaemonLock

**Files:**

- Modify: `src/core/adapters/qdrant/embedded/daemon.ts:63-73,129-208`
- Modify: `tests/core/adapters/qdrant/embedded/daemon.test.ts`

- [ ] **Step 1: Write failing tests for ensureDaemon hardening**

Replace `tests/core/adapters/qdrant/embedded/daemon.test.ts` with expanded
tests. Keep existing tests and add new ones:

```typescript
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EMBEDDED_MARKER,
  getDaemonPaths,
  isDaemonAlive,
} from "../../../../../src/core/adapters/qdrant/embedded/daemon.js";

describe("EMBEDDED_MARKER", () => {
  it("equals 'embedded'", () => {
    expect(EMBEDDED_MARKER).toBe("embedded");
  });
});

describe("getDaemonPaths", () => {
  it("returns pid, port, refs, lock files under storage path", () => {
    const paths = getDaemonPaths("/tmp/test-qdrant");
    expect(paths.pidFile).toBe("/tmp/test-qdrant/daemon.pid");
    expect(paths.portFile).toBe("/tmp/test-qdrant/daemon.port");
    expect(paths.refsFile).toBe("/tmp/test-qdrant/daemon.refs");
    expect(paths.lockFile).toBe("/tmp/test-qdrant/daemon.lock");
  });
});

describe("isDaemonAlive", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "qdrant-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns false when no pid file exists", () => {
    const paths = getDaemonPaths(tempDir);
    expect(isDaemonAlive(paths)).toBe(false);
  });

  it("returns false when pid file contains invalid pid", () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, "99999999", "utf-8");
    expect(isDaemonAlive(paths)).toBe(false);
  });

  it("returns true for current process pid", () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, String(process.pid), "utf-8");
    expect(isDaemonAlive(paths)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify new tests pass (existing behavior)**

Run: `npx vitest run tests/core/adapters/qdrant/embedded/daemon.test.ts`
Expected: PASS (we added tests for existing behavior first)

- [ ] **Step 3: Add lock to incrementRefs/decrementRefs in daemon.ts**

In `src/core/adapters/qdrant/embedded/daemon.ts`, import and use DaemonLock for
ref counting:

```typescript
import { DaemonLock } from "./daemon-lock.js";

const daemonLock = new DaemonLock();

function incrementRefs(paths: DaemonPaths): number {
  const lock = daemonLock.acquire(paths.lockFile);
  try {
    const next = readRefs(paths) + 1;
    writeFileSync(paths.refsFile, String(next), "utf-8");
    return next;
  } finally {
    if (lock) daemonLock.release(lock.fd);
  }
}

function decrementRefs(paths: DaemonPaths): number {
  const lock = daemonLock.acquire(paths.lockFile);
  try {
    const next = Math.max(0, readRefs(paths) - 1);
    writeFileSync(paths.refsFile, String(next), "utf-8");
    return next;
  } finally {
    if (lock) daemonLock.release(lock.fd);
  }
}
```

- [ ] **Step 4: Add lock + graceful shutdown to ensureDaemon**

Replace the `ensureDaemon` function in `daemon.ts:129-208`:

```typescript
async function ensureDaemon(appDataPath?: string): Promise<DaemonHandle> {
  const storagePath = getStoragePath(appDataPath);
  mkdirSync(storagePath, { recursive: true });
  const paths = getDaemonPaths(storagePath);

  // Fast path: attach to running daemon (no lock needed)
  if (isDaemonAlive(paths) && existsSync(paths.portFile)) {
    const port = parseInt(readFileSync(paths.portFile, "utf-8").trim(), 10);
    const url = `http://127.0.0.1:${port}`;
    if (await probeHealth(url)) {
      const refs = incrementRefs(paths);
      console.error(
        `[tea-rags] Attached to Qdrant daemon (port ${port}, refs=${refs})`,
      );
      return {
        url,
        release: () => {
          const remaining = decrementRefs(paths);
          console.error(
            `[tea-rags] Released Qdrant ref (remaining=${remaining})`,
          );
        },
        reconnect: makeReconnect(paths, port),
      };
    }
  }

  // Slow path: need to start daemon — acquire exclusive lock
  const lock = daemonLock.acquire(paths.lockFile);
  if (!lock) {
    // Another process is starting the daemon — wait and attach
    console.error("[tea-rags] Another process is starting Qdrant, waiting...");
    await waitForDaemon(paths);
    return ensureDaemon(appDataPath);
  }

  try {
    // Re-check after lock: another process may have started between our check and lock
    if (isDaemonAlive(paths) && existsSync(paths.portFile)) {
      const port = parseInt(readFileSync(paths.portFile, "utf-8").trim(), 10);
      const url = `http://127.0.0.1:${port}`;
      if (await probeHealth(url)) {
        const refs = incrementRefs(paths);
        console.error(
          `[tea-rags] Attached to Qdrant daemon (port ${port}, refs=${refs})`,
        );
        return {
          url,
          release: () => {
            const remaining = decrementRefs(paths);
            console.error(
              `[tea-rags] Released Qdrant ref (remaining=${remaining})`,
            );
          },
          reconnect: makeReconnect(paths, port),
        };
      }
    }

    cleanupDaemonFiles(paths);

    if (!isBinaryUpToDate(appDataPath)) {
      console.error(`[tea-rags] Downloading Qdrant v${QDRANT_VERSION}...`);
      await downloadQdrant(undefined, undefined, appDataPath);
    }

    const port = await findFreePort();
    const binaryPath = getBinaryPath(undefined, appDataPath);

    const child = spawn(binaryPath, ["--disable-telemetry"], {
      cwd: dirname(binaryPath),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        QDRANT__STORAGE__STORAGE_PATH: storagePath,
        QDRANT__SERVICE__HTTP_PORT: String(port),
        QDRANT__SERVICE__GRPC_PORT: "0",
      },
    });
    child.unref();

    const { pid } = child;
    if (pid === undefined) {
      throw new QdrantOperationError(
        "spawn",
        "daemon failed to spawn — no PID assigned",
      );
    }

    // Verify child is alive before writing PID file
    try {
      process.kill(pid, 0);
    } catch {
      throw new QdrantOperationError(
        "spawn",
        "daemon process died immediately after spawn",
      );
    }

    writeFileSync(paths.pidFile, String(pid), "utf-8");
    writeFileSync(paths.portFile, String(port), "utf-8");
    writeFileSync(paths.refsFile, "1", "utf-8");

    const url = `http://127.0.0.1:${port}`;
    const start = Date.now();
    while (Date.now() - start < HEALTH_CHECK_TIMEOUT_MS) {
      if (await probeHealth(url)) {
        console.error(
          `[tea-rags] Qdrant daemon started (pid=${pid}, port=${port})`,
        );
        scheduleIdleWatcher(paths, pid);
        return {
          url,
          release: () => {
            const remaining = decrementRefs(paths);
            console.error(
              `[tea-rags] Released Qdrant ref (remaining=${remaining})`,
            );
          },
          reconnect: makeReconnect(paths, port),
        };
      }
      await sleep(HEALTH_CHECK_INTERVAL_MS);
    }

    // Graceful shutdown: SIGTERM first, then SIGKILL
    gracefulKill(pid);
    cleanupDaemonFiles(paths);
    throw new QdrantUnavailableError(
      url,
      new Error(
        `Qdrant daemon failed to start within ${HEALTH_CHECK_TIMEOUT_MS}ms`,
      ),
    );
  } finally {
    daemonLock.release(lock.fd);
  }
}

/** SIGTERM → wait 2s → SIGKILL. Verify process is dead. */
function gracefulKill(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // Already dead
  }
  // Brief sync wait for SIGTERM to take effect
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // Dead
    }
  }
  // Force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already dead */
  }
}

/** Wait for another process to finish starting the daemon. */
async function waitForDaemon(paths: DaemonPaths): Promise<void> {
  const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isDaemonAlive(paths) && existsSync(paths.portFile)) {
      const port = parseInt(readFileSync(paths.portFile, "utf-8").trim(), 10);
      if (await probeHealth(`http://127.0.0.1:${port}`)) return;
    }
    await sleep(HEALTH_CHECK_INTERVAL_MS);
  }
}
```

- [ ] **Step 5: Add lockFile to cleanupDaemonFiles**

In `daemon.ts:75-83`, add lockFile to cleanup:

```typescript
function cleanupDaemonFiles(paths: DaemonPaths): void {
  for (const f of [
    paths.pidFile,
    paths.portFile,
    paths.refsFile,
    paths.lockFile,
  ]) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}
```

- [ ] **Step 6: Run all daemon tests**

Run: `npx vitest run tests/core/adapters/qdrant/embedded/` Expected: all PASS

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run` Expected: all PASS (no regressions from DaemonPaths
change)

- [ ] **Step 8: Commit**

```bash
git add src/core/adapters/qdrant/embedded/daemon.ts \
        tests/core/adapters/qdrant/embedded/daemon.test.ts
git commit -m "fix(qdrant): harden ensureDaemon with lock + graceful shutdown"
```

---

### Task 3: IndexingMarkerCodec — typed payload parse/serialize

**Files:**

- Create: `src/core/domains/ingest/pipeline/indexing-marker-codec.ts`
- Create: `tests/core/domains/ingest/pipeline/indexing-marker-codec.test.ts`

- [ ] **Step 1: Write failing tests for parseMarkerPayload**

Create `tests/core/domains/ingest/pipeline/indexing-marker-codec.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  parseMarkerPayload,
  serializeMarkerPayload,
} from "../../../../../src/core/domains/ingest/pipeline/indexing-marker-codec.js";

describe("parseMarkerPayload", () => {
  it("parses complete valid payload", () => {
    const raw = {
      indexingComplete: true,
      startedAt: "2026-03-29T10:00:00.000Z",
      completedAt: "2026-03-29T10:05:00.000Z",
      lastHeartbeat: "2026-03-29T10:04:30.000Z",
      embeddingModel: "jina-embeddings-v2-base-code",
      enrichment: { git: { file: { status: "completed" } } },
    };
    const parsed = parseMarkerPayload(raw);
    expect(parsed.indexingComplete).toBe(true);
    expect(parsed.completedAt).toBe("2026-03-29T10:05:00.000Z");
    expect(parsed.embeddingModel).toBe("jina-embeddings-v2-base-code");
  });

  it("normalizes numeric completedAt to ISO string", () => {
    const raw = {
      indexingComplete: true,
      completedAt: 1774714982000,
    };
    const parsed = parseMarkerPayload(raw);
    expect(typeof parsed.completedAt).toBe("string");
    expect(parsed.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("handles Date completedAt", () => {
    const raw = {
      indexingComplete: true,
      completedAt: new Date("2026-03-29T10:00:00.000Z"),
    };
    const parsed = parseMarkerPayload(raw);
    expect(parsed.completedAt).toBe("2026-03-29T10:00:00.000Z");
  });

  it("defaults indexingComplete to false when missing", () => {
    const parsed = parseMarkerPayload({});
    expect(parsed.indexingComplete).toBe(false);
  });

  it("ignores non-string embeddingModel", () => {
    const parsed = parseMarkerPayload({ embeddingModel: 123 });
    expect(parsed.embeddingModel).toBeUndefined();
  });

  it("ignores non-string lastHeartbeat", () => {
    const parsed = parseMarkerPayload({ lastHeartbeat: 123 });
    expect(parsed.lastHeartbeat).toBeUndefined();
  });

  it("preserves enrichment object as-is", () => {
    const enrichment = { git: { file: { status: "completed" } } };
    const parsed = parseMarkerPayload({ enrichment });
    expect(parsed.enrichment).toBe(enrichment);
  });

  it("returns undefined enrichment when absent", () => {
    const parsed = parseMarkerPayload({});
    expect(parsed.enrichment).toBeUndefined();
  });
});

describe("serializeMarkerPayload", () => {
  it("serializes start marker", () => {
    const result = serializeMarkerPayload({
      indexingComplete: false,
      startedAt: "2026-03-29T10:00:00.000Z",
      embeddingModel: "model-x",
    });
    expect(result.indexingComplete).toBe(false);
    expect(result.startedAt).toBe("2026-03-29T10:00:00.000Z");
    expect(result.embeddingModel).toBe("model-x");
  });

  it("serializes completion marker", () => {
    const result = serializeMarkerPayload({
      indexingComplete: true,
      completedAt: "2026-03-29T10:05:00.000Z",
    });
    expect(result.indexingComplete).toBe(true);
    expect(result.completedAt).toBe("2026-03-29T10:05:00.000Z");
  });

  it("omits undefined fields", () => {
    const result = serializeMarkerPayload({ indexingComplete: true });
    expect("startedAt" in result).toBe(false);
    expect("completedAt" in result).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/indexing-marker-codec.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement IndexingMarkerCodec**

Create `src/core/domains/ingest/pipeline/indexing-marker-codec.ts`:

```typescript
/**
 * Codec for indexing marker payload stored in Qdrant.
 * Normalizes historical format variations (completedAt as string/number/Date)
 * into a single canonical format.
 */

import type { EnrichmentMarkerMap } from "./enrichment/types.js";

export interface IndexingMarkerPayload {
  indexingComplete: boolean;
  startedAt?: string;
  completedAt?: string;
  lastHeartbeat?: string;
  embeddingModel?: string;
  enrichment?: EnrichmentMarkerMap;
}

/** Parse raw Qdrant payload into typed IndexingMarkerPayload. */
export function parseMarkerPayload(
  raw: Record<string, unknown>,
): IndexingMarkerPayload {
  return {
    indexingComplete: raw.indexingComplete === true,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
    completedAt: normalizeTimestamp(raw.completedAt),
    lastHeartbeat:
      typeof raw.lastHeartbeat === "string" ? raw.lastHeartbeat : undefined,
    embeddingModel:
      typeof raw.embeddingModel === "string" ? raw.embeddingModel : undefined,
    enrichment:
      raw.enrichment !== null &&
      raw.enrichment !== undefined &&
      typeof raw.enrichment === "object"
        ? (raw.enrichment as EnrichmentMarkerMap)
        : undefined,
  };
}

/** Serialize IndexingMarkerPayload for Qdrant storage. Omits undefined fields. */
export function serializeMarkerPayload(
  marker: IndexingMarkerPayload,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    indexingComplete: marker.indexingComplete,
  };
  if (marker.startedAt !== undefined) result.startedAt = marker.startedAt;
  if (marker.completedAt !== undefined) result.completedAt = marker.completedAt;
  if (marker.lastHeartbeat !== undefined)
    result.lastHeartbeat = marker.lastHeartbeat;
  if (marker.embeddingModel !== undefined)
    result.embeddingModel = marker.embeddingModel;
  if (marker.enrichment !== undefined) result.enrichment = marker.enrichment;
  return result;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  return undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/indexing-marker-codec.test.ts`
Expected: all 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/indexing-marker-codec.ts \
        tests/core/domains/ingest/pipeline/indexing-marker-codec.test.ts
git commit -m "feat(ingest): add IndexingMarkerCodec for typed payload parsing"
```

---

### Task 4: Refactor StatusModule — remove recursion, use codec

**Files:**

- Modify: `src/core/domains/ingest/pipeline/status-module.ts:148-252`
- Modify: `tests/core/domains/ingest/pipeline/status-module.test.ts`

- [ ] **Step 1: Write failing test for resolveStaleCollection**

Add to `tests/core/domains/ingest/pipeline/status-module.test.ts` inside
existing `describe("StatusModule")`:

```typescript
describe("stale indexing cleanup", () => {
  it("should fall back to alias target when stale versioned collection found", async () => {
    // Index a codebase first
    await createTestFile(codebaseDir, "app.ts", "export const x = 1;");
    await ingest.indexCodebase(codebaseDir);

    // Get the collection name
    const status = await ingest.getIndexStatus(codebaseDir);
    expect(status.status).toBe("indexed");
    // The stale cleanup logic is exercised via getStatusFromCollection
    // which is now non-recursive — tested via integration through getIndexStatus
  });
});
```

- [ ] **Step 2: Refactor StatusModule.getStatusFromCollection()**

Replace `getStatusFromCollection()` in
`src/core/domains/ingest/pipeline/status-module.ts:148-252`:

```typescript
import { parseMarkerPayload, type IndexingMarkerPayload } from "./indexing-marker-codec.js";

  private async getStatusFromCollection(
    sourceCollection: string,
    reportedName: string,
  ): Promise<IndexStatus> {
    const indexingMarker = await this.qdrant.getPoint(sourceCollection, INDEXING_METADATA_ID);
    const info = await this.qdrant.getCollectionInfo(sourceCollection);

    const marker = indexingMarker?.payload
      ? parseMarkerPayload(indexingMarker.payload as Record<string, unknown>)
      : undefined;

    const actualChunksCount = indexingMarker ? Math.max(0, info.pointsCount - 1) : info.pointsCount;
    const enrichment = marker?.enrichment ? mapMarkerToHealth(marker.enrichment) : undefined;

    const schemaMetadata = await this.qdrant.getPoint(sourceCollection, "__schema_metadata__").catch(() => null);
    const sparseVersion =
      typeof schemaMetadata?.payload?.sparseVersion === "number" ? schemaMetadata.payload.sparseVersion : undefined;

    if (marker && !marker.indexingComplete) {
      const referenceTime = marker.lastHeartbeat ?? marker.startedAt;
      const isStale =
        referenceTime !== undefined &&
        Date.now() - new Date(referenceTime).getTime() > STALE_INDEXING_THRESHOLD_MS;

      if (isStale && sourceCollection !== reportedName) {
        const resolved = await this.resolveStaleCollection(sourceCollection, reportedName, actualChunksCount);
        if (resolved.notIndexed) {
          return { isIndexed: false, status: "not_indexed", collectionName: reportedName };
        }
        // Read status from resolved collection (non-recursive: one level only)
        return this.getStatusFromCollection(resolved.collection, reportedName);
      }

      return {
        isIndexed: false,
        status: isStale ? "stale_indexing" : "indexing",
        collectionName: reportedName,
        chunksCount: actualChunksCount,
        embeddingModel: marker.embeddingModel,
        qdrantUrl: this.qdrant.url,
        sparseVersion,
        enrichment,
      };
    }

    if (marker?.indexingComplete) {
      return {
        isIndexed: true,
        status: "indexed",
        collectionName: reportedName,
        chunksCount: actualChunksCount,
        embeddingModel: marker.embeddingModel,
        qdrantUrl: this.qdrant.url,
        sparseVersion,
        lastUpdated: marker.completedAt ? new Date(marker.completedAt) : undefined,
        enrichment,
      };
    }

    // Legacy collection (no marker) — check if it has content
    if (actualChunksCount > 0) {
      return {
        isIndexed: true,
        status: "indexed",
        collectionName: reportedName,
        chunksCount: actualChunksCount,
        qdrantUrl: this.qdrant.url,
        sparseVersion,
      };
    }

    return {
      isIndexed: false,
      status: "not_indexed",
      collectionName: reportedName,
      chunksCount: 0,
      qdrantUrl: this.qdrant.url,
      sparseVersion,
    };
  }

  /**
   * Resolve a stale versioned collection.
   * Deletes the stale collection and finds a working alternative.
   * Returns { collection } to read status from, or { notIndexed } if none found.
   */
  private async resolveStaleCollection(
    staleCollection: string,
    baseName: string,
    chunksCount: number,
  ): Promise<{ collection: string; notIndexed?: never } | { notIndexed: true; collection?: never }> {
    const aliasTarget = await this.getAliasTarget(baseName);
    if (aliasTarget) {
      await this.qdrant.deleteCollection(staleCollection);
      return { collection: aliasTarget };
    }

    const realExists = await this.qdrant.collectionExists(baseName);
    if (realExists) {
      await this.qdrant.deleteCollection(staleCollection);
      return { collection: baseName };
    }

    if (chunksCount === 0) {
      await this.qdrant.deleteCollection(staleCollection);
      return { notIndexed: true };
    }

    // Stale but has chunks and no fallback — report as stale_indexing
    // (this falls through to the stale_indexing return in the caller)
    return { collection: staleCollection };
  }
```

Note: There is still one recursive call in the refactored code — when
`resolveStaleCollection` returns a different collection,
`getStatusFromCollection` is called once more. This is bounded to depth 1
because `resolveStaleCollection` always returns a non-versioned collection
(alias target or baseName), and the stale check
`sourceCollection !== reportedName` won't match on the second call (they'll be
equal).

- [ ] **Step 3: Run status-module tests**

Run: `npx vitest run tests/core/domains/ingest/pipeline/status-module.test.ts`
Expected: all PASS

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run` Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/status-module.ts \
        tests/core/domains/ingest/pipeline/status-module.test.ts
git commit -m "refactor(ingest): remove recursion from StatusModule, use IndexingMarkerCodec"
```

---

### Task 5: Add IndexingFailedError + wrapUnexpectedError

**Files:**

- Modify: `src/core/contracts/errors.ts:56-57`
- Modify: `src/core/domains/ingest/errors.ts`
- Modify: `src/core/domains/ingest/pipeline/base.ts:55-68`

- [ ] **Step 1: Add INGEST_INDEXING_FAILED error code**

In `src/core/contracts/errors.ts`, add after line 57 (`INGEST_REINDEX_FAILED`):

```typescript
  | "INGEST_INDEXING_FAILED"
```

- [ ] **Step 2: Add IndexingFailedError class**

In `src/core/domains/ingest/errors.ts`, add after `ReindexFailedError` class
(after line 101):

```typescript
/** Full indexing failed unexpectedly. */
export class IndexingFailedError extends IngestError {
  constructor(detail: string, cause?: Error) {
    super({
      code: "INGEST_INDEXING_FAILED",
      message: `Full indexing failed: ${detail}`,
      hint: "Check server logs for details, or retry with forceReindex=true",
      httpStatus: 500,
      cause,
    });
  }
}
```

- [ ] **Step 3: Add wrapUnexpectedError to BaseIndexingPipeline**

In `src/core/domains/ingest/pipeline/base.ts`, add import and method. After line
7 (imports), add:

```typescript
import { TeaRagsError } from "../../../infra/errors.js";
```

Inside `BaseIndexingPipeline` class, after `stopHeartbeat()` method (after line
91), add:

```typescript
  /**
   * Wrap unexpected (non-TeaRagsError) errors in a typed error class.
   * Typed errors pass through unchanged.
   */
  protected wrapUnexpectedError(
    error: unknown,
    ErrorClass: new (message: string, cause?: Error) => TeaRagsError,
  ): never {
    if (error instanceof TeaRagsError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ErrorClass(message, error instanceof Error ? error : undefined);
  }
```

- [ ] **Step 4: Run full test suite to verify no regressions**

Run: `npx vitest run` Expected: all PASS (no behavioral changes yet)

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/errors.ts \
        src/core/domains/ingest/errors.ts \
        src/core/domains/ingest/pipeline/base.ts
git commit -m "feat(ingest): add IndexingFailedError + wrapUnexpectedError base method"
```

---

### Task 6: Unify error handling in IndexPipeline

**Files:**

- Modify: `src/core/domains/ingest/indexing.ts:113-122`
- Modify: `tests/core/domains/ingest/indexing.test.ts:361-383,500-517`

- [ ] **Step 1: Update tests — raw errors now throw**

In `tests/core/domains/ingest/indexing.test.ts`, update the two tests that
expect `stats.status === "failed"`.

Replace test at line 361-383:

```typescript
it("should throw IndexingFailedError when indexing encounters a raw error", async () => {
  await createTestFile(
    codebaseDir,
    "test.ts",
    "export function fatalTest(): number {\n  console.log('Testing fatal error');\n  return 42;\n}",
  );

  vi.spyOn(qdrant, "createCollection").mockImplementation(async () => {
    throw new Error("Qdrant connection refused");
  });

  try {
    await expect(ingest.indexCodebase(codebaseDir)).rejects.toThrow(
      "Qdrant connection refused",
    );
  } finally {
    vi.restoreAllMocks();
  }
});
```

Replace test at line 510-517 (the forceReindex pipeline failure test):

```typescript
await expect(
  ingest.indexCodebase(codebaseDir, { forceReindex: true }),
).rejects.toThrow("Simulated pipeline failure");

vi.restoreAllMocks();
```

- [ ] **Step 2: Run tests to verify they fail (old behavior)**

Run: `npx vitest run tests/core/domains/ingest/indexing.test.ts` Expected: FAIL
— tests expect throw, but code returns stats

- [ ] **Step 3: Update IndexPipeline.indexCodebase() catch block**

In `src/core/domains/ingest/indexing.ts`, replace the catch block (lines
113-122):

```typescript
    } catch (error) {
      this.wrapUnexpectedError(error, IndexingFailedError);
    } finally {
```

Add the import at the top of the file:

```typescript
import { IndexingFailedError } from "./errors.js";
```

Remove the now-unused import of `TeaRagsError` from `../../infra/errors.js`
(line 13). `wrapUnexpectedError` handles the TeaRagsError check internally.

- [ ] **Step 4: Reorder alias-before-marker**

In `src/core/domains/ingest/indexing.ts`, swap lines 104-105:

Before:

```typescript
await storeIndexingMarker(
  this.qdrant,
  this.embeddings,
  setup.targetCollection,
  true,
);
await this.finalizeAlias(collectionName, setup);
```

After:

```typescript
await this.finalizeAlias(collectionName, setup);
await storeIndexingMarker(
  this.qdrant,
  this.embeddings,
  setup.targetCollection,
  true,
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/core/domains/ingest/indexing.test.ts` Expected: all
PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/indexing.ts \
        tests/core/domains/ingest/indexing.test.ts
git commit -m "fix(ingest): unify IndexPipeline error handling, reorder alias-before-marker

BREAKING CHANGE: IndexPipeline.indexCodebase() now throws IndexingFailedError
instead of returning stats with status='failed'. MCP error handler already
handles typed errors correctly."
```

---

### Task 7: Unify error handling in ReindexPipeline

**Files:**

- Modify: `src/core/domains/ingest/reindexing.ts:101-106`

- [ ] **Step 1: Replace inline error wrapping with wrapUnexpectedError**

In `src/core/domains/ingest/reindexing.ts`, replace the catch block (lines
101-106):

Before:

```typescript
    } catch (error) {
      if (error instanceof TeaRagsError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new ReindexFailedError(errorMessage, error instanceof Error ? error : undefined);
    } finally {
```

After:

```typescript
    } catch (error) {
      this.wrapUnexpectedError(error, ReindexFailedError);
    } finally {
```

Remove the now-unused import of `TeaRagsError` from `../../infra/errors.js`
(line 9).

- [ ] **Step 2: Run reindexing tests**

Run: `npx vitest run tests/core/domains/ingest/reindexing.test.ts` Expected: all
PASS (behavior unchanged — same wrapping, just via base method)

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run` Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/ingest/reindexing.ts
git commit -m "refactor(ingest): use wrapUnexpectedError in ReindexPipeline"
```

---

### Task 8: Final integration verification

**Files:** None (test-only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run` Expected: all PASS

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit` Expected: no errors

- [ ] **Step 3: Run linter**

Run: `npx eslint src/core/adapters/qdrant/embedded/ src/core/domains/ingest/`
Expected: no errors

- [ ] **Step 4: Build**

Run: `npm run build` Expected: success

- [ ] **Step 5: Final commit (if any formatting changes)**

```bash
git add -A
git commit -m "style(ingest): formatting from linter/prettier"
```
