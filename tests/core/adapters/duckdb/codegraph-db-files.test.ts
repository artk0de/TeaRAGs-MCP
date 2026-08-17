import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodegraphDbFiles } from "../../../../src/core/adapters/duckdb/codegraph-db-files.js";

describe("CodegraphDbFiles", () => {
  let root: string;
  let codegraphDir: string;
  let files: CodegraphDbFiles;

  function seed(name: string, contents = "db"): void {
    writeFileSync(join(codegraphDir, `${name}.duckdb`), contents);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cg-files-"));
    codegraphDir = join(root, "codegraph");
    mkdirSync(codegraphDir, { recursive: true });
    files = new CodegraphDbFiles(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("constructing it does not create or wipe anything under the root", () => {
    const fresh = mkdtempSync(join(tmpdir(), "cg-untouched-"));
    try {
      const spill = join(fresh, "codegraph", ".spill");
      mkdirSync(spill, { recursive: true });
      writeFileSync(join(spill, "in-flight.ndjson"), "x");

      new CodegraphDbFiles(fresh);

      // A concurrent index owns that spill file — pool CONSTRUCTION wipes it,
      // which is exactly why the purge path may not construct a pool.
      expect(existsSync(join(spill, "in-flight.ndjson"))).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("lists the unversioned DB and every _vN generation, and nothing else", () => {
    seed("code_a");
    seed("code_a_v1");
    seed("code_a_v12");
    seed("code_ab_v1");
    seed("code_a_worktree_v1");
    writeFileSync(join(codegraphDir, "code_a_v1.duckdb.wal"), "wal");

    expect(files.listCollectionDbNames("code_a").sort()).toEqual(["code_a", "code_a_v1", "code_a_v12"]);
  });

  it("returns an empty list when the codegraph directory does not exist", () => {
    const missing = new CodegraphDbFiles(join(root, "nope"));
    expect(missing.listCollectionDbNames("code_a")).toEqual([]);
  });

  it("removes the DB and its WAL sidecar together", async () => {
    seed("code_a_v1");
    writeFileSync(join(codegraphDir, "code_a_v1.duckdb.wal"), "wal");

    await files.removeCollection("code_a_v1");

    expect(existsSync(join(codegraphDir, "code_a_v1.duckdb"))).toBe(false);
    expect(existsSync(join(codegraphDir, "code_a_v1.duckdb.wal"))).toBe(false);
  });

  it("is idempotent — removing an absent collection resolves", async () => {
    await expect(files.removeCollection("code_never")).resolves.not.toThrow();
  });

  it("copies the DB and its WAL sidecar on clone", async () => {
    seed("code_src", "payload");
    writeFileSync(join(codegraphDir, "code_src.duckdb.wal"), "walbytes");

    await files.cloneDatabase("code_src", "code_dst");

    expect(readFileSync(join(codegraphDir, "code_dst.duckdb"), "utf-8")).toBe("payload");
    expect(readFileSync(join(codegraphDir, "code_dst.duckdb.wal"), "utf-8")).toBe("walbytes");
  });

  it("drops a stale target WAL when the source has none", async () => {
    seed("code_src", "payload");
    seed("code_dst", "old");
    writeFileSync(join(codegraphDir, "code_dst.duckdb.wal"), "previous tenant");

    await files.cloneDatabase("code_src", "code_dst");

    expect(existsSync(join(codegraphDir, "code_dst.duckdb.wal"))).toBe(false);
  });

  it("clone is a no-op when the source DB is absent", async () => {
    await files.cloneDatabase("code_missing", "code_dst");
    expect(existsSync(join(codegraphDir, "code_dst.duckdb"))).toBe(false);
  });
});
