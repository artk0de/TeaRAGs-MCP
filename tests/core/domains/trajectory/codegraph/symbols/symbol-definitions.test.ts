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

  it("is what the offline tally and oracle harnesses build their symbol table with", () => {
    expect(buildSymbolDefs(extraction)).toEqual(symbolDefinitionsOf(extraction));
  });
});
