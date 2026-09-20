/**
 * Atomic clone publish for `CodegraphDbFiles#cloneDatabase` (bd tea-rags-mcp-i5kiu).
 *
 * A kill during a clone must never leave a partial or WAL-less DuckDB behind a
 * visible clone path: every interrupt point leaves the target either absent
 * ("not cloned" — the next run re-clones) or complete. The interruption is
 * simulated by failing `node:fs/promises` copies/renames at a chosen call;
 * the on-disk state after such a failure is the state a SIGKILL at that same
 * instant would leave behind.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as fsPromisesTypes from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodegraphDbFiles } from "../../../../src/core/adapters/duckdb/codegraph-db-files.js";

/**
 * Kill-simulation failpoints. `copyFile` call N (1-based): every earlier call
 * passes through, call N writes `copyFilePartialBytes` of the source when set
 * and then dies. `rename` call N: every earlier rename passes through, rename
 * N dies before moving anything.
 */
const failpoints = vi.hoisted(() => ({
  copyFileFailOnCall: null as number | null,
  copyFilePartialBytes: null as number | null,
  renameFailOnCall: null as number | null,
  copyFileCalls: 0,
  renameCalls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromisesTypes>();
  const fsSync = await import("node:fs");
  return {
    ...actual,
    copyFile: async (src: Parameters<typeof actual.copyFile>[0], dest: Parameters<typeof actual.copyFile>[1]) => {
      failpoints.copyFileCalls += 1;
      if (failpoints.copyFileFailOnCall === failpoints.copyFileCalls) {
        if (failpoints.copyFilePartialBytes !== null) {
          const bytes = fsSync.readFileSync(src);
          fsSync.writeFileSync(dest, bytes.subarray(0, failpoints.copyFilePartialBytes));
        }
        throw new Error(
          `simulated SIGKILL during copyFile #${failpoints.copyFileCalls} (${String(src)} -> ${String(dest)})`,
        );
      }
      return actual.copyFile(src, dest);
    },
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      failpoints.renameCalls += 1;
      if (failpoints.renameFailOnCall === failpoints.renameCalls) {
        throw new Error(
          `simulated SIGKILL before rename #${failpoints.renameCalls} (${String(from)} -> ${String(to)})`,
        );
      }
      return actual.rename(from, to);
    },
  };
});

describe("CodegraphDbFiles — clone publish is atomic (i5kiu)", () => {
  let root: string;
  let codegraphDir: string;
  let files: CodegraphDbFiles;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cg-files-atomic-"));
    codegraphDir = join(root, "codegraph");
    mkdirSync(codegraphDir, { recursive: true });
    files = new CodegraphDbFiles(root);
    failpoints.copyFileFailOnCall = null;
    failpoints.copyFilePartialBytes = null;
    failpoints.renameFailOnCall = null;
    failpoints.copyFileCalls = 0;
    failpoints.renameCalls = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(name: string, contents: string): void {
    writeFileSync(join(codegraphDir, `${name}.duckdb`), contents);
  }

  const targetDb = (): string => join(codegraphDir, "code_dst.duckdb");
  const targetWal = (): string => join(codegraphDir, "code_dst.duckdb.wal");

  it("a kill mid-copy of the database leaves no partial file at the clone path", async () => {
    seed("code_src", "payload-payload-payload");
    writeFileSync(join(codegraphDir, "code_src.duckdb.wal"), "walbytes");
    failpoints.copyFileFailOnCall = 1;
    failpoints.copyFilePartialBytes = 3;

    await expect(files.cloneDatabase("code_src", "code_dst")).rejects.toThrow(/simulated SIGKILL/);

    expect(existsSync(targetDb())).toBe(false);
    expect(existsSync(targetWal())).toBe(false);
    expect(files.has("code_dst")).toBe(false);
  });

  it("a kill after the database copy but before the WAL copy does not publish a WAL-less clone", async () => {
    seed("code_src", "payload");
    writeFileSync(join(codegraphDir, "code_src.duckdb.wal"), "walbytes");
    failpoints.copyFileFailOnCall = 2;

    await expect(files.cloneDatabase("code_src", "code_dst")).rejects.toThrow(/simulated SIGKILL/);

    expect(existsSync(targetDb())).toBe(false);
    expect(files.has("code_dst")).toBe(false);
  });

  it("a kill between the two publish renames leaves the target not-cloned, not half-published", async () => {
    seed("code_src", "payload");
    writeFileSync(join(codegraphDir, "code_src.duckdb.wal"), "walbytes");
    // Rename #1 (the WAL) lands, rename #2 (the database) never happens — the
    // only honest mid-publish state.
    failpoints.renameFailOnCall = 2;

    await expect(files.cloneDatabase("code_src", "code_dst")).rejects.toThrow(/simulated SIGKILL/);

    // The database is renamed into place LAST: an interruption mid-publish may
    // leave an orphaned WAL (discardOrphanedWal territory) but must never leave
    // a database file that merely LOOKS complete without its log.
    expect(existsSync(targetDb())).toBe(false);
    expect(files.has("code_dst")).toBe(false);
  });

  it("resume: staging leftovers of an interrupted clone are cleaned and the next clone is complete", async () => {
    seed("code_src", "payload");
    writeFileSync(join(codegraphDir, "code_src.duckdb.wal"), "walbytes");
    // What a SIGKILL mid-clone leaves behind: staging copies, nothing published.
    writeFileSync(join(codegraphDir, "code_dst.duckdb.clone-tmp"), "half-written");
    writeFileSync(join(codegraphDir, "code_dst.duckdb.clone-tmp.wal"), "half-written");

    await files.cloneDatabase("code_src", "code_dst");

    expect(readFileSync(targetDb(), "utf-8")).toBe("payload");
    expect(readFileSync(targetWal(), "utf-8")).toBe("walbytes");
    expect(existsSync(join(codegraphDir, "code_dst.duckdb.clone-tmp"))).toBe(false);
    expect(existsSync(join(codegraphDir, "code_dst.duckdb.clone-tmp.wal"))).toBe(false);
    expect(files.has("code_dst")).toBe(true);
    // Staging names never match the anchored `<base>(_vN)?.duckdb` pattern, so
    // the orphan sweep must not see the target twice.
    expect(files.listCollectionDbNames("code_dst")).toHaveLength(1);
  });
});
