/**
 * The codegraph-unavailable error family (bd tea-rags-mcp-a43tr).
 *
 * An optional codegraph consumer (find_symbol's collapsed-symbol fallback)
 * degrades exactly when the store cannot be reached from this process, and
 * decides that by error class — never by message text. Anything outside the
 * family (driver close failure, Qdrant, programming errors) is not a reason to
 * degrade.
 */

import { describe, expect, it } from "vitest";

import {
  CodegraphClientStaleBuildError,
  CodegraphDaemonBuildSkewError,
  CodegraphDaemonExitTimeoutError,
  CodegraphDaemonStaleBuildError,
  CodegraphDaemonUnreachableError,
  DuckDbCloseFailedError,
  DuckDbOpenFailedError,
  isCodegraphUnavailableError,
} from "../../../../src/core/adapters/duckdb/errors.js";
import { InfraError } from "../../../../src/core/adapters/errors.js";
import { QdrantUnavailableError } from "../../../../src/core/adapters/qdrant/errors.js";

describe("CodegraphDaemonStaleBuildError — remedy in the message (a43tr S4)", () => {
  it("names restarting / reconnecting the MCP server and keeps its code", () => {
    const err = new CodegraphDaemonStaleBuildError("/tmp/cg/daemon.sock", "CLIENT-OLD", "DAEMON-NEW", [
      "DAEMON-NEW",
      "DAEMON-NEW",
      "DAEMON-NEW",
    ]);

    expect(err.code).toBe("INFRA_CODEGRAPH_DAEMON_STALE_BUILD");
    expect(err.message).toMatch(/restart the tea-rags MCP server/i);
    expect(err.message).toContain("/mcp reconnect");
  });

  it("the same-build hint names the MCP server process as a possible stale side", () => {
    const err = new CodegraphDaemonStaleBuildError("/tmp/cg/daemon.sock", "CLIENT-OLD", "DAEMON-NEW", [
      "DAEMON-NEW",
      "DAEMON-NEW",
    ]);

    expect(err.hint).toContain("/mcp reconnect");
  });

  // bd tea-rags-mcp-1wr7p: a server that merely predates the on-disk build is
  // now told apart BEFORE any drain, so a build that keeps coming back is
  // someone else's tree — the 2026-08-17 two-builds fight over one daemon.
  it("the same-build hint blames another build tree contending for the daemon, not a lone stale binary", () => {
    const err = new CodegraphDaemonStaleBuildError("/tmp/cg/daemon.sock", "CLIENT", "OTHER-TREE", [
      "OTHER-TREE",
      "OTHER-TREE",
      "OTHER-TREE",
    ]);

    expect(err.hint).toMatch(/same build came back/i);
    expect(err.hint).toMatch(/another build tree/i);
    expect(err.hint).toMatch(/respawns its daemon after each drain/i);
    expect(err.hint).toContain("npm link");
    expect(err.hint).toContain("npm i -g");
    expect(err.hint).toMatch(/could not be read/i);
    expect(err.hint).not.toMatch(/no other session is racing/i);
  });
});

describe("CodegraphClientStaleBuildError (bd tea-rags-mcp-1wr7p)", () => {
  it("names both builds, the missing ops and the reconnect remedy, and says the daemon was left running", () => {
    const err = new CodegraphClientStaleBuildError({
      socketPath: "/tmp/cg/daemon.sock",
      clientFingerprint: "CLIENT-OLD",
      daemonFingerprint: "DISK-NEW",
      missingOps: ["listAllPass1Aggregates"],
    });

    expect(err).toBeInstanceOf(InfraError);
    expect(err.code).toBe("INFRA_CODEGRAPH_CLIENT_STALE_BUILD");
    expect(err.httpStatus).toBe(503);
    expect(err.message).toContain("CLIENT-OLD");
    expect(err.message).toContain("DISK-NEW");
    expect(err.message).toContain("listAllPass1Aggregates");
    expect(err.message).toContain("/mcp reconnect");
    expect(err.hint).toMatch(/left running/i);
    // Restarting its own server process is not something tea-rags does.
    expect(err.hint).toMatch(/does not restart/i);
  });

  it("covers a daemon that advertises no op list at all", () => {
    const err = new CodegraphClientStaleBuildError({
      socketPath: "/tmp/cg/daemon.sock",
      clientFingerprint: "CLIENT-OLD",
      daemonFingerprint: "DISK-OTHER",
      missingOps: [],
    });

    expect(err.missingOps).toEqual([]);
    expect(err.message).toMatch(/does not advertise/i);
    expect(err.message).toContain("/mcp reconnect");
  });
});

describe("CodegraphDaemonUnreachableError", () => {
  it("is a typed InfraError naming the socket, the timeout and the daemon log", () => {
    const cause = Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
    const err = new CodegraphDaemonUnreachableError(
      {
        socketPath: "/tmp/cg/daemon.sock",
        connectTimeoutMs: 5000,
        detail: "ENOENT",
        logPath: "/tmp/cg/daemon.log",
      },
      cause,
    );

    expect(err).toBeInstanceOf(InfraError);
    expect(err.code).toBe("INFRA_CODEGRAPH_DAEMON_UNREACHABLE");
    expect(err.message).toContain("/tmp/cg/daemon.sock");
    expect(err.message).toContain("5000ms");
    expect(err.message).toContain("/tmp/cg/daemon.log");
    expect(err.cause).toBe(cause);
    expect(err.httpStatus).toBe(503);
  });
});

describe("isCodegraphUnavailableError", () => {
  const family: readonly [string, Error][] = [
    ["stale build", new CodegraphDaemonStaleBuildError("/s", "a", "b", ["b"])],
    [
      "client stale build",
      new CodegraphClientStaleBuildError({
        socketPath: "/s",
        clientFingerprint: "a",
        daemonFingerprint: "b",
        missingOps: ["op"],
      }),
    ],
    ["build skew", new CodegraphDaemonBuildSkewError({ socketPath: "/s", missingOps: ["op"] })],
    ["exit timeout", new CodegraphDaemonExitTimeoutError("/s", 3000)],
    [
      "unreachable",
      new CodegraphDaemonUnreachableError({ socketPath: "/s", connectTimeoutMs: 1, detail: "ENOENT", logPath: "/l" }),
    ],
    ["open failed (lock held)", new DuckDbOpenFailedError("/db", new Error("Conflicting lock is held"))],
  ];

  it.each(family)("%s is codegraph-unavailable", (_label, err) => {
    expect(isCodegraphUnavailableError(err)).toBe(true);
  });

  const outside: readonly [string, unknown][] = [
    ["plain Error", new Error("Conflicting lock is held")],
    ["close failed", new DuckDbCloseFailedError("/db")],
    ["Qdrant unavailable", new QdrantUnavailableError("http://localhost:6333")],
    ["non-error value", "INFRA_CODEGRAPH_DAEMON_STALE_BUILD"],
  ];

  it.each(outside)("%s is not codegraph-unavailable", (_label, err) => {
    expect(isCodegraphUnavailableError(err)).toBe(false);
  });
});
