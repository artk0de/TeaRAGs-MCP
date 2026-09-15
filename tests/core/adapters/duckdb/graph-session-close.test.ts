/**
 * Closing a codegraph DuckDB client releases the native database (bd tea-rags-mcp-amh78).
 *
 * `close()` used to drop its references and leave the instance to the garbage
 * collector, which closes it — checkpoint, WAL deletion by path and file lock
 * release included — at a moment nobody chooses. The pool's replacement of a
 * stale client depends on that close having finished before the path is opened
 * again, so close has to be real; and a real close issued under a running query
 * leaves that query's promise unsettled forever, so it drains first.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "graph-session-close-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Count rows of `t` from a separate node process — it needs the file lock for itself. */
function countRowsFromAnotherProcess(path: string): string {
  const script = [
    'import { DuckDBInstance } from "@duckdb/node-api";',
    `const instance = await DuckDBInstance.create(${JSON.stringify(path)});`,
    "const conn = await instance.connect();",
    'const reader = await conn.runAndReadAll("SELECT count(*)::INTEGER AS n FROM t");',
    "process.stdout.write(String(reader.getRowObjects()[0].n));",
    "conn.closeSync();",
    "instance.closeSync();",
  ].join("\n");
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("DuckDbGraphClient#close (amh78)", () => {
  it("releases the database file, so another process can open it read-write straight away", async () => {
    const path = join(tmp, "released.duckdb");
    const client = new DuckDbGraphClient({ path });
    await client.init();
    await client.exec("CREATE TABLE t(x INTEGER)");
    await client.exec("INSERT INTO t VALUES (1), (2)");

    await client.close();

    expect(countRowsFromAnotherProcess(path)).toBe("2");
  });

  it("lets a query already running finish instead of leaving it unsettled", async () => {
    const client = new DuckDbGraphClient({ path: join(tmp, "in-flight.duckdb") });
    await client.init();
    const running = client
      .queryAll<{ s: number }>("SELECT sum(a.range * b.range)::DOUBLE AS s FROM range(20000) a, range(20000) b")
      .then(
        (rows) => `settled with ${rows.length} row`,
        (err: unknown) => `settled with error ${String(err)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 30));

    await client.close();
    const outcome = await Promise.race([
      running,
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve("never settled");
        }, 10_000);
      }),
    ]);

    expect(outcome).toBe("settled with 1 row");
  }, 20_000);
});
