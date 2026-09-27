/**
 * `buildTypeDeclarationRows` — a file's `typeDeclarations` as the
 * `cg_type_declarations` rows the naming lexicon reads (bd tea-rags-mcp-vi0wx,
 * spec §1b): every language, re-openings included (the read filters them), the
 * short name cut off the composed id, the supertypes read off `conforms`.
 */

import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { buildTypeDeclarationRows } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/type-declaration-rows.js";

function extraction(extra: Partial<FileExtraction>): FileExtraction {
  return { relPath: "Sources/Request.swift", language: "swift", imports: [], fileScope: [], chunks: [], ...extra };
}

describe("buildTypeDeclarationRows", () => {
  it("maps each fact to a row, cutting the short name and reading the supertypes", () => {
    const rows = buildTypeDeclarationRows(
      extraction({
        typeDeclarations: [
          { typeId: "Request", symbolKind: "class", line: 3, reopens: false, conforms: ["Base", "Sendable"] },
          { typeId: "Request.State", symbolKind: "enum", line: 9, reopens: false },
          { typeId: "String", symbolKind: "class", line: 20, reopens: true, conforms: ["Encodable"] },
        ],
      }),
    );
    expect(rows).toEqual([
      {
        language: "swift",
        typeId: "Request",
        shortName: "Request",
        symbolKind: "class",
        line: 3,
        reopens: false,
        supertypes: ["Base", "Sendable"],
      },
      {
        language: "swift",
        typeId: "Request.State",
        shortName: "State",
        symbolKind: "enum",
        line: 9,
        reopens: false,
        supertypes: [],
      },
      {
        language: "swift",
        typeId: "String",
        shortName: "String",
        symbolKind: "class",
        line: 20,
        reopens: true,
        supertypes: ["Encodable"],
      },
    ]);
  });

  it("cuts a `::`-qualified id at its last segment too", () => {
    const rows = buildTypeDeclarationRows(
      extraction({
        relPath: "app/models/billing/account.rb",
        language: "ruby",
        typeDeclarations: [{ typeId: "Billing::Account", symbolKind: "class", line: 2, reopens: false }],
      }),
    );
    expect(rows.map((r) => r.shortName)).toEqual(["Account"]);
  });

  // bd tea-rags-mcp-ffxfc: the member census joins its declaration by id AND line.
  it("carries a declaration's member census and leaves a declaration without one unknown", () => {
    const rows = buildTypeDeclarationRows(
      extraction({
        relPath: "app/models/account.rb",
        language: "ruby",
        typeDeclarations: [
          { typeId: "Account", symbolKind: "class", line: 1, reopens: false },
          { typeId: "Account", symbolKind: "class", line: 9, reopens: false },
          { typeId: "MAX", symbolKind: "constant", line: 20, reopens: false },
        ],
        typeMemberCensus: [
          { typeId: "Account", line: 9, methodCount: 3, fieldCount: 1 },
          { typeId: "Account", line: 1, methodCount: 0, fieldCount: 2 },
        ],
      }),
    );
    expect(rows.map((r) => [r.typeId, r.line, r.methodCount, r.fieldCount])).toEqual([
      ["Account", 1, 0, 2],
      ["Account", 9, 3, 1],
      ["MAX", 20, undefined, undefined],
    ]);
    expect(rows[2]).not.toHaveProperty("methodCount");
    expect(rows[2]).not.toHaveProperty("fieldCount");
  });

  it("returns no rows for a file that declares none, so its stored rows are cleared", () => {
    expect(buildTypeDeclarationRows(extraction({}))).toEqual([]);
  });
});
