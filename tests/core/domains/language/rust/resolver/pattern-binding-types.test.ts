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
struct Foo;
struct Bar;
struct Peer;
struct Tx;
struct Rx;
impl Foo { fn m(&self) {} fn get(&self) -> Option<Bar> { None } }
impl Bar { fn m(&self) {} }
impl Peer { fn m(&self) {} }
impl Tx { fn recv(&self) {} }
impl Rx { fn recv(&self) {} }
`;

// bd tea-rags-mcp-s3i8m Task 1a — a pattern-bound name is typed only by folding
// its projection over the scrutinee's type; it never reads the outer binding.
describe.each([false, true])("Rust pattern binding typing (materialized=%s)", (materialized) => {
  it("does not let an outer typed binding leak into a Some(x) arm", () => {
    const f = fixture(
      `${types}\nfn run(x: Foo, o: Option<Missing>) {\n    if let Some(x) = o {\n        x.m();\n    }\n}\n`,
      materialized,
    );
    expect(f.target("x.m()")).not.toBe("Foo#m");
  });

  it("types an if-let payload through a method's declared Option return", () => {
    const f = fixture(
      `${types}\nstruct Holder;\nimpl Holder {\n    fn find(&self) -> Option<Peer> { None }\n    fn run(&self) {\n        if let Some(p) = self.find() {\n            p.m();\n        }\n    }\n}\n`,
      materialized,
    );
    expect(f.target("p.m()", "Holder#run")).toBe("Peer#m");
  });

  it("reads the outer binding inside a same-line scrutinee", () => {
    const f = fixture(`${types}\nfn run(x: Foo) {\n    if let Some(x) = x.get() { x.m(); }\n}\n`, materialized);
    expect(f.target("x.get()")).toBe("Foo#get");
    expect(f.target("x.m()")).toBe("Bar#m");
  });

  it("types a destructured tuple from a free function's declared tuple return", () => {
    const f = fixture(
      `${types}\nfn make_pair() -> (Tx, Rx) { (Tx, Rx) }\nfn run() {\n    let (tx, rx) = make_pair();\n    rx.recv();\n    tx.recv();\n}\n`,
      materialized,
    );
    expect(f.target("rx.recv()")).toBe("Rx#recv");
    expect(f.target("tx.recv()")).toBe("Tx#recv");
  });

  it("types a nested Some((a, b)) through a method's Option of a tuple", () => {
    const f = fixture(
      `${types}\nstruct Holder;\nimpl Holder {\n    fn pair(&self) -> Option<(Tx, Rx)> { None }\n    fn run(&self) {\n        if let Some((_, b)) = self.pair() {\n            b.recv();\n        }\n    }\n}\n`,
      materialized,
    );
    expect(f.target("b.recv()", "Holder#run")).toBe("Rx#recv");
  });

  it("types a struct-pattern field through the declared field type", () => {
    const f = fixture(
      `${types}\nstruct Holder { peer: Peer }\nfn run(holder: Holder, peer: Foo) {\n    let Holder { peer, .. } = holder;\n    peer.m();\n}\n`,
      materialized,
    );
    expect(f.target("peer.m()")).toBe("Peer#m");
  });

  it("types a typed closure param", () => {
    const f = fixture(`${types}\nfn run(items: Items) {\n    items.for_each(|x: Foo| x.m());\n}\n`, materialized);
    expect(f.target("x.m()")).toBe("Foo#m");
  });

  it("leaves a while-let element pop untyped without an element table", () => {
    const f = fixture(
      `${types}\nfn run(n: Foo, mut stack: Vec<Bar>) {\n    while let Some(n) = stack.pop() {\n        n.m();\n    }\n}\n`,
      materialized,
    );
    expect(f.target("n.m()")).not.toBe("Foo#m");
  });

  it("leaves a callback param untyped", () => {
    const f = fixture(`${types}\nfn run(cb: Foo) {\n    apply(|cb| cb.m());\n}\n`, materialized);
    expect(f.target("cb.m()")).not.toBe("Foo#m");
  });

  it("leaves an or-pattern with mismatched payloads untyped", () => {
    const f = fixture(
      `${types}\nenum E { A(Bar), B(Peer) }\nfn run(w: Foo, e: E) {\n    match e {\n        E::A(w) | E::B(w) => w.m(),\n    }\n}\n`,
      materialized,
    );
    expect(f.target("w.m()")).not.toBe("Foo#m");
  });

  it("shadows a for-loop element (untyped in this slice)", () => {
    const f = fixture(
      `${types}\nfn run(p: Foo, v: Vec<Bar>) {\n    for p in v {\n        p.m();\n    }\n}\n`,
      materialized,
    );
    expect(f.target("p.m()")).not.toBe("Foo#m");
  });

  // bd tea-rags-mcp-s3i8m Task 1c — an untyped pattern binding still shadows
  // the outer name, but the call falls through the chain exactly as an unbound
  // receiver does (additive invariant), instead of dropping.
  it("lets an untyped pattern binding read exactly like an unbound receiver", () => {
    const body = (recv: string) =>
      `${types}\nstruct Error;\nimpl Error { fn clone(&self) -> Error { Error } }\nfn run(path: &Cow<'_, [u8]>) {\n    match *path {\n        Cow::Owned(ref path) => {\n            let copy = ${recv}.clone();\n        }\n        _ => {}\n    }\n}\n`;
    const unbound = fixture(body("other"), materialized).target("other.clone()");
    expect(fixture(body("path"), materialized).target("path.clone()")).toBe(unbound);
  });

  it("resolves an untyped if-let payload through the short-name pass like an unbound receiver", () => {
    const body = (recv: string) =>
      `${types}\nstruct Key;\nimpl Key { fn as_encoded(&self) {} }\nfn run() {\n    let maybe_key = compute();\n    if let Some(k) = &maybe_key {\n        ${recv}.as_encoded();\n    }\n}\n`;
    expect(fixture(body("other"), materialized).target("other.as_encoded()")).toBe("Key#as_encoded");
    expect(fixture(body("k"), materialized).target("k.as_encoded()")).toBe("Key#as_encoded");
  });

  it("keeps shadowing: an untyped pattern binding never reads the outer binding's type", () => {
    const body = (recv: string) =>
      `${types}\nstruct Baz;\nimpl Foo { fn new() -> Foo { Foo } fn bar(&self) {} }\nimpl Baz { fn bar(&self) {} }\nfn run() {\n    let k = Foo::new();\n    let opt = compute();\n    if let Some(k) = opt {\n        ${recv}.bar();\n    }\n}\n`;
    const unbound = fixture(body("other"), materialized).target("other.bar()");
    const shadowed = fixture(body("k"), materialized).target("k.bar()");
    expect(shadowed).not.toBe("Foo#bar");
    expect(shadowed).toBe(unbound);
  });

  it("reads the outer binding after a closure on the same line", () => {
    const f = fixture(
      `${types}\nfn run(w: Foo, o: Option<Missing>) {\n    let same = o.map(|w| w.m()) == Some(w.m());\n}\n`,
      materialized,
    );
    expect(f.target("w.m()", "run", 0)).not.toBe("Foo#m");
    expect(f.target("w.m()", "run", 1)).toBe("Foo#m");
  });

  it("restores the outer binding after the pattern scope ends", () => {
    const f = fixture(
      `${types}\nfn run(x: Foo, o: Option<Missing>) {\n    if let Some(x) = o {\n        x.m();\n    }\n    x.m();\n}\n`,
      materialized,
    );
    expect(f.target("x.m()", "run", 1)).toBe("Foo#m");
  });
});
