/**
 * `SymbolDefinition.isAbstractStub` persistence in `cg_symbols`
 * (bd tea-rags-mcp-eikry).
 *
 * The walker marks abstract stubs (empty body / `raise NotImplementedError` /
 * bare `super`, bd bcdfe) on the in-memory symbol table. An incremental run
 * hydrates unchanged files from `cg_symbols` rows, so a flag that does not
 * survive the write/read round trip silently turns every hydrated stub into a
 * concrete definition. These pin the round trip at the adapter seam: both
 * writers (per-file and bulk) carry the flag, the reader maps it back, and a
 * legacy row written before the column existed still hydrates as non-stub.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { SymbolDefinition } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const STUB: SymbolDefinition = {
  relPath: "base.rb",
  symbolId: "Base#perform",
  fqName: "Base#perform",
  shortName: "perform",
  scope: ["Base"],
  isAbstractStub: true,
};

const CONCRETE: SymbolDefinition = {
  relPath: "impl.rb",
  symbolId: "Impl#perform",
  fqName: "Impl#perform",
  shortName: "perform",
  scope: ["Impl"],
};

describe("cg_symbols — isAbstractStub round trip", () => {
  let dir: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-stub-rt-"));
    client = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("per-file upsertSymbols persists the stub mark and listAllSymbols reads it back", async () => {
    await client.upsertSymbols("base.rb", [STUB]);
    await client.upsertSymbols("impl.rb", [CONCRETE]);

    const hydrated = await client.listAllSymbols();
    expect(hydrated.find((d) => d.symbolId === "Base#perform")?.isAbstractStub).toBe(true);
    // Absent, not `false` — the flag is only-ever-true, so a real body must not
    // start carrying a field on ~99% of defs.
    expect(hydrated.find((d) => d.symbolId === "Impl#perform")?.isAbstractStub).toBeUndefined();
  });

  it("bulk upsertSymbolsBulk writes the same rows as the per-file path", async () => {
    const refDir = mkdtempSync(join(tmpdir(), "cg-stub-rt-ref-"));
    const ref = new DuckDbGraphClient({ path: join(refDir, "g.duckdb") });
    await ref.init();
    await runMigrations(ref, DATABASE_MIGRATIONS);
    try {
      await ref.upsertSymbols("base.rb", [STUB]);
      await ref.upsertSymbols("impl.rb", [CONCRETE]);
      await client.upsertSymbolsBulk([
        { relPath: "base.rb", definitions: [STUB] },
        { relPath: "impl.rb", definitions: [CONCRETE] },
      ]);

      const refRows = await ref.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
      const bulkRows = await client.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
      expect(bulkRows).toEqual(refRows);
      expect((await client.listAllSymbols()).find((d) => d.symbolId === "Base#perform")?.isAbstractStub).toBe(true);
    } finally {
      await ref.close();
      rmSync(refDir, { recursive: true, force: true });
    }
  });

  it("a pre-016 row (column never written) hydrates as non-stub without throwing", async () => {
    await client.run(
      "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES (?, ?, ?, ?, ?)",
      ["legacy.rb", "Legacy#perform", "Legacy#perform", "perform", '["Legacy"]'],
    );
    const hydrated = await client.listAllSymbols();
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].isAbstractStub).toBeUndefined();
  });

  it("re-upserting a stub def as concrete clears the mark", async () => {
    await client.upsertSymbols("base.rb", [STUB]);
    // The same file re-walked after the stub grew a real body — DELETE+INSERT
    // must leave no residue of the old mark.
    await client.upsertSymbols("base.rb", [{ ...STUB, isAbstractStub: undefined }]);
    const hydrated = await client.listAllSymbols();
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].isAbstractStub).toBeUndefined();
  });
});
