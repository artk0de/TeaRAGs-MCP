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
      { name: "cache", kind: "field", line: 3, ownerSymbolId: "Svc", typeName: "Item", typeSource: "annotation" },
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
      { name: "xs", kind: "param", line: 2, ...owner, typeName: "Doc", typeSource: "annotation" },
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
