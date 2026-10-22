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

/**
 * A type spelled in ANOTHER file's declaration (a callee's return, a struct's
 * field) is placed through THAT file's own `use` imports
 * (bd tea-rags-mcp-s3i8m letCall S4b).
 */
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
        moduleReexports: runState.moduleReexports,
        rustUseImportsByFile: runState.rustUseImportsByFile,
      };
      return language.resolver.resolve(call, ctx);
    },
    edges() {
      return new CallEdgeResolutionRunner(factory, runState).resolve(extraction, symbolTable).methodEdges;
    },
  };
}

// A second `path`/`m` owner elsewhere keeps the global short-name passes from
// answering by uniqueness: every edge asserted below is the placement's.
const namesakes = {
  "src/other.rs": `
pub struct TempDir; impl TempDir { pub fn path(&self) {} }
pub struct Peer; impl Peer { pub fn m(&self) {} }
pub struct B; impl B { pub fn m(&self) {} }
`,
};

describe.each([false, true])("Rust declaring-file type placement (materialized=%s)", (materialized) => {
  it("places a callee's return through the callee file's own import", () => {
    const f = fixture(
      {
        "src/main.rs": `use crate::dir::tmpdir;
fn run() {
  let td = tmpdir();
  td.path();
}
`,
        "src/dir.rs": `use crate::tests::TempDir;
pub fn tmpdir() -> TempDir { todo!() }
`,
        "src/tests.rs": "pub struct TempDir;\nimpl TempDir { pub fn path(&self) {} }",
        ...namesakes,
      },
      materialized,
    );
    expect(f.resolve("td.path()")).toEqual({ targetRelPath: "src/tests.rs", targetSymbolId: "TempDir#path" });
  });

  it("places a method return spelled through a renamed import", () => {
    const f = fixture(
      {
        "src/main.rs": `use crate::builder::Builder;
fn run(builder: Builder) {
  builder.c().m();
}
`,
        "src/builder.rs": `use crate::a::B as C;
pub struct Builder;
impl Builder { pub fn c(&self) -> C { todo!() } }
`,
        "src/a.rs": "pub struct B;\nimpl B { pub fn m(&self) {} }",
        ...namesakes,
      },
      materialized,
    );
    expect(f.resolve("builder.c().m()")).toEqual({ targetRelPath: "src/a.rs", targetSymbolId: "B#m" });
  });

  it("climbs a callee's `use super::` from the callee's own module", () => {
    const f = fixture(
      {
        "src/main.rs": `use crate::store::fsm::make_peer;
fn run() {
  let p = make_peer();
  p.m();
}
`,
        "src/store/fsm.rs": `use super::peer::Peer;
pub fn make_peer() -> Peer { todo!() }
`,
        "src/store/peer.rs": "pub struct Peer;\nimpl Peer { pub fn m(&self) {} }",
        ...namesakes,
      },
      materialized,
    );
    expect(f.resolve("p.m()")).toEqual({ targetRelPath: "src/store/peer.rs", targetSymbolId: "Peer#m" });
  });

  it("places a struct field's smart-pointer argument through the struct file's import", () => {
    const f = fixture(
      {
        "src/main.rs": `use crate::holder::Holder;
fn run(h: Holder) {
  h.inner.m();
}
`,
        "src/holder.rs": `use std::sync::Arc;
use crate::peer::Peer;
pub struct Holder { pub inner: Arc<Peer> }
`,
        "src/peer.rs": "pub struct Peer;\nimpl Peer { pub fn m(&self) {} }",
        ...namesakes,
      },
      materialized,
    );
    expect(f.resolve("h.inner.m()")).toEqual({ targetRelPath: "src/peer.rs", targetSymbolId: "Peer#m" });
  });

  it("follows a `pub use` re-export the callee's import names", () => {
    const f = fixture(
      {
        "src/main.rs": `use crate::dir::make_peer;
fn run() {
  let p = make_peer();
  p.m();
}
`,
        "src/dir.rs": `use crate::store::Peer;
pub fn make_peer() -> Peer { todo!() }
`,
        "src/store/mod.rs": "mod peer;\npub use self::peer::Peer;",
        "src/store/peer.rs": "pub struct Peer;\nimpl Peer { pub fn m(&self) {} }",
        ...namesakes,
      },
      materialized,
    );
    expect(f.resolve("p.m()")).toEqual({ targetRelPath: "src/store/peer.rs", targetSymbolId: "Peer#m" });
  });

  it.each([
    ["an external import", "use external::TempDir;", "pub struct TempDir;\nimpl TempDir { pub fn path(&self) {} }"],
    ["a glob import", "use crate::tests::*;", "pub struct TempDir;\nimpl TempDir { pub fn path(&self) {} }"],
    [
      "more than one candidate",
      "use crate::tests::TempDir;",
      "pub struct TempDir;\nimpl TempDir { pub fn path(&self) {} }\nmod inner { pub struct TempDir; impl TempDir { pub fn path(&self) {} } }",
    ],
  ])("declines a return bound by %s", (_label, importLine, testsFile) => {
    const f = fixture(
      {
        "src/main.rs": `use crate::dir::tmpdir;
fn run() {
  let td = tmpdir();
  td.path();
}
`,
        "src/dir.rs": `${importLine}
pub fn tmpdir() -> TempDir { todo!() }
`,
        "src/tests.rs": testsFile,
        ...namesakes,
      },
      materialized,
    );
    expect(f.resolve("td.path()")).toBeNull();
  });

  it("lets a typed miss on a placed type continue when a project trait declares the member", () => {
    const f = fixture(
      {
        "src/main.rs": `use crate::dir::tmpdir;
fn run() {
  let td = tmpdir();
  td.finish();
}
`,
        "src/dir.rs": `use crate::tests::TempDir;
pub fn tmpdir() -> TempDir { todo!() }
`,
        "src/tests.rs": `pub trait Finish { fn finish(&self) {} }
pub struct TempDir;
impl Finish for TempDir {}
impl TempDir { pub fn path(&self) {} }
`,
        ...namesakes,
      },
      materialized,
    );
    expect(f.edges()).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceSymbolId: "run", targetSymbolId: "Finish#finish" })]),
    );
  });
});
