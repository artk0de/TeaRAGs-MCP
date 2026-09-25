/**
 * `getChunkSignalsBulk` keys on `(relPath, symbolId)`, never on the bare
 * symbolId (bd tea-rags-mcp-xtdkq).
 *
 * A `SymbolId` is unique per FILE, not per repository: every top-level `main`
 * in a repo carries the same unqualified id. Grouping the method edge table by
 * `source_symbol_id` / `target_symbol_id` alone therefore merged every namesake
 * into ONE node, and the deferred chunk pass wrote that union onto every one of
 * them — measured on this repo's own index, three unrelated `main` functions
 * carried an identical `codegraph.chunk.fanOut = 543`, the union of every
 * namesake's callees, scripts included. 543 belongs to none of them, and the
 * `god-method` label threshold is 67.
 *
 * Same defect class as `n9bmd` (cg_ambiguous_fanout PK lacking source_rel_path)
 * and migration 020 (cg_symbols_edges_method PK). The fix follows the prior art
 * `DuckDbMethodEdgeReader#getCalleeEdgesScoped` already set for `trace_path`
 * (bd tea-rags-mcp-oxnvl): the row carries `source_rel_path` and
 * `target_rel_path`, so the grouping keeps them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { fileScopedSymbolKey } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const BENCH = "scripts/bench-onnx.ts";
const GATE = "scripts/cochange-forgotten-change-gate.ts";
const LIB = "src/lib.ts";

describe("DuckDbGraphClient — getChunkSignalsBulk namesake scoping (bd tea-rags-mcp-xtdkq)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-namesake-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Two unrelated scripts, each with a top-level `main` and a top-level `run` —
   * the exact shape the live index carries. `main` fans out to 2 callees in one
   * file and 3 in the other; `run` takes one incoming call in each file.
   */
  async function seedNamesakes(): Promise<void> {
    await db.upsertFile(
      { relPath: BENCH, language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          { sourceSymbolId: "main", targetSymbolId: "run", targetRelPath: BENCH, callExpression: "run()" },
          { sourceSymbolId: "main", targetSymbolId: "log", targetRelPath: LIB, callExpression: "log()" },
        ],
      },
    );
    await db.upsertFile(
      { relPath: GATE, language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          { sourceSymbolId: "main", targetSymbolId: "run", targetRelPath: GATE, callExpression: "run()" },
          { sourceSymbolId: "main", targetSymbolId: "check", targetRelPath: GATE, callExpression: "check()" },
          { sourceSymbolId: "main", targetSymbolId: "log", targetRelPath: LIB, callExpression: "log()" },
        ],
      },
    );
  }

  it("gives each namesake its own fanOut instead of the union of every namesake's callees", async () => {
    await seedNamesakes();

    const bulk = await db.getChunkSignalsBulk();

    expect(bulk.get(fileScopedSymbolKey({ relPath: BENCH, symbolId: "main" }))?.fanOut).toBe(2);
    expect(bulk.get(fileScopedSymbolKey({ relPath: GATE, symbolId: "main" }))?.fanOut).toBe(3);
  });

  it("gives each namesake its own fanIn instead of every namesake's callers", async () => {
    await seedNamesakes();

    const bulk = await db.getChunkSignalsBulk();

    expect(bulk.get(fileScopedSymbolKey({ relPath: BENCH, symbolId: "run" }))?.fanIn).toBe(1);
    expect(bulk.get(fileScopedSymbolKey({ relPath: GATE, symbolId: "run" }))?.fanIn).toBe(1);
  });

  it("carries no bare-symbolId entry a consumer could read the union from", async () => {
    await seedNamesakes();

    const bulk = await db.getChunkSignalsBulk();

    // Before the scoping this read answered { fanOut: 5 } — the 543 of the live
    // index in miniature — and three unrelated functions were stamped with it.
    expect(bulk.get("main")).toBeUndefined();
    expect(bulk.get("run")).toBeUndefined();
  });

  it("still aggregates a symbol's fanIn across the files that CALL it — the scope is the target's own file", async () => {
    await seedNamesakes();

    const bulk = await db.getChunkSignalsBulk();

    // `log` is declared once and called from both scripts: 2, not 1 per caller.
    expect(bulk.get(fileScopedSymbolKey({ relPath: LIB, symbolId: "log" }))?.fanIn).toBe(2);
  });
});
