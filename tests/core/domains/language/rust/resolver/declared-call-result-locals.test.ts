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

function fixture(files: Record<string, string>, materialized: boolean) {
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
  const extraction = extractions.find((entry) => entry.relPath === "src/main.rs")!;
  return {
    extraction,
    symbolTable,
    chunk(symbolId = "run") {
      const chunk = extraction.chunks.find((entry) => entry.symbolId === symbolId)!;
      expect(chunk?.symbolId).toBe(symbolId);
      return chunk;
    },
    resolve(text: string, symbolId = "run") {
      const chunk = extraction.chunks.find((entry) => entry.symbolId === symbolId)!;
      expect(chunk?.symbolId).toBe(symbolId);
      const call = chunk.calls.find((entry) => entry.callText === text)!;
      expect(call?.callText).toBe(text);
      expect(chunk.callResultBindings?.value).toEqual([
        expect.objectContaining({ endLine: expect.any(Number), scopeEndLine: chunk.endLine }),
      ]);
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

describe.each([false, true])("Rust declared call-result locals (materialized=%s)", (materialized) => {
  it("types a bare-call result through exact declaration facts and the production runner", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
fn make() -> Product { todo!() }
fn run() {
  let value = make();
  value.finish();
}
`,
      },
      materialized,
    );
    expect(f.chunk().localBindings).toBeUndefined();
    expect(f.resolve("value.finish()")).toEqual(productFinish);
    expect(f.edges()).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceSymbolId: "run", ...productFinish })]),
    );
  });

  it("keeps namesake free functions and nominal returns in their declaring module", () => {
    const f = fixture(
      {
        "src/main.rs": `
${finishers}
fn make() -> Other { todo!() }
mod inner {
  struct Product;
  impl Product { fn finish(&self) {} }
  fn make() -> Product { todo!() }
  fn run() {
    let value = make();
    value.finish();
  }
}
mod sibling {
  fn make() -> Other { todo!() }
}
`,
      },
      materialized,
    );
    expect(f.resolve("value.finish()", "inner.run")).toEqual({
      targetRelPath: "src/main.rs",
      targetSymbolId: "inner::Product#finish",
    });
  });

  it("does not borrow the return of a cross-file namesake", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
fn make() {}
fn run() {
  let value = make();
  value.finish();
}
`,
        "src/other.rs": "struct Product;\nfn make() -> Product { todo!() }",
      },
      materialized,
    );
    expect(f.resolve("value.finish()")).toBeNull();
  });

  it("does not infer from a cross-file-only free function", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
fn run() {
  let value = make();
  value.finish();
}
`,
        "src/other.rs": "struct Product;\nfn make() -> Product { todo!() }",
      },
      materialized,
    );
    expect(f.resolve("value.finish()")).toBeNull();
  });

  it("borrows a cross-file free function's return when an internal import binds it", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
use crate::makers::make;
fn run() {
  let value = make();
  value.finish();
}
`,
        "src/makers.rs": `
pub struct Product;
impl Product { pub fn finish(&self) {} }
pub fn make() -> Product { todo!() }
`,
      },
      materialized,
    );
    // Two `Product` types exist; the return spelling is the callee file's own,
    // placed there — not the caller's namesake.
    expect(f.resolve("value.finish()")).toEqual({
      targetRelPath: "src/makers.rs",
      targetSymbolId: "Product#finish",
    });
  });

  it("refuses an imported callee despite an exact same-file namesake", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
use external::make;
fn make() -> Product { todo!() }
fn run() {
  let value = make();
  value.finish();
}
`,
      },
      materialized,
    );
    expect(f.resolve("value.finish()")).toBeNull();
  });

  it.each([
    ["async", "async fn make() -> Product { todo!() }"],
    ["std wrapper", "fn make() -> std::boxed::Box<Product> { todo!() }"],
    ["missing return", "fn make() { todo!() }"],
    ["unknown return", "fn make() -> Unknown { todo!() }"],
    ["Self return", "fn make() -> Self { todo!() }"],
    ["duplicate target", "fn make() -> Product { todo!() }\nfn make() -> Other { todo!() }"],
  ])("declines %s without a usable exact declared return", (_name, declaration) => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
${declaration}
fn run() {
  let value = make();
  value.finish();
}
`,
      },
      materialized,
    );
    expect(f.resolve("value.finish()")).toBeNull();
  });

  it("withholds a generic callee without changing its existing declared return fact", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
fn make<T>() -> Product { todo!() }
fn run() {
  let value = make();
  value.finish();
}
`,
      },
      materialized,
    );
    expect(f.extraction.structuredReturnTypes?.["src/main.rs::make"]).toEqual({ form: "instance", name: "Product" });
    expect(f.chunk().callResultBindings?.value).toBeUndefined();
    expect(f.edges().filter((edge) => edge.targetSymbolId === "Product#finish")).toEqual([]);
  });

  it("refuses wildcard imports rather than guessing a same-file callee", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
use external::*;
fn make() -> Product { todo!() }
fn run() {
  let value = make();
  value.finish();
}
`,
      },
      materialized,
    );
    expect(f.resolve("value.finish()")).toBeNull();
  });

  it.each([
    "const make: fn() -> Product = other;",
    "static make: fn() -> Product = other;",
    "macro_rules! make { () => {} }",
  ])("withholds a value-namespace collision: %s", (declaration) => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
${declaration}
fn make() -> Product { todo!() }
fn run() {
  let value = make();
  value.finish();
}
`,
      },
      materialized,
    );
    expect(f.chunk().callResultBindings?.value).toBeUndefined();
    expect(f.edges().filter((edge) => edge.targetSymbolId === "Product#finish")).toEqual([]);
  });

  it("does not treat an associated function as an inferred instance method", () => {
    const f = fixture(
      {
        "src/main.rs": `
struct Product;
struct Other;
impl Product { fn finish() {} }
impl Other { fn finish(&self) {} }
fn make() -> Product { todo!() }
fn run() {
  let value = make();
  value.finish();
}
`,
      },
      materialized,
    );
    expect(f.resolve("value.finish()")).toBeNull();
  });

  it.each(["value.inner.finish()", "value.get().finish()"])(
    "keeps placed instance dispatch exact through %s",
    (call) => {
      const f = fixture(
        {
          "src/main.rs": `
struct Product;
struct Other;
struct Holder { inner: Product }
impl Product { fn finish() {} }
impl Other { fn finish(&self) {} }
impl Holder { fn get(&self) -> Product { todo!() } }
fn make() -> Holder { todo!() }
fn run() {
  let value = make();
  ${call};
}
`,
        },
        materialized,
      );
      expect(f.resolve(call)).toBeNull();
    },
  );

  it("does not call an instance method as a placed class constructor", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
struct Holder;
impl Holder { fn new(&self) -> Product { todo!() } }
fn make() -> Holder { todo!() }
fn run() {
  let value = make();
  Holder::new().finish();
}
`,
      },
      materialized,
    );
    expect(f.resolve("Holder::new().finish()")).toBeNull();
  });

  it("does not place a nominal return in a different file", () => {
    const f = fixture(
      {
        "src/main.rs": `struct Other;\nimpl Other { fn finish(&self) {} }
fn make() -> Product { todo!() }
fn run() {
  let value = make();
  value.finish();
}
`,
        "src/other.rs": "struct Product;\nimpl Product { fn finish(&self) {} }",
      },
      materialized,
    );
    expect(f.resolve("value.finish()")).toBeNull();
  });

  it("does not use a result before its binding or inside its initializer", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
fn make(_: ()) -> Product { todo!() }
fn run() {
  value.finish();
  let value = make(
    value.finish()
  );
  value.finish();
}
`,
      },
      materialized,
    );
    expect(f.resolve("value.finish()")).toBeNull();
    const calls = f.chunk().calls.filter((call) => call.callText === "value.finish()");
    expect(calls).toHaveLength(3);
    expect(f.edges().filter((edge) => edge.targetSymbolId === "Product#finish")).toHaveLength(1);
  });

  it("declines same-line uses without column proof", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
fn make() -> Product { todo!() }
fn run() { let value = make(); value.finish(); }
`,
      },
      materialized,
    );
    expect(f.resolve("value.finish()")).toBeNull();
  });

  it.each([
    ["callee parameter", "fn run(make: fn() -> Product)", "let value = make();"],
    ["callee local", "fn run()", "let make = factory;\nlet value = make();"],
    ["callee pattern", "fn run()", "let (make, _) = pair;\nlet value = make();"],
    ["result shadow", "fn run()", "let value = make();\nlet value = unknown;"],
    ["result assignment", "fn run()", "let mut value = make();\nvalue = unknown;"],
    ["result update", "fn run()", "let mut value = make();\nvalue += unknown;"],
    ["result pattern", "fn run()", "let value = make();\nlet (value, _) = pair;"],
    ["closure", "fn run()", "let value = make();\nlet closure = |make| make();"],
    ["nested function", "fn run()", "let value = make();\nfn nested() {}"],
    ["local const", "fn run()", "const make: fn() -> Product = other;\nlet value = make();"],
    ["block-local result", "fn run()", "{ let value = make(); }"],
  ])("withholds extraction for unproved shadow safety: %s", (_name, header, body) => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
fn make() -> Product { todo!() }
${header} {
  ${body}
  value.finish();
}
`,
      },
      materialized,
    );
    expect(f.chunk().callResultBindings?.value).toBeUndefined();
  });

  it.each(["module::make()", "make::<Product>()", "make().await", "make()?", "(|| make())()", "make!()"])(
    "withholds unsupported initializer %s",
    (initializer) => {
      const f = fixture(
        {
          "src/main.rs": `${finishers}
fn make() -> Product { todo!() }
fn run() {
  let value = ${initializer};
  value.finish();
}
`,
        },
        materialized,
      );
      expect(f.chunk().callResultBindings?.value).toBeUndefined();
    },
  );

  // A dotted method init is a proven initializer since bd tea-rags-mcp-2g2og:
  // the receiver is fold-typed and the method's declared return answers, so it
  // moved out of the withheld list above.
  it("records a dotted method init and types the binding from it", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
struct Source;
impl Source { fn make(&self) -> Product { todo!() } }
fn run(source: &Source) {
  let value = source.make();
  value.finish();
}
`,
      },
      materialized,
    );
    expect(f.chunk().callResultBindings?.value).toEqual([
      expect.objectContaining({ callee: "source.make", endLine: expect.any(Number), scopeEndLine: expect.any(Number) }),
    ]);
    expect(f.resolve("value.finish()")).toEqual(productFinish);
  });

  it("keeps annotated locals and constructor bindings unchanged", () => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
fn make() -> Product { todo!() }
fn run() {
  let annotated: Product = make();
  let constructed = Product::new();
}
`,
      },
      materialized,
    );
    expect(f.chunk().localBindings).toEqual({
      annotated: [{ line: 9, type: "Product" }],
      constructed: [{ line: 10, type: "Product" }],
    });
    expect(f.chunk().callResultBindings).toBeUndefined();
  });

  it.each(["value.inner.finish()", "value.get().finish()"])("threads produced locals into %s", (call) => {
    const f = fixture(
      {
        "src/main.rs": `${finishers}
struct Holder { inner: Product }
impl Holder { fn get(&self) -> Product { todo!() } }
fn make() -> Holder { todo!() }
fn run() {
  let value = make();
  ${call};
}
`,
      },
      materialized,
    );
    expect(f.resolve(call)).toEqual(productFinish);
  });
});
