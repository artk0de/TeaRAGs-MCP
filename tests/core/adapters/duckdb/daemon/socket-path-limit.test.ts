/**
 * The codegraph daemon's unix socket path stays within the platform's
 * `sun_path` limit (bd tea-rags-mcp-js1ie). A long HOME / TEA_RAGS_DATA_DIR
 * produced a 110-byte path, `listen` failed with EINVAL, and every client gave
 * up after its connect timeout.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import {
  daemonPathsForKeyDir,
  daemonSocketPathForKeyDir,
  ensureDaemonSocketDir,
  getDaemonPaths,
  readDaemonPid,
  resolveDaemonClientTarget,
  sweepOrphanedDaemonKeyDirs,
} from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import { DATABASE_MIGRATIONS_MODULE_URL } from "../../../../../src/core/domains/maintenance/migration/database/index.js";

const DARWIN_USABLE = 103;
const LINUX_USABLE = 107;

const roots: string[] = [];
const aliases: string[] = [];
const shutdowns: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown().catch(() => undefined);
  for (const dir of [...roots.splice(0), ...aliases.splice(0)]) rmSync(dir, { recursive: true, force: true });
});

/** A storage dir whose keyed socket path is far past every platform's limit. */
function makeLongRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cg-sock-"));
  roots.push(root);
  const long = join(root, "a".repeat(60), "codegraph");
  mkdirSync(long, { recursive: true });
  return long;
}

function bytes(path: string): number {
  return Buffer.byteLength(path);
}

const LONG_KEY_DIR = `/Users/${"u".repeat(40)}/Library/Application Support/${"x".repeat(30)}/codegraph/b-12345678`;

describe("daemonSocketPathForKeyDir (js1ie)", () => {
  it("keeps a short key dir's socket in the key dir, unchanged", () => {
    expect(daemonSocketPathForKeyDir("/home/u/.tea-rags/codegraph/b-12345678", { platform: "linux" })).toBe(
      "/home/u/.tea-rags/codegraph/b-12345678/codegraph-daemon.sock",
    );
  });

  it("moves a too-long darwin socket under the tmp dir within 103 bytes", () => {
    const socket = daemonSocketPathForKeyDir(LONG_KEY_DIR, { platform: "darwin", tmpDir: "/var/folders/ab/cd/T" });
    expect(bytes(join(LONG_KEY_DIR, "codegraph-daemon.sock"))).toBeGreaterThan(DARWIN_USABLE);
    expect(bytes(socket)).toBeLessThanOrEqual(DARWIN_USABLE);
    expect(socket.startsWith("/var/folders/ab/cd/T/")).toBe(true);
  });

  it("applies the 107-byte linux limit", () => {
    const keyDir = `/home/${"u".repeat(60)}/.tea-rags/codegraph/b-12345678`;
    const socket = daemonSocketPathForKeyDir(keyDir, { platform: "linux", tmpDir: "/tmp" });
    expect(bytes(socket)).toBeLessThanOrEqual(LINUX_USABLE);
    expect(socket).not.toBe(join(keyDir, "codegraph-daemon.sock"));
  });

  it("is deterministic per key dir and distinct across key dirs", () => {
    const host = { platform: "darwin" as const, tmpDir: "/var/folders/ab/cd/T" };
    expect(daemonSocketPathForKeyDir(LONG_KEY_DIR, host)).toBe(daemonSocketPathForKeyDir(LONG_KEY_DIR, host));
    expect(daemonSocketPathForKeyDir(`${LONG_KEY_DIR}0`, host)).not.toBe(daemonSocketPathForKeyDir(LONG_KEY_DIR, host));
  });

  it("falls back to /tmp when the tmp dir itself is too long", () => {
    const socket = daemonSocketPathForKeyDir(LONG_KEY_DIR, { platform: "darwin", tmpDir: `/var/${"t".repeat(90)}` });
    expect(socket.startsWith("/tmp/")).toBe(true);
    expect(bytes(socket)).toBeLessThanOrEqual(DARWIN_USABLE);
  });

  it("leaves Windows untouched, however long the key dir", () => {
    const keyDir = `C:\\Users\\${"u".repeat(80)}\\.tea-rags\\codegraph\\b-12345678`;
    expect(daemonSocketPathForKeyDir(keyDir, { platform: "win32", tmpDir: "C:\\Temp" })).toBe(
      join(keyDir, "codegraph-daemon.sock"),
    );
  });
});

describe("daemon paths over a long storage dir (js1ie)", () => {
  it("server and client derive the same in-limit socket path", () => {
    const dir = makeLongRoot();
    const server = getDaemonPaths(dir).socketPath;
    const client = resolveDaemonClientTarget(dir).paths.socketPath;
    expect(client).toBe(server);
    expect(bytes(server)).toBeLessThanOrEqual(process.platform === "linux" ? LINUX_USABLE : DARWIN_USABLE);
    aliases.push(dirname(server));
  });

  it("a real daemon listens on the long dir's socket and clients reach it", async () => {
    const dir = makeLongRoot();
    const paths = getDaemonPaths(dir);
    aliases.push(dirname(paths.socketPath));

    const { shutdown } = await runDaemon({
      rootDir: dir,
      paths,
      migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
      exit: () => undefined,
    });
    shutdowns.push(shutdown);

    await new Promise<void>((resolve, reject) => {
      const socket = connect(paths.socketPath, () => {
        socket.end();
        resolve();
      });
      socket.once("error", reject);
    });
    // The client-side back-mapping (`daemonPathsForKeyDir(dirname(socket))`)
    // still addresses this daemon's own lifecycle files.
    const recovered = daemonPathsForKeyDir(dirname(paths.socketPath));
    expect(readDaemonPid(recovered)).toBe(process.pid);
    expect(realpathSync(recovered.pidFile)).toBe(realpathSync(paths.pidFile));

    await shutdown();
    expect(existsSync(paths.socketPath)).toBe(false);
  });

  it("the dead-key-dir sweep also removes the key dir's tmp alias", () => {
    const dir = makeLongRoot();
    const paths = getDaemonPaths(dir);
    const alias = dirname(paths.socketPath);
    aliases.push(alias);
    ensureDaemonSocketDir(paths);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    writeFileSync(paths.pidFile, "999999999", "utf-8");

    expect(sweepOrphanedDaemonKeyDirs(dir)).toContain(paths.buildDir);

    expect(existsSync(paths.buildDir)).toBe(false);
    expect(() => lstatSync(alias)).toThrow();
  });
});
