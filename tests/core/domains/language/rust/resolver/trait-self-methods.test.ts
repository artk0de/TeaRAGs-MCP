import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type {
  CallContext,
  FileExtraction,
  HierarchySnapshot,
  InheritanceEdgeRow,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
import { MapHierarchyView } from "../../../../../../src/core/domains/trajectory/codegraph/hierarchy-view/hierarchy-view.js";
import { symbolDefinitionsOf } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-definitions.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-s3i8m Task 2 rule 5 — a trait-provided `self.m()`: the
 * method body lives in a trait (a default method), and the impl that hands it
 * to `Self` is generated, derived, blanket, or simply does not override it.
 * Every fixture keeps an unrelated inherent namesake of the member so the
 * global short-name fallback stays ambiguous and only the trait read answers.
 * The hierarchy is built from the walker's own `implements` edges, as the
 * provider persists them.
 */
function fixture(files: Record<string, string>) {
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
    symbolTable.upsertFile(relPath, symbolDefinitionsOf(extraction));
    extractions.push(extraction);
  }
  const snapshot: HierarchySnapshot = { ancestorsBySource: {}, descendantsByAncestor: {} };
  for (const edge of extractions.flatMap((file) => file.inheritanceEdges ?? [])) {
    const row: InheritanceEdgeRow = {
      sourceFqName: edge.source,
      sourceSymbolId: null,
      ancestorFqName: edge.ancestor,
      ancestorSymbolId: null,
      kind: edge.kind,
      ordinal: edge.ordinal,
    };
    (snapshot.ancestorsBySource[edge.source] ??= []).push(row);
    (snapshot.descendantsByAncestor[edge.ancestor] ??= []).push(row);
  }
  const hierarchy = new MapHierarchyView(snapshot);
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
        hierarchy,
      };
      return language.resolver.resolve(call, ctx);
    },
  };
}

const crateRoot = { "s/src/lib.rs": "pub mod node;\npub fn s_root() {}\n" };

/** An unrelated inherent namesake of every member under test: the global short-name read stays ambiguous. */
const namesakes = {
  "s/src/other.rs": `pub struct Other;
impl Other {
    pub fn upcast(&self) {}
    pub fn downcast(&self) {}
    pub fn global(&self) {}
    pub fn ping(&self) {}
    pub fn len_hint(&self) {}
    pub fn write_bytes(&self) {}
    pub fn paint(&self) {}
}
`,
};

describe("Rust trait-provided self.m() (s3i8m Task 2 rule 5)", () => {
  it("a sole project trait declaring the member answers when no impl is visible (servo Castable#upcast)", () => {
    const f = fixture({
      ...crateRoot,
      ...namesakes,
      "s/src/inheritance.rs": "pub trait Castable {\n    fn upcast(&self) -> u32 { 0 }\n}\n",
      "s/src/virtual.rs": "pub trait Virtual {\n    fn hook(&self);\n}\n",
      "s/src/node.rs": `use crate::virtual::Virtual;
pub struct Node;
impl Virtual for Node {
    fn hook(&self) {}
}
impl Node {
    pub fn run(&self) {
        self.upcast();
    }
}
`,
    });
    expect(f.resolve("self.upcast()", "s/src/node.rs")).toEqual({
      targetRelPath: "s/src/inheritance.rs",
      targetSymbolId: "Castable#upcast",
    });
  });

  it("a std-overlapping member with no impl evidence declines (downcast)", () => {
    const f = fixture({
      ...crateRoot,
      ...namesakes,
      "s/src/inheritance.rs": "pub trait Castable {\n    fn downcast(&self) -> u32 { 0 }\n}\n",
      "s/src/node.rs": "pub struct Node;\nimpl Node {\n    pub fn run(&self) {\n        self.downcast();\n    }\n}\n",
    });
    expect(f.resolve("self.downcast()", "s/src/node.rs")).toBeNull();
  });

  it("a std-overlapping member resolves once the type visibly implements the declaring trait", () => {
    const f = fixture({
      ...crateRoot,
      ...namesakes,
      "s/src/inheritance.rs": "pub trait Castable {\n    fn downcast(&self) -> u32 { 0 }\n}\n",
      "s/src/node.rs": `use crate::inheritance::Castable;
pub struct Node;
impl Castable for Node {}
impl Node {
    pub fn run(&self) {
        self.downcast();
    }
}
`,
    });
    expect(f.resolve("self.downcast()", "s/src/node.rs")).toEqual({
      targetRelPath: "s/src/inheritance.rs",
      targetSymbolId: "Castable#downcast",
    });
  });

  it("a blanket-impl trait's provided method answers (servo DomGlobal#global)", () => {
    const f = fixture({
      ...crateRoot,
      ...namesakes,
      "s/src/reflector.rs": `pub trait DomObject {}
pub trait DomGlobal {
    fn global(&self) -> u32 { 0 }
}
impl<T: DomObject> DomGlobal for T {}
`,
      "s/src/node.rs": `use crate::reflector::DomObject;
pub struct Node;
impl DomObject for Node {}
impl Node {
    pub fn run(&self) {
        self.global();
    }
}
`,
    });
    expect(f.resolve("self.global()", "s/src/node.rs")).toEqual({
      targetRelPath: "s/src/reflector.rs",
      targetSymbolId: "DomGlobal#global",
    });
  });

  it("two project traits declaring the member and no impl evidence leave no edge", () => {
    const f = fixture({
      ...crateRoot,
      ...namesakes,
      "s/src/a.rs": "pub trait Alpha {\n    fn ping(&self) {}\n}\n",
      "s/src/b.rs": "pub trait Beta {\n    fn ping(&self) {}\n}\n",
      "s/src/node.rs": "pub struct Node;\nimpl Node {\n    pub fn run(&self) {\n        self.ping();\n    }\n}\n",
    });
    expect(f.resolve("self.ping()", "s/src/node.rs")).toBeNull();
  });

  it("a caller in `impl Tr for T` reaches Tr's default method even when another trait declares it", () => {
    const f = fixture({
      ...crateRoot,
      ...namesakes,
      "s/src/a.rs": "pub trait Alpha {\n    fn ping(&self) {}\n    fn hook(&self);\n}\n",
      "s/src/b.rs": "pub trait Beta {\n    fn ping(&self) {}\n}\n",
      "s/src/node.rs": `use crate::a::Alpha;
pub struct Node;
impl Alpha for Node {
    fn hook(&self) {
        self.ping();
    }
}
`,
    });
    expect(f.resolve("self.ping()", "s/src/node.rs")).toEqual({
      targetRelPath: "s/src/a.rs",
      targetSymbolId: "Alpha#ping",
    });
  });

  it("an impl on a foreign type never guesses: std's own methods answer `self` there (tikv SyncSender#try_send)", () => {
    const f = fixture({
      ...crateRoot,
      ...namesakes,
      "s/src/sink.rs": "pub trait DataSink {\n    fn try_send(&self) -> u32;\n}\n",
      "s/src/other_ping.rs": "pub struct Pinger;\nimpl Pinger {\n    pub fn try_send(&self) {}\n}\n",
      "s/src/transport.rs": `use std::sync::mpsc;
pub trait CasualRouter {
    fn send(&self);
}
impl CasualRouter for mpsc::SyncSender<u64> {
    fn send(&self) {
        self.try_send();
    }
}
`,
    });
    expect(f.resolve("self.try_send()", "s/src/transport.rs")).toBeNull();
  });

  describe("inside a trait default body", () => {
    const files = {
      ...crateRoot,
      ...namesakes,
      "s/src/base.rs": "pub trait Base {\n    fn write_bytes(&self) {}\n}\n",
      "s/src/unrelated.rs": "pub trait Unrelated {\n    fn write_bytes(&self) {}\n    fn len_hint(&self) {}\n}\n",
      "s/src/codec.rs": `use crate::base::Base;
pub trait Codec: Base {
    fn len_hint(&self) -> usize;
    fn encode(&self) {
        self.len_hint();
        self.write_bytes();
    }
}
`,
    };

    // A bodiless signature is in the table as `Tr::m`, a default method as `Tr#m`.
    it("a sibling signature of the same trait resolves to that trait", () => {
      expect(fixture(files).resolve("self.len_hint()", "s/src/codec.rs")).toEqual({
        targetRelPath: "s/src/codec.rs",
        targetSymbolId: "Codec::len_hint",
      });
    });

    it("a supertrait member resolves to the supertrait, not an unrelated namesake trait", () => {
      expect(fixture(files).resolve("self.write_bytes()", "s/src/codec.rs")).toEqual({
        targetRelPath: "s/src/base.rs",
        targetSymbolId: "Base#write_bytes",
      });
    });
  });

  it("a Deref target's member still wins over a trait fallback", () => {
    const f = fixture({
      ...crateRoot,
      ...namesakes,
      "s/src/paint.rs": "pub trait Paint {\n    fn paint(&self) {}\n}\n",
      "s/src/node.rs": `pub struct Inner;
impl Inner {
    pub fn paint(&self) {}
}
pub struct Node {
    inner: Inner,
}
impl std::ops::Deref for Node {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.inner
    }
}
impl Node {
    pub fn run(&self) {
        self.paint();
    }
}
`,
    });
    expect(f.resolve("self.paint()", "s/src/node.rs")).toEqual({
      targetRelPath: "s/src/node.rs",
      targetSymbolId: "Inner#paint",
    });
  });
  describe("generic Self in a blanket impl (s3i8m rule A)", () => {
    const decoders = {
      ...crateRoot,
      ...namesakes,
      "s/src/number.rs": "pub trait NumberDecoder {\n    fn read_u8(&mut self) -> u8 { 0 }\n}\n",
      "s/src/other_reader.rs": "pub trait OtherReader {\n    fn read_u8(&mut self) -> u8 { 0 }\n}\n",
      "s/src/bytes.rs": "pub struct Bytes;\nimpl Bytes {\n    pub fn read_u8(&self) {}\n}\n",
    };

    it("a bound on the impl's type parameter proves the declaring trait (tikv CompactByteDecoder)", () => {
      const f = fixture({
        ...decoders,
        "s/src/compact.rs": `use crate::number::NumberDecoder;
pub trait CompactByteDecoder {
    fn f(&mut self);
}
impl<T: NumberDecoder> CompactByteDecoder for T {
    fn f(&mut self) {
        self.read_u8();
    }
}
`,
      });
      expect(f.resolve("self.read_u8()", "s/src/compact.rs")).toEqual({
        targetRelPath: "s/src/number.rs",
        targetSymbolId: "NumberDecoder#read_u8",
      });
    });

    it("a where-clause bound proves the declaring trait", () => {
      const f = fixture({
        ...decoders,
        "s/src/compact.rs": `use crate::number::NumberDecoder;
pub trait CompactByteDecoder {
    fn f(&mut self);
}
impl<T> CompactByteDecoder for T
where
    T: NumberDecoder + ?Sized,
{
    fn f(&mut self) {
        self.read_u8();
    }
}
`,
      });
      expect(f.resolve("self.read_u8()", "s/src/compact.rs")).toEqual({
        targetRelPath: "s/src/number.rs",
        targetSymbolId: "NumberDecoder#read_u8",
      });
    });

    it("two bounds both declaring the member leave no edge", () => {
      const f = fixture({
        ...decoders,
        "s/src/compact.rs": `use crate::number::NumberDecoder;
use crate::other_reader::OtherReader;
pub trait CompactByteDecoder {
    fn f(&mut self);
}
impl<T: NumberDecoder + OtherReader> CompactByteDecoder for T {
    fn f(&mut self) {
        self.read_u8();
    }
}
`,
      });
      expect(f.resolve("self.read_u8()", "s/src/compact.rs")).toBeNull();
    });

    it("no bound declaring the member leaves no edge and never guesses", () => {
      const f = fixture({
        ...crateRoot,
        ...namesakes,
        "s/src/number.rs": "pub trait NumberDecoder {\n    fn read_u8(&mut self) -> u8 { 0 }\n}\n",
        "s/src/bytes.rs": "pub struct Bytes;\nimpl Bytes {\n    pub fn read_u8(&self) {}\n}\n",
        "s/src/marker.rs": "pub trait Marker {}\n",
        "s/src/compact.rs": `use crate::marker::Marker;
pub trait CompactByteDecoder {
    fn f(&mut self);
}
impl<T: Marker> CompactByteDecoder for T {
    fn f(&mut self) {
        self.read_u8();
    }
}
`,
      });
      expect(f.resolve("self.read_u8()", "s/src/compact.rs")).toBeNull();
    });
  });

  it("a namesake type in another crate lends its implements edges to no caller (s3i8m rule B)", () => {
    const f = fixture({
      "a/src/lib.rs": "pub mod peer;\npub mod store;\n",
      "a/src/store.rs": "pub trait Store {\n    fn region(&self) -> u32 { 0 }\n}\n",
      "a/src/other_store.rs": "pub trait OtherStore {\n    fn region(&self) -> u32 { 0 }\n}\n",
      "a/src/peer.rs": "use crate::store::Store;\npub struct Peer;\nimpl Store for Peer {}\n",
      "b/src/lib.rs": "pub mod peer;\n",
      "b/src/peer.rs": `pub struct Peer;
impl Peer {
    pub fn run(&self) {
        self.region();
    }
}
`,
      "b/src/region.rs": "pub struct Region;\nimpl Region {\n    pub fn region(&self) {}\n}\n",
    });
    expect(f.resolve("self.region()", "b/src/peer.rs")).toBeNull();
  });

  it("a crate namesake still lets the declaring file's own impls prove a trait (servo GPUCanvasContext#size)", () => {
    const f = fixture({
      "a/src/lib.rs": "pub mod canvas;\npub mod store;\n",
      "a/src/store.rs": "pub trait Store {\n    fn region(&self) -> u32 { 0 }\n}\n",
      "a/src/other_store.rs": "pub trait OtherStore {\n    fn region(&self) -> u32 { 0 }\n}\n",
      "a/src/stub.rs": "pub struct Canvas;\n",
      "a/src/canvas.rs": `use crate::store::Store;
pub struct Canvas;
impl Canvas {
    pub fn run(&self) {
        self.region();
    }
}
impl Store for Canvas {}
`,
    });
    expect(f.resolve("self.region()", "a/src/canvas.rs")).toEqual({
      targetRelPath: "a/src/store.rs",
      targetSymbolId: "Store#region",
    });
  });

  it("the enclosing impl's own header trait proves it even for a namesake Self", () => {
    const f = fixture({
      "a/src/lib.rs": "pub mod peer;\npub mod store;\n",
      "a/src/store.rs": "pub trait Store {\n    fn region(&self) -> u32 { 0 }\n    fn hook(&self);\n}\n",
      "a/src/other_store.rs": "pub trait OtherStore {\n    fn region(&self) -> u32 { 0 }\n}\n",
      "a/src/peer.rs": `use crate::store::Store;
pub struct Peer;
impl Store for Peer {
    fn hook(&self) {
        self.region();
    }
}
`,
      "a/src/peer2.rs": "pub struct Peer;\n",
    });
    expect(f.resolve("self.region()", "a/src/peer.rs")).toEqual({
      targetRelPath: "a/src/store.rs",
      targetSymbolId: "Store#region",
    });
  });
});
