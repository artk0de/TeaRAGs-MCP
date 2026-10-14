import { describe, expect, it } from "vitest";

import {
  findOrphanedDaemon,
  parseProcessTable,
  readProcessTable,
  type OrphanedDaemonDiscoveryDeps,
  type ProcessTableRow,
} from "../../../../../src/core/adapters/qdrant/embedded/daemon-discovery.js";

const BINARY = "/home/u/.tea-rags/qdrant/bin/qdrant";
const STORAGE = "/home/u/.tea-rags/qdrant";

function daemonRow(pid: number, storage: string, port: number, binary = BINARY): ProcessTableRow {
  return {
    pid,
    commandLine:
      `${binary} --disable-telemetry HOME=/home/u QDRANT__STORAGE__STORAGE_PATH=${storage} ` +
      `QDRANT__SERVICE__HTTP_PORT=${port} QDRANT__SERVICE__GRPC_PORT=0`,
  };
}

function makeDeps(rows: readonly ProcessTableRow[] | undefined, alive = (_pid: number) => true) {
  return {
    readProcessTable: async () => rows,
    isAlive: alive,
  } satisfies OrphanedDaemonDiscoveryDeps;
}

describe("findOrphanedDaemon", () => {
  it("finds the live qdrant serving this storage and reads its port from its environment", async () => {
    const rows = [
      { pid: 1, commandLine: "/sbin/launchd" },
      daemonRow(3150, "/other/storage", 6000),
      daemonRow(3151, STORAGE, 50779),
    ];
    expect(await findOrphanedDaemon(STORAGE, BINARY, makeDeps(rows))).toEqual({ pid: 3151, port: 50779 });
  });

  it("does not match a storage path that only shares a prefix with this one", async () => {
    const rows = [daemonRow(3150, `${STORAGE}-old`, 6000)];
    expect(await findOrphanedDaemon(STORAGE, BINARY, makeDeps(rows))).toBeUndefined();
  });

  it("ignores a process that is not our qdrant binary even when it carries the storage env", async () => {
    const rows = [daemonRow(77, STORAGE, 6000, "/usr/local/bin/node")];
    expect(await findOrphanedDaemon(STORAGE, BINARY, makeDeps(rows))).toBeUndefined();
  });

  it("ignores a matching row whose pid is no longer alive", async () => {
    const rows = [daemonRow(3150, STORAGE, 50779)];
    expect(
      await findOrphanedDaemon(
        STORAGE,
        BINARY,
        makeDeps(rows, () => false),
      ),
    ).toBeUndefined();
  });

  it("ignores a matching row without a readable http port", async () => {
    const rows = [{ pid: 3150, commandLine: `${BINARY} --disable-telemetry QDRANT__STORAGE__STORAGE_PATH=${STORAGE}` }];
    expect(await findOrphanedDaemon(STORAGE, BINARY, makeDeps(rows))).toBeUndefined();
  });

  it("degrades to undefined when the process table cannot be read", async () => {
    expect(await findOrphanedDaemon(STORAGE, BINARY, makeDeps(undefined))).toBeUndefined();
  });

  it("matches a storage path that contains spaces", async () => {
    const spaced = "/Users/a b/.tea-rags/qdrant";
    const rows = [daemonRow(9, spaced, 41000)];
    expect(await findOrphanedDaemon(spaced, BINARY, makeDeps(rows))).toEqual({ pid: 9, port: 41000 });
  });
});

describe("parseProcessTable", () => {
  it("splits `pid command` lines and skips blank or malformed ones", () => {
    const stdout = `  3150 /bin/qdrant --disable-telemetry A=1\n\n garbage\n   12 /bin/sh -c x\n`;
    expect(parseProcessTable(stdout)).toEqual([
      { pid: 3150, commandLine: "/bin/qdrant --disable-telemetry A=1" },
      { pid: 12, commandLine: "/bin/sh -c x" },
    ]);
  });
});

describe("readProcessTable", () => {
  it("lists this very process with its command line", async () => {
    const rows = await readProcessTable();
    expect(rows).toBeDefined();
    expect(rows?.some((row) => row.pid === process.pid)).toBe(true);
  });
});
