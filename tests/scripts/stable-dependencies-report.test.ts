import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertNotLiveCodegraphDatabase,
  collectStableDependencies,
  parseArgs,
  renderStableDependenciesReport,
} from "../../scripts/stable-dependencies-report.js";
import { DuckDbGraphClient } from "../../src/core/adapters/duckdb/client.js";
import type { RelPath } from "../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../src/core/domains/maintenance/migration/database/runner.js";

describe("parseArgs", () => {
  it("requires --db and defaults the rest to the detector's own defaults", () => {
    expect(parseArgs(["--db", "/tmp/copy.duckdb"])).toEqual({ dbPath: "/tmp/copy.duckdb", top: 20 });
    expect(() => parseArgs([])).toThrow(/--db/);
  });

  it("parses the detector knobs and the output options", () => {
    expect(
      parseArgs([
        "--db",
        "g.duckdb",
        "--tolerance",
        "0.3",
        "--min-connection-count",
        "8",
        "--top",
        "5",
        "--json",
        "out.json",
      ]),
    ).toEqual({ dbPath: "g.duckdb", tolerance: 0.3, minConnectionCount: 8, top: 5, jsonOut: "out.json" });
  });

  it("rejects values the detector cannot interpret", () => {
    expect(() => parseArgs(["--db", "g", "--tolerance", "1"])).toThrow(/--tolerance/);
    expect(() => parseArgs(["--db", "g", "--tolerance", "abc"])).toThrow(/--tolerance/);
    expect(() => parseArgs(["--db", "g", "--min-connection-count", "-1"])).toThrow(/--min-connection-count/);
    expect(() => parseArgs(["--db", "g", "--top", "0"])).toThrow(/--top/);
    expect(() => parseArgs(["--db", "g", "--frobnicate"])).toThrow(/--frobnicate/);
  });
});

describe("assertNotLiveCodegraphDatabase", () => {
  it("refuses a graph file the running tea-rags owns, and accepts a copy elsewhere", () => {
    const check = (dbPath: string) => () => {
      assertNotLiveCodegraphDatabase(dbPath, "/data/.tea-rags");
    };
    expect(check("/data/.tea-rags/codegraph/code_x_v3.duckdb")).toThrow(/copy/i);
    expect(check("/data/.tea-rags/codegraph/../codegraph/code_x_v3.duckdb")).toThrow(/copy/i);
    expect(check("/tmp/sdp/code_x_v3.duckdb")).not.toThrow();
  });
});

describe("collectStableDependencies + renderStableDependenciesReport", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sdp-report-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A copy-shaped fixture: written, closed, then read by the script READ_ONLY. */
  async function writeFixture(path: string): Promise<void> {
    const db = new DuckDbGraphClient({ path });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    // Every file defines one symbol: a symbol-less, call-less file is a
    // pass-through the detector deliberately never judges.
    const importsFrom = async (source: RelPath, targets: RelPath[]): Promise<void> => {
      await db.upsertFile(
        { relPath: source, language: "typescript" },
        { fileEdges: targets.map((t) => ({ targetRelPath: t, importText: t })), methodEdges: [] },
      );
      await db.upsertSymbols(source, [
        { symbolId: source, fqName: source, shortName: source, relPath: source, scope: [] },
      ]);
    };
    // core/stable.ts: 5 importers, 1 import → I = 1/6 ; lib/volatile.ts: 1 importer, 4 imports → I = 4/5
    for (let i = 1; i <= 5; i++) await importsFrom(`app/user${i}.ts`, ["core/stable.ts"]);
    await importsFrom("core/stable.ts", ["lib/volatile.ts"]);
    await importsFrom("lib/volatile.ts", ["vendor/a.ts", "vendor/b.ts", "vendor/c.ts", "vendor/d.ts"]);
    for (const leaf of ["vendor/a.ts", "vendor/b.ts", "vendor/c.ts", "vendor/d.ts"]) await importsFrom(leaf, []);
    await db.close();
  }

  it("reads a closed graph file read-only and renders both instabilities, the delta and the edge weight", async () => {
    const dbPath = join(dir, "copy.duckdb");
    await writeFixture(dbPath);

    const { graph, report } = await collectStableDependencies(dbPath, {});
    const text = renderStableDependenciesReport(report, graph, 20);

    expect(report.violations.map((v) => `${v.sourceRelPath} -> ${v.targetRelPath}`)).toEqual([
      "core/stable.ts -> lib/volatile.ts",
    ]);
    expect(text).toContain("core/stable.ts -> lib/volatile.ts");
    expect(text).toContain("0.167");
    expect(text).toContain("0.800");
    expect(text).toContain("0.633");
    expect(text).toMatch(/violations\s+1/);
    expect(text).toMatch(/disjoint\s+1/);
  });
});
