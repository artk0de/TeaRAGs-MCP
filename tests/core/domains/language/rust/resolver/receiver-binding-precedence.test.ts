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

// The production runner's edge for one call site — its context carries every
// file's `use` imports, which a declaring-file placement reads.
const edgeTarget = (f: ReturnType<typeof fixture>, callExpression: string): string | null => {
  const edges = f.edges().filter((edge) => edge.callExpression === callExpression);
  expect(edges.length).toBeLessThanOrEqual(1);
  return edges.length === 0 ? null : `${edges[0].targetRelPath}::${edges[0].targetSymbolId}`;
};

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

// Measured lost-edge guards (servo transformstreamdefaultcontroller): an
// earlier `let p = Promise::new(..)` is shadowed by `let p =
// Promise::new_in_realm(..)`, which must type `p` itself. Two walker facts
// carry it: `new_in_realm` is declared twice (inherent and trait impl) with
// one return, and `RootedPromise`'s `deref` returns `&Self::Target` where the
// impl fixes `type Target = Promise`.
const promiseFile = (options: { traitImpl: boolean; derefReturn: string; traitReturn?: string }) => `
use std::ops::Deref;
use std::rc::Rc;
pub struct Realm;
pub struct Error;
pub struct RootedPromise(Rc<Promise>);
impl Deref for RootedPromise {
    type Target = Promise;
    fn deref(&self) -> ${options.derefReturn} { &self.0 }
}
pub struct Promise;
impl Promise {
    pub fn new(realm: &mut Realm) -> RootedPromise { todo!() }
    pub fn new_in_realm(realm: &mut Realm) -> RootedPromise { todo!() }
    pub fn reject_error(&self, realm: &mut Realm, error: Error) {}
}
${
  options.traitImpl
    ? `pub trait PromiseHelpers {
    fn new_in_realm(realm: &mut Realm) -> RootedPromise;
    fn reject_error(&self, realm: &mut Realm, error: Error);
}
impl PromiseHelpers for Promise {
    fn new_in_realm(realm: &mut Realm) -> ${options.traitReturn ?? "RootedPromise"} { todo!() }
    fn reject_error(&self, realm: &mut Realm, error: Error) {}
}`
    : ""
}
pub struct Stream;
impl Stream { pub fn reject_error(&self, realm: &mut Realm, error: Error) {} }
`;

const promiseCaller = `
use crate::promise::{Error, Promise, Realm};
fn run(realm: &mut Realm, e: Error, ok: bool) {
    if ok {
        let p = Promise::new(realm);
        return;
    }
    let p = Promise::new_in_realm(realm);
    p.reject_error(realm, e);
}
`;

describe.each([false, true])(
  "Rust shadowing constructor returning a Deref wrapper (materialized=%s)",
  (materialized) => {
    const resolvePromise = (file: string) =>
      target(
        fixture({ "src/promise.rs": file, "src/main.rs": promiseCaller }, materialized).resolve(
          "p.reject_error(realm, e)",
        ),
      );

    it("types the servo shape: agreeing twin constructors returning a `Self::Target` deref", () => {
      expect(resolvePromise(promiseFile({ traitImpl: true, derefReturn: "&Self::Target" }))).toBe(
        "Promise#reject_error",
      );
    });

    it("types a constructor an inherent and a trait impl both declare with one return", () => {
      expect(resolvePromise(promiseFile({ traitImpl: true, derefReturn: "&Promise" }))).toBe("Promise#reject_error");
    });

    it("derefs a non-generic wrapper through its impl's concrete `type Target`", () => {
      expect(resolvePromise(promiseFile({ traitImpl: false, derefReturn: "&Self::Target" }))).toBe(
        "Promise#reject_error",
      );
    });

    it("still declines a constructor whose declarations disagree on the return", () => {
      const disagreeing = promiseFile({ traitImpl: true, derefReturn: "&Promise", traitReturn: "Stream" });
      expect(resolvePromise(disagreeing)).toBeNull();
    });
  },
);

// Measured lost-edge guards (servo animation_manager / fetch): a parameter is
// pinned `let trusted_x = Trusted::new(x)` and re-rooted in a closure as
// `let x = trusted_x.root()`. Three facts carry the shadowing let's type:
// `Trusted::new(ptr: &T) -> Trusted<T>` binds `T` from its argument, `root()`
// returns the project alias `DomRoot<T> = Root<Dom<T>>`, and `Root<T>` derefs
// through `<T as Deref>::Target`.
const rootFile = `
use std::ops::Deref;
pub struct Dom<T> { ptr: *const T }
impl<T> Deref for Dom<T> {
    type Target = T;
    fn deref(&self) -> &T { todo!() }
}
pub struct Root<T> { value: T }
impl<T> Deref for Root<T>
where
    T: Deref,
{
    type Target = <T as Deref>::Target;
    fn deref(&self) -> &Self::Target { todo!() }
}
pub type DomRoot<T> = Root<Dom<T>>;
`;

const refcountedFile = `
use crate::root::DomRoot;
pub struct Trusted<T> { ptr: *const T }
impl<T> Trusted<T> {
    pub fn new(ptr: &T) -> Trusted<T> { todo!() }
    pub fn root(&self) -> DomRoot<T> { todo!() }
}
`;

const windowFile = `
pub struct Document;
pub struct Window;
impl Window { pub fn Document(&self) -> Document { todo!() } }
pub struct Worker;
impl Worker { pub fn Document(&self) -> Document { todo!() } }
`;

const trustedCaller = (parameter: string) => `
use crate::refcounted::Trusted;
use crate::window::{Window, Worker};
fn run(window: ${parameter}) {
    let trusted_window = Trusted::new(window);
    let callback = Box::new(move || {
        let window = trusted_window.root();
        window.Document();
    });
}
`;

describe.each([false, true])("Rust re-rooted Trusted<T> receiver (materialized=%s)", (materialized) => {
  const resolveDocument = (files: Record<string, string>) =>
    edgeTarget(fixture(files, materialized), "window.Document()");
  const corpus = (caller: string, overrides: Record<string, string> = {}) => ({
    "src/root.rs": rootFile,
    "src/refcounted.rs": refcountedFile,
    "src/window.rs": windowFile,
    "src/main.rs": caller,
    ...overrides,
  });

  it("types the servo shape: Trusted::new(&Window).root() derefs to Window", () => {
    expect(resolveDocument(corpus(trustedCaller("&Window")))).toBe("src/window.rs::Window#Document");
  });

  it("expands the alias even when an `impl DomRoot<T>` block shares its name (servo root.rs)", () => {
    const aliasImpl = `${rootFile}impl<T> DomRoot<T> { pub fn as_traced(&self) {} }\n`;
    expect(resolveDocument(corpus(trustedCaller("&Window"), { "src/root.rs": aliasImpl }))).toBe(
      "src/window.rs::Window#Document",
    );
  });

  it("places the argument's type through the caller's imports when a trait impl elsewhere shares its name (servo GlobalScope)", () => {
    const helpers = "use crate::window::Window;\npub trait Helper {}\nimpl Helper for Window {}\n";
    expect(resolveDocument(corpus(trustedCaller("&Window"), { "src/helpers.rs": helpers }))).toBe(
      "src/window.rs::Window#Document",
    );
  });

  it("keeps the type after the pin itself is re-bound by a clone (servo fetch.rs trusted_global)", () => {
    const caller = trustedCaller("&Window").replace(
      "        window.Document();\n",
      "        let trusted_window = trusted_window.clone();\n        window.Document();\n",
    );
    expect(resolveDocument(corpus(caller))).toBe("src/window.rs::Window#Document");
  });

  it("binds the generic argument through `&mut T` too", () => {
    const mutRefcounted = refcountedFile.replace("pub fn new(ptr: &T)", "pub fn new(ptr: &mut T)");
    expect(resolveDocument(corpus(trustedCaller("&mut Window"), { "src/refcounted.rs": mutRefcounted }))).toBe(
      "src/window.rs::Window#Document",
    );
  });

  it("expands a project alias spelled in the declaring file (alias declared there)", () => {
    const inline = `${rootFile}
pub struct Trusted<T> { ptr: *const T }
impl<T> Trusted<T> {
    pub fn new(ptr: &T) -> Trusted<T> { todo!() }
    pub fn root(&self) -> DomRoot<T> { todo!() }
}
`;
    const caller = trustedCaller("&Window").replace("use crate::refcounted::Trusted;", "use crate::root::Trusted;");
    const files = corpus(caller, { "src/root.rs": inline, "src/refcounted.rs": "pub struct Unused;\n" });
    expect(resolveDocument(files)).toBe("src/window.rs::Window#Document");
  });

  it("derefs `Root<Dom<W>>` straight to W through `<T as Deref>::Target`, past Dom's own members", () => {
    const domMember = rootFile.replace(
      "pub struct Root<T>",
      "impl<T> Dom<T> { pub fn Document(&self) {} }\npub struct Root<T>",
    );
    expect(resolveDocument(corpus(trustedCaller("&Window"), { "src/root.rs": domMember }))).toBe(
      "src/window.rs::Window#Document",
    );
  });

  it("leaves the re-rooted name untyped when the argument's type is unknown", () => {
    const caller = trustedCaller("&Window").replace("Trusted::new(window)", "Trusted::new(make())");
    expect(resolveDocument(corpus(caller))).toBeNull();
  });

  it("leaves it untyped when the constructor parameter is not the bare generic", () => {
    const wrapped = refcountedFile.replace("pub fn new(ptr: &T)", "pub fn new(ptr: Vec<T>)");
    expect(resolveDocument(corpus(trustedCaller("&Window"), { "src/refcounted.rs": wrapped }))).toBeNull();
  });
});

// Measured lost-edge guard (servo layout/context.rs): `let image =
// self.get_cached_image_for_url(..)?` shadows a parameter; the method returns
// `Result<CachedImage, _>` where the declaring file imports `Image as
// CachedImage`, so `?` must unwrap to the renamed import's type. The sole
// project symbol named `Result` is another file's `impl MallocSizeOf for
// Result<T, E>` block, which must not capture the std spelling.
const mallocFile = `
pub trait MallocSizeOf { fn size_of(&self) -> usize; }
impl<T, E> MallocSizeOf for Result<T, E> { fn size_of(&self) -> usize { 0 } }
`;

const imageCacheFile = `
pub struct Image;
impl Image { pub fn metadata(&self) {} }
`;

const layoutContext = (init: string) => `
use crate::image_cache::{Image as CachedImage};
pub enum ResolveImageError { None }
pub struct Style;
impl Style { pub fn metadata(&self) {} }
pub struct LayoutContext;
impl LayoutContext {
    fn get_cached_image_for_url(&self, url: u32) -> Result<CachedImage, ResolveImageError> { todo!() }
    fn resolve(&self, image: &Style, url: u32) -> Result<(), ResolveImageError> {
        let image = ${init};
        image.metadata();
        Ok(())
    }
}
`;

describe.each([false, true])("Rust `?`-unwrapped method result shadowing (materialized=%s)", (materialized) => {
  const resolveMetadata = (init: string, declaringFile = layoutContext(init)) =>
    edgeTarget(
      fixture(
        { "src/malloc.rs": mallocFile, "src/image_cache.rs": imageCacheFile, "src/main.rs": declaringFile },
        materialized,
      ),
      "image.metadata()",
    );

  it("types the servo shape: `?` unwraps Result<CachedImage, _> to the renamed import", () => {
    expect(resolveMetadata("self.get_cached_image_for_url(url)?")).toBe("src/image_cache.rs::Image#metadata");
  });

  it("does not type the shadowing let as the Result's payload without `?`", () => {
    expect(resolveMetadata("self.get_cached_image_for_url(url)")).not.toBe("src/main.rs::Style#metadata");
    expect(resolveMetadata("self.get_cached_image_for_url(url)")).not.toBe("src/image_cache.rs::Image#metadata");
  });

  it("keeps a project `Result` the declaring file declares itself", () => {
    const init = "self.get_cached_image_for_url(url)?";
    const ownResult = `${layoutContext(init)}pub struct Result<T, E>(T, E);\n`;
    expect(resolveMetadata(init, ownResult)).toBeNull();
  });
});
