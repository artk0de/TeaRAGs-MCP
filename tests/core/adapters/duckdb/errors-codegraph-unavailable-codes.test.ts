/**
 * Drift guard for the codegraph-unavailable family (bd tea-rags-mcp-89k7k.35.10).
 *
 * Domain consumers decide membership by `code` from the contracts set, because
 * they may not import the adapter's classes. The classes live in
 * `adapters/duckdb/errors.ts`; this test derives the set from them so a class
 * added to (or dropped from) the family cannot leave the set behind.
 */

import { describe, expect, it } from "vitest";

import {
  CodegraphClientBuildTreeGoneError,
  CodegraphClientStaleBuildError,
  CodegraphDaemonBuildSkewError,
  CodegraphDaemonBuildUnavailableError,
  CodegraphDaemonDrainRefusedError,
  CodegraphDaemonExitTimeoutError,
  CodegraphDaemonRequestAbortedError,
  CodegraphDaemonStaleBuildError,
  CodegraphDaemonUnreachableError,
  CodegraphDaemonUnresponsiveError,
  CodegraphDatabaseHeldByForeignDaemonError,
  DuckDbCloseFailedError,
  DuckDbOpenFailedError,
} from "../../../../src/core/adapters/duckdb/errors.js";
import {
  CODEGRAPH_UNAVAILABLE_ERROR_CODES,
  isCodegraphUnavailableError,
} from "../../../../src/core/contracts/types/codegraph-unavailable.js";

const FAMILY = [
  new CodegraphDaemonStaleBuildError("/s", "a", "b", ["b"]),
  new CodegraphClientStaleBuildError({
    socketPath: "/s",
    clientFingerprint: "a",
    daemonFingerprint: "b",
    missingOps: [],
  }),
  new CodegraphClientBuildTreeGoneError({ socketPath: "/s", loadedFingerprint: "a" }),
  new CodegraphDaemonBuildSkewError({ socketPath: "/s", missingOps: ["op"] }),
  new CodegraphDaemonExitTimeoutError("/s", 3000),
  new CodegraphDaemonUnreachableError({ socketPath: "/s", connectTimeoutMs: 1, detail: "ENOENT", logPath: "/l" }),
  new CodegraphDaemonUnresponsiveError({ socketPath: "/s", silentForMs: 1, pendingCalls: 1 }),
  new CodegraphDaemonDrainRefusedError({ socketPath: "/s" }),
  new CodegraphDaemonBuildUnavailableError({ socketPath: "/s", buildKey: "k" }),
  new CodegraphDatabaseHeldByForeignDaemonError("/db", { pid: 1, buildDir: "/d", buildFingerprint: undefined }),
  new DuckDbOpenFailedError("/db"),
];

describe("CODEGRAPH_UNAVAILABLE_ERROR_CODES", () => {
  it("is exactly the codes of the adapter's codegraph-unavailable classes", () => {
    expect(new Set(FAMILY.map((err) => err.code))).toEqual(CODEGRAPH_UNAVAILABLE_ERROR_CODES);
  });

  it.each(FAMILY.map((err) => [err.constructor.name, err] as const))(
    "%s satisfies the contract predicate",
    (_name, err) => {
      expect(isCodegraphUnavailableError(err)).toBe(true);
    },
  );

  it.each([
    ["close failed", new DuckDbCloseFailedError("/db")],
    ["request aborted", new CodegraphDaemonRequestAbortedError("op")],
    ["plain Error", new Error("x")],
    ["bare string", "INFRA_DUCKDB_OPEN_FAILED"],
  ])("%s is outside the family", (_name, err) => {
    expect(isCodegraphUnavailableError(err)).toBe(false);
  });
});
