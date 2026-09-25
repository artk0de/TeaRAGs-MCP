import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(PyLang);
  return p.parse(src);
}

/** Through the COMPOSED walker, so the pass is exercised where production runs it. */
function extractionOf(src: string, chunks: WalkInput["chunks"]) {
  return new PythonLanguage().walker.walk({ tree: parse(src), code: src, relPath: "a.py", language: "python", chunks });
}

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return extractionOf(src, chunks).identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.3 — the naming lexicon's syntactic half for Python.
describe("Python walker — identifier declarations", () => {
  it("records self, annotated params, constructor-typed locals and self fields", () => {
    const src = [
      "class Svc:",
      "    def load(self, repo: Repo):",
      "        doc = Document()",
      "        self.cache = Cache()",
    ].join("\n");
    const chunks = [
      { symbolId: "Svc", startLine: 1, endLine: 4, scope: [] },
      { symbolId: "Svc.load", startLine: 2, endLine: 4, scope: ["Svc"] },
    ];
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "self", kind: "param", line: 2, ownerSymbolId: "Svc.load" },
      { name: "repo", kind: "param", line: 2, ownerSymbolId: "Svc.load", typeName: "Repo", typeSource: "annotation" },
      {
        name: "doc",
        kind: "local",
        line: 3,
        ownerSymbolId: "Svc.load",
        typeName: "Document",
        typeSource: "constructor",
        boundCallee: { member: "Document" },
      },
      {
        name: "cache",
        kind: "field",
        line: 4,
        ownerSymbolId: "Svc.load",
        typeName: "Cache",
        typeSource: "constructor",
        boundCallee: { member: "Cache" },
      },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.21 — the call-return join reads the TARGET's return row.
  it("records each def's return annotation as a return of the def's own chunk", () => {
    const src = [
      "class Svc:",
      "    async def load(self, id) -> Doc:",
      "        pass",
      "    def many(self) -> list[Job]:",
      "        pass",
      "    @property",
      "    def repo(self) -> Optional[Repo]:",
      "        pass",
      "    def untyped(self) -> None:",
      "        pass",
      'def top() -> "Widget":',
      "    pass",
    ].join("\n");
    const declarations = declarationsOf(src, [
      { symbolId: "Svc", startLine: 1, endLine: 10, scope: [] },
      { symbolId: "Svc.load", startLine: 2, endLine: 3, scope: ["Svc"] },
      { symbolId: "Svc.many", startLine: 4, endLine: 5, scope: ["Svc"] },
      { symbolId: "Svc.repo", startLine: 6, endLine: 8, scope: ["Svc"] },
      { symbolId: "Svc.untyped", startLine: 9, endLine: 10, scope: ["Svc"] },
      { symbolId: "top", startLine: 11, endLine: 12, scope: [] },
    ]);
    expect((declarations ?? []).filter((d) => d.kind === "return")).toEqual([
      // `async def … -> Doc` already names what `await load()` yields.
      { name: "load", kind: "return", line: 2, ownerSymbolId: "Svc.load", typeName: "Doc", typeSource: "annotation" },
      { name: "many", kind: "return", line: 4, ownerSymbolId: "Svc.many", typeName: "Job", typeSource: "annotation" },
      { name: "repo", kind: "return", line: 7, ownerSymbolId: "Svc.repo", typeName: "Repo", typeSource: "annotation" },
      { name: "top", kind: "return", line: 11, ownerSymbolId: "top", typeName: "Widget", typeSource: "annotation" },
    ]);
  });

  it("covers default, typed-default and splat params, annotated locals, qualified constructors", () => {
    const src = [
      "def run(n=1, m: list[Job] = None, *args, **kw):",
      "    total: int = 0",
      "    inv = models.Invoice()",
      "    res = make_result()",
      "    other.cache = Cache()",
      "    a, b = 1, 2",
      "    total += 1",
    ].join("\n");
    const chunks = [{ symbolId: "run", startLine: 1, endLine: 7, scope: [] }];
    expect(declarationsOf(src, chunks)).toEqual([
      { name: "n", kind: "param", line: 1, ownerSymbolId: "run" },
      { name: "m", kind: "param", line: 1, ownerSymbolId: "run", typeName: "Job", typeSource: "annotation" },
      { name: "args", kind: "param", line: 1, ownerSymbolId: "run" },
      { name: "kw", kind: "param", line: 1, ownerSymbolId: "run" },
      { name: "total", kind: "local", line: 2, ownerSymbolId: "run", typeName: "int", typeSource: "annotation" },
      {
        name: "inv",
        kind: "local",
        line: 3,
        ownerSymbolId: "run",
        typeName: "models.Invoice",
        typeSource: "constructor",
        boundCallee: { member: "Invoice", receiver: "models" },
      },
      { name: "res", kind: "local", line: 4, ownerSymbolId: "run", boundCallee: { member: "make_result" } },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.16 — collections name their element, the way Go / Java / Swift already do.
  it("unwraps list / Sequence / Iterable / set / tuple / Optional annotations to the element; maps keep the head", () => {
    const src = [
      "def run(a: list[Job], b: typing.List[Job], c: Sequence[Item], d: Iterable[Item],",
      "        e: set[Tag], f: tuple[Doc, ...], g: typing.Optional[Repo], h: Optional[list[Job]],",
      "        i: dict[str, Job], j: Tuple[Doc, int], k: Set[Tag]):",
      "    pass",
    ].join("\n");
    const chunks = [{ symbolId: "run", startLine: 1, endLine: 4, scope: [] }];
    expect(Object.fromEntries((declarationsOf(src, chunks) ?? []).map((d) => [d.name, d.typeName]))).toEqual({
      a: "Job",
      b: "Job",
      c: "Item",
      d: "Item",
      e: "Tag",
      f: "Doc",
      g: "Repo",
      h: "Job",
      i: "dict",
      j: "Doc",
      k: "Tag",
    });
  });

  // bd tea-rags-mcp-4p3sb.16 — the row builder finds the CallRef by (startLine, member, receiver).
  it("binds a local / field to the outermost call, as the CallRef the walker emits on that line", () => {
    const src = [
      "class Svc:",
      "    async def load(self, repo):",
      "        doc = repo.find_doc(1)",
      "        rows = await self.fetch_rows()",
      "        n = len(rows)",
      "        s = super().load()",
      "        self.cache = Cache()",
      "        k = 1",
      "        chained = repo.query().first()",
    ].join("\n");
    const chunks = [
      { symbolId: "Svc", startLine: 1, endLine: 9, scope: [] },
      { symbolId: "Svc.load", startLine: 2, endLine: 9, scope: ["Svc"] },
    ];
    const extraction = extractionOf(src, chunks);
    const bound = Object.fromEntries((extraction.identifierDeclarations ?? []).map((d) => [d.name, d.boundCallee]));
    expect(bound).toEqual({
      self: undefined,
      repo: undefined,
      doc: { member: "find_doc", receiver: "repo" },
      rows: { member: "fetch_rows", receiver: "self" },
      n: { member: "len" },
      s: { member: "load", receiver: "super" },
      cache: { member: "Cache" },
      k: undefined,
      chained: { member: "first", receiver: "repo.query()" },
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
});
