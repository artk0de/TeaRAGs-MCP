import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { collectTypeDeclarationReaders } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/type-declaration-readers.js";

function fixture(files: Record<string, string>, materialized: boolean, mainFile = "src/main.rs") {
  const language = new RustLanguage();
  const factory = new LanguageFactory();
  const runState = new CodegraphRunState([], new Map(), new Map(), collectTypeDeclarationReaders(factory));
  const symbolTable = new InMemoryGlobalSymbolTable();
  const extractions: FileExtraction[] = [];
  for (const [relPath, code] of Object.entries(files)) {
    const parser = new Parser();
    parser.setLanguage(RustLang);
    const native = parser.parse(code);
    const tree = { rootNode: materialized ? materializeTree(native.rootNode, code) : native.rootNode };
    const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
    const extraction = language.walker.walk({ tree, code, relPath, language: "rust", chunks });
    symbolTable.upsertFile(
      relPath,
      extraction.chunks.map((chunk) => ({
        ...chunk,
        fqName: chunk.symbolId,
        shortName: chunk.symbolId.split(/#|\.|::/).at(-1)!,
        relPath,
      })),
    );
    extractions.push(extraction);
    runState.absorb(extraction, []);
  }
  const extraction = extractions.find((entry) => entry.relPath === mainFile)!;
  return {
    extraction,
    symbolTable,
    resolve(text: string, symbolId = "run") {
      const chunk = extraction.chunks.find((entry) => entry.symbolId === symbolId)!;
      expect(chunk?.symbolId).toBe(symbolId);
      const call = chunk.calls.find((entry) => entry.callText === text)!;
      expect(call?.callText).toBe(text);
      const ctx: CallContext = {
        callerFile: extraction.relPath,
        callerScope: chunk.scope,
        callerSymbolId: chunk.symbolId,
        imports: extraction.imports,
        symbolTable,
        localBindings: chunk.localBindings,
        callResultBindings: chunk.callResultBindings,
        structuredReturnTypes: runState.structuredReturnTypes,
        classFieldTypesByClassKey: runState.classFieldTypesByClassKey,
        typeDeclarations: runState.typeDeclarations,
      };
      return language.resolver.resolve(call, ctx);
    },
    edges() {
      return new CallEdgeResolutionRunner(factory, runState).resolve(extraction, symbolTable).methodEdges;
    },
  };
}

const finishers = `
struct Product;
struct Other;
impl Product { fn finish(&self) {} }
impl Other { fn finish(&self) {} }
`;
const productFinish = { targetRelPath: "src/main.rs", targetSymbolId: "Product#finish" };

describe.each([false, true])("Rust method-call result locals (materialized=%s)", (materialized) => {
  it("types a binding from the init method's declared return on the receiver's type", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
struct Engine;
impl Engine { fn write_batch(&self) -> Product { todo!() } }
fn run(e: &Engine) {
  let wb = e.write_batch();
  wb.finish();
}
`,
      },
      materialized,
    );
    expect(f.resolve("wb.finish()")).toEqual(productFinish);
    expect(f.edges()).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceSymbolId: "run", ...productFinish })]),
    );
  });

  it("declines when the receiver's type declares the member on neither itself nor its deref", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
struct Engine;
impl Engine { fn write_batch(&self) -> Product { todo!() } }
fn run(e: &Engine) {
  let wb = e.write_batch();
  wb.missing();
}
`,
      },
      materialized,
    );
    expect(f.resolve("wb.missing()")).toBeNull();
  });

  it("keeps a self-receiver init inside its declaring type's method returns", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
struct Engine { field: Product }
impl Engine {
  fn write_batch(&self) -> Product { todo!() }
  fn run(&self) {
    let wb = self.write_batch();
    wb.finish();
  }
}
`,
      },
      materialized,
    );
    expect(f.resolve("wb.finish()", "Engine#run")).toEqual(productFinish);
  });
});
