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
 * tikv's tidb codec declares `pub type Result<T> = std::result::Result<T, Error>;`
 * in `codec/error.rs`, re-exports it from `codec/mod.rs`
 * (`pub use self::error::{Error, Result};`) and `decimal.rs` imports it through
 * that re-export. A `-> Result<Res<Decimal>>` return is std's `Result`: its
 * `unwrap` / `unwrap_err` are std's (the rustc driver agrees), and the NEXT
 * hop is the project's `Res`. Before the alias was followed through the
 * re-export the first hop landed on a project namesake (`Res#unwrap`,
 * `PessimisticLockKeyResult#unwrap_err`).
 */
function fixture(files: Record<string, string>, callerFile: string, materialized: boolean) {
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
  const extraction = extractions.find((entry) => entry.relPath === callerFile)!;
  return (callText: string, symbolId = "run"): string | undefined => {
    const chunk = extraction.chunks.find((entry) => entry.symbolId === symbolId)!;
    expect(chunk?.symbolId).toBe(symbolId);
    const call = chunk.calls.find((entry) => entry.callText.replace(/\s+/g, "") === callText)!;
    expect(call?.callText.replace(/\s+/g, "")).toBe(callText);
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
      moduleReexports: runState.moduleReexports,
      rustUseImportsByFile: runState.rustUseImportsByFile,
    };
    return language.resolver.resolve(call, ctx)?.targetSymbolId ?? undefined;
  };
}

const codec = (modBody: string) => ({
  "src/lib.rs": "pub mod codec;\npub mod other;\n",
  "src/codec/mod.rs": `pub mod error;\npub mod decimal;\n${modBody}\n`,
  "src/codec/error.rs": "pub struct Error;\npub type Result<T> = std::result::Result<T, Error>;\n",
  // A lone project `unwrap_err` namesake elsewhere, as tikv's PessimisticLockKeyResult.
  "src/other.rs": "pub enum LockResult { A }\nimpl LockResult { pub fn unwrap_err(self) -> u8 { 0 } }\n",
});

const decimal = (body: string) => `
use crate::codec::{Error, Result};

pub enum Res<T> { Ok(T), Truncated(T) }
impl<T> Res<T> {
  pub fn unwrap(self) -> T { todo!() }
}
// The impl block names the alias Result in this file; it declares no type.
impl<T> From<Res<T>> for Result<T> {
  fn from(r: Res<T>) -> Result<T> { todo!() }
}
pub struct Decimal;
impl Decimal {
  pub fn from_bytes(s: &[u8]) -> Result<Res<Decimal>> { todo!() }
}
${body}
`;

describe.each([false, true])("Rust re-exported project Result alias (materialized=%s)", (materialized) => {
  const reexported = "pub use self::error::{Error, Result};";

  it("types `T::assoc(..)` returning a re-exported alias as std `Result`: first hop std, next hop `Res`", () => {
    const target = fixture(
      {
        ...codec(reexported),
        "src/codec/decimal.rs": decimal("fn run(s: &[u8]) {\n  let v = Decimal::from_bytes(s).unwrap().unwrap();\n}"),
      },
      "src/codec/decimal.rs",
      materialized,
    );
    expect(target("Decimal::from_bytes(s).unwrap()")).toBeUndefined();
    expect(target("Decimal::from_bytes(s).unwrap().unwrap()")).toBe("Res#unwrap");
  });

  it("keeps std `unwrap` / `unwrap_err` on the alias off project namesakes inside a `mod tests` glob scope", () => {
    const target = fixture(
      {
        ...codec(reexported),
        "src/codec/decimal.rs": decimal(
          "mod tests {\n  use super::*;\n  fn run(s: &[u8]) {\n    let d = Decimal::from_bytes(s).unwrap();\n    let e = d.unwrap();\n    Decimal::from_bytes(s).unwrap_err();\n  }\n}",
        ),
      },
      "src/codec/decimal.rs",
      materialized,
    );
    expect(target("Decimal::from_bytes(s).unwrap()", "tests.run")).toBeUndefined();
    expect(target("Decimal::from_bytes(s).unwrap_err()", "tests.run")).toBeUndefined();
    expect(target("d.unwrap()", "tests.run")).toBe("Res#unwrap");
  });

  it("types the alias the same way for a caller in another file", () => {
    const target = fixture(
      {
        ...codec(`${reexported}\npub mod arith;`),
        "src/codec/decimal.rs": decimal(""),
        "src/codec/arith.rs":
          "use crate::codec::decimal::Decimal;\nfn run(s: &[u8]) {\n  let v = Decimal::from_bytes(s).unwrap().unwrap();\n}\n",
      },
      "src/codec/arith.rs",
      materialized,
    );
    expect(target("Decimal::from_bytes(s).unwrap()")).toBeUndefined();
    expect(target("Decimal::from_bytes(s).unwrap().unwrap()")).toBe("Res#unwrap");
  });

  it("expands an alias whose body names std `Result` through a renaming `use` (backup-stream `StdResult`)", () => {
    const target = fixture(
      {
        ...codec(reexported),
        "src/codec/error.rs":
          "use std::{fmt, result::Result as StdResult};\npub struct Error;\npub type Result<T> = StdResult<T, Error>;\n",
        "src/codec/decimal.rs": decimal("fn run(s: &[u8]) {\n  let v = Decimal::from_bytes(s).unwrap().unwrap();\n}"),
      },
      "src/codec/decimal.rs",
      materialized,
    );
    expect(target("Decimal::from_bytes(s).unwrap()")).toBeUndefined();
    expect(target("Decimal::from_bytes(s).unwrap().unwrap()")).toBe("Res#unwrap");
  });

  it("keeps a trait-provided default method on a receiver the alias types (tikv runner `Exec::new(..)?.collect_summary(..)`)", () => {
    const target = fixture(
      {
        ...codec(reexported),
        "src/codec/decimal.rs": decimal(
          "pub trait BatchExecutor { fn collect_summary(self, i: usize) -> u8 { 0 } }\nimpl BatchExecutor for Decimal {}\nfn run(s: &[u8]) {\n  let v = Decimal::from_bytes(s).unwrap().unwrap().collect_summary(1);\n}",
        ),
      },
      "src/codec/decimal.rs",
      materialized,
    );
    expect(target("Decimal::from_bytes(s).unwrap().unwrap().collect_summary(1)")).toBe("BatchExecutor#collect_summary");
  });

  it("reads `StdResult` through its `use` over a same-name impl block in the alias file (backup-stream errors.rs)", () => {
    const target = fixture(
      {
        ...codec(reexported),
        "src/codec/error.rs":
          "use std::result::Result as StdResult;\npub struct Error;\npub type Result<T> = StdResult<T, Error>;\npub trait Report { fn report(self); }\nimpl<T> Report for StdResult<T, Error> { fn report(self) {} }\n",
        "src/codec/decimal.rs": decimal("fn run(s: &[u8]) {\n  let v = Decimal::from_bytes(s).unwrap().unwrap();\n}"),
      },
      "src/codec/decimal.rs",
      materialized,
    );
    expect(target("Decimal::from_bytes(s).unwrap()")).toBeUndefined();
    expect(target("Decimal::from_bytes(s).unwrap().unwrap()")).toBe("Res#unwrap");
  });

  it("keeps the alias std when its argument is an unplaced external type (`-> Result<TimeStamp>`)", () => {
    const target = fixture(
      {
        ...codec(reexported),
        "src/codec/decimal.rs": decimal(
          "pub struct DataFile;\nimpl DataFile {\n  fn begin_ts(v: u8) -> Result<txn_types::TimeStamp> { todo!() }\n}\nfn run() {\n  let t = DataFile::begin_ts(1).unwrap();\n}",
        ),
      },
      "src/codec/decimal.rs",
      materialized,
    );
    expect(target("DataFile::begin_ts(1).unwrap()")).toBeUndefined();
  });

  it("drops a std method a typed project receiver provably lacks instead of binding a namesake (tikv `p.to_string()`)", () => {
    const target = fixture(
      {
        ...codec(reexported),
        "src/other.rs":
          "pub enum LockResult { A }\nimpl LockResult { pub fn unwrap_err(self) -> u8 { 0 } }\npub struct Datum;\nimpl Datum { pub fn to_string(&self) -> u8 { 0 } }\n",
        "src/codec/decimal.rs": decimal(
          'pub struct Time;\nimpl Time {\n  pub fn parse(s: &str) -> Result<Time> { todo!() }\n}\nfn run() {\n  let p = Time::parse("x").unwrap();\n  let s = p.to_string();\n}',
        ),
      },
      "src/codec/decimal.rs",
      materialized,
    );
    expect(target("p.to_string()")).toBeUndefined();
  });

  it("reads the alias past a grouped `use super::{X, *}` in the tests module (tikv decimal.rs:2931)", () => {
    const target = fixture(
      {
        ...codec(reexported),
        "src/codec/decimal.rs": decimal(
          "mod tests {\n  use super::{Decimal, *};\n  fn run(s: &[u8]) {\n    let v = Decimal::from_bytes(s).unwrap().unwrap();\n  }\n}",
        ),
      },
      "src/codec/decimal.rs",
      materialized,
    );
    expect(target("Decimal::from_bytes(s).unwrap()", "tests.run")).toBeUndefined();
    expect(target("Decimal::from_bytes(s).unwrap().unwrap()", "tests.run")).toBe("Res#unwrap");
  });

  it("refuses an alias the re-export chain cannot place: no hop is typed, nothing binds by name", () => {
    const target = fixture(
      {
        ...codec("pub use self::error::Error;"),
        "src/codec/decimal.rs": decimal("fn run(s: &[u8]) {\n  let v = Decimal::from_bytes(s).unwrap().unwrap();\n}"),
      },
      "src/codec/decimal.rs",
      materialized,
    );
    expect(target("Decimal::from_bytes(s).unwrap()")).toBeUndefined();
    expect(target("Decimal::from_bytes(s).unwrap().unwrap()")).toBeUndefined();
  });
});
