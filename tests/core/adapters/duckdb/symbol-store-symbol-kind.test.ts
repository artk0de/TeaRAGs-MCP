/**
 * `SymbolDefinition.symbolKind` persistence in `cg_symbols.symbol_kind`
 * (bd tea-rags-mcp-vi0wx, migration 035).
 *
 * Type-name judgement reads the declaration kind from the store, and an
 * incremental run hydrates unchanged files from `cg_symbols` rows — so the kind
 * must survive the write/read round trip on both writers, and a def without a
 * kind (or a pre-035 row) must hydrate WITHOUT the field rather than with a
 * guessed one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { SymbolDefinition } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const CLASS_DEF: SymbolDefinition = {
  relPath: "foo.ts",
  symbolId: "Foo",
  fqName: "Foo",
  shortName: "Foo",
  scope: [],
  symbolKind: "class",
};

const UNKNOWN_DEF: SymbolDefinition = {
  relPath: "bar.ts",
  symbolId: "bar",
  fqName: "bar",
  shortName: "bar",
  scope: [],
};

describe("cg_symbols — symbolKind round trip", () => {
  let dir: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-symbol-kind-rt-"));
    client = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("upsertSymbolsBulk persists the kind and listAllSymbols reads it back", async () => {
    await client.upsertSymbolsBulk([
      { relPath: "foo.ts", definitions: [CLASS_DEF] },
      { relPath: "bar.ts", definitions: [UNKNOWN_DEF] },
    ]);

    const hydrated = await client.listAllSymbols();
    expect(hydrated.find((d) => d.symbolId === "Foo")?.symbolKind).toBe("class");
    expect(hydrated.find((d) => d.symbolId === "bar")).not.toHaveProperty("symbolKind");
    expect(await client.queryAll("SELECT symbol_id, symbol_kind FROM cg_symbols ORDER BY symbol_id")).toEqual([
      { symbol_id: "Foo", symbol_kind: "class" },
      { symbol_id: "bar", symbol_kind: null },
    ]);
  });

  it("per-file upsertSymbols writes the same rows as the bulk path", async () => {
    const refDir = mkdtempSync(join(tmpdir(), "cg-symbol-kind-rt-ref-"));
    const ref = new DuckDbGraphClient({ path: join(refDir, "g.duckdb") });
    await ref.init();
    await runMigrations(ref, DATABASE_MIGRATIONS);
    try {
      await ref.upsertSymbols("foo.ts", [CLASS_DEF]);
      await ref.upsertSymbols("bar.ts", [UNKNOWN_DEF]);
      await client.upsertSymbolsBulk([
        { relPath: "foo.ts", definitions: [CLASS_DEF] },
        { relPath: "bar.ts", definitions: [UNKNOWN_DEF] },
      ]);

      const refRows = await ref.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
      const bulkRows = await client.queryAll("SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id");
      expect(bulkRows).toEqual(refRows);
    } finally {
      await ref.close();
      rmSync(refDir, { recursive: true, force: true });
    }
  });

  it("a re-walk that changes the kind refreshes the row", async () => {
    await client.upsertSymbolsBulk([{ relPath: "foo.ts", definitions: [CLASS_DEF] }]);
    await client.upsertSymbolsBulk([{ relPath: "foo.ts", definitions: [{ ...CLASS_DEF, symbolKind: "interface" }] }]);

    const hydrated = await client.listAllSymbols();
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].symbolKind).toBe("interface");
  });
});
