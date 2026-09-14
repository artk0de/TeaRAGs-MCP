/**
 * `SymbolDefinition.startLine` / `endLine` persistence in `cg_symbols`, and the
 * per-file bulk read the payload healer maps chunks to symbols with
 * (bd tea-rags-mcp-9i2ow).
 *
 * The healer runs outside any walk, so the walker's line index is gone by the
 * time it maps a stored chunk to the symbol that owns it. The ranges have to
 * survive the write/read round trip, a range that MOVED has to reach the row
 * even when nothing else about the definition changed, and a row that predates
 * the columns has to read back as "no range" rather than as a fabricated one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { SymbolDefinition } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function def(relPath: string, symbolId: string, startLine?: number, endLine?: number): SymbolDefinition {
  return {
    relPath,
    symbolId,
    fqName: symbolId,
    shortName: symbolId,
    scope: [],
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

describe("cg_symbols — line range round trip", () => {
  let dir: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-line-range-rt-"));
    client = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("per-file upsertSymbols persists the range and listAllSymbols reads it back", async () => {
    await client.upsertSymbols("a.ts", [def("a.ts", "outer", 240, 320), def("a.ts", "outer.walkScope", 257, 300)]);

    const hydrated = await client.listAllSymbols();
    expect(hydrated.find((d) => d.symbolId === "outer")).toMatchObject({ startLine: 240, endLine: 320 });
    expect(hydrated.find((d) => d.symbolId === "outer.walkScope")).toMatchObject({ startLine: 257, endLine: 300 });
  });

  it("bulk upsertSymbolsBulk writes the same rows as the per-file path", async () => {
    const refDir = mkdtempSync(join(tmpdir(), "cg-line-range-rt-ref-"));
    const ref = new DuckDbGraphClient({ path: join(refDir, "g.duckdb") });
    await ref.init();
    await runMigrations(ref, DATABASE_MIGRATIONS);
    try {
      await ref.upsertSymbols("a.ts", [def("a.ts", "A", 1, 9)]);
      await ref.upsertSymbols("b.ts", [def("b.ts", "B", 3, 4)]);
      await client.upsertSymbolsBulk([
        { relPath: "a.ts", definitions: [def("a.ts", "A", 1, 9)] },
        { relPath: "b.ts", definitions: [def("b.ts", "B", 3, 4)] },
      ]);

      const refRows = await ref.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
      const bulkRows = await client.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
      expect(bulkRows).toEqual(refRows);
      expect(bulkRows).toMatchObject([
        { symbol_id: "A", start_line: 1, end_line: 9 },
        { symbol_id: "B", start_line: 3, end_line: 4 },
      ]);
    } finally {
      await ref.close();
      rmSync(refDir, { recursive: true, force: true });
    }
  });

  it("a row with no range (pre-024, or a walker that tracked none) hydrates without one", async () => {
    await client.upsertSymbols("a.ts", [def("a.ts", "NoLines")]);
    await client.run(
      "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES (?, ?, ?, ?, ?)",
      ["legacy.ts", "Legacy", "Legacy", "Legacy", "[]"],
    );

    for (const hydrated of await client.listAllSymbols()) {
      expect(hydrated.startLine).toBeUndefined();
      expect(hydrated.endLine).toBeUndefined();
    }
  });

  it("counts a moved range as a row change, and keeps the chunk join across it", async () => {
    await client.upsertSymbols("a.ts", [def("a.ts", "A#run", 10, 20)]);
    await client.updateSymbolChunkIds("a.ts", new Map([["A#run", "chunk-a"]]));

    // Two lines inserted above the method: the definition is otherwise
    // identical, so a value diff blind to the range would leave 10-20 on disk.
    await client.upsertSymbols("a.ts", [def("a.ts", "A#run", 12, 22)]);

    expect((await client.listAllSymbols())[0]).toMatchObject({ startLine: 12, endLine: 22 });
    expect(await client.queryAll("SELECT chunk_id FROM cg_symbols WHERE symbol_id = 'A#run'")).toEqual([
      { chunk_id: "chunk-a" },
    ]);
  });

  describe("getSymbolLineRangesBulk", () => {
    it("answers every ranged symbol of each requested file, and nothing else", async () => {
      await client.upsertSymbolsBulk([
        {
          relPath: "walker.ts",
          definitions: [
            def("walker.ts", "collectPythonInheritanceEdges", 240, 320),
            def("walker.ts", "collectPythonInheritanceEdges.walkScope", 257, 300),
            def("walker.ts", "unranged"),
          ],
        },
        { relPath: "other.ts", definitions: [def("other.ts", "Other", 1, 5)] },
        { relPath: "not-asked.ts", definitions: [def("not-asked.ts", "Hidden", 1, 5)] },
      ]);

      const ranges = await client.getSymbolLineRangesBulk(["walker.ts", "other.ts", "absent.ts"]);

      expect([...ranges.keys()].sort()).toEqual(["other.ts", "walker.ts"]);
      expect(ranges.get("walker.ts")?.sort((a, b) => a.startLine - b.startLine)).toEqual([
        { symbolId: "collectPythonInheritanceEdges", startLine: 240, endLine: 320 },
        { symbolId: "collectPythonInheritanceEdges.walkScope", startLine: 257, endLine: 300 },
      ]);
      expect(ranges.get("other.ts")).toEqual([{ symbolId: "Other", startLine: 1, endLine: 5 }]);
    });

    it("is a no-op returning an empty map for no paths", async () => {
      expect(await client.getSymbolLineRangesBulk([])).toEqual(new Map());
    });

    it("reads paths past one IN-list chunk without dropping any", async () => {
      const files = Array.from({ length: 450 }, (_, i) => `f${i}.ts`);
      await client.upsertSymbolsBulk(files.map((f) => ({ relPath: f, definitions: [def(f, `S${f}`, 1, 2)] })));

      const ranges = await client.getSymbolLineRangesBulk(files);

      expect(ranges.size).toBe(450);
    });
  });
});
