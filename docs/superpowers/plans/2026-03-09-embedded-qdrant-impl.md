# Embedded Qdrant Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Replace Docker dependency with auto-managed Qdrant binary —
zero-config for users. Rename package and home directory.

**Architecture:** Postinstall downloads platform-specific Qdrant binary. At
startup, daemon-style process management (modeled after ONNX daemon): detached
child process, PID/port file discovery, refcounting, idle shutdown. Autodetect
probes localhost:6333 first; if external Qdrant responds, uses it; otherwise
spawns embedded daemon.

**Tech Stack:** Node.js child_process (detached), net (free port), node:https
(download), PID/port/refs files for daemon discovery.

---

### Task 1: Migrate home directory ~/.tea-rags-mcp → ~/.tea-rags

**Files:**

- Modify: `src/bootstrap/config/paths.ts`
- Modify: `src/core/ingest/pipeline/infra/debug-logger.ts` (comment only)
- Modify: `src/core/adapters/embeddings/onnx/worker.ts:87`
- Create: `src/bootstrap/migrate.ts`
- Create: `tests/unit/bootstrap/migrate.test.ts`
- Modify: `tests/vitest.setup.ts` (redirect test logs to temp dir +
  auto-cleanup)

**Step 1: Write the failing test for migration**

File: `tests/unit/bootstrap/migrate.test.ts`

```typescript
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateHomeDir } from "../../../src/bootstrap/migrate.js";

describe("migrateHomeDir", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "tea-rags-migrate-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("does nothing when neither directory exists", () => {
    migrateHomeDir(tempHome);
    expect(existsSync(join(tempHome, ".tea-rags"))).toBe(false);
  });

  it("keeps .tea-rags if it already exists", () => {
    const newDir = join(tempHome, ".tea-rags");
    mkdirSync(newDir);
    writeFileSync(join(newDir, "marker"), "new");

    migrateHomeDir(tempHome);
    expect(readFileSync(join(newDir, "marker"), "utf-8")).toBe("new");
  });

  it("renames .tea-rags-mcp to .tea-rags when only old exists", () => {
    const oldDir = join(tempHome, ".tea-rags-mcp");
    mkdirSync(oldDir);
    writeFileSync(join(oldDir, "data.json"), '{"test":1}');

    migrateHomeDir(tempHome);

    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(join(tempHome, ".tea-rags"))).toBe(true);
    expect(
      readFileSync(join(tempHome, ".tea-rags", "data.json"), "utf-8"),
    ).toBe('{"test":1}');
  });

  it("does not overwrite .tea-rags if both exist", () => {
    const oldDir = join(tempHome, ".tea-rags-mcp");
    const newDir = join(tempHome, ".tea-rags");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(join(oldDir, "old"), "old-data");
    writeFileSync(join(newDir, "new"), "new-data");

    migrateHomeDir(tempHome);

    // New dir preserved, old dir untouched
    expect(readFileSync(join(newDir, "new"), "utf-8")).toBe("new-data");
    expect(existsSync(oldDir)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bootstrap/migrate.test.ts` Expected: FAIL —
module not found.

**Step 3: Write migration module**

File: `src/bootstrap/migrate.ts`

```typescript
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OLD_DIR_NAME = ".tea-rags-mcp";
const NEW_DIR_NAME = ".tea-rags";

/**
 * Migrate ~/.tea-rags-mcp → ~/.tea-rags if only old exists.
 * If both exist, leave both (user decides).
 * If neither exists, do nothing — new dir is created on demand.
 */
export function migrateHomeDir(home = homedir()): void {
  const oldPath = join(home, OLD_DIR_NAME);
  const newPath = join(home, NEW_DIR_NAME);

  if (existsSync(newPath)) return; // already migrated or fresh
  if (!existsSync(oldPath)) return; // nothing to migrate

  try {
    renameSync(oldPath, newPath);
    console.error(`[tea-rags] Migrated ${oldPath} → ${newPath}`);
  } catch (err) {
    console.error(
      `[tea-rags] Migration failed (${oldPath} → ${newPath}): ${(err as Error).message}`,
    );
  }
}
```

**Step 4: Update paths.ts**

File: `src/bootstrap/config/paths.ts` line 4:

```typescript
// Before:
const APP_DIR_NAME = ".tea-rags-mcp";
// After:
const APP_DIR_NAME = ".tea-rags";
```

**Step 5: Update ONNX worker fallback path**

File: `src/core/adapters/embeddings/onnx/worker.ts` line 87:

```typescript
// Before:
const dataDir =
  process.env.TEA_RAGS_DATA_DIR ??
  (process.env.HOME ? `${process.env.HOME}/.tea-rags-mcp` : null);
// After:
const dataDir =
  process.env.TEA_RAGS_DATA_DIR ??
  (process.env.HOME ? `${process.env.HOME}/.tea-rags` : null);
```

**Step 6: Update debug-logger comment**

File: `src/core/ingest/pipeline/infra/debug-logger.ts` line 4:

```typescript
// Before:
 * Writes detailed trace logs to ~/.tea-rags-mcp/logs/ when DEBUG=1
// After:
 * Writes detailed trace logs to ~/.tea-rags/logs/ when DEBUG=1
```

**Step 7: Call migration at startup**

File: `src/index.ts` — add before `parseAppConfig()`:

```typescript
import { migrateHomeDir } from "./bootstrap/migrate.js";

async function main() {
  migrateHomeDir();
  const config = parseAppConfig();
  ...
```

**Step 8: Setup test log isolation**

File: `tests/vitest.setup.ts` — redirect logs to temp dir and auto-cleanup:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

import { setDebug } from "../src/core/ingest/pipeline/infra/runtime.js";

// Set test-specific environment variables
process.env.DEBUG = process.env.DEBUG || "true";
setDebug(true);
process.env.MAX_TOTAL_CHUNKS = process.env.MAX_TOTAL_CHUNKS || "1000";
process.env.CHUNKER_POOL_SIZE = process.env.CHUNKER_POOL_SIZE || "1";

// Redirect app data to temp dir to avoid polluting user's home
const testDataDir = mkdtempSync(join(tmpdir(), "tea-rags-test-"));
process.env.TEA_RAGS_DATA_DIR = testDataDir;

afterAll(() => {
  rmSync(testDataDir, { recursive: true, force: true });
});
```

Note: This requires `paths.ts` to respect `TEA_RAGS_DATA_DIR` override. Update
`appDataDir()`:

```typescript
export function appDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), APP_DIR_NAME);
}
```

**Step 9: Run all tests**

Run: `npx vitest run` Expected: PASS. Logs/snapshots written to temp dir,
auto-cleaned after test run.

**Step 10: Commit**

```bash
git add src/bootstrap/migrate.ts src/bootstrap/config/paths.ts \
  src/core/adapters/embeddings/onnx/worker.ts \
  src/core/ingest/pipeline/infra/debug-logger.ts \
  src/index.ts tests/vitest.setup.ts tests/unit/bootstrap/migrate.test.ts
git commit -m "refactor: migrate home directory from .tea-rags-mcp to .tea-rags

- Auto-migrate on startup (rename if only old exists)
- Redirect test logs to temp dir with auto-cleanup
- Support TEA_RAGS_DATA_DIR override in paths.ts"
```

---

### Task 2: Binary downloader

**Files:**

- Create: `src/embedded/download.ts`
- Create: `scripts/postinstall.js`
- Create: `tests/unit/embedded/download.test.ts`

**Step 1: Write the failing test**

File: `tests/unit/embedded/download.test.ts`

```typescript
import { describe, expect, it } from "vitest";

import {
  getBinaryPath,
  getPlatformAsset,
  QDRANT_VERSION,
} from "../../../src/embedded/download.js";

describe("getPlatformAsset", () => {
  it("returns correct asset for darwin-arm64", () => {
    expect(getPlatformAsset("darwin", "arm64")).toBe(
      "qdrant-aarch64-apple-darwin.tar.gz",
    );
  });

  it("returns correct asset for darwin-x64", () => {
    expect(getPlatformAsset("darwin", "x64")).toBe(
      "qdrant-x86_64-apple-darwin.tar.gz",
    );
  });

  it("returns correct asset for linux-x64", () => {
    expect(getPlatformAsset("linux", "x64")).toBe(
      "qdrant-x86_64-unknown-linux-gnu.tar.gz",
    );
  });

  it("returns correct asset for linux-arm64", () => {
    expect(getPlatformAsset("linux", "arm64")).toBe(
      "qdrant-aarch64-unknown-linux-musl.tar.gz",
    );
  });

  it("throws for unsupported platform", () => {
    expect(() => getPlatformAsset("win32", "x64")).toThrow(
      /unsupported platform/i,
    );
  });
});

describe("getBinaryPath", () => {
  it("returns path under node_modules/.cache/tea-rags", () => {
    const path = getBinaryPath();
    expect(path).toMatch(/\.cache[\\/]tea-rags[\\/]qdrant/);
  });
});

describe("QDRANT_VERSION", () => {
  it("is a valid semver string", () => {
    expect(QDRANT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/embedded/download.test.ts` Expected: FAIL —
module not found.

**Step 3: Write implementation**

File: `src/embedded/download.ts`

```typescript
import { execSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const QDRANT_VERSION = "1.17.0";

const PLATFORM_MAP: Record<string, Record<string, string>> = {
  darwin: {
    arm64: "qdrant-aarch64-apple-darwin.tar.gz",
    x64: "qdrant-x86_64-apple-darwin.tar.gz",
  },
  linux: {
    x64: "qdrant-x86_64-unknown-linux-gnu.tar.gz",
    arm64: "qdrant-aarch64-unknown-linux-musl.tar.gz",
  },
};

export function getPlatformAsset(platform: string, arch: string): string {
  const archMap = PLATFORM_MAP[platform];
  if (!archMap?.[arch]) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
  return archMap[arch];
}

export function getBinaryPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, "../../node_modules/.cache/tea-rags/qdrant");
}

export function getDownloadUrl(asset: string): string {
  return `https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}/${asset}`;
}

export function isBinaryPresent(): boolean {
  return existsSync(getBinaryPath());
}

export async function downloadQdrant(
  platform = process.platform,
  arch = process.arch,
): Promise<string> {
  const asset = getPlatformAsset(platform, arch);
  const url = getDownloadUrl(asset);
  const binaryPath = getBinaryPath();
  const cacheDir = dirname(binaryPath);

  mkdirSync(cacheDir, { recursive: true });

  const tarPath = join(cacheDir, asset);
  await downloadFile(url, tarPath);

  execSync(
    `tar -xzf ${JSON.stringify(tarPath)} -C ${JSON.stringify(cacheDir)} qdrant`,
    {
      stdio: "pipe",
    },
  );

  unlinkSync(tarPath);
  chmodSync(binaryPath, 0o755);

  return binaryPath;
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const request = (reqUrl: string) => {
      get(reqUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (!location) return reject(new Error("Redirect without location"));
          request(location);
          return;
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      }).on("error", reject);
    };
    request(url);
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/embedded/download.test.ts` Expected: PASS

**Step 5: Write postinstall script**

File: `scripts/postinstall.js`

```javascript
#!/usr/bin/env node
async function main() {
  try {
    const {
      isBinaryPresent,
      downloadQdrant,
      QDRANT_VERSION,
      getPlatformAsset,
    } = await import("../build/embedded/download.js");

    if (isBinaryPresent()) {
      console.error(
        `[tea-rags] Qdrant v${QDRANT_VERSION} binary already present`,
      );
      return;
    }

    const asset = getPlatformAsset(process.platform, process.arch);
    console.error(
      `[tea-rags] Downloading Qdrant v${QDRANT_VERSION} (${asset})...`,
    );
    await downloadQdrant();
    console.error(`[tea-rags] Qdrant binary ready`);
  } catch (err) {
    console.error(`[tea-rags] Postinstall: ${err.message}`);
    console.error(`[tea-rags] Binary will be downloaded on first startup`);
  }
}
main();
```

**Step 6: Commit**

```bash
git add src/embedded/download.ts scripts/postinstall.js tests/unit/embedded/download.test.ts
git commit -m "feat(embedded): add Qdrant binary downloader and postinstall script"
```

---

### Task 3: Qdrant daemon — process manager with refcounting

Modeled after ONNX daemon pattern: detached process, PID/port file discovery,
refcount-based idle shutdown.

**Files:**

- Create: `src/embedded/daemon.ts`
- Create: `src/embedded/types.ts`
- Create: `tests/unit/embedded/daemon.test.ts`

**Step 1: Write the failing test**

File: `tests/unit/embedded/daemon.test.ts`

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EMBEDDED_MARKER,
  getDaemonPaths,
  isDaemonAlive,
} from "../../../src/embedded/daemon.js";

describe("EMBEDDED_MARKER", () => {
  it("equals 'embedded'", () => {
    expect(EMBEDDED_MARKER).toBe("embedded");
  });
});

describe("getDaemonPaths", () => {
  it("returns pid, port, refs files under storage path", () => {
    const paths = getDaemonPaths("/tmp/test-qdrant");
    expect(paths.pidFile).toBe("/tmp/test-qdrant/daemon.pid");
    expect(paths.portFile).toBe("/tmp/test-qdrant/daemon.port");
    expect(paths.refsFile).toBe("/tmp/test-qdrant/daemon.refs");
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
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/embedded/daemon.test.ts` Expected: FAIL — module
not found.

**Step 3: Write types**

File: `src/embedded/types.ts`

```typescript
export interface DaemonPaths {
  pidFile: string;
  portFile: string;
  refsFile: string;
  storagePath: string;
}

export interface DaemonHandle {
  url: string;
  release: () => void;
}

export type QdrantResolution =
  | { mode: "external"; url: string }
  | { mode: "embedded"; url: string; release: () => void };
```

**Step 4: Write daemon implementation**

File: `src/embedded/daemon.ts`

```typescript
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { appDataDir } from "../bootstrap/config/paths.js";
import {
  downloadQdrant,
  getBinaryPath,
  isBinaryPresent,
  QDRANT_VERSION,
} from "./download.js";
import type { DaemonHandle, DaemonPaths, QdrantResolution } from "./types.js";

export const EMBEDDED_MARKER = "embedded";
const HEALTH_CHECK_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 200;
const IDLE_SHUTDOWN_MS = 30_000;

// --- Path helpers ---

export function getDaemonPaths(storagePath: string): DaemonPaths {
  return {
    pidFile: join(storagePath, "daemon.pid"),
    portFile: join(storagePath, "daemon.port"),
    refsFile: join(storagePath, "daemon.refs"),
    storagePath,
  };
}

function getStoragePath(): string {
  return (
    process.env.QDRANT_EMBEDDED_STORAGE_PATH ?? join(appDataDir(), "qdrant")
  );
}

// --- Process probing ---

export function isDaemonAlive(paths: DaemonPaths): boolean {
  if (!existsSync(paths.pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(paths.pidFile, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probeHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/readyz`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Refcount management ---

function readRefs(paths: DaemonPaths): number {
  try {
    return parseInt(readFileSync(paths.refsFile, "utf-8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function incrementRefs(paths: DaemonPaths): number {
  const next = readRefs(paths) + 1;
  writeFileSync(paths.refsFile, String(next), "utf-8");
  return next;
}

function decrementRefs(paths: DaemonPaths): number {
  const next = Math.max(0, readRefs(paths) - 1);
  writeFileSync(paths.refsFile, String(next), "utf-8");
  return next;
}

function cleanupDaemonFiles(paths: DaemonPaths): void {
  for (const f of [paths.pidFile, paths.portFile, paths.refsFile]) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

// --- Free port ---

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// --- Main API ---

export async function resolveQdrantUrl(
  qdrantUrl?: string,
): Promise<QdrantResolution> {
  if (qdrantUrl && qdrantUrl !== EMBEDDED_MARKER) {
    return { mode: "external", url: qdrantUrl };
  }

  if (!qdrantUrl) {
    const defaultUrl = "http://localhost:6333";
    if (await probeHealth(defaultUrl)) {
      return { mode: "external", url: defaultUrl };
    }
  }

  const handle = await ensureDaemon();
  return { mode: "embedded", url: handle.url, release: handle.release };
}

async function ensureDaemon(): Promise<DaemonHandle> {
  const storagePath = getStoragePath();
  mkdirSync(storagePath, { recursive: true });
  const paths = getDaemonPaths(storagePath);

  // Attach to existing daemon
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
      };
    }
  }

  cleanupDaemonFiles(paths);

  if (!isBinaryPresent()) {
    console.error(`[tea-rags] Downloading Qdrant v${QDRANT_VERSION}...`);
    await downloadQdrant();
  }

  const port = await findFreePort();
  const binaryPath = getBinaryPath();

  const child = spawn(
    binaryPath,
    ["--storage-path", storagePath, "--port", String(port), "--grpc-port", "0"],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();

  writeFileSync(paths.pidFile, String(child.pid), "utf-8");
  writeFileSync(paths.portFile, String(port), "utf-8");
  writeFileSync(paths.refsFile, "1", "utf-8");

  const url = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < HEALTH_CHECK_TIMEOUT_MS) {
    if (await probeHealth(url)) {
      console.error(
        `[tea-rags] Qdrant daemon started (pid=${child.pid}, port=${port})`,
      );
      scheduleIdleWatcher(paths, child.pid!);
      return {
        url,
        release: () => {
          const remaining = decrementRefs(paths);
          console.error(
            `[tea-rags] Released Qdrant ref (remaining=${remaining})`,
          );
        },
      };
    }
    await sleep(HEALTH_CHECK_INTERVAL_MS);
  }

  try {
    process.kill(child.pid!, "SIGKILL");
  } catch {
    /* ignore */
  }
  cleanupDaemonFiles(paths);
  throw new Error(
    `Qdrant daemon failed to start within ${HEALTH_CHECK_TIMEOUT_MS}ms`,
  );
}

function scheduleIdleWatcher(paths: DaemonPaths, pid: number): void {
  let idleSince: number | null = null;

  const interval = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(interval);
      cleanupDaemonFiles(paths);
      return;
    }

    const refs = readRefs(paths);
    if (refs <= 0) {
      if (idleSince === null) {
        idleSince = Date.now();
      } else if (Date.now() - idleSince >= IDLE_SHUTDOWN_MS) {
        console.error(`[tea-rags] Qdrant daemon idle, shutting down`);
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* ignore */
        }
        cleanupDaemonFiles(paths);
        clearInterval(interval);
      }
    } else {
      idleSince = null;
    }
  }, 5000);

  interval.unref();
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/embedded/daemon.test.ts` Expected: PASS

**Step 6: Commit**

```bash
git add src/embedded/daemon.ts src/embedded/types.ts tests/unit/embedded/daemon.test.ts
git commit -m "feat(embedded): add Qdrant daemon with refcounting and idle shutdown"
```

---

### Task 4: Integrate daemon into bootstrap

**Files:**

- Modify: `src/bootstrap/config/schemas.ts:19`
- Modify: `src/bootstrap/config/index.ts:12,37`
- Modify: `src/bootstrap/factory.ts:44-45,97`
- Modify: `src/index.ts:24-28`
- Create: `tests/unit/bootstrap/embedded-integration.test.ts`

**Step 1: Write the failing test**

File: `tests/unit/bootstrap/embedded-integration.test.ts`

```typescript
import { describe, expect, it } from "vitest";

describe("coreSchema qdrantUrl", () => {
  it("accepts 'embedded' as valid value", async () => {
    const { coreSchema } =
      await import("../../../src/bootstrap/config/schemas.js");
    const result = coreSchema.safeParse({
      qdrantUrl: "embedded",
      transportMode: "stdio",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.qdrantUrl).toBe("embedded");
  });

  it("defaults to undefined when not set", async () => {
    const { coreSchema } =
      await import("../../../src/bootstrap/config/schemas.js");
    const result = coreSchema.safeParse({ transportMode: "stdio" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.qdrantUrl).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bootstrap/embedded-integration.test.ts`
Expected: FAIL — current default is `"http://localhost:6333"`.

**Step 3: Update config schema**

File: `src/bootstrap/config/schemas.ts` line 19:

```typescript
// Before:
qdrantUrl: z.string().default("http://localhost:6333"),
// After:
qdrantUrl: z.string().optional(),
```

**Step 4: Update AppConfig**

File: `src/bootstrap/config/index.ts`:

```typescript
// AppConfig interface:
qdrantUrl?: string;   // was: qdrantUrl: string
```

**Step 5: Update factory.ts**

```typescript
import { resolveQdrantUrl } from "../embedded/daemon.js";

// AppContext — add:
embeddedRelease?: () => void;

// createAppContext — replace line 45:
const resolution = await resolveQdrantUrl(config.qdrantUrl);
const qdrant = new QdrantManager(resolution.url, config.qdrantApiKey);
const embeddedRelease = resolution.mode === "embedded" ? resolution.release : undefined;

// Return: add embeddedRelease
```

**Step 6: Update index.ts shutdown**

```typescript
const cleanup = () => {
  if (
    "terminate" in ctx.embeddings &&
    typeof ctx.embeddings.terminate === "function"
  ) {
    void (ctx.embeddings as { terminate: () => Promise<void> }).terminate();
  }
  if (ctx.embeddedRelease) {
    ctx.embeddedRelease();
  }
};
```

**Step 7: Run all tests**

Run: `npx vitest run` Expected: PASS

**Step 8: Commit**

```bash
git add src/bootstrap/config/schemas.ts src/bootstrap/config/index.ts \
  src/bootstrap/factory.ts src/index.ts tests/unit/bootstrap/embedded-integration.test.ts
git commit -m "feat(embedded): integrate Qdrant daemon into bootstrap with autodetect"
```

---

### Task 5: Package rename — @artk0de/tea-rags-mcp → tea-rags

**Files:**

- Modify: `package.json` (name, bin, postinstall)
- Modify: `package-lock.json` (regenerated)

**Step 1: Update package.json**

```json
{
  "name": "tea-rags",
  "bin": {
    "tea-rags": "build/index.js"
  },
  "scripts": {
    "postinstall": "node scripts/postinstall.js",
    ...existing
  }
}
```

Remove `publishConfig.access: "public"` (not scoped anymore).

**Step 2: Search and update all references**

Search codebase for `tea-rags-mcp` and `@artk0de/tea-rags-mcp`. Update all
occurrences in source code.

**Step 3: Regenerate lock file**

Run: `npm install`

**Step 4: Verify**

Run: `npm run type-check && npx vitest run` Expected: PASS

**Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat!: rename package to tea-rags

BREAKING CHANGE: package renamed from @artk0de/tea-rags-mcp to tea-rags"
```

---

### Task 6: npm publish config

**Files:**

- Modify: `package.json` (files field)

**Step 1: Add files field**

```json
{
  "files": ["build/", "scripts/postinstall.js", "prompts.json"]
}
```

**Step 2: Verify**

Run: `npm pack --dry-run` Expected: `scripts/postinstall.js` and
`build/embedded/download.js` in the tarball.

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: configure npm files for embedded Qdrant distribution"
```

---

### Task 7: Update Docusaurus docs — paths and references

All `~/.tea-rags-mcp` references must become `~/.tea-rags`. All `tea-rags-mcp`
package references must become `tea-rags`.

**Files to update (`.tea-rags-mcp` → `.tea-rags`):**

- `website/docs/config/providers/onnx.md`
- `website/docs/config/performance-tuning.md`
- `website/docs/config/project-level-setup.md`
- `website/docs/config/environment-variables.md`
- `website/docs/operations/troubleshooting.md`
- `website/docs/architecture/overview.md`

**Files to update (`tea-rags-mcp` package name → `tea-rags`):**

- All 19 files found in website/ (see grep results above)
- `website/docusaurus.config.ts`

**Note:** Skip `website/docs/changelog.md` — it's auto-generated by
semantic-release.

**Step 1: Search and replace `.tea-rags-mcp` → `.tea-rags` in website/**

For each file: replace all occurrences. Be careful not to replace in code blocks
that reference git repo name or GitHub URLs.

Rules:

- `~/.tea-rags-mcp` → `~/.tea-rags` (home directory paths)
- `@artk0de/tea-rags-mcp` → `tea-rags` (npm package)
- `tea-rags-mcp` (standalone, as package name) → `tea-rags`
- Keep GitHub repo URL as-is (unless repo is also renamed)

**Step 2: Update Docusaurus config**

File: `website/docusaurus.config.ts` — update title/navbar if they reference old
name.

**Step 3: Add new env vars to docs**

In `website/docs/config/environment-variables.md`, add:

- `QDRANT_URL` — document autodetect behavior (unset/`embedded`/`http://...`)
- `QDRANT_EMBEDDED_STORAGE_PATH` — default `~/.tea-rags/qdrant/`
- `TEA_RAGS_DATA_DIR` — override base data directory

**Step 4: Update installation/quickstart**

Remove Docker/Podman as prerequisite. New install:

```bash
npm install tea-rags
```

**Step 5: Build docs to verify**

Run: `cd website && npm run build` Expected: No broken links or build errors.

**Step 6: Commit**

```bash
git add website/
git commit -m "docs: update all references from tea-rags-mcp to tea-rags

- Migrate ~/.tea-rags-mcp paths to ~/.tea-rags
- Update package name references
- Add embedded Qdrant env var documentation
- Remove Docker prerequisite from installation"
```

---

## Task Dependency Graph

```
Task 1 (home dir migration) ──→ Task 2 (downloader) ──→ Task 3 (daemon) ──→ Task 4 (bootstrap)
                                                                                     ↓
                                                                          Task 5 (rename) ──→ Task 6 (npm files)
                                                                                                      ↓
                                                                                                Task 7 (docs)
```

## Daemon Architecture Summary

```
MCP Session 1 ──→ resolveQdrantUrl()
                      │
                      ├─ QDRANT_URL=http://... → external, done
                      │
                      ├─ QDRANT_URL unset → probe localhost:6333
                      │   ├─ alive → external, done
                      │   └─ dead ↓
                      │
                      └─ ensureDaemon()
                          ├─ daemon.pid exists + process alive + /readyz ok?
                          │   └─ YES: refcount++, return url
                          │
                          └─ NO: cleanup stale files
                              ├─ ensure binary (lazy download)
                              ├─ find free port
                              ├─ spawn(qdrant, {detached, stdio:ignore})
                              ├─ child.unref()
                              ├─ write pid/port/refs files
                              ├─ poll /readyz
                              ├─ scheduleIdleWatcher()
                              └─ return { url, release }

On shutdown:
  release() → refs-- → idle watcher detects refs=0
                         → wait 30s → SIGTERM → cleanup files

Files:
  ~/.tea-rags/qdrant/
  ├── daemon.pid          # Qdrant process PID
  ├── daemon.port         # HTTP port (dynamic)
  ├── daemon.refs         # Client refcount
  └── storage/            # Qdrant data (collections, WAL, etc.)
```
