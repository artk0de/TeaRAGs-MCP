import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { InheritanceEdgeRow } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

function row(s: string, a: string, kind: InheritanceEdgeRow["kind"]): InheritanceEdgeRow {
  return { sourceFqName: s, sourceSymbolId: s, ancestorFqName: a, ancestorSymbolId: a, kind, ordinal: 0 };
}

describe("inheritance upsert + delete", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-inh-crud-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("upsertFile persists inheritance rows; removeFile clears them", async () => {
    await db.upsertFile(
      { relPath: "a.ts", language: "typescript" },
      { fileEdges: [], methodEdges: [], inheritance: [row("Dog", "Animal", "super")] },
    );
    expect(await db.queryAll("SELECT source_fq_name FROM cg_symbols_inheritance")).toHaveLength(1);

    await db.removeFile("a.ts");
    expect(await db.queryAll("SELECT * FROM cg_symbols_inheritance")).toHaveLength(0);
  });

  it("re-upsert of the same file replaces its inheritance rows (idempotent)", async () => {
    const node = { relPath: "a.ts", language: "typescript" };
    await db.upsertFile(node, { fileEdges: [], methodEdges: [], inheritance: [row("Dog", "Animal", "super")] });
    await db.upsertFile(node, { fileEdges: [], methodEdges: [], inheritance: [row("Dog", "Animal", "super")] });
    expect(await db.queryAll("SELECT * FROM cg_symbols_inheritance")).toHaveLength(1);
  });

  it("upsertFile with no inheritance field leaves the table untouched", async () => {
    await db.upsertFile({ relPath: "a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    expect(await db.queryAll("SELECT * FROM cg_symbols_inheritance")).toHaveLength(0);
  });
});
