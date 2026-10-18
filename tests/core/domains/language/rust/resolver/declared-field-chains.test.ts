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
    symbolTable.upsertFile(
      relPath,
      chunks.map((chunk) => ({
        ...chunk,
        fqName: chunk.symbolId,
        shortName: chunk.symbolId.split(/#|\.|::/).at(-1)!,
        relPath,
      })),
    );
    const extraction = language.walker.walk({ tree, code, relPath, language: "rust", chunks });
    extractions.push(extraction);
    runState.absorb(extraction, []);
  }
  return {
    extractions,
    runState,
    symbolTable,
    edges(file = "src/main.rs") {
      return new CallEdgeResolutionRunner(factory, runState).resolve(
        extractions.find((entry) => entry.relPath === file)!,
        symbolTable,
      );
    },
    resolve(text: string, file = "src/main.rs", callerSymbolId = /(?:^|[.#:]|::)run$/) {
      const extraction = extractions.find((entry) => entry.relPath === file)!;
      const chunk = extraction.chunks.find((entry) => entry.calls.some((call) => call.callText === text))!;
      const call = chunk.calls.find((entry) => entry.callText === text)!;
      expect(chunk.symbolId).toMatch(callerSymbolId);
      if (text.startsWith("holder.")) {
        expect(
          chunk.localBindings?.holder?.some((binding) => binding.typeRef !== undefined || binding.type !== undefined),
        ).toBe(true);
      }
      const ctx: CallContext = {
        callerFile: file,
        callerScope: chunk.scope,
        callerSymbolId: chunk.symbolId,
        imports: extraction.imports,
        symbolTable,
        localBindings: chunk.localBindings,
        classFieldTypes: extraction.classFieldTypes,
        classFieldTypesByClassKey: runState.classFieldTypesByClassKey,
        structuredReturnTypes: Object.assign({}, ...extractions.map((entry) => entry.structuredReturnTypes)),
        typeDeclarations: runState.typeDeclarations,
      };
      return language.resolver.resolve(call, ctx);
    },
  };
}

const finishers = `struct Product; struct Other;
impl Product { fn finish(&self) {} } impl Other { fn finish(&self) {} }`;
const productFinish = { targetRelPath: "src/main.rs", targetSymbolId: "Product#finish" };

describe.each([false, true])("Rust declared field chains (materialized=%s)", (materialized) => {
  it("publishes placed fields without changing the legacy field map", () => {
    const f = fixture(
      {
        "src/main.rs": `struct Holder<T> { value: T, wrapped: Wrapper<T>, product: Product }
struct Wrapper<U> { item: U } ${finishers}`,
      },
      materialized,
    );
    expect(f.extractions[0].classFieldTypesByClassKey).toEqual({
      "src/main.rs::Holder": { value: "T", wrapped: "Wrapper", product: "Product" },
      "src/main.rs::Wrapper": { item: "U" },
    });
    expect(f.extractions[0].typeDeclarations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          typeId: "Holder",
          genericParameters: ["T"],
          genericFieldParameters: { value: "T" },
          fieldTypeArguments: { wrapped: ["T"] },
        }),
      ]),
    );
    expect(f.extractions[0].classFieldTypes?.Holder).toEqual({ value: "T", wrapped: "Wrapper", product: "Product" });
  });

  it.each([
    ["holder.product.finish()", "struct Holder { product: Product }", "holder: Holder"],
    [
      "holder.inner.product.finish()",
      "struct Holder { inner: Inner } struct Inner { product: Product }",
      "holder: Holder",
    ],
    ["holder.value.finish()", "struct Holder<T> { value: T }", "holder: Holder<Product>"],
    [
      "holder.wrapped.item.finish()",
      "struct Holder { wrapped: Wrapper<Product> } struct Wrapper<T> { item: T }",
      "holder: Holder",
    ],
    [
      "holder.wrapped.item.finish()",
      "struct Holder<T> { wrapped: Wrapper<T> } struct Wrapper<U> { item: U }",
      "holder: Holder<Product>",
    ],
    ["holder.product.finish()", "struct Holder { product: &'static Product }", "holder: Holder"],
  ])("resolves %s through explicit struct fields", (call, declarations, parameter) => {
    const f = fixture(
      {
        "src/main.rs": `${declarations} ${finishers}
fn run(${parameter}) { ${call}; }`,
      },
      materialized,
    );
    expect(f.resolve(call)).toEqual(productFinish);
  });

  it("uses the declaring module's exact owner and nominal scope", () => {
    const f = fixture(
      {
        "src/main.rs": `
struct Holder { product: Other } ${finishers}
mod inner {
  struct Product; struct Holder { product: Product }
  impl Product { fn finish(&self) {} }
  fn run(holder: Holder) { holder.product.finish(); }
}`,
      },
      materialized,
    );
    expect(f.extractions[0].classFieldTypesByClassKey?.["src/main.rs::inner::Holder"]).toEqual({ product: "Product" });
    expect(f.resolve("holder.product.finish()")).toEqual({
      targetRelPath: "src/main.rs",
      targetSymbolId: "inner::Product#finish",
    });
  });

  it("seeds compound self chains from the lexical class rather than the method frame", () => {
    const f = fixture(
      {
        "src/main.rs": `struct Holder { inner: Inner } struct Inner { product: Product }
${finishers}
impl Holder { fn run(&self) { self.inner.product.finish(); } }`,
      },
      materialized,
    );
    expect(f.resolve("self.inner.product.finish()")).toEqual(productFinish);
  });

  it("does not seed self inside an associated function without an instance receiver", () => {
    const f = fixture(
      {
        "src/main.rs": `struct Holder { inner: Inner } struct Inner { product: Product }
${finishers}
impl Holder { fn run() { self.inner.product.finish(); } }`,
      },
      materialized,
    );
    expect(f.resolve("self.inner.product.finish()")).toBeNull();
  });

  it("does not inherit an instance self seed inside a nested free function", () => {
    const f = fixture(
      {
        "src/main.rs": `struct Holder { inner: Inner } struct Inner { product: Product }
${finishers}
impl Holder { fn run(&self) {
fn nested() { self.inner.product.finish(); }
} }`,
      },
      materialized,
    );
    const caller = f.extractions[0].chunks.find((chunk) =>
      chunk.calls.some((call) => call.callText === "self.inner.product.finish()"),
    )!;
    expect(caller.symbolId).toBe("Holder#run.nested");
    expect(caller.scope).toEqual(["Holder", "run"]);
    expect(caller.symbolKind).toBe("function");
    expect(f.resolve("self.inner.product.finish()", "src/main.rs", /^Holder#run\.nested$/)).toBeNull();
  });

  it("threads fields after declared method returns and constructor results", () => {
    const f = fixture(
      {
        "src/main.rs": `struct Holder; struct Inner { product: Product }
${finishers}
impl Holder { fn new() -> Self { todo!() } fn get(&self) -> Inner { todo!() } }
fn run(holder: Holder) { holder.get().product.finish(); Holder::new().get().product.finish(); }`,
      },
      materialized,
    );
    expect(f.resolve("holder.get().product.finish()")).toEqual(productFinish);
    expect(f.resolve("Holder::new().get().product.finish()")).toEqual(productFinish);
  });

  it("carries placed fields and generic facts through absorb and the production runner", () => {
    const f = fixture(
      {
        "src/main.rs": `struct Holder<T> { wrapped: Wrapper<T> } struct Wrapper<U> { item: U }
${finishers}
fn run(holder: Holder<Product>) { holder.wrapped.item.finish(); }`,
      },
      materialized,
    );
    expect(f.runState.classFieldTypesByClassKey["src/main.rs::Holder"]).toEqual({ wrapped: "Wrapper" });
    expect(f.edges().methodEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetRelPath: "src/main.rs", targetSymbolId: "Product#finish" }),
      ]),
    );
  });

  it("permits cross-file fields only when substituting an already placed owner argument", async () => {
    const f = fixture(
      {
        "src/holder.rs": "struct Holder<T> { value: T }",
        "src/main.rs": `${finishers}\nfn run(holder: Holder<Product>) { holder.value.finish(); }`,
      },
      materialized,
    );
    expect(f.resolve("holder.value.finish()")).toEqual(productFinish);
    expect(f.edges().methodEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetRelPath: "src/main.rs", targetSymbolId: "Product#finish" }),
      ]),
    );
    const persisted = f.edges("src/holder.rs").pass1Aggregates!;
    expect(persisted.classFieldTypesByClassKey).toEqual({ "src/holder.rs::Holder": { value: "T" } });
    expect(persisted.typeDeclarations).toEqual([
      expect.objectContaining({ typeId: "Holder", genericParameters: ["T"], genericFieldParameters: { value: "T" } }),
    ]);
    const factory = new LanguageFactory();
    const hydrated = new CodegraphRunState([], new Map(), new Map(), collectTypeDeclarationReaders(factory));
    const caller = f.extractions.find((entry) => entry.relPath === "src/main.rs")!;
    hydrated.absorb(caller, []);
    await hydrated.seal(
      async () => f.symbolTable,
      async () => [persisted],
    );
    expect(hydrated.classFieldTypesByClassKey["src/holder.rs::Holder"]).toEqual({ value: "T" });
    expect(new CallEdgeResolutionRunner(factory, hydrated).resolve(caller, f.symbolTable).methodEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetRelPath: "src/main.rs", targetSymbolId: "Product#finish" }),
      ]),
    );
  });

  it.each([
    ["struct Holder { missing: Product }", "holder: Holder", "holder.product.finish()", "missing field"],
    [
      "struct Holder; struct Wrong { product: Product }",
      "holder: Holder",
      "holder.product.finish()",
      "other owner's field",
    ],
    ["struct Holder<T> { value: T }", "holder: Holder", "holder.value.finish()", "unbound generic"],
    [
      "struct Holder { value: Option<Product> }",
      "holder: Holder",
      "holder.value.finish()",
      "Option is not transparent",
    ],
    ["struct Holder { value: Box<Product> }", "holder: Holder", "holder.value.finish()", "Box is not transparent"],
    [
      "struct Holder { value: Wrapper<Vec<Product>> } struct Wrapper<T> { item: T }",
      "holder: Holder",
      "holder.value.item.finish()",
      "nested generic shape",
    ],
    [
      "struct Holder { product: Product } struct Holder { product: Other }",
      "holder: Holder",
      "holder.product.finish()",
      "ambiguous owner",
    ],
    [
      "struct Holder { product: Product, product: Other }",
      "holder: Holder",
      "holder.product.finish()",
      "ambiguous field",
    ],
    ["struct Holder { product: Product }", "", "Holder.product.finish()", "class field access"],
    ["struct Holder { product: Product }", "", "Self.product.finish()", "unplaced Self"],
    ["struct Holder { value: (Product, Other) }", "holder: Holder", "holder.value.finish()", "tuple field"],
  ])("declines %s (%s, %s: %s)", (declarations, parameter, call) => {
    const f = fixture(
      { "src/main.rs": `${declarations} ${finishers}\nfn run(${parameter}) { ${call}; }` },
      materialized,
    );
    expect(f.resolve(call)).toBeNull();
  });

  it("does not consume an imported field alias despite local namesakes", () => {
    const f = fixture(
      {
        "src/main.rs": `use external::Product;
struct Holder { product: Product } ${finishers}
fn run(holder: Holder) { holder.product.finish(); }`,
      },
      materialized,
    );
    expect(f.resolve("holder.product.finish()")).toBeNull();
  });

  it("does not resolve a declaring file's nominal field using the caller's imports", () => {
    const f = fixture(
      {
        "src/holder.rs": "use external::Product; struct Holder { product: Product }",
        "src/main.rs": `${finishers}\nfn run(holder: Holder) { holder.product.finish(); }`,
      },
      materialized,
    );
    expect(f.resolve("holder.product.finish()")).toBeNull();
  });

  it("does not type fields after an external declared method return", () => {
    const f = fixture(
      {
        "src/main.rs": `struct Holder; struct Inner { product: Product } ${finishers}
impl Holder { fn get(&self) -> external::Inner { todo!() } }
fn run(holder: Holder) { holder.get().product.finish(); }`,
      },
      materialized,
    );
    expect(f.resolve("holder.get().product.finish()")).toBeNull();
  });
});
