import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function fixture(files: Record<string, string>, materialized: boolean) {
  const language = new RustLanguage();
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
    extractions.push(language.walker.walk({ tree, code, relPath, language: "rust", chunks }));
  }
  const structuredReturnTypes = Object.assign({}, ...extractions.map((file) => file.structuredReturnTypes));
  const typeDeclarations = Object.fromEntries(extractions.map((file) => [file.relPath, file.typeDeclarations ?? []]));
  return {
    extractions,
    resolve(text: string, file = "src/main.rs") {
      const extraction = extractions.find((entry) => entry.relPath === file)!;
      const chunk = extraction.chunks.find((entry) => entry.calls.some((call) => call.callText === text))!;
      const call = chunk.calls.find((entry) => entry.callText === text)!;
      const ctx: CallContext = {
        callerFile: file,
        callerScope: chunk.scope,
        callerSymbolId: chunk.symbolId,
        imports: extraction.imports,
        symbolTable,
        localBindings: chunk.localBindings,
        structuredReturnTypes,
        typeDeclarations,
      };
      return language.resolver.resolve(call, ctx);
    },
  };
}

const declarations = `
struct Builder;
struct Product;
struct Other;
impl Builder {
  fn new() -> Self { todo!() }
  fn product(&self) -> Product { todo!() }
  fn again(&self) -> Self { todo!() }
}
impl Product { fn finish(&self) {} }
impl Other { fn finish(&self) {} }
fn run(builder: Builder) {
  Builder::new().product().finish();
  builder.again().product().finish();
}
`;

describe.each([false, true])("Rust declared return chains (materialized=%s)", (materialized) => {
  it("publishes exact file-qualified callable returns and consumes them through the public language", () => {
    const f = fixture({ "src/main.rs": declarations }, materialized);
    expect(f.extractions[0].structuredReturnTypes?.["src/main.rs::Builder#product"]).toEqual({
      form: "instance",
      name: "Product",
    });
    expect(f.extractions[0].structuredReturnTypes?.["src/main.rs::Builder.new"]).toEqual({
      form: "instance",
      name: "Self",
    });
    expect(f.resolve("Builder::new().product().finish()")).toEqual({
      targetRelPath: "src/main.rs",
      targetSymbolId: "Product#finish",
    });
    expect(f.resolve("builder.again().product().finish()")).toEqual({
      targetRelPath: "src/main.rs",
      targetSymbolId: "Product#finish",
    });
  });

  it("substitutes only the generic parameters named by the receiver's owner declaration", () => {
    const f = fixture(
      {
        "src/main.rs": `
struct Holder<T> { value: T }
struct Product;
struct Other;
impl<T> Holder<T> { fn get(&self) -> T { todo!() } }
impl Product { fn finish(&self) {} }
impl Other { fn finish(&self) {} }
fn run(holder: Holder<Product>) { holder.get().finish(); }
`,
      },
      materialized,
    );
    expect(f.extractions[0].chunks.find((chunk) => chunk.symbolId === "run")?.localBindings?.holder[0].typeRef).toEqual(
      { form: "instance", name: "Holder", args: [{ form: "instance", name: "Product" }] },
    );
    expect(f.resolve("holder.get().finish()")).toEqual({
      targetRelPath: "src/main.rs",
      targetSymbolId: "Product#finish",
    });
  });

  it.each(["Holder<Product>", "&Holder<Product>"])(
    "retains generic arguments from an annotated let binding %s",
    (annotation) => {
      const f = fixture(
        {
          "src/main.rs": `
struct Holder<T> { value: T }
struct Product; struct Other;
impl<T> Holder<T> { fn get(&self) -> T { todo!() } }
impl Product { fn finish(&self) {} } impl Other { fn finish(&self) {} }
fn run() {
    let holder: ${annotation} = todo!();
    holder.get().finish();
}
`,
        },
        materialized,
      );
      expect(f.extractions[0].chunks.find((chunk) => chunk.symbolId === "run")?.localBindings?.holder[0]).toMatchObject(
        {
          type: "Holder",
          typeRef: { form: "instance", name: "Holder", args: [{ form: "instance", name: "Product" }] },
        },
      );
      expect(f.resolve("holder.get().finish()")).toEqual({
        targetRelPath: "src/main.rs",
        targetSymbolId: "Product#finish",
      });
    },
  );

  it("keeps a bounded type parameter's annotated let binding as its original bare type", () => {
    const f = fixture(
      {
        "src/main.rs": `
struct Worker;
fn run<T: Worker>() { let value: T = todo!(); value.go(); }
`,
      },
      materialized,
    );
    expect(f.extractions[0].chunks.find((chunk) => chunk.symbolId === "run")?.localBindings?.value).toEqual([
      { line: 3, type: "T" },
    ]);
  });

  it("declines an imported generic argument even when a local type has the same name", () => {
    const f = fixture(
      {
        "src/main.rs": `
use external::Product;
struct Holder<T> { value: T } struct Product; struct Other;
impl<T> Holder<T> { fn get(&self) -> T { todo!() } }
impl Product { fn finish(&self) {} } impl Other { fn finish(&self) {} }
fn run() { let holder: Holder<Product> = todo!(); holder.get().finish(); }
`,
      },
      materialized,
    );
    expect(f.extractions[0].chunks.find((chunk) => chunk.symbolId === "run")?.localBindings?.holder[0].typeRef).toEqual(
      { form: "instance", name: "Holder", args: [{ form: "instance", name: "Product" }] },
    );
    expect(f.resolve("holder.get().finish()")).toBeNull();
  });

  it("declines an ambiguous generic argument without selecting a global namesake", () => {
    const f = fixture(
      {
        "src/main.rs": `
struct Holder<T> { value: T }
impl<T> Holder<T> { fn get(&self) -> T { todo!() } }
fn run() { let holder: Holder<Product> = todo!(); holder.get().finish(); }
`,
        "src/a.rs": "struct Product; impl Product { fn finish(&self) {} }",
        "src/b.rs": "struct Product; impl Product { fn finish(&self) {} }",
      },
      materialized,
    );
    expect(f.extractions[0].chunks.find((chunk) => chunk.symbolId === "run")?.localBindings?.holder[0].typeRef).toEqual(
      { form: "instance", name: "Holder", args: [{ form: "instance", name: "Product" }] },
    );
    expect(f.resolve("holder.get().finish()")).toBeNull();
  });

  it("uses a constructor's declared non-Self return for new compound inference", () => {
    const f = fixture(
      {
        "src/main.rs": `
struct Builder; struct Actual; struct Product; struct Other;
impl Builder { fn new() -> Actual { todo!() } fn product(&self) -> Other { todo!() } }
impl Actual { fn product(&self) -> Product { todo!() } }
impl Product { fn finish(&self) {} } impl Other { fn finish(&self) {} }
fn run() { Builder::new().product().finish(); }
`,
      },
      materialized,
    );
    expect(f.resolve("Builder::new().product().finish()")).toEqual({
      targetRelPath: "src/main.rs",
      targetSymbolId: "Product#finish",
    });
  });

  it.each(["", "-> std::io::Error"])("does not seed new compound inference from a constructor return %s", (returns) => {
    const f = fixture(
      {
        "src/main.rs": `
struct Builder; struct Product; struct Other;
impl Builder { fn new() ${returns} { todo!() } fn product(&self) -> Product { todo!() } }
impl Product { fn finish(&self) {} } impl Other { fn finish(&self) {} }
fn run() { Builder::new().product().finish(); }
`,
      },
      materialized,
    );
    expect(f.resolve("Builder::new().product().finish()")).toBeNull();
  });

  it.each(["impl<T> Holder<Vec<T>>", "impl<U> Holder<U>"])(
    "declines non-identity owner substitution in %s",
    (owner) => {
      const f = fixture(
        {
          "src/main.rs": `
struct Holder<T> { value: T } struct Product; struct Other;
${owner} { fn get(&self) -> T { todo!() } }
impl Product { fn finish(&self) {} } impl Other { fn finish(&self) {} }
fn run(holder: Holder<Product>) { holder.get().finish(); }
`,
        },
        materialized,
      );
      expect(f.resolve("holder.get().finish()")).toBeNull();
    },
  );

  it("declines an externally imported return alias despite an in-project namesake", () => {
    const f = fixture(
      {
        "src/main.rs": `
use std::io::Error as Product;
struct Builder; struct Product; struct Other;
impl Builder { fn new() -> Self { todo!() } fn product(&self) -> Product { todo!() } }
impl Product { fn finish(&self) {} } impl Other { fn finish(&self) {} }
fn run() { Builder::new().product().finish(); }
`,
      },
      materialized,
    );
    expect(f.resolve("Builder::new().product().finish()")).toBeNull();
  });

  it("keeps same-file module namesakes separate", () => {
    const f = fixture(
      {
        "src/main.rs": `
mod left {
  pub struct Builder; pub struct Product;
  impl Builder { pub fn new() -> Self { todo!() } pub fn product(&self) -> Product { todo!() } }
  impl Product { pub fn finish(&self) {} }
  fn run() { Builder::new().product().finish(); }
}
mod right {
  pub struct Builder; pub struct Product;
  impl Builder { pub fn product(&self) -> Product { todo!() } }
  impl Product { pub fn finish(&self) {} }
}
`,
      },
      materialized,
    );
    expect(f.resolve("Builder::new().product().finish()")).toEqual({
      targetRelPath: "src/main.rs",
      targetSymbolId: "left::Product#finish",
    });
  });

  it.each([
    ["fn product(&self) {}", "missing declared return"],
    ["fn product(&self) -> std::io::Error { todo!() }", "external return"],
    ["fn product<T>(&self) -> T { todo!() }", "unknown method generic"],
  ])("declines a chain with %s (%s)", (method) => {
    const f = fixture(
      {
        "src/main.rs": `struct Builder; struct A; struct B;
impl Builder { fn new() -> Self { todo!() } ${method} }
impl A { fn finish(&self) {} } impl B { fn finish(&self) {} }
fn run() { Builder::new().product().finish(); }`,
      },
      materialized,
    );
    expect(f.resolve("Builder::new().product().finish()")).toBeNull();
  });

  it("does not resolve another file's imported return using the caller's imports", () => {
    const f = fixture(
      {
        "src/lib.rs": `use external::Product;
struct Builder; impl Builder { fn product(&self) -> Product { todo!() } }`,
        "src/main.rs": `struct Product; struct Other;
impl Product { fn finish(&self) {} } impl Other { fn finish(&self) {} }
fn run(builder: Builder) { builder.product().finish(); }`,
      },
      materialized,
    );
    expect(f.resolve("builder.product().finish()")).toBeNull();
  });

  it("declines ambiguous returned types rather than choosing a global namesake", () => {
    const f = fixture(
      {
        "src/main.rs": `struct Builder; impl Builder { fn new() -> Self { todo!() } fn product(&self) -> Product { todo!() } }
fn run() { Builder::new().product().finish(); }`,
        "src/a.rs": "struct Product; impl Product { fn finish(&self) {} }",
        "src/b.rs": "struct Product; impl Product { fn finish(&self) {} }",
      },
      materialized,
    );
    expect(f.resolve("Builder::new().product().finish()")).toBeNull();
  });

  it.each([
    [
      "async fn new() -> Self",
      "fn product(&self) -> Product",
      "Builder::new().product().finish()",
      "src/main.rs::Builder.new",
    ],
    [
      "fn new() -> Self",
      "async fn product(&self) -> Product",
      "builder.product().finish()",
      "src/main.rs::Builder#product",
    ],
  ])(
    "withholds async callable return for %s until the future is awaited",
    (constructor, method, callText, returnKey) => {
      const f = fixture(
        {
          "src/main.rs": `
struct Builder; struct Product; struct Other;
impl Builder { ${constructor} { todo!() } ${method} { todo!() } }
impl Product { fn finish(&self) {} } impl Other { fn finish(&self) {} }
fn run(builder: Builder) { ${callText}; }
`,
        },
        materialized,
      );
      expect(f.resolve(callText)).toBeNull();
      expect(f.extractions[0].structuredReturnTypes?.[returnKey]).toBeUndefined();
    },
  );
});
