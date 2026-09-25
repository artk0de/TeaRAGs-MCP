import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertNotLiveCodegraphDatabase,
  buildStableDependenciesJson,
  collectStableDependencies,
  parseArgs,
  renderStableDependenciesReport,
} from "../../scripts/stable-dependencies-report.js";
import { DuckDbGraphClient } from "../../src/core/adapters/duckdb/client.js";
import type {
  FileDependencyGraph,
  FileDependencyGraphFile,
  RelPath,
} from "../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../src/core/domains/maintenance/migration/database/runner.js";
import { detectStableDependencyViolations } from "../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

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
    // no-symbol endpoint the detector deliberately never judges.
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

    // The fixture's volatile file has stable.ts as its only importer, which the
    // private-collaborator rule (bd tea-rags-mcp-er6mu) excludes by default; this
    // test pins reading and rendering, so it opts back in.
    const { graph, report } = await collectStableDependencies(dbPath, { judgePrivateCollaborators: true });
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

/**
 * The no-symbol exclusion (bd tea-rags-mcp-thc7s) catches barrels, type-only
 * modules and object-literal modules alike — on the self-index 276 of 1102
 * files and 891 of 2314 edges. The report says what the rule is and which files
 * it took out, so the SDP premise review can judge the rule, not just a count.
 */
describe("the no-symbol exclusion in the report", () => {
  function file(relPath: string, symbolCount = 1): FileDependencyGraphFile {
    return { relPath, language: "typescript", symbolCount };
  }

  /** Two no-symbol files: `lib/types.ts` excludes 3 edges, `lib/index.ts` 2. */
  function graph(): FileDependencyGraph {
    return {
      files: [file("lib/index.ts", 0), file("lib/types.ts", 0), file("lib/impl.ts"), file("a.ts"), file("b.ts")],
      edges: [
        { sourceRelPath: "lib/index.ts", targetRelPath: "lib/impl.ts", callWeight: 0 },
        { sourceRelPath: "a.ts", targetRelPath: "lib/index.ts", callWeight: 0 },
        { sourceRelPath: "a.ts", targetRelPath: "lib/types.ts", callWeight: 0 },
        { sourceRelPath: "b.ts", targetRelPath: "lib/types.ts", callWeight: 0 },
        { sourceRelPath: "lib/impl.ts", targetRelPath: "lib/types.ts", callWeight: 0 },
      ],
    };
  }

  it("prints the reason as what it is, the excluded-file count and the top files by edges excluded", () => {
    const g = graph();
    const text = renderStableDependenciesReport(detectStableDependencyViolations(g), g, 1);

    expect(text).not.toMatch(/pass-through/);
    expect(text).toMatch(/no-symbol endpoint\s+5/);
    expect(text).toContain("no-symbol endpoint: barrel, type-only or object-literal module");
    expect(text).toMatch(/files excluded\s+2/);
    expect(text).toMatch(/3\s+lib\/types\.ts/);
    // --top 1: the sample stops at the file that excluded the most.
    expect(text).not.toMatch(/2\s+lib\/index\.ts/);
  });

  it("carries the same count and sample in the --json document", () => {
    const g = graph();
    const json = buildStableDependenciesJson(detectStableDependencyViolations(g), g, "/tmp/copy.duckdb", 1);

    expect(json.summary.excluded.noSymbolEndpoints).toBe(5);
    expect(json.noSymbolEndpointFiles).toEqual({
      reason: "no-symbol endpoint: barrel, type-only or object-literal module",
      count: 2,
      sample: [{ relPath: "lib/types.ts", excludedEdgeCount: 3 }],
    });
  });
});

// bd tea-rags-mcp-er6mu: the private-collaborator exclusion and the root-cause
// grouping, as the report prints them.
describe("private collaborators and root causes in the report", () => {
  function file(relPath: string): FileDependencyGraphFile {
    return { relPath, language: "typescript", symbolCount: 1 };
  }

  /**
   * `hub.ts` imported by `s1.ts`, `s2.ts` (each with 5 importers of its own),
   * importing `s1.ts` back plus 4 leaves; `s1.ts` also imports `private.ts`,
   * which nothing else imports and which imports 4 leaves.
   */
  function graph(): FileDependencyGraph {
    const files = [file("hub.ts"), file("s1.ts"), file("s2.ts"), file("private.ts")];
    const edges: FileDependencyGraph["edges"] = [];
    const add = (sourceRelPath: string, targetRelPath: string) => {
      edges.push({ sourceRelPath, targetRelPath, callWeight: 1 });
    };
    for (const s of ["s1.ts", "s2.ts"]) {
      add(s, "hub.ts");
      for (let i = 1; i <= 5; i++) {
        files.push(file(`${s}-in${i}.ts`));
        add(`${s}-in${i}.ts`, s);
      }
    }
    add("hub.ts", "s1.ts");
    add("s1.ts", "private.ts");
    for (let i = 1; i <= 4; i++) {
      files.push(file(`hub-leaf${i}.ts`), file(`private-leaf${i}.ts`));
      add("hub.ts", `hub-leaf${i}.ts`);
      add("private.ts", `private-leaf${i}.ts`);
    }
    return { files, edges };
  }

  it("prints the private-collaborator count with its reason and a top root causes section", () => {
    const g = graph();
    const text = renderStableDependenciesReport(detectStableDependencyViolations(g), g, 20);

    expect(text).toMatch(/private collaborator\s+1/);
    expect(text).toContain("private collaborator: source is the target's sole importer");
    expect(text).toContain("top 20 root causes");
    expect(text).toMatch(/2\s+.*hub\.ts.*cycle/);
    expect(text).not.toMatch(/-> private\.ts/);
  });

  it("carries the root causes in the --json document", () => {
    const g = graph();
    const json = buildStableDependenciesJson(detectStableDependencyViolations(g), g, "/tmp/copy.duckdb", 20);

    expect(json.summary.excluded.privateCollaborators).toBe(1);
    expect(json.rootCauses.map((r) => [r.targetRelPath, r.violationCount, r.cycleWithDependents])).toEqual([
      ["hub.ts", 2, true],
    ]);
  });

  it("parses --judge-private-collaborators, to measure the report without the exclusion", () => {
    expect(parseArgs(["--db", "g.duckdb", "--judge-private-collaborators"])).toEqual({
      dbPath: "g.duckdb",
      top: 20,
      judgePrivateCollaborators: true,
    });
  });
});
