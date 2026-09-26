import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(RustLang);
  return p.parse(src);
}

/** Through the COMPOSED walker, so the pass is exercised where production runs it. */
function extractionOf(src: string, chunks: WalkInput["chunks"]) {
  return new RustLanguage().walker.walk({ tree: parse(src), code: src, relPath: "svc.rs", language: "rust", chunks });
}

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return extractionOf(src, chunks).identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.5 — the naming lexicon's syntactic half for Rust.
describe("Rust walker — identifier declarations", () => {
  it("records struct fields; references, lifetimes and generic args are stripped", () => {
    const src = [
      "struct Svc {",
      "    repo: Repo,",
      "    cache: Vec<Item>,",
      "    db: &'static mut Db,",
      "    pair: (u8, u8),",
      "}",
    ].join("\n");
    const chunks = [{ symbolId: "Svc", startLine: 1, endLine: 6, scope: [] }];
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "repo", kind: "field", line: 2, ownerSymbolId: "Svc", typeName: "Repo", typeSource: "annotation" },
      {
        name: "cache",
        kind: "field",
        line: 3,
        ownerSymbolId: "Svc",
        typeName: "Item",
        typeSource: "annotation",
        typeMultiplicity: "many",
      },
      { name: "db", kind: "field", line: 4, ownerSymbolId: "Svc", typeName: "Db", typeSource: "annotation" },
      { name: "pair", kind: "field", line: 5, ownerSymbolId: "Svc" },
    ]);
  });

  it("records params and let locals; struct literals and `X::new` type by constructor", () => {
    const src = [
      "impl Svc {",
      "    fn load(&self, id: &str, mut xs: Vec<Doc>, (a, b): (i32, i32), pool: std::sync::Pool) {",
      "        let doc = Document { id: 1 };",
      "        let row = self.repo.get(id);",
      "        let cfg: Config = Config::new();",
      "        let mut w = Widget::new();",
      "        let g = crate::ui::Panel::new(1);",
      "        let d = Default::default();",
      "        let (p, q) = (1, 2);",
      "        let r = &mut Rc::new(3);",
      "        let f = |k: Key, z| k;",
      "        let s = Wrapper::<u8>::new();",
      "    }",
      "}",
    ].join("\n");
    const chunks = [
      { symbolId: "Svc", startLine: 1, endLine: 14, scope: [] },
      { symbolId: "Svc#load", startLine: 2, endLine: 13, scope: ["Svc"] },
    ];
    const owner = { ownerSymbolId: "Svc#load" };
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "id", kind: "param", line: 2, ...owner, typeName: "str", typeSource: "annotation" },
      {
        name: "xs",
        kind: "param",
        line: 2,
        ...owner,
        typeName: "Doc",
        typeSource: "annotation",
        typeMultiplicity: "many",
      },
      { name: "a", kind: "param", line: 2, ...owner },
      { name: "b", kind: "param", line: 2, ...owner },
      { name: "pool", kind: "param", line: 2, ...owner, typeName: "std::sync::Pool", typeSource: "annotation" },
      { name: "doc", kind: "local", line: 3, ...owner, typeName: "Document", typeSource: "constructor" },
      { name: "row", kind: "local", line: 4, ...owner, boundCallee: { member: "get", receiver: "self.repo" } },
      {
        name: "cfg",
        kind: "local",
        line: 5,
        ...owner,
        typeName: "Config",
        typeSource: "annotation",
        boundCallee: { member: "new", receiver: "Config" },
      },
      {
        name: "w",
        kind: "local",
        line: 6,
        ...owner,
        typeName: "Widget",
        typeSource: "constructor",
        boundCallee: { member: "new", receiver: "Widget" },
      },
      {
        name: "g",
        kind: "local",
        line: 7,
        ...owner,
        typeName: "crate::ui::Panel",
        typeSource: "constructor",
        boundCallee: { member: "new", receiver: "crate::ui::Panel" },
      },
      { name: "d", kind: "local", line: 8, ...owner, boundCallee: { member: "default", receiver: "Default" } },
      { name: "p", kind: "local", line: 9, ...owner },
      { name: "q", kind: "local", line: 9, ...owner },
      {
        name: "r",
        kind: "local",
        line: 10,
        ...owner,
        typeName: "Rc",
        typeSource: "constructor",
        boundCallee: { member: "new", receiver: "Rc" },
      },
      { name: "f", kind: "local", line: 11, ...owner },
      { name: "k", kind: "param", line: 11, ...owner, typeName: "Key", typeSource: "annotation" },
      { name: "z", kind: "param", line: 11, ...owner },
      {
        name: "s",
        kind: "local",
        line: 12,
        ...owner,
        typeName: "Wrapper",
        typeSource: "constructor",
        boundCallee: { member: "new", receiver: "Wrapper::<u8>" },
      },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.16 — the row builder finds the CallRef by (startLine, member, receiver).
  it("binds a local / field to the outermost call, as the CallRef the walker emits on that line", () => {
    const code = [
      "impl Svc {",
      "    async fn load(&self, id: u32) {",
      "        let a = fetch(id)?;",
      "        let b = self.api.get(id).await;",
      "        let c = self.api.get(id).await?;",
      "        let v = vec![1, 2];",
      "        let m = mymod::make!(id);",
      "        let n = 1;",
      "    }",
      "}",
    ].join("\n");
    const extraction = extractionOf(code, [
      { symbolId: "Svc", startLine: 1, endLine: 10, scope: [] },
      { symbolId: "Svc#load", startLine: 2, endLine: 9, scope: ["Svc"] },
    ]);
    const bound = Object.fromEntries((extraction.identifierDeclarations ?? []).map((d) => [d.name, d.boundCallee]));
    expect(bound).toEqual({
      id: undefined,
      a: { member: "fetch" },
      b: { member: "get", receiver: "self.api" },
      c: { member: "get", receiver: "self.api" },
      v: { member: "vec" },
      m: { member: "make", receiver: "mymod" },
      n: undefined,
    });
    for (const declaration of extraction.identifierDeclarations ?? []) {
      if (declaration.boundCallee === undefined) continue;
      const onLine = extraction.chunks
        .flatMap((chunk) => chunk.calls)
        .filter((call) => call.startLine === declaration.line)
        .map((call) =>
          call.receiver === null ? { member: call.member } : { member: call.member, receiver: call.receiver },
        );
      expect(onLine).toContainEqual(declaration.boundCallee);
    }
  });

  // bd tea-rags-mcp-bjzaf — `?` consumes a returned Result; a local bound without it holds the Result.
  it("marks a local whose bound call is consumed through `?`, and only that one", () => {
    const code = [
      "fn run(id: u32) -> Result<(), Error> {",
      "    let doc = load(id)?;",
      "    let attempt = load(id);",
      "    let awaited = fetch(id).await?;",
      "    let pending = fetch(id).await;",
      "    let n = 1;",
      "    Ok(())",
      "}",
    ].join("\n");
    const declarations = declarationsOf(code, [{ symbolId: "run", startLine: 1, endLine: 8, scope: [] }]);
    const unwrapped = Object.fromEntries(
      (declarations ?? []).filter((d) => d.kind === "local").map((d) => [d.name, d.boundCallUnwrapped]),
    );
    expect(unwrapped).toEqual({
      doc: true,
      attempt: undefined,
      awaited: true,
      pending: undefined,
      n: undefined,
    });
  });

  it("records the Result a return was read through as its wrapper; Option stays read as its element", () => {
    const code = [
      "impl Svc {",
      "    fn open(c: Config) -> Result<Self, Error> { todo!() }",
      "}",
      "fn load() -> Result<Doc, Error> { todo!() }",
      "fn read() -> io::Result<Doc> { todo!() }",
      "fn find() -> Option<Doc> { None }",
      "fn plain() -> Doc { todo!() }",
    ].join("\n");
    const declarations = declarationsOf(code, [
      { symbolId: "Svc", startLine: 1, endLine: 3, scope: [] },
      { symbolId: "Svc.open", startLine: 2, endLine: 2, scope: ["Svc"] },
      { symbolId: "load", startLine: 4, endLine: 4, scope: [] },
      { symbolId: "read", startLine: 5, endLine: 5, scope: [] },
      { symbolId: "find", startLine: 6, endLine: 6, scope: [] },
      { symbolId: "plain", startLine: 7, endLine: 7, scope: [] },
    ]);
    expect(
      (declarations ?? []).filter((d) => d.kind === "return").map((d) => [d.name, d.typeName, d.returnWrapper]),
    ).toEqual([
      ["open", "Svc", "Result"],
      ["load", "Doc", "Result"],
      ["read", "Doc", "Result"],
      ["find", "Doc", undefined],
      ["plain", "Doc", undefined],
    ]);
  });

  it("keeps the Result wrapper of a return whose Ok value names nothing; a plain unit return stays silent", () => {
    const code = [
      "fn save() -> Result<(), Error> { Ok(()) }",
      "fn pair() -> Result<(u32, u32), Error> { todo!() }",
      "fn noop() -> () {}",
      "fn unit() {}",
      "fn maybe() -> Option<()> { None }",
    ].join("\n");
    const declarations = declarationsOf(
      code,
      ["save", "pair", "noop", "unit", "maybe"].map((symbolId, i) => ({
        symbolId,
        startLine: i + 1,
        endLine: i + 1,
        scope: [],
      })),
    );
    expect((declarations ?? []).filter((d) => d.kind === "return")).toEqual([
      { name: "save", kind: "return", line: 1, ownerSymbolId: "save", returnWrapper: "Result" },
      { name: "pair", kind: "return", line: 2, ownerSymbolId: "pair", returnWrapper: "Result" },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.21 — the call-return join reads the TARGET's return row.
  it("records each fn's return type as a return of the fn's own chunk; `Self` names the impl's type", () => {
    const code = [
      "impl<'a> Svc<'a> {",
      "    fn with_config(c: Config) -> Self { todo!() }",
      "    fn load(&self) -> Doc { todo!() }",
      "    async fn all(&self) -> Vec<Job> { todo!() }",
      "    fn maybe(&self) -> Option<Self> { None }",
      "    fn run(&self) {}",
      "}",
      "trait Api { fn get(&self) -> Self; }",
      "fn fetch() -> Result<Doc, Error> { todo!() }",
    ].join("\n");
    const declarations = declarationsOf(code, [
      { symbolId: "Svc", startLine: 1, endLine: 7, scope: [] },
      { symbolId: "Svc.with_config", startLine: 2, endLine: 2, scope: ["Svc"] },
      { symbolId: "Svc#load", startLine: 3, endLine: 3, scope: ["Svc"] },
      { symbolId: "Svc#all", startLine: 4, endLine: 4, scope: ["Svc"] },
      { symbolId: "Svc#maybe", startLine: 5, endLine: 5, scope: ["Svc"] },
      { symbolId: "Svc#run", startLine: 6, endLine: 6, scope: ["Svc"] },
      { symbolId: "Api", startLine: 8, endLine: 8, scope: [] },
      { symbolId: "fetch", startLine: 9, endLine: 9, scope: [] },
    ]);
    expect((declarations ?? []).filter((d) => d.kind === "return")).toEqual([
      {
        name: "with_config",
        kind: "return",
        line: 2,
        ownerSymbolId: "Svc.with_config",
        typeName: "Svc",
        typeSource: "annotation",
      },
      { name: "load", kind: "return", line: 3, ownerSymbolId: "Svc#load", typeName: "Doc", typeSource: "annotation" },
      {
        name: "all",
        kind: "return",
        line: 4,
        ownerSymbolId: "Svc#all",
        typeName: "Job",
        typeSource: "annotation",
        typeMultiplicity: "many",
      },
      { name: "maybe", kind: "return", line: 5, ownerSymbolId: "Svc#maybe", typeName: "Svc", typeSource: "annotation" },
      // A returned `Result<T, E>` names `T`, what its callers' `?` yields (bd tea-rags-mcp-1hj3o),
      // and keeps `Result` for a caller that binds it without `?` (bd tea-rags-mcp-bjzaf).
      {
        name: "fetch",
        kind: "return",
        line: 9,
        ownerSymbolId: "fetch",
        typeName: "Doc",
        typeSource: "annotation",
        returnWrapper: "Result",
      },
    ]);
  });

  // bd tea-rags-mcp-1hj3o — a Result is consumed through `?`, as an async fn's value through `.await`.
  it("reads a returned Result<T, E> as T — aliases, Self and collections included; a parameter keeps its head", () => {
    const code = [
      "impl Svc {",
      "    fn open(c: Config) -> Result<Self, Error> { todo!() }",
      "    fn all(&self) -> io::Result<Vec<Doc>> { todo!() }",
      "    fn save(&self) -> Result<(), Error> { todo!() }",
      "    fn find(&self) -> anyhow::Result<Option<Doc>> { todo!() }",
      "    fn check(r: Result<Doc, Error>) -> std::result::Result<Box<Doc>, Error> { todo!() }",
      "}",
    ].join("\n");
    const declarations = declarationsOf(code, [
      { symbolId: "Svc", startLine: 1, endLine: 7, scope: [] },
      { symbolId: "Svc.open", startLine: 2, endLine: 2, scope: ["Svc"] },
      { symbolId: "Svc#all", startLine: 3, endLine: 3, scope: ["Svc"] },
      { symbolId: "Svc#save", startLine: 4, endLine: 4, scope: ["Svc"] },
      { symbolId: "Svc#find", startLine: 5, endLine: 5, scope: ["Svc"] },
      { symbolId: "Svc.check", startLine: 6, endLine: 6, scope: ["Svc"] },
    ]);
    expect((declarations ?? []).map((d) => [d.kind, d.name, d.typeName, d.typeMultiplicity ?? "one"])).toEqual([
      ["return", "open", "Svc", "one"],
      ["param", "c", "Config", "one"],
      ["return", "all", "Doc", "many"],
      // `Result<(), E>` returns nothing a local could be named after through `?`:
      // no type, only the `Result` wrapper a `?`-less caller holds (bd tea-rags-mcp-bjzaf).
      ["return", "save", undefined, "one"],
      ["return", "find", "Doc", "one"],
      ["return", "check", "Doc", "one"],
      // A `Result` in hand is a Result: only the return is consumed through `?`.
      ["param", "r", "Result", "one"],
    ]);
  });

  // bd tea-rags-mcp-4p3sb.17 — a collection or wrapper names its element; maps keep their head.
  it("unwraps Vec / VecDeque / HashSet / BTreeSet / Option / Box / Rc / Arc<T> and &[T] to the element", () => {
    const code = [
      "fn f(a: Vec<Job>, b: VecDeque<Job>, c: HashSet<Tag>, d: BTreeSet<Tag>, e: Option<Repo>, g: Box<Repo>,",
      "  h: Rc<Repo>, i: Arc<Repo>, j: &[Job], k: &mut [u8], l: Option<Box<Repo>>, m: std::collections::HashSet<Tag>,",
      "  n: HashMap<String, Job>, o: BTreeMap<u32, Job>, p: Vec<(u8, u8)>, q: Box<dyn Fn()>, s: Rc<RefCell<Db>>) {}",
    ].join("\n");
    const declarations = declarationsOf(code, [{ symbolId: "f", startLine: 1, endLine: 3, scope: [] }]);
    expect(Object.fromEntries((declarations ?? []).map((d) => [d.name, d.typeName]))).toEqual({
      a: "Job",
      b: "Job",
      c: "Tag",
      d: "Tag",
      e: "Repo",
      g: "Repo",
      h: "Repo",
      i: "Repo",
      j: "Job",
      k: "u8",
      l: "Repo",
      m: "Tag",
      n: "HashMap",
      o: "BTreeMap",
      p: undefined,
      q: undefined,
      s: "RefCell",
    });
  });
});

// bd tea-rags-mcp-4p3sb.26 — a collection or slice names its element AND says it holds many.
describe("Rust walker — identifier type multiplicity", () => {
  it("marks Vec / VecDeque / sets / slices many; Option, Box and a map stay one", () => {
    const src = [
      "fn pick(candidates: Vec<Item>, fallback: Item, slice: &[Item], set: HashSet<Item>, opt: Option<Item>,",
      "        boxed: Box<Item>, nested: Option<Vec<Item>>, map: HashMap<K, Item>) -> Vec<Item> {",
      "    let queue: VecDeque<Item> = VecDeque::new();",
      "    let one = Item::new();",
      "}",
    ].join("\n");
    const declarations = declarationsOf(src, [{ symbolId: "pick", startLine: 1, endLine: 5, scope: [] }]) ?? [];
    expect(declarations.map((d) => [d.kind, d.name, d.typeName, d.typeMultiplicity ?? "one"])).toEqual([
      ["return", "pick", "Item", "many"],
      ["param", "candidates", "Item", "many"],
      ["param", "fallback", "Item", "one"],
      ["param", "slice", "Item", "many"],
      ["param", "set", "Item", "many"],
      ["param", "opt", "Item", "one"],
      ["param", "boxed", "Item", "one"],
      ["param", "nested", "Item", "many"],
      ["param", "map", "HashMap", "one"],
      ["local", "queue", "Item", "many"],
      ["local", "one", "Item", "one"],
    ]);
  });
});
