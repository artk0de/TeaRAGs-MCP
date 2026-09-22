/**
 * Build-keyed daemon lifecycle (bd tea-rags-mcp-42hno).
 *
 * One socket path used to serve every build, so the first client whose build
 * fingerprint differed drained the daemon and cut every other session's
 * in-flight requests (the 08-17 EPIPE class). The lifecycle files now nest
 * under a per-build key directory derived from the build fingerprint, so each
 * build owns a daemon on its own socket. These specs pin the layout itself:
 * keying, the legacy view the one-time migration reads, per-key cleanup, and
 * the orphan sweep a spawn runs.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import {
  daemonPathsForKeyDir,
  getBuildKey,
  getDaemonPaths,
  getLegacyDaemonPaths,
  listDaemonKeyDirs,
  sweepOrphanedDaemonKeyDirs,
  unlinkDaemonFiles,
} from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import { DaemonLock } from "../../../../../src/core/adapters/qdrant/embedded/daemon-lock.js";
import { DATABASE_MIGRATIONS_MODULE_URL } from "../../../../../src/core/domains/maintenance/migration/database/index.js";

let root: string;
const shutdowns: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown().catch(() => undefined);
  if (root) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "cg-keyed-"));
  mkdirSync(root, { recursive: true });
  return root;
}

/** The pid of a process that has already exited — proof a dead pid reads as dead. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolve) =>
    child.once("exit", () => {
      resolve();
    }),
  );
  return child.pid;
}

function writePidFile(paths: ReturnType<typeof getDaemonPaths>, pid: number): void {
  mkdirSync(dirname(paths.pidFile), { recursive: true });
  writeFileSync(paths.pidFile, String(pid), "utf-8");
}

describe("build-keyed daemon layout (42hno)", () => {
  it("nests the five lifecycle files and the log under a per-build key directory", () => {
    const dir = makeRoot();
    const p = getDaemonPaths(dir);
    expect(p.storageDir).toBe(dir);
    expect(p.buildDir).toBe(join(dir, getBuildKey()));
    for (const [file, name] of [
      [p.socketPath, "codegraph-daemon.sock"],
      [p.pidFile, "codegraph-daemon.pid"],
      [p.portFile, "codegraph-daemon.port"],
      [p.refsFile, "codegraph-daemon.refs"],
      [p.lockFile, "codegraph-daemon.lock"],
      [p.logFile, "codegraph-daemon.log"],
    ] as const) {
      expect(file).toBe(join(p.buildDir, name));
    }
  });

  it("derives a stable key that follows the build fingerprint override", () => {
    const dir = makeRoot();
    const before = getDaemonPaths(dir).buildDir;
    expect(getBuildKey()).toBe(getBuildKey());
    process.env.TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT = "forced-other-build";
    try {
      const after = getDaemonPaths(dir).buildDir;
      expect(after).not.toBe(before);
      expect(after).toBe(join(dir, getBuildKey()));
    } finally {
      delete process.env.TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT;
    }
  });

  it("getLegacyDaemonPaths yields the pre-keying layout: files directly in the storage dir", () => {
    const dir = makeRoot();
    const legacy = getLegacyDaemonPaths(dir);
    expect(legacy.socketPath).toBe(join(dir, "codegraph-daemon.sock"));
    expect(legacy.pidFile).toBe(join(dir, "codegraph-daemon.pid"));
    expect(legacy.lockFile).toBe(join(dir, "codegraph-daemon.lock"));
  });

  it("daemonPathsForKeyDir maps the directory owning a socket back onto that daemon's files", () => {
    const dir = makeRoot();
    const p = getDaemonPaths(dir);
    const recovered = daemonPathsForKeyDir(dirname(p.socketPath));
    expect(recovered.socketPath).toBe(p.socketPath);
    expect(recovered.pidFile).toBe(p.pidFile);
    expect(recovered.refsFile).toBe(p.refsFile);
  });
});

describe("per-key cleanup on exit (42hno)", () => {
  it("a stopping daemon unlinks only its own key directory's files", async () => {
    const dir = makeRoot();
    const own = daemonPathsForKeyDir(join(dir, "b-aaaaaaaa"));
    const other = daemonPathsForKeyDir(join(dir, "b-bbbbbbbb"));
    for (const paths of [own, other]) {
      mkdirSync(paths.buildDir, { recursive: true });
      for (const f of [paths.pidFile, paths.socketPath, paths.refsFile, paths.lockFile]) writeFileSync(f, "x");
    }
    writePidFile(own, process.pid);

    unlinkDaemonFiles(own);

    for (const f of [own.socketPath, own.pidFile, own.refsFile, own.lockFile]) {
      expect(existsSync(f)).toBe(false);
    }
    // The other build's files are untouched.
    for (const f of [other.socketPath, other.pidFile, other.refsFile, other.lockFile]) {
      expect(existsSync(f)).toBe(true);
    }
  });

  it("a real keyed daemon cleans its own files on shutdown and leaves a sibling key intact", async () => {
    const dir = makeRoot();
    const own = getDaemonPaths(dir);
    const sibling = daemonPathsForKeyDir(join(dir, "b-cccccccc"));
    mkdirSync(sibling.buildDir, { recursive: true });
    writeFileSync(sibling.pidFile, String(process.pid), "utf-8");

    const { shutdown } = await runDaemon({
      rootDir: dir,
      paths: own,
      migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
      exit: () => undefined,
    });
    shutdowns.push(shutdown);
    expect(existsSync(own.pidFile)).toBe(true);

    await shutdown();

    expect(existsSync(own.socketPath)).toBe(false);
    expect(existsSync(own.pidFile)).toBe(false);
    expect(existsSync(sibling.pidFile)).toBe(true);
  });
});

describe("dead-key-dir sweep (42hno)", () => {
  it("lists key dirs with their pid liveness", async () => {
    const dir = makeRoot();
    const live = getDaemonPaths(dir);
    const dead = daemonPathsForKeyDir(join(dir, "b-dddddddd"));
    writePidFile(live, process.pid);
    writePidFile(dead, await deadPid());

    const listed = listDaemonKeyDirs(dir);
    const byDir = new Map(listed.map((s) => [s.keyDir, s]));
    expect(byDir.get(live.buildDir)?.alive).toBe(true);
    expect(byDir.get(dead.buildDir)?.alive).toBe(false);
  });

  it("sweeps key dirs whose pid is dead and keeps live ones", async () => {
    const dir = makeRoot();
    const live = getDaemonPaths(dir);
    const dead = daemonPathsForKeyDir(join(dir, "b-dddddddd"));
    writePidFile(live, process.pid);
    writePidFile(dead, await deadPid());

    const swept = sweepOrphanedDaemonKeyDirs(dir);

    expect(swept).toContain(dead.buildDir);
    expect(existsSync(dead.buildDir)).toBe(false);
    expect(existsSync(live.buildDir)).toBe(true);
  });

  it("skips a dead-pid dir a concurrent spawner still holds the spawn lock on", async () => {
    const dir = makeRoot();
    const spawning = daemonPathsForKeyDir(join(dir, "b-eeeeeeee"));
    writePidFile(spawning, await deadPid());
    const lock = new DaemonLock().acquire(spawning.lockFile);
    expect(lock).not.toBeNull();

    const swept = sweepOrphanedDaemonKeyDirs(dir);

    expect(swept).not.toContain(spawning.buildDir);
    expect(existsSync(spawning.buildDir)).toBe(true);
    if (lock) new DaemonLock().release(lock.fd);
  });
});
