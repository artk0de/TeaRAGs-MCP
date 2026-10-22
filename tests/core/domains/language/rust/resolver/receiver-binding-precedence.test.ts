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

// Multi-file fixture mirrored from declared-call-result-locals.test.ts.
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
    extraction,
    symbolTable,
    chunk(symbolId = "run") {
      const chunk = extraction.chunks.find((entry) => entry.symbolId === symbolId)!;
      expect(chunk?.symbolId).toBe(symbolId);
      return chunk;
    },
    resolve(text: string, symbolId = "run") {
      const chunk = extraction.chunks.find((entry) => entry.symbolId === symbolId)!;
      expect(chunk?.symbolId).toBe(symbolId);
      const call = chunk.calls.find((entry) => entry.callText === text)!;
      expect(call?.callText).toBe(text);
      // The channel is keyed by the LOCAL VARIABLE's name (`.value` matched
      // the original fixtures' `let value = make()`); tests assert their own
      // binding shapes — here only that the chunk carries one.
      expect(Object.keys(chunk.callResultBindings ?? {}).length).toBeGreaterThan(0);
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
      return language.resolver.resolve(call, ctx);
    },
    edges() {
      return new CallEdgeResolutionRunner(factory, runState).resolve(extraction, symbolTable).methodEdges;
    },
  };
}

const bodySink = `
struct BodySink;
impl BodySink {
    fn take(&mut self) {}
    fn transmit(&self) {}
}
`;

const cmSketch = (newReturn: string) => `
pub struct CmSketch;
impl CmSketch {
    pub fn new(width: usize) -> ${newReturn} { todo!() }
    pub fn insert(&mut self, bytes: &[u8]) {}
    pub fn as_mut(&mut self) {}
}
`;

const target = (resolution: ReturnType<ReturnType<typeof fixture>["resolve"]>) => resolution?.targetSymbolId ?? null;

// bd tea-rags-mcp-s3i8m — a receiver bound on two channels (localBindings and
// callResultBindings) reads the binding declared LATER, and the constructor
// heuristic `let x = T::new(..)` yields to `T::new`'s declared return.
describe.each([false, true])("Rust receiver binding precedence (materialized=%s)", (materialized) => {
  // The untyped `Some(sink)` let CONTINUES the call; with `take` declared on two
  // project types (servo declares many) no later pass picks BodySink's.
  it("a later call-result let shadows the parameter type (servo http_loader sink)", () => {
    const f = fixture(
      {
        "src/main.rs": `${bodySink}
struct Queue;
impl Queue { fn take(&mut self) {} }
fn run(sink: BodySink) {
    let mut sink = Some(sink);
    if let Some(sink) = sink.take() {
        sink.transmit();
    }
}
`,
      },
      materialized,
    );
    expect(target(f.resolve("sink.take()"))).not.toBe("BodySink#take");
    expect(target(f.resolve("sink.transmit()"))).toBe("BodySink#transmit");
  });

  it("keeps the parameter type when no later let rebinds it", () => {
    const f = fixture(
      {
        "src/main.rs": `${bodySink}
fn make() -> BodySink { todo!() }
fn run(sink: BodySink) {
    let other = make();
    sink.take();
    other.transmit();
}
`,
      },
      materialized,
    );
    expect(target(f.resolve("sink.take()"))).toBe("BodySink#take");
  });

  it("keeps an earlier call-result let's type when nothing rebinds it", () => {
    const f = fixture(
      {
        "src/main.rs": `${bodySink}
struct Other;
impl Other { fn take(&mut self) {} }
fn make() -> Other { todo!() }
fn run(sink: BodySink) {
    sink.transmit();
    let other = make();
    other.take();
}
`,
      },
      materialized,
    );
    expect(target(f.resolve("other.take()"))).toBe("Other#take");
  });

  it("types a constructor local by the constructor's declared Option return (tikv analyze_context cms)", () => {
    const f = fixture(
      {
        "src/cmsketch.rs": cmSketch("Option<Self>"),
        "src/main.rs": `
use crate::cmsketch::CmSketch;
fn run(bytes: &[u8]) {
    let mut cms = CmSketch::new(3);
    cms.as_mut();
    if let Some(cms) = cms.as_mut() {
        cms.insert(bytes);
    }
}
`,
      },
      materialized,
    );
    expect(target(f.resolve("cms.as_mut()"))).not.toBe("CmSketch#as_mut");
    expect(target(f.resolve("cms.insert(bytes)"))).toBe("CmSketch#insert");
  });

  it("keeps the constructor heuristic when the constructor returns Self", () => {
    const f = fixture(
      {
        "src/cmsketch.rs": cmSketch("Self"),
        "src/main.rs": `
use crate::cmsketch::CmSketch;
fn run(bytes: &[u8]) {
    let mut cms = CmSketch::new(3);
    cms.insert(bytes);
}
`,
      },
      materialized,
    );
    expect(target(f.resolve("cms.insert(bytes)"))).toBe("CmSketch#insert");
  });
  // Measured lost-edge guards (tikv): a shadowing `let` whose callee carries no
  // declared return still types the name when its initializer folds.
  const twins = `
struct Store;
struct Twin;
impl Store {
    fn new() -> Store { todo!() }
    fn from_vec(v: Vec<u8>) -> Self { todo!() }
    fn with_tag(self, tag: u8) -> Self { self }
    fn scan(&self) {}
}
impl Twin { fn scan(&self) {} fn from_vec(v: Vec<u8>) -> Self { todo!() } fn new() -> Twin { todo!() } }
`;

  it.each([
    [
      "a derived clone (tikv pd_client.clone())",
      "fn run(store: &Store) {\n    let store = store.clone();\n    store.scan();\n}",
    ],
    [
      "a std identity call (tikv test::black_box)",
      "fn run() {\n    let store = Store::new();\n    let store = test::black_box(&store);\n    store.scan();\n}",
    ],
    [
      "a builder chain (tikv Write::new(..).set_last_change(..))",
      "fn run() {\n    let store = Store::new();\n    let store = Store::new().with_tag(1);\n    store.scan();\n}",
    ],
    [
      "a non-constructor associated fn (tikv KeyBuilder::from_vec)",
      "fn run(v: Vec<u8>) {\n    let store = Store::new();\n    let store = Store::from_vec(v);\n    store.scan();\n}",
    ],
  ])("types a shadowing let through %s", (_shape, body) => {
    const f = fixture({ "src/main.rs": `${twins}\n${body}\n` }, materialized);
    expect(target(f.resolve("store.scan()"))).toBe("Store#scan");
  });
});
