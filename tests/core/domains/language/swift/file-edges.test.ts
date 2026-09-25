/**
 * Swift file→file edges (bd tea-rags-mcp-y99pg.38).
 *
 * A Swift `import` names a MODULE, never a file, so the runner's default
 * import→file loop can find no target and every Swift file used to carry
 * `codegraph.file.fanIn = fanOut = 0` while its chunks had resolved cross-file
 * calls. The file graph is therefore derived from those calls: a caller file
 * depends on every distinct OTHER file its resolved calls land in.
 *
 * Driven through the REAL `CallEdgeResolutionRunner` and the REAL
 * `LanguageFactory`-built Swift provider, because the runner reads the FACADE —
 * a derivation the facade does not forward never runs in production (bd
 * tea-rags-mcp-x9qsh), however well a unit test of the helper passes.
 */

import Parser from "tree-sitter";
import { describe, expect, it } from "vitest";

import type { FileExtraction, SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";
import { collectSymbols } from "../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../src/core/domains/language/kernel/symbol-id.js";
import {
  CODEGRAPH_LANGUAGES,
  loadCodegraphGrammarSync,
} from "../../../../../src/core/domains/trajectory/codegraph/symbols/file-extractor.js";
import { CallEdgeResolutionRunner } from "../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { lastSegment } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-name.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const CHECKOUT = "Sources/Shop/Checkout.swift";
const BILLING = "Sources/Shop/Billing.swift";

const CHECKOUT_SRC = `import Foundation

public class Checkout {
    public func run() -> Int {
        let billing = Billing()
        return billing.charge(10)
    }

    public func again() -> Int {
        return run()
    }
}
`;

const BILLING_SRC = `import Foundation

public class Billing {
    public init() {}

    public func charge(_ amount: Int) -> Int {
        return amount
    }
}
`;

const swiftRow = CODEGRAPH_LANGUAGES[".swift"];
const factory = new LanguageFactory();
const composer = new DefaultSymbolIdComposer();

function extract(code: string, relPath: string): FileExtraction {
  const { walker } = factory.create("swift");
  if (!walker) throw new Error("swift provider has no walker");
  const parser = new Parser();
  parser.setLanguage(loadCodegraphGrammarSync(factory, ".swift"));
  const tree = { rootNode: parser.parse(code).rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => walker.nameOf(node),
    swiftRow.scopeSeparator,
    swiftRow.disambiguateOverloads ?? false,
    composer,
  );
  return walker.walk({ tree, code, relPath, language: "swift", chunks });
}

function symbolTableOf(extractions: FileExtraction[]): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const extraction of extractions) {
    const defs: SymbolDefinition[] = extraction.chunks.map((c) => ({
      symbolId: c.symbolId,
      fqName: c.symbolId,
      shortName: lastSegment(c.symbolId),
      relPath: extraction.relPath,
      scope: c.scope,
    }));
    table.upsertFile(extraction.relPath, defs);
  }
  return table;
}

describe("swift file edges — derived from resolved cross-file calls", () => {
  const checkout = extract(CHECKOUT_SRC, CHECKOUT);
  const billing = extract(BILLING_SRC, BILLING);
  const symbolTable = symbolTableOf([checkout, billing]);
  const runner = new CallEdgeResolutionRunner(factory, new CodegraphRunState());

  it("gives the caller file ONE edge to the file declaring the type it calls into", () => {
    const edges = runner.resolve(checkout, symbolTable);

    // Precondition: the call graph itself reaches Billing.swift.
    expect(edges.methodEdges.some((e) => e.targetRelPath === BILLING)).toBe(true);
    // The file graph follows it — once per target file, however many calls land there.
    expect(edges.fileEdges).toEqual([{ targetRelPath: BILLING, importText: null }]);
  });

  it("emits no self edge for calls that stay inside the file", () => {
    const edges = runner.resolve(checkout, symbolTable);

    expect(edges.methodEdges.some((e) => e.targetRelPath === CHECKOUT)).toBe(true);
    expect(edges.fileEdges.map((e) => e.targetRelPath)).not.toContain(CHECKOUT);
  });

  it("gives a file whose calls resolve nowhere else no file edges", () => {
    expect(runner.resolve(billing, symbolTable).fileEdges).toEqual([]);
  });
});
