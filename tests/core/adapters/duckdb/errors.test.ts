/**
 * Tests for typed DuckDB adapter errors. These wrap the raw driver
 * failures so the pool / codegraph trajectory can catch InfraError
 * instances without leaking driver internals — see typed-errors rule.
 */

import { describe, expect, it } from "vitest";

import {
  CodegraphDatabaseHeldByForeignDaemonError,
  daemonErrorFromWire,
  daemonErrorToWire,
  DuckDbCloseFailedError,
  DuckDbOpenFailedError,
  isCodegraphUnavailableError,
} from "../../../../src/core/adapters/duckdb/errors.js";
import { InfraError } from "../../../../src/core/adapters/errors.js";

describe("DuckDbOpenFailedError", () => {
  it("embeds the dbPath in the message and exposes the underlying cause", () => {
    const cause = new Error("lock held by pid 1234");
    const err = new DuckDbOpenFailedError("/tmp/codegraph_abc.duckdb", cause);
    expect(err).toBeInstanceOf(InfraError);
    expect(err.code).toBe("INFRA_DUCKDB_OPEN_FAILED");
    expect(err.message).toContain("/tmp/codegraph_abc.duckdb");
    expect(err.cause).toBe(cause);
    expect(err.httpStatus).toBe(503);
  });

  it("works without a cause (cold-start path)", () => {
    const err = new DuckDbOpenFailedError("/tmp/x.duckdb");
    expect(err.message).toContain("/tmp/x.duckdb");
    expect(err.cause).toBeUndefined();
    expect(err.toUserMessage()).toContain("single-writer");
  });

  it("marks a lost file lock as lock contention and a non-database file as not (zgg62)", () => {
    const lock = new DuckDbOpenFailedError(
      "/tmp/a.duckdb",
      new Error('IO Error: Could not set lock on file "/tmp/a.duckdb": Conflicting lock is held in node (PID 1)'),
    );
    const junk = new DuckDbOpenFailedError(
      "/tmp/b.duckdb",
      new Error('IO Error: The file "/tmp/b.duckdb" exists, but it is not a valid DuckDB database file!'),
    );
    expect(lock.lockContention).toBe(true);
    expect(lock.toUserMessage()).toContain("single-writer");
    expect(junk.lockContention).toBe(false);
    expect(junk.toUserMessage()).toContain("not a DuckDB database");
  });

  it("survives the daemon wire as the same typed error (zgg62)", () => {
    const original = new DuckDbOpenFailedError(
      "/tmp/b.duckdb",
      new Error('IO Error: The file "/tmp/b.duckdb" exists, but it is not a valid DuckDB database file!'),
    );
    const rebuilt = daemonErrorFromWire(JSON.parse(JSON.stringify(daemonErrorToWire(original))));
    expect(rebuilt).toBeInstanceOf(DuckDbOpenFailedError);
    expect((rebuilt as DuckDbOpenFailedError).code).toBe("INFRA_DUCKDB_OPEN_FAILED");
    expect((rebuilt as DuckDbOpenFailedError).lockContention).toBe(false);
    expect(rebuilt.message).toBe(original.message);

    const other = daemonErrorFromWire(daemonErrorToWire(Object.assign(new Error("boom"), { name: "SomeError" })));
    expect(other).not.toBeInstanceOf(DuckDbOpenFailedError);
    expect(other.name).toBe("SomeError");
    expect(other.message).toBe("boom");
  });
});

describe("DuckDbCloseFailedError", () => {
  it("embeds the dbPath and cause, 500 status (distinct from open)", () => {
    const cause = new Error("hung connection");
    const err = new DuckDbCloseFailedError("/tmp/codegraph_def.duckdb", cause);
    expect(err).toBeInstanceOf(InfraError);
    expect(err.code).toBe("INFRA_DUCKDB_CLOSE_FAILED");
    expect(err.message).toContain("/tmp/codegraph_def.duckdb");
    expect(err.cause).toBe(cause);
    expect(err.httpStatus).toBe(500);
  });

  it("works without a cause", () => {
    const err = new DuckDbCloseFailedError("/tmp/y.duckdb");
    expect(err.cause).toBeUndefined();
    expect(err.toUserMessage()).toContain("driver rejected");
  });
});

describe("the lock holder of a lost DuckDB open (hw27k)", () => {
  const LOCK_MESSAGE =
    'IO Error: Could not set lock on file "/tmp/a.duckdb": Conflicting lock is held in ' +
    "/usr/local/bin/node (PID 50906) by user me. See also https://duckdb.org/docs/stable/connect/concurrency";

  it("reads the holder's pid out of the driver's message, and none from any other failure", () => {
    expect(new DuckDbOpenFailedError("/tmp/a.duckdb", new Error(LOCK_MESSAGE)).lockHolderPid).toBe(50906);
    expect(
      new DuckDbOpenFailedError("/tmp/a.duckdb", new Error("not a valid DuckDB database")).lockHolderPid,
    ).toBeUndefined();
    expect(new DuckDbOpenFailedError("/tmp/a.duckdb").lockHolderPid).toBeUndefined();
  });

  it("names another build's daemon, and survives the daemon wire as the same class", () => {
    const original = new CodegraphDatabaseHeldByForeignDaemonError(
      "/tmp/a.duckdb",
      { pid: 50906, buildDir: "/d/b-0123abcd", buildFingerprint: "/other/checkout/build/x|1.0.0|42" },
      new Error(LOCK_MESSAGE),
    );
    expect(original.code).toBe("INFRA_CODEGRAPH_DB_HELD_BY_FOREIGN_DAEMON");
    expect(original.message).toContain("pid 50906");
    expect(original.message).toContain("/other/checkout/build/x");
    expect(isCodegraphUnavailableError(original)).toBe(true);

    const rebuilt = daemonErrorFromWire(JSON.parse(JSON.stringify(daemonErrorToWire(original))));
    expect(rebuilt).toBeInstanceOf(CodegraphDatabaseHeldByForeignDaemonError);
    expect((rebuilt as CodegraphDatabaseHeldByForeignDaemonError).holderPid).toBe(50906);
    expect(rebuilt.message).toBe(original.message);
  });

  it("falls back to the build-key directory when the holder's fingerprint is unknown", () => {
    const err = new CodegraphDatabaseHeldByForeignDaemonError("/tmp/a.duckdb", {
      pid: 7,
      buildDir: "/d/b-0123abcd",
      buildFingerprint: undefined,
    });
    expect(err.message).toContain("/d/b-0123abcd");
  });
});
