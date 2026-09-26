import { describe, expect, it } from "vitest";

import { buildSymbolDefs } from "../../../../../../scripts/ts-codegraph-typechecker-oracle.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { symbolDefinitionsOf } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-definitions.js";

const extraction: FileExtraction = {
  relPath: "Sources/Request.swift",
  language: "swift",
  imports: [],
  fileScope: [],
  chunks: [
    {
      symbolId: "Request#validate~2",
      scope: ["Request"],
      startLine: 10,
      endLine: 20,
      calls: [],
      arity: { minRequired: 0, maxPositional: 1, hasSplat: false },
      kwargs: { required: ["statusCode"], optional: [], hasSplat: false },
      acceptsBlock: false,
      visibility: "private",
    },
  ],
};

describe("symbolDefinitionsOf — the one chunk → SymbolDefinition mapping", () => {
  it("threads every call signature the narrowers read", () => {
    expect(symbolDefinitionsOf(extraction)).toEqual([
      {
        symbolId: "Request#validate~2",
        fqName: "Request#validate~2",
        shortName: "validate",
        relPath: "Sources/Request.swift",
        scope: ["Request"],
        arity: { minRequired: 0, maxPositional: 1, hasSplat: false },
        kwargs: { required: ["statusCode"], optional: [], hasSplat: false },
        acceptsBlock: false,
        visibility: "private",
        startLine: 10,
        endLine: 20,
      },
    ]);
  });

  it("threads the walker's symbol kind onto the definition (bd tea-rags-mcp-vi0wx)", () => {
    const defs = symbolDefinitionsOf({
      ...extraction,
      chunks: [{ symbolId: "Request", scope: [], calls: [], symbolKind: "class" }],
    });
    expect(defs[0].symbolKind).toBe("class");
  });

  it("omits the symbol kind when the walker recorded none", () => {
    const defs = symbolDefinitionsOf({ ...extraction, chunks: [{ symbolId: "Request", scope: [], calls: [] }] });
    expect(defs[0]).not.toHaveProperty("symbolKind");
  });

  it("is what the offline tally and oracle harnesses build their symbol table with", () => {
    expect(buildSymbolDefs(extraction)).toEqual(symbolDefinitionsOf(extraction));
  });
});
