import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type {
  CallContext,
  FileExtraction,
  HierarchyView,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { symbolDefinitionsOf } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-definitions.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-s3i8m Task 2 — crate-scoped impl resolution. Rust forbids an
 * inherent impl outside the defining crate, so a type name unique inside its
 * crate owns every `T#m` / `T.m` the crate declares, in whatever file the impl
 * block sits. Every fixture keeps a namesake in a second crate so the global
 * short-name fallback stays ambiguous and only the crate-scoped read can answer.
 */
function fixture(files: Record<string, string>, hierarchy?: HierarchyView) {
  const language = new RustLanguage();
  const symbolTable = new InMemoryGlobalSymbolTable();
  const extractions: FileExtraction[] = [];
  for (const [relPath, code] of Object.entries(files)) {
    const parser = new Parser();
    parser.setLanguage(RustLang);
    const native = parser.parse(code);
    const tree = { rootNode: materializeTree(native.rootNode, code) };
    const chunks = collectSymbols(tree, language.walker.nameOf, "::", false, new DefaultSymbolIdComposer());
    const extraction = language.walker.walk({ tree, code, relPath, language: "rust", chunks });
    // The production table rows: walker chunks carry the declaration kind.
    symbolTable.upsertFile(relPath, symbolDefinitionsOf(extraction));
    extractions.push(extraction);
  }
  const structuredReturnTypes = Object.assign({}, ...extractions.map((file) => file.structuredReturnTypes));
  const typeDeclarations = Object.fromEntries(extractions.map((file) => [file.relPath, file.typeDeclarations ?? []]));
  return {
    resolve(text: string, file: string) {
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
        ...(hierarchy === undefined ? {} : { hierarchy }),
      };
      return language.resolver.resolve(call, ctx);
    },
  };
}

const crateB = {
  "b/src/lib.rs": "pub mod peer;\npub fn b_root() {}\n",
  "b/src/peer.rs": "pub struct Peer;\nimpl Peer {\n    pub fn region(&self) -> u64 { 0 }\n}\n",
};

const crateA = {
  "a/src/lib.rs": "pub mod peer;\npub mod ops;\npub mod other;\npub fn a_root() {}\n",
  "a/src/peer.rs": "pub struct Peer;\n",
  "a/src/ops.rs": `use crate::peer::Peer;
pub struct Region;
impl Region {
    pub fn id(&self) -> u64 { 0 }
}
impl Peer {
    pub fn region(&self) -> Region { Region }
}
`,
  "a/src/other.rs": `use crate::peer::Peer;
impl Peer {
    pub fn run(&self) {
        self.region();
        self.region().id();
    }
}
`,
};

describe("Rust crate-scoped impl members (s3i8m Task 2)", () => {
  it("self.m() reaches the crate-unique type's impl in another file of the same crate", () => {
    const f = fixture({ ...crateA, ...crateB });
    expect(f.resolve("self.region()", "a/src/other.rs")).toEqual({
      targetRelPath: "a/src/ops.rs",
      targetSymbolId: "Peer#region",
    });
  });

  it("places self on the crate-unique type so a self-rooted chain types through a cross-file impl", () => {
    const f = fixture({
      ...crateA,
      ...crateB,
      "b/src/region.rs": "pub struct Id;\nimpl Id {\n    pub fn id(&self) {}\n}\n",
    });
    expect(f.resolve("self.region().id()", "a/src/other.rs")).toEqual({
      targetRelPath: "a/src/ops.rs",
      targetSymbolId: "Region#id",
    });
  });

  it("declines when the crate declares the type name twice", () => {
    const f = fixture({ ...crateA, ...crateB, "a/src/legacy.rs": "pub struct Peer;\n" });
    expect(f.resolve("self.region()", "a/src/other.rs")).toBeNull();
  });

  it("declines when an inherent and a trait impl both define the member", () => {
    const f = fixture({
      ...crateA,
      ...crateB,
      "a/src/regioned.rs": `use crate::peer::Peer;
pub trait Regioned {
    fn region(&self) -> u64;
}
impl Regioned for Peer {
    fn region(&self) -> u64 { 1 }
}
`,
    });
    expect(f.resolve("self.region()", "a/src/other.rs")).toBeNull();
  });

  it("declines in a file no crate marker roots", () => {
    const f = fixture({
      ...crateB,
      "c/tests/x.rs": "pub struct Peer;\n",
      "c/tests/y.rs": "impl Peer {\n    pub fn region(&self) {}\n}\n",
      "c/tests/z.rs": "impl Peer {\n    pub fn run(&self) {\n        self.region();\n    }\n}\n",
    });
    expect(f.resolve("self.region()", "c/tests/z.rs")).toBeNull();
  });

  it("a cross-file impl's `-> Self::Assoc` return never types the chain as the owner (tikv write_batch)", () => {
    const f = fixture({
      "a/src/lib.rs": "pub mod engine;\npub mod wb;\npub fn a_root() {}\n",
      "a/src/engine.rs": `pub struct Engine;
impl Engine {
    pub fn run(&self) {
        self.write_batch().set_sequence_number();
    }
}
`,
      "a/src/wb.rs": `use crate::engine::Engine;
pub trait WriteBatchExt {
    type WriteBatch;
    fn write_batch(&self) -> Self::WriteBatch;
}
pub struct Batch;
impl Batch {
    pub fn set_sequence_number(&self) {}
}
impl WriteBatchExt for Engine {
    type WriteBatch = Batch;
    fn write_batch(&self) -> Self::WriteBatch { Batch }
}
`,
    });
    expect(f.resolve("self.write_batch().set_sequence_number()", "a/src/engine.rs")).toEqual({
      targetRelPath: "a/src/wb.rs",
      targetSymbolId: "Batch#set_sequence_number",
    });
  });

  it("a typed receiver resolves a member its type's crate declares in another file", () => {
    const f = fixture({
      ...crateB,
      "b/src/store.rs": "pub struct Other;\nimpl Other {\n    pub fn get(&self) {}\n}\n",
      "a/src/lib.rs": "pub mod store;\npub fn a_root() {}\n",
      "a/src/store.rs": "pub struct Store;\n",
      "a/src/store_ops.rs": "use crate::store::Store;\nimpl Store {\n    pub fn get(&self) {}\n}\n",
      "a/src/user.rs": "use crate::store::Store;\npub fn use_it(s: Store) {\n    s.get();\n}\n",
    });
    expect(f.resolve("s.get()", "a/src/user.rs")).toEqual({
      targetRelPath: "a/src/store_ops.rs",
      targetSymbolId: "Store#get",
    });
  });

  // bd tea-rags-mcp-s3i8m Task 1d — a typed pattern receiver whose type
  // implements a project trait reaches the trait's provided method.
  it("a typed pattern receiver resolves a trait-provided method through the implements hierarchy", () => {
    const hierarchy: HierarchyView = {
      getAncestors: (fqName) =>
        fqName === "Input"
          ? [
              {
                sourceFqName: "Input",
                ancestorFqName: "FormControl",
                ancestorSymbolId: null,
                kind: "implements",
                depth: 1,
              },
            ]
          : [],
      getDescendants: () => [],
    };
    const f = fixture(
      {
        ...crateB,
        "b/src/other.rs": "pub struct Other;\nimpl Other {\n    pub fn to_element(&self) -> u32 { 1 }\n}\n",
        "a/src/lib.rs": "pub mod form;\npub fn a_root() {}\n",
        "a/src/form.rs": `pub trait FormControl {
    fn to_element(&self) -> u32 { 0 }
}
pub struct Input;
impl Input {
    pub fn own(&self) {}
}
impl FormControl for Input {}
pub struct Owner;
impl Owner {
    pub fn input(&self) -> Option<Input> { None }
    pub fn run(&self) {
        if let Some(i) = self.input() {
            i.to_element();
        }
    }
}
`,
      },
      hierarchy,
    );
    expect(f.resolve("i.to_element()", "a/src/form.rs")).toEqual({
      targetRelPath: "a/src/form.rs",
      targetSymbolId: "FormControl#to_element",
    });
  });
});
