/**
 * `ForeignBuildDaemonLockArbiter#settle` branch by branch (bd tea-rags-mcp-hw27k).
 *
 * `foreign-build-lock.test.ts` pins the two branches a REAL foreign daemon
 * reaches on its own — drained when idle, held while a client is connected.
 * The other settlements need a holder that misbehaves on cue, so they are
 * pinned here against lifecycle files and a scripted socket:
 *
 * - the holder is not another build's daemon (no pid in the error, a pid no
 *   key dir records, a dead recorded pid, OUR own build dir) → the caller keeps
 *   its plain retry, nothing is contacted;
 * - the holder refuses the drain (a write in flight) → held, `drainRefused`;
 * - the holder's socket does not accept → held, `unreachable`;
 * - the holder accepts the shutdown but does not exit in time → held,
 *   `exitTimeout`.
 *
 * Every `held` settlement keeps the holder alive and names its pid and build
 * dir, which the pool turns into `CodegraphDatabaseHeldByForeignDaemonError`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import { ForeignBuildDaemonLockArbiter } from "../../../../../src/core/adapters/duckdb/daemon/foreign-build-lock-arbiter.js";
import {
  daemonPathsForKeyDir,
  getBuildKey,
  type CodegraphDaemonPaths,
} from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import {
  decodeFrames,
  encodeFrame,
  type DaemonRequest,
} from "../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import {
  CodegraphDaemonDrainRefusedError,
  DuckDbOpenFailedError,
} from "../../../../../src/core/adapters/duckdb/errors.js";

const COLLECTION = fixturePhysicalCollectionName("code_arbiter_v1");
const OWN_FINGERPRINT = "/here/build/core/adapters/duckdb/daemon|0.0.0|1";
const FOREIGN_FINGERPRINT = "/elsewhere/worktree/build/core/adapters/duckdb/daemon|0.0.0|1";

let root: string;
let storageDir: string;
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((res) => {
      server.close(() => {
        res();
      });
    });
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): void {
  root = mkdtempSync(join(tmpdir(), "cg-arb-"));
  storageDir = join(root, "d");
  mkdirSync(storageDir, { recursive: true });
}

/** A build-key dir recording `pid` as its daemon, with no socket yet. */
function makeKeyDir(fingerprint: string, pid: number): CodegraphDaemonPaths {
  const paths = daemonPathsForKeyDir(join(storageDir, getBuildKey(fingerprint)));
  mkdirSync(paths.buildDir, { recursive: true });
  writeFileSync(paths.pidFile, String(pid), "utf-8");
  return paths;
}

/** The lock-contention open failure DuckDB reports, naming `pid` as the holder. */
function lockErrorHeldBy(pid: number | undefined): DuckDbOpenFailedError {
  const holder = pid === undefined ? "" : `: Conflicting lock is held in /usr/local/bin/node (PID ${pid})`;
  return new DuckDbOpenFailedError(
    join(root, "codegraph", "code_arbiter_v1.duckdb"),
    new Error(`IO Error: Could not set lock on file "code_arbiter_v1.duckdb"${holder} by user x.`),
  );
}

/** Scripted daemon on `paths.socketPath`: answers the handshake, answers `shutdown` as told. */
async function listenAsDaemon(
  paths: CodegraphDaemonPaths,
  onShutdown: "refuse" | "accept",
): Promise<{ shutdownRequests: () => number }> {
  let shutdownRequests = 0;
  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const frame of frames) {
        const req = JSON.parse(frame) as DaemonRequest;
        if (req.op === "handshake") {
          sock.write(encodeFrame({ id: req.id, ok: true, result: { buildFingerprint: FOREIGN_FINGERPRINT } }));
        } else if (req.op === "shutdown") {
          shutdownRequests++;
          const refusal = new CodegraphDaemonDrainRefusedError({ socketPath: paths.socketPath });
          sock.write(
            encodeFrame(
              onShutdown === "refuse"
                ? { id: req.id, ok: false, error: { name: refusal.name, message: refusal.message } }
                : { id: req.id, ok: true, result: true },
            ),
          );
        } else {
          sock.write(encodeFrame({ id: req.id, ok: true, result: true }));
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => {
    server.listen(paths.socketPath, () => {
      res();
    });
  });
  return { shutdownRequests: () => shutdownRequests };
}

function makeArbiter(exitTimeoutMs = 300): ForeignBuildDaemonLockArbiter {
  return new ForeignBuildDaemonLockArbiter({
    storageDir,
    ownBuildDir: daemonPathsForKeyDir(join(storageDir, getBuildKey(OWN_FINGERPRINT))).buildDir,
    buildFingerprint: OWN_FINGERPRINT,
    exitTimeoutMs,
  });
}

describe("ForeignBuildDaemonLockArbiter#settle (hw27k)", () => {
  describe("a holder that is not another build's daemon keeps the plain retry", () => {
    it("when the driver did not name the holder's pid", async () => {
      makeRoot();
      makeKeyDir(FOREIGN_FINGERPRINT, process.pid);

      expect(await makeArbiter().settle(lockErrorHeldBy(undefined), COLLECTION)).toEqual({
        kind: "notForeignBuildDaemon",
      });
    });

    it("when no build-key dir records the holder's pid", async () => {
      makeRoot();
      makeKeyDir(FOREIGN_FINGERPRINT, process.pid);

      expect(await makeArbiter().settle(lockErrorHeldBy(process.ppid), COLLECTION)).toEqual({
        kind: "notForeignBuildDaemon",
      });
    });

    it("when the recorded daemon pid is dead", async () => {
      makeRoot();
      // Beyond any pid the kernel hands out: signal 0 answers ESRCH.
      const deadPid = 2 ** 22 + 7;
      makeKeyDir(FOREIGN_FINGERPRINT, deadPid);

      expect(await makeArbiter().settle(lockErrorHeldBy(deadPid), COLLECTION)).toEqual({
        kind: "notForeignBuildDaemon",
      });
    });

    it("when the holder is THIS build's own daemon, and its socket is never contacted", async () => {
      makeRoot();
      const own = makeKeyDir(OWN_FINGERPRINT, process.pid);
      const daemon = await listenAsDaemon(own, "accept");

      expect(await makeArbiter().settle(lockErrorHeldBy(process.pid), COLLECTION)).toEqual({
        kind: "notForeignBuildDaemon",
      });
      expect(daemon.shutdownRequests()).toBe(0);
    });
  });

  it("a foreign holder that refuses the drain is held as drainRefused, named with its fingerprint", async () => {
    makeRoot();
    const foreign = makeKeyDir(FOREIGN_FINGERPRINT, process.pid);
    const daemon = await listenAsDaemon(foreign, "refuse");

    const settlement = await makeArbiter().settle(lockErrorHeldBy(process.pid), COLLECTION);

    expect(settlement).toEqual({
      kind: "held",
      reason: "drainRefused",
      holder: { pid: process.pid, buildDir: foreign.buildDir, buildFingerprint: FOREIGN_FINGERPRINT },
    });
    expect(daemon.shutdownRequests()).toBe(1);
  });

  it("a foreign holder whose socket does not accept is held as unreachable", async () => {
    makeRoot();
    const foreign = makeKeyDir(FOREIGN_FINGERPRINT, process.pid);

    const settlement = await makeArbiter().settle(lockErrorHeldBy(process.pid), COLLECTION);

    expect(settlement).toEqual({
      kind: "held",
      reason: "unreachable",
      holder: { pid: process.pid, buildDir: foreign.buildDir, buildFingerprint: undefined },
    });
  });

  it("a foreign holder that accepts the shutdown but does not exit in time is held as exitTimeout", async () => {
    makeRoot();
    const foreign = makeKeyDir(FOREIGN_FINGERPRINT, process.pid);
    const daemon = await listenAsDaemon(foreign, "accept");

    const started = Date.now();
    const settlement = await makeArbiter(300).settle(lockErrorHeldBy(process.pid), COLLECTION);

    expect(settlement).toEqual({
      kind: "held",
      reason: "exitTimeout",
      holder: { pid: process.pid, buildDir: foreign.buildDir, buildFingerprint: FOREIGN_FINGERPRINT },
    });
    expect(daemon.shutdownRequests()).toBe(1);
    // Bounded by the exit timeout, not the 10 s default.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a foreign holder with a connected client is held and never asked to shut down", async () => {
    makeRoot();
    const foreign = makeKeyDir(FOREIGN_FINGERPRINT, process.pid);
    writeFileSync(foreign.refsFile, "1", "utf-8");
    const daemon = await listenAsDaemon(foreign, "accept");

    const settlement = await makeArbiter().settle(lockErrorHeldBy(process.pid), COLLECTION);

    expect(settlement).toEqual({
      kind: "held",
      reason: "clientConnected",
      holder: { pid: process.pid, buildDir: foreign.buildDir, buildFingerprint: undefined },
    });
    expect(daemon.shutdownRequests()).toBe(0);
  });

  describe("describe", () => {
    it("fills in the holder's build fingerprint over a control handshake", async () => {
      makeRoot();
      const foreign = makeKeyDir(FOREIGN_FINGERPRINT, process.pid);
      const daemon = await listenAsDaemon(foreign, "accept");

      const described = await makeArbiter().describe(
        { pid: process.pid, buildDir: foreign.buildDir, buildFingerprint: undefined },
        COLLECTION,
      );

      expect(described.buildFingerprint).toBe(FOREIGN_FINGERPRINT);
      expect(daemon.shutdownRequests()).toBe(0);
    });

    it("leaves the fingerprint unknown when the holder's socket does not accept", async () => {
      makeRoot();
      const foreign = makeKeyDir(FOREIGN_FINGERPRINT, process.pid);
      const holder = { pid: process.pid, buildDir: foreign.buildDir, buildFingerprint: undefined };

      expect(await makeArbiter().describe(holder, COLLECTION)).toEqual(holder);
    });
  });
});
