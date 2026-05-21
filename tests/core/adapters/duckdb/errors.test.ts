/**
 * Tests for typed DuckDB adapter errors. These wrap the raw driver
 * failures so the pool / codegraph trajectory can catch InfraError
 * instances without leaking driver internals — see typed-errors rule.
 */

import { describe, expect, it } from "vitest";

import { DuckDbCloseFailedError, DuckDbOpenFailedError } from "../../../../src/core/adapters/duckdb/errors.js";
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
