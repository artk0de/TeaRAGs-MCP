import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { collectTypeDeclarationReaders } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/type-declaration-readers.js";

/**
 * bd tea-rags-mcp-2g2og.24 slice 1 — `self.f…`, `local.f…` and method-call
 * chains typed through declared struct fields (named AND tuple) and declared
 * method returns (`Option`/`Result` unwrapped only by `?` / `unwrap` /
 * `expect`, owner generics substituted or dropped), multi-line receivers
 * included. A chain that ends on a std type with no project impl of the
 * member classifies EXTERNAL; one that ends on a project type resolves.
 */
function fixture(code: string) {
  const language = new RustLanguage();
  const runState = new CodegraphRunState(
    [],
    new Map(),
    new Map(),
    collectTypeDeclarationReaders(new LanguageFactory()),
  );
  const symbolTable = new InMemoryGlobalSymbolTable();
  const relPath = "src/main.rs";
  const tree = new Parser();
  tree.setLanguage(RustLang);
  const parsed = { rootNode: tree.parse(code).rootNode };
  const chunks = collectSymbols(parsed, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
  symbolTable.upsertFile(
    relPath,
    chunks.map((chunk) => ({
      ...chunk,
      fqName: chunk.symbolId,
      shortName: chunk.symbolId.split(/#|\.|::/).at(-1)!,
      relPath,
    })),
  );
  const extraction: FileExtraction = language.walker.walk({ tree: parsed, code, relPath, language: "rust", chunks });
  runState.absorb(extraction, []);
  const site = (text: string) => {
    const chunk = extraction.chunks.find((entry) => entry.calls.some((call) => call.callText === text));
    if (chunk === undefined) throw new Error(`no call ${text}`);
    const call = chunk.calls.find((entry) => entry.callText === text)!;
    const ctx: CallContext = {
      callerFile: relPath,
      callerScope: chunk.scope,
      callerSymbolId: chunk.symbolId,
      imports: extraction.imports,
      symbolTable,
      localBindings: chunk.localBindings,
      callResultBindings: chunk.callResultBindings,
      classFieldTypes: extraction.classFieldTypes,
      classFieldTypesByClassKey: runState.classFieldTypesByClassKey,
      structuredReturnTypes: extraction.structuredReturnTypes,
      typeDeclarations: runState.typeDeclarations,
    };
    return { call, ctx };
  };
  return {
    extraction,
    resolve(text: string) {
      const { call, ctx } = site(text);
      return language.resolver.resolve(call, ctx);
    },
    external(text: string) {
      const { call, ctx } = site(text);
      return language.resolver.targetsExternalImport?.(call, ctx);
    },
  };
}

// `Other#finish` / `Other#push` make every member a shared short name, so a
// global short-name fallback would have a candidate to (wrongly) land on.
const project = `struct Product; struct Other;
impl Product { fn finish(&self) {} }
impl Other { fn finish(&self) {} fn push(&self) {} fn is_empty(&self) {} fn clone(&self) {} fn is_some(&self) {} }`;
const productFinish = { targetRelPath: "src/main.rs", targetSymbolId: "Product#finish" };

describe("Rust self-field and method-return chains (2g2og.24)", () => {
  it("records tuple-struct positional fields in the placed field map", () => {
    const f = fixture(`${project}
struct Wrap(Product, Vec<u8>);`);
    expect(f.extraction.classFieldTypesByClassKey?.["src/main.rs::Wrap"]).toEqual({ "0": "Product", "1": "Vec" });
  });

  it("resolves a tuple field receiver `self.0`", () => {
    const f = fixture(`${project}
struct Wrap(Product);
impl Wrap { fn run(&self) { self.0.finish(); } }`);
    expect(f.resolve("self.0.finish()")).toEqual(productFinish);
  });

  it("resolves a multi-line self-field chain", () => {
    const f = fixture(`${project}
struct Inner { product: Product }
struct Holder { inner: Inner }
impl Holder { fn run(&self) {
    self.inner
        .product
        .finish();
} }`);
    const text = f.extraction.chunks
      .flatMap((chunk) => chunk.calls)
      .find((call) => call.member === "finish" && call.receiver?.includes("\n"))!.callText;
    expect(f.resolve(text)).toEqual(productFinish);
  });

  it("types a method return through owner generics it cannot substitute", () => {
    const f = fixture(`${project}
struct Store<E> { e: E }
impl<E> Store<E> { fn applied(&self) {} }
impl Other { fn applied(&self) {} }
struct Peer<E> { store: Store<E> }
impl<E> Peer<E> {
    fn get_store(&self) -> &Store<E> { &self.store }
    fn run(&self) { self.get_store().applied(); }
}`);
    expect(f.resolve("self.get_store().applied()")).toEqual({
      targetRelPath: "src/main.rs",
      targetSymbolId: "Store#applied",
    });
  });

  it("unwraps a declared Option return only through unwrap / expect / ?", () => {
    const f = fixture(`${project}
struct Holder;
impl Holder {
    fn product(&self) -> Option<Product> { None }
    fn run(&self) -> Option<()> {
        self.product().unwrap().finish();
        self.product().expect("x").finish();
        self.product()?.finish();
        None
    }
}`);
    expect(f.resolve("self.product().unwrap().finish()")).toEqual(productFinish);
    expect(f.resolve('self.product().expect("x").finish()')).toEqual(productFinish);
    expect(f.resolve("self.product()?.finish()")).toEqual(productFinish);
  });

  it("derefs a std smart-pointer field to its project target, but not for the pointer's own members", () => {
    const f = fixture(`${project}
use std::sync::Arc;
struct Holder { product: Arc<Product> }
impl Holder { fn run(&self) { self.product.finish(); self.product.clone(); } }`);
    expect(f.resolve("self.product.finish()")).toEqual(productFinish);
    expect(f.resolve("self.product.clone()")).toBeNull();
    expect(f.external("self.product.clone()")).toBe(true);
  });

  it("derefs a Box field like Rust's auto-deref (PIN-UPDATED: was 'Box is not transparent')", () => {
    const f = fixture(`${project}
struct Holder { value: Box<Product> }
fn run(holder: Holder) { holder.value.finish(); }`);
    expect(f.resolve("holder.value.finish()")).toEqual(productFinish);
  });

  it.each([
    ["self.items.push(1)", "struct Holder { items: Vec<u8> }", "impl Holder { fn run(&self) { self.items.push(1); } }"],
    [
      "self.inner.name.is_empty()",
      "struct Inner { name: String } struct Holder { inner: Inner }",
      "impl Holder { fn run(&self) { self.inner.name.is_empty(); } }",
    ],
    ["holder.items.push(1)", "struct Holder { items: Vec<u8> }", "fn run(holder: Holder) { holder.items.push(1); }"],
    [
      "self.maybe.is_some()",
      "struct Holder { maybe: Option<Product> }",
      "impl Holder { fn run(&self) { self.maybe.is_some(); } }",
    ],
  ])("classifies %s — a typed chain ending on a std type — external, never a short-name edge", (call, decl, body) => {
    const f = fixture(`${project}
${decl}
${body}`);
    expect(f.resolve(call)).toBeNull();
    expect(f.external(call)).toBe(true);
  });

  it("keeps a chain ending on a project type in the denominator when the member is missing", () => {
    const f = fixture(`${project}
struct Holder { product: Product }
impl Holder { fn run(&self) { self.product.push(); } }`);
    expect(f.resolve("self.product.push()")).toBeNull();
    expect(f.external("self.product.push()")).toBe(false);
  });

  it("keeps a std-typed chain in the denominator when the project implements the member on that std type", () => {
    const f = fixture(`${project}
trait Grow { fn grow(&mut self); }
impl Grow for Vec<u8> { fn grow(&mut self) {} }
struct Holder { items: Vec<u8> }
impl Holder { fn run(&mut self) { self.items.grow(); } }`);
    expect(f.external("self.items.grow()")).toBe(false);
  });
});
