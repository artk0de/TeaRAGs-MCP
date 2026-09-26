/**
 * `DuckDbGraphSession#applyScopedRowDiff` — the insert / update / delete diff a
 * scoped rewrite applies instead of a delete-all-then-insert (bd
 * tea-rags-mcp-4p3sb): unchanged rows are never rewritten, rows gone from the
 * scope are deleted and returned, and value columns of a composite type (a
 * LIST) compare by content, not by object identity.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphSession } from "../../../../src/core/adapters/duckdb/graph-session.js";

let dir: string;
let session: DuckDbGraphSession;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "graph-session-row-diff-"));
  session = new DuckDbGraphSession({ path: join(dir, "g.duckdb") });
  await session.open();
  await session.exec(
    "CREATE TABLE t (file VARCHAR NOT NULL, name VARCHAR NOT NULL, tags VARCHAR[], PRIMARY KEY (file, name))",
  );
});

afterEach(async () => {
  await session.close();
  rmSync(dir, { recursive: true, force: true });
});

async function rowsOf(file: string): Promise<{ name: string; tags: string[] | null }[]> {
  const rows = await session.queryAll<{ name: string; tags: string[] | null }>(
    "SELECT name, tags FROM t WHERE file = ? ORDER BY name",
    [file],
  );
  return rows.map((r) => ({ name: r.name, tags: r.tags === null ? null : [...r.tags] }));
}

describe("DuckDbGraphSession#applyScopedRowDiff", () => {
  it("inserts new keys, updates a stored LIST that changed, deletes keys gone from the scope and returns them", async () => {
    await session.run(
      "INSERT INTO t VALUES ('a.rb', 'keep', NULL), ('a.rb', 'change', ['x']), ('a.rb', 'drop', ['d'])",
    );
    await session.run("INSERT INTO t VALUES ('b.rb', 'other', ['y'])");

    const deleted = await session.applyScopedRowDiff(
      "t",
      "file",
      ["a.rb"],
      ["file", "name"],
      ["tags"],
      [
        ["a.rb", "keep", null],
        // The driver hands the stored LIST back as an array: it must fingerprint
        // by content, so a NULL incoming value reads as a change.
        ["a.rb", "change", null],
        ["a.rb", "new", null],
        ["a.rb", "new", "duplicate key — the first row wins"],
      ],
    );

    expect(deleted).toEqual([["a.rb", "drop"]]);
    expect(await rowsOf("a.rb")).toEqual([
      { name: "change", tags: null },
      { name: "keep", tags: null },
      { name: "new", tags: null },
    ]);
    // Rows outside the scope are never touched.
    expect(await rowsOf("b.rb")).toEqual([{ name: "other", tags: ["y"] }]);
  });

  it("an empty scope reads and writes nothing", async () => {
    await session.run("INSERT INTO t VALUES ('a.rb', 'keep', ['x'])");
    expect(
      await session.applyScopedRowDiff("t", "file", [], ["file", "name"], ["tags"], [["a.rb", "x", null]]),
    ).toEqual([]);
    expect(await rowsOf("a.rb")).toEqual([{ name: "keep", tags: ["x"] }]);
  });

  it("clearColumnByScopeValuesBatched clears the column in scope only, and an empty scope is a no-op", async () => {
    await session.run("INSERT INTO t VALUES ('a.rb', 'n', ['x']), ('b.rb', 'm', ['y'])");
    await session.clearColumnByScopeValuesBatched("t", "tags", "file", []);
    await session.clearColumnByScopeValuesBatched("t", "tags", "file", ["a.rb"]);
    expect(await rowsOf("a.rb")).toEqual([{ name: "n", tags: null }]);
    expect(await rowsOf("b.rb")).toEqual([{ name: "m", tags: ["y"] }]);
  });
});
