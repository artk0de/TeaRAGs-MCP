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

function fixture(code: string, materialized: boolean) {
  const language = new RustLanguage();
  const factory = new LanguageFactory();
  const runState = new CodegraphRunState([], new Map(), new Map(), collectTypeDeclarationReaders(factory));
  const symbolTable = new InMemoryGlobalSymbolTable();
  const relPath = "src/main.rs";
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
  return {
    target(text: string, symbolId = "run", occurrence = 0) {
      const chunk = extraction.chunks.find((entry) => entry.symbolId === symbolId)!;
      expect(chunk?.symbolId).toBe(symbolId);
      const call = chunk.calls.filter((entry) => entry.callText === text)[occurrence];
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
      };
      return language.resolver.resolve(call, ctx)?.targetSymbolId ?? null;
    },
  };
}

const types = `
use std::collections::HashMap;
struct Foo;
struct Bar;
struct Peer;
struct Key;
impl Foo { fn m(&self) {} }
impl Bar { fn m(&self) {} }
impl Peer { fn m(&self) {} }
impl Key { fn m(&self) {} }
`;

const source = (body: string) => `${types}\n${body}\n`;

// bd tea-rags-mcp-s3i8m Task 1b — loop elements, closure adapter parameters,
// std element accessors and project enum variant payloads fold to a type.
describe.each([false, true])("Rust pattern binding element typing (materialized=%s)", (materialized) => {
  it("types a for element over a Vec field's iter()", () => {
    const f = fixture(
      source(
        `struct Holder { peers: Vec<Peer> }\nimpl Holder {\n    fn run(&self) {\n        for p in self.peers.iter() {\n            p.m();\n        }\n    }\n}`,
      ),
      materialized,
    );
    expect(f.target("p.m()", "Holder#run")).toBe("Peer#m");
  });

  it("types a for element over a borrowed Vec param", () => {
    const f = fixture(source(`fn run(v: Vec<Peer>) {\n    for p in &v {\n        p.m();\n    }\n}`), materialized);
    expect(f.target("p.m()")).toBe("Peer#m");
  });

  it("types the key and value of a for (k, v) over a HashMap", () => {
    const f = fixture(
      source(`fn run(map: HashMap<Key, Peer>) {\n    for (k, v) in map {\n        v.m();\n        k.m();\n    }\n}`),
      materialized,
    );
    expect(f.target("v.m()")).toBe("Peer#m");
    expect(f.target("k.m()")).toBe("Key#m");
  });

  it("types map values() and enumerate() elements", () => {
    const f = fixture(
      source(
        `struct Holder { by_id: HashMap<Key, Peer>, list: Vec<Bar> }\nimpl Holder {\n    fn run(&self) {\n        for p in self.by_id.values() {\n            p.m();\n        }\n        for (i, b) in self.list.iter().enumerate() {\n            b.m();\n        }\n    }\n}`,
      ),
      materialized,
    );
    expect(f.target("p.m()", "Holder#run")).toBe("Peer#m");
    expect(f.target("b.m()", "Holder#run")).toBe("Bar#m");
  });

  it("settles .map by the receiver's type: Option payload vs iterator element", () => {
    const f = fixture(
      source(`fn run(opt: Option<Peer>, vec: Vec<Bar>) {\n    opt.map(|p| p.m());\n    vec.iter().map(|b| b.m());\n}`),
      materialized,
    );
    expect(f.target("p.m()")).toBe("Peer#m");
    expect(f.target("b.m()")).toBe("Bar#m");
  });

  it("types Result map_err to the error and fold's second param to the element", () => {
    const f = fixture(
      source(
        `fn run(res: Result<Foo, Bar>, v: Vec<Peer>) {\n    res.map_err(|e| e.m());\n    v.iter().fold(0, |acc, p| p.m());\n}`,
      ),
      materialized,
    );
    expect(f.target("e.m()")).toBe("Bar#m");
    expect(f.target("p.m()")).toBe("Peer#m");
  });

  it("leaves an iterator adapter on an untyped receiver untyped", () => {
    const f = fixture(source(`fn run(p: Foo) {\n    unknown().iter().map(|p| p.m());\n}`), materialized);
    expect(f.target("p.m()")).toBeNull();
  });

  it("types while let Some(n) = stack.pop()", () => {
    const f = fixture(
      source(`fn run(n: Foo, mut stack: Vec<Bar>) {\n    while let Some(n) = stack.pop() {\n        n.m();\n    }\n}`),
      materialized,
    );
    expect(f.target("n.m()")).toBe("Bar#m");
  });

  it("types map insert / remove_entry and Option as_mut / take", () => {
    const f = fixture(
      source(
        `struct Holder { boxes: HashMap<Key, Peer>, cms: Option<Bar>, sink: Option<Foo> }\nimpl Holder {\n    fn run(&mut self, k: Key, v: Peer) {\n        if let Some(mailbox) = self.boxes.insert(k, v) {\n            mailbox.m();\n        }\n        if let Some((key, _)) = self.boxes.remove_entry(&k) {\n            key.m();\n        }\n        if let Some(cms) = self.cms.as_mut() {\n            cms.m();\n        }\n        if let Some(sink) = self.sink.take() {\n            sink.m();\n        }\n    }\n}`,
      ),
      materialized,
    );
    expect(f.target("mailbox.m()", "Holder#run")).toBe("Peer#m");
    expect(f.target("key.m()", "Holder#run")).toBe("Key#m");
    expect(f.target("cms.m()", "Holder#run")).toBe("Bar#m");
    expect(f.target("sink.m()", "Holder#run")).toBe("Foo#m");
  });

  it("types a project enum variant payload, positional and named", () => {
    const f = fixture(
      source(
        `enum Msg { A(Bar), B { peer: Peer } }\nfn run(msg: Msg) {\n    match msg {\n        Msg::A(w) => w.m(),\n        Msg::B { peer } => peer.m(),\n    }\n}`,
      ),
      materialized,
    );
    expect(f.target("w.m()")).toBe("Bar#m");
    expect(f.target("peer.m()")).toBe("Peer#m");
  });

  it("types match self { Self::A(w) } inside the enum's impl", () => {
    const f = fixture(
      source(
        `enum Slot { A(Bar), B }\nimpl Slot {\n    fn run(&self) {\n        match self {\n            Self::A(w) => w.m(),\n            Self::B => {}\n        }\n    }\n}`,
      ),
      materialized,
    );
    expect(f.target("w.m()", "Slot#run")).toBe("Bar#m");
  });

  it("substitutes a generic enum's payload from the scrutinee's type arguments", () => {
    const f = fixture(
      source(
        `enum Slot<T> { Full(T), Empty }\nfn run(s: Slot<Peer>) {\n    if let Slot::Full(p) = s {\n        p.m();\n    }\n}`,
      ),
      materialized,
    );
    expect(f.target("p.m()")).toBe("Peer#m");
  });

  it("types if let Some(k) = &end where the local is a cloned Option field", () => {
    const f = fixture(
      source(
        `struct Holder { end: Option<Key> }\nimpl Holder {\n    fn run(&self) {\n        let end = self.end.clone();\n        if let Some(k) = &end {\n            k.m();\n        }\n    }\n}`,
      ),
      materialized,
    );
    expect(f.target("k.m()", "Holder#run")).toBe("Key#m");
  });

  it("types a for element over a slice param", () => {
    const f = fixture(
      source(`fn run(keys: &[Key]) {\n    for k in keys.iter() {\n        k.m();\n    }\n}`),
      materialized,
    );
    expect(f.target("k.m()")).toBe("Key#m");
  });

  it("does not type a variant the scrutinee's enum does not declare", () => {
    const f = fixture(
      source(
        `enum Msg { A(Bar) }\nenum Other { A(Peer) }\nfn run(msg: Msg) {\n    if let Other::A(w) = msg {\n        w.m();\n    }\n}`,
      ),
      materialized,
    );
    expect(f.target("w.m()")).toBeNull();
  });
});
