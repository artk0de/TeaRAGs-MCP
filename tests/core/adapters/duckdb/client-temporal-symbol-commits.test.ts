/**
 * The temporal symbol-commit store (bd tea-rags-mcp-3gz4f): per-file replace,
 * the stored-file universe the hook prunes against, and the read-side slice.
 *
 * Invariants under test:
 *   - `replaceSymbolCommits` replaces ONLY the files named — an incremental
 *     flush leaves every other file's rows standing;
 *   - a file re-flushed with fewer symbols loses its old rows (replace, not
 *     union — a previous content version's commits do not linger);
 *   - `readTemporalSymbolCommits` returns the file's rows shas-parsed;
 *   - `deleteTemporalSymbolCommitFiles` drops exactly the named files.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { TemporalSymbolCommitFileSnapshot } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function file(relPath: string, symbols: [string, string[]][]): TemporalSymbolCommitFileSnapshot {
  return { relPath, symbols: symbols.map(([symbolId, commitShas]) => ({ symbolId, commitShas })) };
}

describe("DuckDbGraphClient — temporal symbol-commit store (bd tea-rags-mcp-3gz4f)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-symbol-commits-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaces only the named files and re-flush loses stale symbols", async () => {
    await db.replaceTemporalSymbolCommits([
      file("src/a.ts", [
        ["A#one", ["s1", "s2"]],
        ["A#two", ["s2"]],
      ]),
      file("src/b.ts", [["B#run", ["s3"]]]),
    ]);

    // Incremental: re-flush a.ts with one symbol fewer — b.ts untouched.
    await db.replaceTemporalSymbolCommits([file("src/a.ts", [["A#one", ["s1", "s2", "s9"]]])]);

    const a = await db.readTemporalSymbolCommits("src/a.ts");
    expect(a.symbols).toEqual([{ symbolId: "A#one", commitShas: ["s1", "s2", "s9"] }]);
    const b = await db.readTemporalSymbolCommits("src/b.ts");
    expect(b.symbols).toEqual([{ symbolId: "B#run", commitShas: ["s3"] }]);
  });

  it("lists stored files and deletes exactly the named ones", async () => {
    await db.replaceTemporalSymbolCommits([
      file("src/a.ts", [["A#one", ["s1"]]]),
      file("src/b.ts", [["B#run", ["s3"]]]),
      file("gone/deleted.ts", [["G#x", ["s4"]]]),
    ]);
    expect(await db.storedTemporalSymbolCommitFilePaths()).toEqual(["gone/deleted.ts", "src/a.ts", "src/b.ts"]);

    await db.deleteTemporalSymbolCommitFiles(["gone/deleted.ts"]);

    expect(await db.storedTemporalSymbolCommitFilePaths()).toEqual(["src/a.ts", "src/b.ts"]);
    expect((await db.readTemporalSymbolCommits("gone/deleted.ts")).symbols).toEqual([]);
  });

  it("is a no-op on empty batches", async () => {
    await db.replaceTemporalSymbolCommits([]);
    await db.deleteTemporalSymbolCommitFiles([]);
    expect(await db.storedTemporalSymbolCommitFilePaths()).toEqual([]);
  });
});
