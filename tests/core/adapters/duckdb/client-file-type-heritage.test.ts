/**
 * `readFileDependencyGraph` — per-file `typeHeritage` (bd tea-rags-mcp-r8hme.52.6):
 * the implementation evidence `abstractionBypass` judges by.
 *
 * Invariants under test:
 *   - each type a file declares carries the in-project files declaring each
 *     supertype it names, resolved by exact name (`type_id` OR `short_name`);
 *   - a supertype no project file declares (`Error`) is dropped, and a type
 *     left with none is dropped with it;
 *   - a re-opening row contributes its own supertypes (Ruby `include`);
 *   - a short name declared in two files resolves to both;
 *   - a qualified written supertype (`Billing::Base`) resolves by `type_id`;
 *   - a file with no in-project heritage carries no field at all.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { SymbolDefinitionKind, TypeDeclarationRow } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function decl(
  typeId: string,
  symbolKind: SymbolDefinitionKind,
  extra: Partial<TypeDeclarationRow> = {},
): TypeDeclarationRow {
  return {
    language: "typescript",
    typeId,
    shortName: typeId.split(/::|\./).at(-1) ?? typeId,
    symbolKind,
    line: 1,
    reopens: false,
    supertypes: [],
    ...extra,
  };
}

describe("DuckDbGraphClient — readFileDependencyGraph typeHeritage", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-file-type-heritage-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    for (const relPath of [
      "src/port.ts",
      "src/impl.ts",
      "src/errors.ts",
      "src/plain.ts",
      "src/a/named.ts",
      "src/b/named.ts",
      "src/multi.ts",
      "app/base.rb",
      "app/invoice.rb",
      "app/mixin.rb",
      "app/reopen.rb",
    ]) {
      await db.upsertFile(
        { relPath, language: relPath.endsWith(".rb") ? "ruby" : "typescript" },
        { fileEdges: [], methodEdges: [] },
      );
    }
    await db.replaceTypeDeclarationsBulk([
      { relPath: "src/port.ts", rows: [decl("Port", "interface")] },
      { relPath: "src/impl.ts", rows: [decl("Impl", "class", { supertypes: ["Port", "Error"] })] },
      { relPath: "src/errors.ts", rows: [decl("AppError", "class", { supertypes: ["Error"] })] },
      { relPath: "src/plain.ts", rows: [decl("Plain", "class")] },
      { relPath: "src/a/named.ts", rows: [decl("Named", "interface")] },
      { relPath: "src/b/named.ts", rows: [decl("Named", "interface")] },
      { relPath: "src/multi.ts", rows: [decl("Multi", "class", { supertypes: ["Named"] })] },
      { relPath: "app/base.rb", rows: [decl("Billing::Base", "class", { language: "ruby" })] },
      {
        relPath: "app/invoice.rb",
        rows: [decl("Billing::Invoice", "class", { language: "ruby", supertypes: ["Billing::Base"] })],
      },
      { relPath: "app/mixin.rb", rows: [decl("Auditable", "module", { language: "ruby" })] },
      {
        relPath: "app/reopen.rb",
        rows: [decl("Billing::Invoice", "class", { language: "ruby", reopens: true, supertypes: ["Auditable"] })],
      },
    ]);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function heritageOf(relPath: string) {
    const graph = await db.readFileDependencyGraph();
    return graph.files.find((f) => f.relPath === relPath)?.typeHeritage;
  }

  it("resolves an implemented interface to the file declaring it and drops the external supertype", async () => {
    expect(await heritageOf("src/impl.ts")).toEqual([
      { typeName: "Impl", supertypes: [{ name: "Port", declaringRelPaths: ["src/port.ts"] }] },
    ]);
  });

  it("drops a type whose only supertype is external, leaving the file without the field", async () => {
    const graph = await db.readFileDependencyGraph();
    const errors = graph.files.find((f) => f.relPath === "src/errors.ts");
    expect(errors).toBeDefined();
    expect(errors && "typeHeritage" in errors).toBe(false);
  });

  it("carries no field for a file whose types name no supertype", async () => {
    const graph = await db.readFileDependencyGraph();
    const plain = graph.files.find((f) => f.relPath === "src/plain.ts");
    expect(plain && "typeHeritage" in plain).toBe(false);
  });

  it("resolves an ambiguous short name to every declaring file", async () => {
    expect(await heritageOf("src/multi.ts")).toEqual([
      { typeName: "Multi", supertypes: [{ name: "Named", declaringRelPaths: ["src/a/named.ts", "src/b/named.ts"] }] },
    ]);
  });

  it("resolves a qualified written supertype by type id", async () => {
    expect(await heritageOf("app/invoice.rb")).toEqual([
      { typeName: "Invoice", supertypes: [{ name: "Billing::Base", declaringRelPaths: ["app/base.rb"] }] },
    ]);
  });

  it("lets a re-opening row contribute its own supertypes", async () => {
    expect(await heritageOf("app/reopen.rb")).toEqual([
      { typeName: "Invoice", supertypes: [{ name: "Auditable", declaringRelPaths: ["app/mixin.rb"] }] },
    ]);
  });
});
