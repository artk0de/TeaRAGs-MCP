/**
 * One daemon per build-key directory (bd tea-rags-mcp-imgjx).
 *
 * Live: one index worker spawned TWO daemons of the same build within the same
 * second. The pid file named the second, so every client talked to it, while
 * the first — unreachable, its socket inode already unlinked by the second —
 * held the DuckDB RW lock on the collection it had opened. The reachable daemon
 * then retried its own open every second until the orphan's 60s idle eviction
 * let go. `runDaemon` had no single-instance guard, so the loser of a spawn race
 * simply kept running.
 *
 * These specs pin the daemon-side guard: the owner lock is claimed before any
 * DuckDB file or the socket is touched, a loser exits cleanly, and a dead
 * owner's leftovers never block the next daemon.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { getDaemonPaths, type CodegraphDaemonPaths } from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import { CodegraphDaemonOwnedElsewhereError } from "../../../../../src/core/adapters/duckdb/errors.js";
import { DATABASE_MIGRATIONS_MODULE_URL } from "../../../../../src/core/domains/maintenance/migration/database/index.js";

// Above every real pid_max (macOS 99998, Linux 4194304) — reads as ESRCH.
const DEAD_PID = 99999999;

let root: string | undefined;
const shutdowns: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown().catch(() => undefined);
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makePaths(): { paths: CodegraphDaemonPaths; dataDir: string } {
  root = mkdtempSync(join(tmpdir(), "cg-imgjx-"));
  const paths = getDaemonPaths(join(root, "d"));
  mkdirSync(paths.buildDir, { recursive: true });
  return { paths, dataDir: join(root, "data") };
}

async function start(paths: CodegraphDaemonPaths, dataDir: string, exit: (code: number) => void) {
  return runDaemon({
    rootDir: dataDir,
    paths,
    buildFingerprint: "imgjx-daemon",
    migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
    exit,
  });
}

/** Every file under `dir`, recursively — empty when the dir was never created. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf-8" });
}

describe("codegraph daemon single-instance ownership (imgjx)", () => {
  it("two daemons racing for one key directory leave exactly one owner", async () => {
    const { paths, dataDir } = makePaths();
    const exit = vi.fn();

    const results = await Promise.allSettled([start(paths, dataDir, exit), start(paths, dataDir, exit)]);

    const owners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");
    for (const owner of owners) shutdowns.push(owner.value.shutdown);
    expect(owners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason).toBeInstanceOf(CodegraphDaemonOwnedElsewhereError);
    // The loser exits cleanly — a lost race is not a startup failure.
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    // The owner's lifecycle files survive the loser's exit.
    expect(readFileSync(paths.pidFile, "utf-8").trim()).toBe(String(process.pid));
    expect(existsSync(paths.socketPath)).toBe(true);
  });

  it("a daemon started against a key directory a live daemon owns exits without touching the socket or a DuckDB file", async () => {
    const { paths, dataDir } = makePaths();
    // The vitest parent stands in for the live owner: its pid answers signal 0.
    const owner = process.ppid;
    writeFileSync(paths.ownerFile, String(owner), "utf-8");
    writeFileSync(paths.pidFile, String(owner), "utf-8");
    writeFileSync(paths.socketPath, "", "utf-8"); // the owner's socket inode
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.fn();

    await expect(start(paths, dataDir, exit)).rejects.toBeInstanceOf(CodegraphDaemonOwnedElsewhereError);

    expect(exit).toHaveBeenCalledWith(0);
    // One log line naming the owner, for the spawn log.
    const lines = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((l) => l.includes("[codegraph-daemon]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(String(owner));
    // Nothing of the owner's was replaced, and no database was opened.
    expect(existsSync(paths.socketPath)).toBe(true);
    expect(readFileSync(paths.pidFile, "utf-8").trim()).toBe(String(owner));
    expect(readFileSync(paths.ownerFile, "utf-8").trim()).toBe(String(owner));
    expect(filesUnder(dataDir).filter((f) => f.endsWith(".duckdb"))).toEqual([]);
  });

  it("a dead owner's leftover files do not block a new daemon", async () => {
    const { paths, dataDir } = makePaths();
    writeFileSync(paths.ownerFile, String(DEAD_PID), "utf-8");
    writeFileSync(paths.pidFile, String(DEAD_PID), "utf-8");
    writeFileSync(paths.socketPath, "", "utf-8"); // stale socket inode of the crashed daemon
    const exit = vi.fn();

    const daemon = await start(paths, dataDir, exit);
    shutdowns.push(daemon.shutdown);

    expect(exit).not.toHaveBeenCalled();
    expect(readFileSync(paths.ownerFile, "utf-8").trim()).toBe(String(process.pid));
    expect(readFileSync(paths.pidFile, "utf-8").trim()).toBe(String(process.pid));
  });

  it("releases ownership on shutdown so the next spawn of the same build can own the key directory", async () => {
    const { paths, dataDir } = makePaths();
    const exit = vi.fn();

    const first = await start(paths, dataDir, exit);
    await first.shutdown();
    expect(existsSync(paths.ownerFile)).toBe(false);

    const second = await start(paths, dataDir, exit);
    shutdowns.push(second.shutdown);
    expect(exit).not.toHaveBeenCalled();
    expect(readFileSync(paths.ownerFile, "utf-8").trim()).toBe(String(process.pid));
  });
});
