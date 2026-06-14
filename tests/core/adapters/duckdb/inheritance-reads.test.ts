import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { InheritanceEdgeRow } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

// Animal <- Dog <- Puppy ; EmbeddingProvider implemented by Onnx, Remote.
function row(s: string, a: string, kind: InheritanceEdgeRow["kind"]): InheritanceEdgeRow {
  return { sourceFqName: s, sourceSymbolId: s, ancestorFqName: a, ancestorSymbolId: a, kind, ordinal: 0 };
}

describe("hierarchy reads", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-inh-reads-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    const upsert = async (relPath: string, r: InheritanceEdgeRow) =>
      db.upsertFile({ relPath, language: "typescript" }, { fileEdges: [], methodEdges: [], inheritance: [r] });
    await upsert("dog.ts", row("Dog", "Animal", "super"));
    await upsert("puppy.ts", row("Puppy", "Dog", "super"));
    await upsert("onnx.ts", row("Onnx", "EmbeddingProvider", "implements"));
    await upsert("remote.ts", row("Remote", "EmbeddingProvider", "implements"));
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("getSubtypes returns direct implementers (reverse index)", async () => {
    const subs = await db.getSubtypes("EmbeddingProvider");
    expect(subs.map((e) => e.sourceFqName).sort()).toEqual(["Onnx", "Remote"]);
    expect(subs.every((e) => e.kind === "implements")).toBe(true);
  });

  it("getSupertypes returns direct ancestors", async () => {
    const sup = await db.getSupertypes("Puppy");
    expect(sup.map((e) => e.ancestorFqName)).toEqual(["Dog"]);
  });

  it("getTransitiveSubtypes walks the chain Animal -> Dog -> Puppy", async () => {
    const subs = await db.getTransitiveSubtypes("Animal");
    expect(subs.map((e) => e.sourceFqName).sort()).toEqual(["Dog", "Puppy"]);
    const puppy = subs.find((e) => e.sourceFqName === "Puppy");
    expect(puppy?.depth).toBe(2);
  });

  it("loadHierarchySnapshot indexes both directions", async () => {
    const snap = await db.loadHierarchySnapshot();
    expect(snap.descendantsByAncestor["EmbeddingProvider"].map((e) => e.sourceFqName).sort()).toEqual([
      "Onnx",
      "Remote",
    ]);
    expect(snap.ancestorsBySource["Puppy"].map((e) => e.ancestorFqName)).toEqual(["Dog"]);
  });
});
