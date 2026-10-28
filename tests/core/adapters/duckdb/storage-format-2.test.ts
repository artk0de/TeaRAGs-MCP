import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";

it("creates new codegraph databases in the DuckDB 2.0 storage format", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-storage-version-"));
  const path = join(dir, "graph.duckdb");
  const db = new DuckDbGraphClient({ path });
  try {
    await db.init();
    await db.exec("CREATE TABLE sample (id INTEGER)");
    await db.checkpoint();
    await db.close();
    expect(Number(readFileSync(path).readBigUInt64LE(12))).toBe(999);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
