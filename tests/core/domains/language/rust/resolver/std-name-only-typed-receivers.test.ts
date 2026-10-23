import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { collectTypeDeclarationReaders } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/type-declaration-readers.js";

/**
 * RESIDUAL R5 regressions on tikv: a std-prelude member (`unwrap`) on a
 * receiver the SOURCE types as the project's `Res<T>` lost its correct edge
 * because the static fold could not recover the type — a glob import hid the
 * same-file free function's declared return, and an associated-fn chain head
 * (`Decimal::from_bytes(..)`) was typed only for constructor-named functions.
 * The fold now types both; the no-evidence rule still drops an untyped
 * `x.unwrap()`.
 */
function edgesOf(code: string, materialized: boolean) {
  const language = new RustLanguage();
  const factory = new LanguageFactory();
  const runState = new CodegraphRunState([], new Map(), new Map(), collectTypeDeclarationReaders(factory));
  const symbolTable = new InMemoryGlobalSymbolTable();
  const relPath = "src/codec/decimal.rs";
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const native = parser.parse(code);
  const tree = { rootNode: materialized ? materializeTree(native.rootNode, code) : native.rootNode };
  const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
  const extraction: FileExtraction = language.walker.walk({ tree, code, relPath, language: "rust", chunks });
  symbolTable.upsertFile(
    relPath,
    extraction.chunks.map((chunk) => ({
      ...chunk,
      fqName: chunk.symbolId,
      shortName: chunk.symbolId.split(/#|\.|::/).at(-1)!,
      relPath,
    })),
  );
  runState.absorb(extraction, []);
  const chunk = extraction.chunks.find((entry) => entry.symbolId === "run")!;
  expect(chunk?.symbolId).toBe("run");
  const ctx: CallContext = {
    callerFile: relPath,
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
  return (callText: string): string | undefined => {
    const call = chunk.calls.find((entry) => entry.callText.replace(/\s+/g, "") === callText);
    expect(call?.callText.replace(/\s+/g, "")).toBe(callText);
    return language.resolver.resolve(call!, ctx)?.targetSymbolId ?? undefined;
  };
}

const declarations = `
use codec::prelude::*;

pub enum Res<T> { Ok(T), Truncated(T) }
impl<T> Res<T> {
  pub fn unwrap(self) -> T { todo!() }
}
pub struct Decimal;
pub struct Error;
impl Decimal {
  pub fn from_bytes(s: &[u8]) -> Result<Res<Decimal>, Error> { todo!() }
  pub fn round(&self, frac: i8) -> Res<Decimal> { todo!() }
}
fn fix_word_cnt_err(a: u8, b: u8) -> Res<Decimal> { todo!() }
`;

describe.each([false, true])("Rust R5 typed std-name receivers (materialized=%s)", (materialized) => {
  it("types a same-file free-fn result local behind a glob import (A: `let res = fix(..); res.unwrap()`)", () => {
    const target = edgesOf(
      `${declarations}
fn run(a: u8) {
  let res = fix_word_cnt_err(a, a);
  let v = res.unwrap();
}
`,
      materialized,
    );
    expect(target("res.unwrap()")).toBe("Res#unwrap");
  });

  it("types an associated-fn chain head by its declared return (B: `Decimal::from_bytes(s).unwrap().unwrap()`)", () => {
    const target = edgesOf(
      `${declarations}
fn run(s: &[u8]) {
  let d = Decimal::from_bytes(s).unwrap().unwrap();
}
`,
      materialized,
    );
    expect(target("Decimal::from_bytes(s).unwrap().unwrap()")).toBe("Res#unwrap");
    // The inner `unwrap` is the std `Result`'s — never the project namesake.
    expect(target("Decimal::from_bytes(s).unwrap()")).toBeUndefined();
  });

  it("types an associated-fn result local (A: `let d = Decimal::from_bytes(s).unwrap(); d.unwrap()`)", () => {
    const target = edgesOf(
      `${declarations}
fn run(s: &[u8]) {
  let d = Decimal::from_bytes(s).unwrap();
  let v = d.unwrap();
}
`,
      materialized,
    );
    expect(target("d.unwrap()")).toBe("Res#unwrap");
  });

  it("keeps a method-call chain head typed (B: `dec.round(2).unwrap()` on a `Decimal` param)", () => {
    const target = edgesOf(
      `${declarations}
fn run(dec: Decimal) {
  let r = dec.round(2).unwrap();
}
`,
      materialized,
    );
    expect(target("dec.round(2).unwrap()")).toBe("Res#unwrap");
  });

  it("still drops `x.unwrap()` on an untyped receiver bound only to the lone project `Res#unwrap`", () => {
    const target = edgesOf(
      `${declarations}
fn run() {
  let x = external::make();
  let v = x.unwrap();
}
`,
      materialized,
    );
    expect(target("x.unwrap()")).toBeUndefined();
  });
});
