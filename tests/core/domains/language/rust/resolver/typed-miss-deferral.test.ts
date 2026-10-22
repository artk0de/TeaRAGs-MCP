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
 * bd tea-rags-mcp-s3i8m.5 — the chain typing of 2g2og.24 is ADDITIVE: where
 * the typed hop cannot place the member (an unplaceable tuple field, an
 * owner placed on an impl-only file, a `Deref` whose target the fold cannot
 * follow) the call defers to the prior read instead of dropping. Only a
 * PROVEN miss — a declared project type with no such member anywhere and no
 * `Deref`, or a field whose declared type is provably foreign — still drops.
 */
function fixture(files: Record<string, string>) {
  const language = new RustLanguage();
  const runState = new CodegraphRunState(
    [],
    new Map(),
    new Map(),
    collectTypeDeclarationReaders(new LanguageFactory()),
  );
  const symbolTable = new InMemoryGlobalSymbolTable();
  const extractions: FileExtraction[] = [];
  for (const [relPath, code] of Object.entries(files)) {
    const parser = new Parser();
    parser.setLanguage(RustLang);
    const tree = { rootNode: materializeTree(parser.parse(code).rootNode, code) };
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
    runState.absorb(extraction, []);
    extractions.push(extraction);
  }
  const structuredReturnTypes = Object.assign({}, ...extractions.map((file) => file.structuredReturnTypes));
  return {
    resolve(member: string, file: string) {
      const extraction = extractions.find((entry) => entry.relPath === file)!;
      const chunk = extraction.chunks.find((entry) => entry.calls.some((call) => call.member === member))!;
      const call = chunk.calls.find((entry) => entry.member === member)!;
      const ctx: CallContext = {
        callerFile: file,
        callerScope: chunk.scope,
        callerSymbolId: chunk.symbolId,
        imports: extraction.imports,
        symbolTable,
        localBindings: chunk.localBindings,
        callResultBindings: chunk.callResultBindings,
        structuredReturnTypes,
        typeDeclarations: runState.typeDeclarations,
        classFieldTypes: extraction.classFieldTypes,
        classFieldTypesByClassKey: runState.classFieldTypesByClassKey,
      };
      return language.resolver.resolve(call, ctx);
    },
  };
}

describe("Rust chain typing defers to the prior read on an unplaceable typed hop (s3i8m.5)", () => {
  it("resolves `self.0.borrow_mut()` on a tuple field whose project wrapper type the fold cannot place", () => {
    // DomRefCell has impl blocks in two files, so its short name is not a
    // sole placement candidate — the typed hop is silent, not a miss.
    const f = fixture({
      "src/cell.rs": `
pub struct DomRefCell<T> { value: T }
impl<T> DomRefCell<T> { pub fn borrow_mut(&self) -> &T { &self.value } }
`,
      "src/size.rs": `
use crate::cell::DomRefCell;
pub trait SizeOf { fn size_of(&self) -> usize; }
impl<T> SizeOf for DomRefCell<T> { fn size_of(&self) -> usize { 0 } }
`,
      "src/storage.rs": `
use crate::cell::DomRefCell;
pub struct Entry;
pub struct AttributeStorage(DomRefCell<Vec<Entry>>);
impl AttributeStorage {
    pub fn clear(&self) { self.0.borrow_mut(); }
}
`,
    });
    expect(f.resolve("borrow_mut", "src/storage.rs")).toEqual({
      targetRelPath: "src/cell.rs",
      targetSymbolId: "DomRefCell#borrow_mut",
    });
  });

  it("keeps a tuple field of a provably foreign type unresolved instead of landing on a namesake", () => {
    const f = fixture({
      "src/lib.rs": `
use std::sync::Arc;
use url::Url;
pub struct ServoUrl(Arc<Url>);
impl ServoUrl {
    pub fn username(&self) -> &str { self.0.username() }
}
`,
    });
    expect(f.resolve("username", "src/lib.rs")).toBeNull();
  });

  it("resolves through a project Deref whose target the fold cannot follow (`get_store().commit_index()`)", () => {
    const f = fixture({
      "src/entry_storage.rs": `
pub struct EntryStorage<EK> { engine: EK }
impl<EK> EntryStorage<EK> { pub fn commit_index(&self) -> u64 { 0 } }
`,
      "src/peer_storage.rs": `
use std::ops::Deref;
use crate::entry_storage::EntryStorage;
pub struct PeerStorage<EK> { entry_storage: EntryStorage<EK> }
impl<EK> Deref for PeerStorage<EK> {
    type Target = EntryStorage<EK>;
    fn deref(&self) -> &Self::Target { &self.entry_storage }
}
`,
      "src/peer.rs": `
use crate::peer_storage::PeerStorage;
pub struct Peer<EK> { storage: PeerStorage<EK> }
impl<EK> Peer<EK> {
    pub fn get_store(&self) -> &PeerStorage<EK> { &self.storage }
    pub fn ready(&self) -> u64 { self.get_store().commit_index() }
}
`,
    });
    expect(f.resolve("commit_index", "src/peer.rs")).toEqual({
      targetRelPath: "src/entry_storage.rs",
      targetSymbolId: "EntryStorage#commit_index",
    });
  });

  it("resolves a multi-line field chain whose type the caller file only reopens with an impl block", () => {
    const f = fixture({
      "src/engine.rs": `
pub struct MemoryEngine;
impl MemoryEngine { pub fn bg_worker_manager(&self) -> u64 { 0 } }
`,
      "src/write_batch.rs": `
use crate::engine::MemoryEngine;
pub trait WriteBatchExt { fn batch(&self); }
impl WriteBatchExt for MemoryEngine { fn batch(&self) {} }
pub struct WriteBatch { engine: MemoryEngine }
impl WriteBatch {
    pub fn flush(&self) -> u64 {
        self
            .engine
            .bg_worker_manager()
    }
}
`,
    });
    expect(f.resolve("bg_worker_manager", "src/write_batch.rs")).toEqual({
      targetRelPath: "src/engine.rs",
      targetSymbolId: "MemoryEngine#bg_worker_manager",
    });
  });

  it("resolves through a project Deref whose target is a type alias (`self.ctx.router.state_cnt()`)", () => {
    const f = fixture({
      "src/router.rs": `
pub struct Router<N> { n: N }
impl<N> Router<N> { pub fn state_cnt(&self) -> usize { 0 } }
pub type BatchRouter<N> = Router<N>;
`,
      "src/store.rs": `
use std::ops::Deref;
use crate::router::BatchRouter;
pub struct RaftRouter { router: BatchRouter<u8> }
impl Deref for RaftRouter {
    type Target = BatchRouter<u8>;
    fn deref(&self) -> &BatchRouter<u8> { &self.router }
}
pub struct PollContext { router: RaftRouter }
pub struct StoreFsmDelegate { ctx: PollContext }
impl StoreFsmDelegate {
    pub fn count(&self) -> usize { self.ctx.router.state_cnt() }
}
`,
    });
    expect(f.resolve("state_cnt", "src/store.rs")).toEqual({
      targetRelPath: "src/router.rs",
      targetSymbolId: "Router#state_cnt",
    });
  });

  it("still drops a miss whose Deref declares a target no project type names (`-> &AttrValue`)", () => {
    const f = fixture({
      "src/main.rs": `
use std::ops::Deref;
use style::attr::AttrValue;
pub struct AttrValueRef(AttrValue);
impl Deref for AttrValueRef {
    type Target = AttrValue;
    fn deref(&self) -> &AttrValue { &self.0 }
}
pub struct ClipboardEventType;
impl ClipboardEventType { pub fn as_atom(&self) {} }
pub struct Attr;
impl Attr {
    pub fn value(&self) -> AttrValueRef { todo() }
    pub fn atom(&self) { self.value().as_atom(); }
}
`,
    });
    expect(f.resolve("as_atom", "src/main.rs")).toBeNull();
  });

  it("still drops a proven miss: a declared project type with no such member and no Deref", () => {
    const f = fixture({
      "src/main.rs": `
pub struct Engine;
impl Engine { pub fn start(&self) {} }
pub struct Other;
impl Other { pub fn stop(&self) {} }
pub struct Holder { engine: Engine }
impl Holder {
    pub fn run(&self) {
        self
            .engine
            .stop();
    }
}
`,
    });
    expect(f.resolve("stop", "src/main.rs")).toBeNull();
  });
});
