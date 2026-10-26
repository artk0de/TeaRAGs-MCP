import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { symbolDefinitionsOf } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-definitions.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * Lexical scope of a Rust BARE call (`foo(..)`): nested fn items of the
 * enclosing fn bodies, then the enclosing module's free fns, then what that
 * module's `use super::*` glob brings in — never an impl member, never an item
 * across an inline `mod` boundary. Decided before the global short-name pass.
 */
function fixture(files: Record<string, string>, materialized: boolean, mainFile = "src/main.rs") {
  const language = new RustLanguage();
  const symbolTable = new InMemoryGlobalSymbolTable();
  const extractions: FileExtraction[] = [];
  for (const [relPath, code] of Object.entries(files)) {
    const parser = new Parser();
    parser.setLanguage(RustLang);
    const native = parser.parse(code);
    const tree = { rootNode: materialized ? materializeTree(native.rootNode, code) : native.rootNode };
    const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
    const extraction = language.walker.walk({ tree, code, relPath, language: "rust", chunks });
    symbolTable.upsertFile(relPath, symbolDefinitionsOf(extraction));
    extractions.push(extraction);
  }
  const extraction = extractions.find((entry) => entry.relPath === mainFile)!;
  return {
    symbolTable,
    definitions: symbolDefinitionsOf(extraction),
    resolve(text: string, symbolId: string) {
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
      };
      return language.resolver.resolve(call, ctx);
    },
  };
}

const at = (targetSymbolId: string, targetRelPath = "src/main.rs") => ({ targetRelPath, targetSymbolId });

describe.each([false, true])("Rust bare-call lexical scope (materialized=%s)", (materialized) => {
  it("resolves a same-file module fn despite workspace namesakes (free fn, method, associated fn)", () => {
    const f = fixture(
      {
        "src/main.rs": `
fn get_engine_type(dir: u32) -> u32 {
  dir
}
fn run() {
  get_engine_type(1);
}
`,
        "src/config.rs": `
pub struct Config;
impl Config {
  pub fn get_engine_type(&self) {}
}
pub struct Server;
impl Server {
  pub fn get_engine_type() {}
}
pub fn get_engine_type() {}
`,
      },
      materialized,
    );
    expect(f.resolve("get_engine_type(1)", "run")).toEqual(at("get_engine_type"));
  });

  it("never lands a bare call on a same-file method namesake of the enclosing impl", () => {
    const f = fixture(
      {
        "src/main.rs": `
struct S;
impl S {
  fn helper(&self) {}
  fn run(&self) {
    helper();
  }
}
fn helper() {}
`,
      },
      materialized,
    );
    expect(f.resolve("helper()", "S#run")).toEqual(at("helper"));
  });

  it("lets a nested fn item shadow the module fn of the same name", () => {
    const f = fixture(
      {
        "src/main.rs": `
fn helper() {}
fn run() {
  fn helper() {}
  helper();
}
`,
      },
      materialized,
    );
    expect(f.resolve("helper()", "run")).toEqual(at("run.helper"));
  });

  it("sees the enclosing fn's nested items from a nested fn body", () => {
    const f = fixture(
      {
        "src/main.rs": `
fn run() {
  fn sibling() {}
  fn inner() {
    sibling();
  }
  inner();
}
`,
        "src/other.rs": `
pub fn sibling() {}
`,
      },
      materialized,
    );
    expect(f.resolve("sibling()", "run.inner")).toEqual(at("run.sibling"));
  });

  it("reaches the outer module's fn from `mod tests { use super::*; }`", () => {
    const f = fixture(
      {
        "src/main.rs": `
fn helper() {}
#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn t() {
    helper();
  }
}
`,
        "src/other.rs": `
pub fn helper() {}
`,
      },
      materialized,
    );
    expect(f.resolve("helper()", "tests.t")).toEqual(at("helper"));
  });

  it("prefers the inline module's own fn over the glob-imported parent fn", () => {
    const f = fixture(
      {
        "src/main.rs": `
fn helper() {}
mod tests {
  use super::*;
  fn helper() {}
  fn t() {
    helper();
  }
}
`,
      },
      materialized,
    );
    expect(f.resolve("helper()", "tests.t")).toEqual(at("tests.helper"));
  });

  it("crosses an inline module boundary only into the parent its `use super::*` names, never a sibling", () => {
    const f = fixture(
      {
        "src/main.rs": `
fn helper() {}
mod a {
  pub fn helper() {}
}
mod b {
  use super::*;
  fn t() {
    helper();
  }
}
`,
      },
      materialized,
    );
    expect(f.resolve("helper()", "b.t")).toEqual(at("helper"));
  });

  it("does not resolve into a sibling inline module's fn the caller's module never imports", () => {
    const f = fixture(
      {
        "src/main.rs": `
mod a {
  pub fn helper() {}
}
mod b {
  fn t() {
    helper();
  }
}
`,
        "src/other.rs": `
pub fn helper() {}
`,
      },
      materialized,
    );
    expect(f.resolve("helper()", "b.t")).toBeNull();
  });

  it("lands cfg-gated twins on the one symbolId they share", () => {
    const f = fixture(
      {
        "src/main.rs": `
#[cfg(unix)]
fn helper() {}
#[cfg(windows)]
fn helper() {}
fn run() {
  helper();
}
`,
        "src/other.rs": `
pub fn helper() {}
`,
      },
      materialized,
    );
    expect(f.resolve("helper()", "run")).toEqual(at("helper"));
  });

  it("leaves two distinct same-scope candidates unresolved, never falling to the impl member", () => {
    const f = fixture(
      {
        "src/main.rs": `
fn helper() {}
struct S;
impl S {
  fn helper(&self) {}
  fn run(&self) {
    helper();
  }
}
`,
      },
      materialized,
    );
    // Two different ids for one same-scope name only arise from a model the
    // walker cannot express directly; inject the twin the symbol table holds.
    const twin = f.symbolTable.lookupByShortName("helper").find((def) => def.symbolId === "helper")!;
    f.symbolTable.upsertFile("src/main.rs", [
      ...f.definitions,
      { ...twin, symbolId: "helper@windows", fqName: "helper@windows" },
    ]);
    expect(f.resolve("helper()", "S#run")).toBeNull();
  });

  it("defers a `use x::foo as bar` rename to the import binding over a workspace namesake", () => {
    const f = fixture(
      {
        "src/main.rs": `
mod util;
use crate::util::foo as bar;
fn run() {
  bar();
}
`,
        "src/util.rs": `
pub fn foo() {}
`,
        "src/other.rs": `
pub fn bar() {}
`,
      },
      materialized,
    );
    expect(f.resolve("bar()", "run")).toEqual(at("foo", "src/util.rs"));
  });

  it("defers to an explicit `use` in the caller's inline module over the outer module's fn", () => {
    const f = fixture(
      {
        "src/main.rs": `
mod util;
fn foo() {}
mod tests {
  use crate::util::foo;
  fn t() {
    foo();
  }
}
`,
        "src/util.rs": `
pub fn foo() {}
`,
      },
      materialized,
    );
    expect(f.resolve("foo()", "tests.t")).toEqual(at("foo", "src/util.rs"));
  });
});
