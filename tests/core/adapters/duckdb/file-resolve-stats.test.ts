import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type {
  FileResolveStatsEntry,
  FileResolveStatsRow,
  ResolveRunStatsRow,
} from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

// bd tea-rags-mcp-xpmwg — resolve stats describe the CORPUS, not the last run's
// batch. Each resolved file owns its rows; `getRunStats` sums them per
// (language, receiver kind) for languages a whole-corpus run has covered, and
// keeps reading the legacy per-run table for every other language.

function kind(receiverKind: string, attempted: number, resolved: number): FileResolveStatsRow {
  return {
    receiverKind,
    attempted,
    resolved,
    externalSkipped: 0,
    unresolvable: 0,
    noInProjectDef: 0,
    coreAmbiguous: 0,
    ambiguousFanout: 0,
    unnarrowedTemplate: 0,
  };
}

function file(relPath: string, language: string, rows: FileResolveStatsRow[]): FileResolveStatsEntry {
  return { relPath, language, rows };
}

function legacy(language: string, receiverKind: string, attempted: number, resolved: number): ResolveRunStatsRow {
  return { language, ...kind(receiverKind, attempted, resolved) };
}

describe("DuckDbGraphClient — per-file resolve stats (xpmwg)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  const fileRows = async (relPath: string): Promise<{ receiver_kind: string; attempted: number; resolved: number }[]> =>
    (
      await db.queryAll<{ receiver_kind: string; attempted: number; resolved: number }>(
        "SELECT receiver_kind, attempted, resolved FROM cg_file_resolve_stats WHERE rel_path = ? ORDER BY receiver_kind",
        [relPath],
      )
    ).map((r) => ({ receiver_kind: r.receiver_kind, attempted: Number(r.attempted), resolved: Number(r.resolved) }));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-file-resolve-stats-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-resolving a file REPLACES its rows — a kind it no longer tallies disappears", async () => {
    await db.recordFileResolveStats({
      files: [file("src/a.ts", "typescript", [kind("constant", 5, 3), kind("dynamic", 2, 0)])],
      completeLanguages: [],
    });
    await db.recordFileResolveStats({
      files: [file("src/a.ts", "typescript", [kind("constant", 1, 1)])],
      completeLanguages: [],
    });

    expect(await fileRows("src/a.ts")).toEqual([{ receiver_kind: "constant", attempted: 1, resolved: 1 }]);
  });

  it("a resolved file with no call site clears its rows", async () => {
    await db.recordFileResolveStats({
      files: [file("src/a.ts", "typescript", [kind("constant", 5, 3)])],
      completeLanguages: [],
    });
    await db.recordFileResolveStats({ files: [file("src/a.ts", "typescript", [])], completeLanguages: [] });

    expect(await fileRows("src/a.ts")).toEqual([]);
  });

  it("a write names only its own files — every other file's rows survive", async () => {
    await db.recordFileResolveStats({
      files: [
        file("src/a.ts", "typescript", [kind("constant", 5, 3)]),
        file("src/b.ts", "typescript", [kind("constant", 7, 7)]),
      ],
      completeLanguages: ["typescript"],
    });
    await db.recordFileResolveStats({
      files: [file("src/a.ts", "typescript", [kind("constant", 4, 4)])],
      completeLanguages: [],
    });

    expect(await fileRows("src/b.ts")).toEqual([{ receiver_kind: "constant", attempted: 7, resolved: 7 }]);
    const ts = (await db.getRunStats()).filter((r) => r.language === "typescript");
    expect(ts).toEqual([legacy("typescript", "constant", 11, 11)]);
  });

  it("removeFile drops the file's rows from the aggregate", async () => {
    await db.recordFileResolveStats({
      files: [
        file("src/a.ts", "typescript", [kind("constant", 5, 3)]),
        file("src/b.ts", "typescript", [kind("constant", 7, 7)]),
      ],
      completeLanguages: ["typescript"],
    });

    await db.removeFile("src/a.ts");

    expect(await fileRows("src/a.ts")).toEqual([]);
    expect(await db.getRunStats()).toEqual([legacy("typescript", "constant", 7, 7)]);
  });

  it("a language no whole-corpus run has covered reads the legacy table, even with per-file rows present", async () => {
    // The pre-migration index: a full measurement in cg_run_stats, then one
    // small incremental that wrote a single file's tally.
    await db.recordRunStats([legacy("typescript", "bareCall", 175773, 122777)]);
    await db.recordFileResolveStats({
      files: [file("src/one.tsx", "typescript", [kind("bareCall", 3, 2)])],
      completeLanguages: [],
    });

    expect(await db.getRunStats()).toEqual([legacy("typescript", "bareCall", 175773, 122777)]);
  });

  it("a covered language reads the per-file aggregate while an uncovered one keeps its legacy rows, ordered by language then kind", async () => {
    await db.recordRunStats([legacy("typescript", "bareCall", 999, 1), legacy("ruby", "constant", 40, 30)]);
    await db.recordFileResolveStats({
      files: [
        file("src/a.ts", "typescript", [kind("bareCall", 5, 4), kind("constant", 2, 2)]),
        file("src/b.ts", "typescript", [kind("bareCall", 6, 1)]),
        file("app/x.rb", "ruby", [kind("constant", 1, 1)]),
      ],
      completeLanguages: ["typescript"],
    });

    expect(await db.getRunStats()).toEqual([
      legacy("ruby", "constant", 40, 30),
      legacy("typescript", "bareCall", 11, 5),
      legacy("typescript", "constant", 2, 2),
    ]);
  });

  it("sums every counter column, not just attempted/resolved", async () => {
    const full: FileResolveStatsRow = {
      receiverKind: "chain",
      attempted: 10,
      resolved: 2,
      externalSkipped: 1,
      unresolvable: 2,
      noInProjectDef: 3,
      coreAmbiguous: 1,
      ambiguousFanout: 1,
      unnarrowedTemplate: 1,
    };
    await db.recordFileResolveStats({
      files: [file("a.rb", "ruby", [full]), file("b.rb", "ruby", [full])],
      completeLanguages: ["ruby"],
    });

    expect(await db.getRunStats()).toEqual([
      {
        language: "ruby",
        receiverKind: "chain",
        attempted: 20,
        resolved: 4,
        externalSkipped: 2,
        unresolvable: 4,
        noInProjectDef: 6,
        coreAmbiguous: 2,
        ambiguousFanout: 2,
        unnarrowedTemplate: 2,
      },
    ]);
  });
});
