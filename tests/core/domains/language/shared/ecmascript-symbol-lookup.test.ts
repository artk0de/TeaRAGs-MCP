/**
 * The ECMAScript family's symbol-table lookups (bd tea-rags-mcp-t5cji): the
 * TypeScript and JavaScript resolvers' ONE entry point into the polyglot
 * symbol table, mirroring `lookupRubySymbolsByShortName` /
 * `lookupPythonSymbolsByShortName`. TS and JS answer for each other; nothing
 * else does.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, NamedSymbol } from "../../../../../src/core/contracts/types/codegraph.js";
import {
  isEcmascriptSourcePath,
  lookupEcmascriptSymbols,
  lookupEcmascriptSymbolsByShortName,
} from "../../../../../src/core/domains/language/shared/ecmascript-symbol-lookup.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const sym = (
  symbolId: string,
  shortName: string,
  relPath: string,
  scope: string[],
  extra: Partial<NamedSymbol> = {},
): NamedSymbol => ({ symbolId, fqName: symbolId, shortName, relPath, scope, ...extra });

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const ctx = (symbolTable: InMemoryGlobalSymbolTable): CallContext => ({
  callerFile: "web/caller.ts",
  callerScope: [],
  imports: [],
  symbolTable,
});

const TS = "web/report.ts";
const TSX = "web/Report.tsx";
const JS = "web/legacy/report.js";
const RB = "app/models/report.rb";
const PY = "lib/report.py";

describe("isEcmascriptSourcePath", () => {
  it("admits every TypeScript and JavaScript extension, declarations included", () => {
    for (const path of [
      TS,
      TSX,
      "types/api.d.ts",
      "web/a.mts",
      "web/a.cts",
      JS,
      "web/a.jsx",
      "web/a.mjs",
      "web/a.cjs",
    ]) {
      expect(isEcmascriptSourcePath(path), path).toBe(true);
    }
  });

  it("rejects every other codegraph language", () => {
    for (const path of [RB, PY, "cmd/main.go", "src/Main.java", "src/lib.rs", "bin/run.sh", "Rakefile.rake"]) {
      expect(isEcmascriptSourcePath(path), path).toBe(false);
    }
  });
});

describe("lookupEcmascriptSymbolsByShortName", () => {
  it("keeps TS and JS namesakes and drops Ruby and Python ones", () => {
    const symbolTable = tableWith(
      [RB, [sym("Report#render", "render", RB, ["Report"])]],
      [TS, [sym("Report#render", "render", TS, ["Report"])]],
      [PY, [sym("Report.render", "render", PY, ["Report"])]],
      [JS, [sym("LegacyReport#render", "render", JS, ["LegacyReport"])]],
    );
    expect(lookupEcmascriptSymbolsByShortName(ctx(symbolTable), "render").map((d) => d.relPath)).toEqual([TS, JS]);
  });

  it("forwards lookup options and still filters by family under them", () => {
    const symbolTable = tableWith([TS, [sym("Report#name", "name", TS, ["Report"])]]);
    symbolTable.setSchemaColumns([
      sym("Report#name", "name", RB, ["Report"], { isSchemaColumn: true }),
      sym("Report#name", "name", TSX, ["Report"], { isSchemaColumn: true }),
    ]);
    expect(
      lookupEcmascriptSymbolsByShortName(ctx(symbolTable), "name", { includeSchemaColumns: true }).map(
        (d) => d.relPath,
      ),
    ).toEqual([TS, TSX]);
  });

  it("is a no-op on a table that holds only the family", () => {
    const symbolTable = tableWith(
      [TS, [sym("Report#render", "render", TS, ["Report"])]],
      [JS, [sym("LegacyReport#render", "render", JS, ["LegacyReport"])]],
    );
    expect(lookupEcmascriptSymbolsByShortName(ctx(symbolTable), "render")).toEqual(
      symbolTable.lookupByShortName("render"),
    );
  });
});

describe("lookupEcmascriptSymbols", () => {
  it("drops a Ruby definition sharing the fully-qualified name", () => {
    const symbolTable = tableWith(
      [RB, [sym("Report#render", "render", RB, ["Report"])]],
      [TS, [sym("Report#render", "render", TS, ["Report"])]],
    );
    expect(lookupEcmascriptSymbols(ctx(symbolTable), "Report#render").map((d) => d.relPath)).toEqual([TS]);
  });

  it("answers nothing when only a foreign file declares the name", () => {
    const symbolTable = tableWith([PY, [sym("Report", "Report", PY, [])]]);
    expect(lookupEcmascriptSymbols(ctx(symbolTable), "Report")).toEqual([]);
  });
});
