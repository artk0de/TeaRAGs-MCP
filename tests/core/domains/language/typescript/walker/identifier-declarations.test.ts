import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";
import { buildIdentifierRows } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/identifier-rows.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(TsLang.typescript);
  return p.parse(src);
}

/** Through the COMPOSED walker, so the pass is exercised where production runs it. */
function extractionOf(src: string, chunks: WalkInput["chunks"]) {
  return new TypeScriptLanguage().walker.walk({
    tree: parse(src),
    code: src,
    relPath: "a.ts",
    language: "typescript",
    chunks,
  });
}

function declarationsOf(src: string, chunks: WalkInput["chunks"]) {
  return extractionOf(src, chunks).identifierDeclarations;
}

// bd tea-rags-mcp-4p3sb.4 — the naming lexicon's syntactic half for TypeScript.
describe("TypeScript walker — identifier declarations", () => {
  const chunks = [
    { symbolId: "Svc", startLine: 1, endLine: 11, scope: [] },
    { symbolId: "Svc#constructor", startLine: 4, endLine: 4, scope: ["Svc"] },
    { symbolId: "Svc#load", startLine: 5, endLine: 10, scope: ["Svc"] },
  ];
  const src = [
    "class Svc {",
    "  private repo: Repo<Doc> = new Repo();",
    "  static count = new Counter();",
    "  constructor(private readonly db: Db, opt?: Options) {}",
    "  load(id: string, { a, b: c }: Opts, ...more: string[]) {",
    "    const doc = new Document(id);",
    "    let row = repo.get(id), n: number = 1;",
    "    const { d, e = 2, ...f } = obj;",
    "    const fn = (p: P) => p, g = new ns.Widget<string>();",
    "  }",
    "}",
  ].join("\n");

  it("records annotated and constructed fields, params and locals; destructuring binds each name untyped", () => {
    expect(declarationsOf(src, chunks)).toEqual([
      {
        name: "repo",
        kind: "field",
        line: 2,
        ownerSymbolId: "Svc",
        typeName: "Repo",
        typeSource: "annotation",
        boundCallee: { member: "constructor", receiver: "Repo" },
      },
      {
        name: "count",
        kind: "field",
        line: 3,
        ownerSymbolId: "Svc",
        typeName: "Counter",
        typeSource: "constructor",
        boundCallee: { member: "constructor", receiver: "Counter" },
      },
      {
        name: "db",
        kind: "param",
        line: 4,
        ownerSymbolId: "Svc#constructor",
        typeName: "Db",
        typeSource: "annotation",
      },
      {
        name: "opt",
        kind: "param",
        line: 4,
        ownerSymbolId: "Svc#constructor",
        typeName: "Options",
        typeSource: "annotation",
      },
      { name: "id", kind: "param", line: 5, ownerSymbolId: "Svc#load", typeName: "string", typeSource: "annotation" },
      { name: "a", kind: "param", line: 5, ownerSymbolId: "Svc#load" },
      { name: "c", kind: "param", line: 5, ownerSymbolId: "Svc#load" },
      {
        name: "more",
        kind: "param",
        line: 5,
        ownerSymbolId: "Svc#load",
        typeName: "string",
        typeSource: "annotation",
        typeMultiplicity: "many",
      },
      {
        name: "doc",
        kind: "local",
        line: 6,
        ownerSymbolId: "Svc#load",
        typeName: "Document",
        typeSource: "constructor",
        boundCallee: { member: "constructor", receiver: "Document" },
      },
      {
        name: "row",
        kind: "local",
        line: 7,
        ownerSymbolId: "Svc#load",
        boundCallee: { member: "get", receiver: "repo" },
      },
      { name: "n", kind: "local", line: 7, ownerSymbolId: "Svc#load", typeName: "number", typeSource: "annotation" },
      { name: "d", kind: "local", line: 8, ownerSymbolId: "Svc#load" },
      { name: "e", kind: "local", line: 8, ownerSymbolId: "Svc#load" },
      { name: "f", kind: "local", line: 8, ownerSymbolId: "Svc#load" },
      { name: "fn", kind: "local", line: 9, ownerSymbolId: "Svc#load" },
      { name: "p", kind: "param", line: 9, ownerSymbolId: "Svc#load", typeName: "P", typeSource: "annotation" },
      {
        name: "g",
        kind: "local",
        line: 9,
        ownerSymbolId: "Svc#load",
        typeName: "ns.Widget",
        typeSource: "constructor",
        boundCallee: { member: "constructor", receiver: "ns.Widget" },
      },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.16 — a collection names its element; Promise and maps keep their head.
  it("unwraps T[] / Array<T> / ReadonlyArray<T> / readonly T[] / Set<T> annotations to the element", () => {
    const code = [
      "function f(a: Job[], b: Array<Job>, c: ReadonlyArray<Job>, d: readonly Job[], e: Set<ns.Tag>,",
      "  p: Promise<Job>, m: Map<string, Job>, u: Job | null) {}",
    ].join("\n");
    const declarations = declarationsOf(code, [{ symbolId: "f", startLine: 1, endLine: 2, scope: [] }]);
    expect(Object.fromEntries((declarations ?? []).map((d) => [d.name, d.typeName]))).toEqual({
      a: "Job",
      b: "Job",
      c: "Job",
      d: "Job",
      e: "ns.Tag",
      p: "Promise",
      m: "Map",
      u: undefined,
    });
  });

  // bd tea-rags-mcp-4p3sb.21 — the call-return join reads the TARGET's return row.
  it("records each function's return annotation as a return of the function's own chunk", () => {
    const code = [
      "async function loadDocument(id: string): Promise<Document> { return x; }",
      "function pending(): Promise<Document> { return x; }",
      "const make = (): Maker => new Maker();",
      "const fetchAll = async function (): Promise<Job[]> { return []; };",
      "function untyped() {}",
      "export function* ids(): Generator<Id> {}",
      "class Svc {",
      "  find(id: string): Doc[] { return []; }",
      "  load = async (): Promise<Repo> => repo;",
      "  static build(): Widget { return w; }",
      "  isDoc(x: unknown): x is Doc { return true; }",
      "}",
      "interface Api { get(): Thing; }",
      "declare function external(): Ext;",
      "function inline(): Folded { return f; }",
      "function log(): void {} async function flush(): Promise<void> {} function fail(): never { throw e; }",
    ].join("\n");
    const declarations = declarationsOf(code, [
      { symbolId: "loadDocument", startLine: 1, endLine: 1, scope: [] },
      { symbolId: "pending", startLine: 2, endLine: 2, scope: [] },
      { symbolId: "make", startLine: 3, endLine: 3, scope: [] },
      { symbolId: "fetchAll", startLine: 4, endLine: 4, scope: [] },
      { symbolId: "untyped", startLine: 5, endLine: 5, scope: [] },
      { symbolId: "ids", startLine: 6, endLine: 6, scope: [] },
      { symbolId: "Svc", startLine: 7, endLine: 12, scope: [] },
      { symbolId: "Svc#find", startLine: 8, endLine: 8, scope: ["Svc"] },
      { symbolId: "Svc#load", startLine: 9, endLine: 9, scope: ["Svc"] },
      { symbolId: "Svc.build", startLine: 10, endLine: 10, scope: ["Svc"] },
      { symbolId: "Svc#isDoc", startLine: 11, endLine: 11, scope: ["Svc"] },
      { symbolId: "Api", startLine: 13, endLine: 13, scope: [] },
      { symbolId: "Api#get", startLine: 13, endLine: 13, scope: ["Api"] },
      { symbolId: "external", startLine: 14, endLine: 14, scope: [] },
      // `inline` has no chunk of its own: its line belongs to an unrelated chunk.
      { symbolId: "trailer", startLine: 15, endLine: 15, scope: [] },
      // `void` / `never` name no value a local could hold: no return.
      { symbolId: "log", startLine: 16, endLine: 16, scope: [] },
      { symbolId: "flush", startLine: 16, endLine: 16, scope: [] },
      { symbolId: "fail", startLine: 16, endLine: 16, scope: [] },
    ]);
    expect((declarations ?? []).filter((d) => d.kind === "return")).toEqual([
      // async: `await loadDocument()` is a Document; the Promise it was read through is kept
      // for a caller that binds the call without `await` (bd tea-rags-mcp-bjzaf).
      {
        name: "loadDocument",
        kind: "return",
        line: 1,
        ownerSymbolId: "loadDocument",
        typeName: "Document",
        typeSource: "annotation",
        returnWrapper: "Promise",
      },
      // not async: a Promise returned as a value stays a Promise.
      {
        name: "pending",
        kind: "return",
        line: 2,
        ownerSymbolId: "pending",
        typeName: "Promise",
        typeSource: "annotation",
      },
      { name: "make", kind: "return", line: 3, ownerSymbolId: "make", typeName: "Maker", typeSource: "annotation" },
      {
        name: "fetchAll",
        kind: "return",
        line: 4,
        ownerSymbolId: "fetchAll",
        typeName: "Job",
        typeSource: "annotation",
        typeMultiplicity: "many",
        returnWrapper: "Promise",
      },
      { name: "ids", kind: "return", line: 6, ownerSymbolId: "ids", typeName: "Generator", typeSource: "annotation" },
      {
        name: "find",
        kind: "return",
        line: 8,
        ownerSymbolId: "Svc#find",
        typeName: "Doc",
        typeSource: "annotation",
        typeMultiplicity: "many",
      },
      {
        name: "load",
        kind: "return",
        line: 9,
        ownerSymbolId: "Svc#load",
        typeName: "Repo",
        typeSource: "annotation",
        returnWrapper: "Promise",
      },
      {
        name: "build",
        kind: "return",
        line: 10,
        ownerSymbolId: "Svc.build",
        typeName: "Widget",
        typeSource: "annotation",
      },
      { name: "get", kind: "return", line: 13, ownerSymbolId: "Api#get", typeName: "Thing", typeSource: "annotation" },
      {
        name: "external",
        kind: "return",
        line: 14,
        ownerSymbolId: "external",
        typeName: "Ext",
        typeSource: "annotation",
      },
      // `void` / `never` name no value — but an async `Promise<void>` is still a
      // Promise to a caller that does not await it (bd tea-rags-mcp-bjzaf).
      { name: "flush", kind: "return", line: 16, ownerSymbolId: "flush", returnWrapper: "Promise" },
    ]);
  });

  // bd tea-rags-mcp-1hj3o — tree-sitter spells `undefined` as `literal_type`, never `predefined_type`.
  it("persists no typed return row for any valueless spelling, in every position a return is read from", () => {
    const valueless = [
      "function a(): undefined { return; }",
      "function b(): void {}",
      "function c(): never { throw e; }",
      "async function d(): Promise<void> {}",
      "async function e(): Promise<undefined> {}",
      "async function f(): Promise<never> {}",
      "function g(): null { return null; }",
      "const h = (): undefined => undefined;",
      "const i = async (): Promise<undefined> => undefined;",
      "class K { m(): undefined { return; } n = async (): Promise<void> => {}; }",
      "interface Api { get(): undefined; put(): void; }",
      // A union has no single name: `T | undefined` types no return, the `T` included.
      "function j(): Doc | undefined { return; }",
      "function k(): undefined | Doc { return; }",
      "async function l(): Promise<Doc | undefined> {}",
    ];
    const code = [...valueless, "async function kept(): Promise<Doc> {}"].join("\n");
    const returnChunks = [
      { symbolId: "a", line: 1 },
      { symbolId: "b", line: 2 },
      { symbolId: "c", line: 3 },
      { symbolId: "d", line: 4 },
      { symbolId: "e", line: 5 },
      { symbolId: "f", line: 6 },
      { symbolId: "g", line: 7 },
      { symbolId: "h", line: 8 },
      { symbolId: "i", line: 9 },
      { symbolId: "K#m", line: 10 },
      { symbolId: "K#n", line: 10 },
      { symbolId: "Api#get", line: 11 },
      { symbolId: "Api#put", line: 11 },
      { symbolId: "j", line: 12 },
      { symbolId: "k", line: 13 },
      { symbolId: "l", line: 14 },
      { symbolId: "kept", line: 15 },
    ].map(({ symbolId, line }) => ({ symbolId, startLine: line, endLine: line, scope: [] }));
    const extraction = extractionOf(code, returnChunks);
    const returnRows = buildIdentifierRows(extraction).filter((r) => r.kind === "return");
    expect(returnRows.filter((r) => r.typeName !== undefined).map((r) => [r.ownerSymbolId, r.typeName])).toEqual([
      ["kept", "Doc"],
    ]);
    // bd tea-rags-mcp-bjzaf — an async function still returns a Promise, whatever it
    // resolves to: its row carries the wrapper alone, so `const p = d()` is a Promise.
    expect(
      returnRows.filter((r) => r.typeName === undefined).map((r) => [r.ownerSymbolId, r.returnWrapper, r.typeSource]),
    ).toEqual([
      ["d", "Promise", undefined],
      ["e", "Promise", undefined],
      ["f", "Promise", undefined],
      ["i", "Promise", undefined],
      ["K#n", "Promise", undefined],
      ["l", "Promise", undefined],
    ]);
  });

  // bd tea-rags-mcp-4p3sb.16 — the row builder finds the CallRef by (startLine, member, receiver).
  it("binds a local / field to the outermost call, as the CallRef the walker emits on that line", () => {
    const code = [
      "class Repo {",
      "  private cache = makeCache();",
      "  async load(id: string) {",
      "    const doc = await this.api.find(id);",
      "    const first = this.api.where(id).first();",
      "    const bound = handler.call(ctx, 1);",
      "    const w = new Widget();",
      "    const z = get()!;",
      "    const n = 1;",
      "  }",
      "}",
    ].join("\n");
    const extraction = extractionOf(code, [
      { symbolId: "Repo", startLine: 1, endLine: 11, scope: [] },
      { symbolId: "Repo#load", startLine: 3, endLine: 10, scope: ["Repo"] },
    ]);
    const bound = Object.fromEntries((extraction.identifierDeclarations ?? []).map((d) => [d.name, d.boundCallee]));
    expect(bound).toEqual({
      cache: { member: "makeCache" },
      id: undefined,
      doc: { member: "find", receiver: "this.api" },
      first: { member: "first", receiver: "this.api.where(id)" },
      bound: { member: "handler" },
      w: { member: "constructor", receiver: "Widget" },
      z: { member: "get" },
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
});

// bd tea-rags-mcp-4p3sb.26 — a collection annotation names its element AND says it holds many.
describe("TypeScript walker — identifier type multiplicity", () => {
  const multiplicityOf = (src: string) =>
    (declarationsOf(src, [{ symbolId: "pick", startLine: 1, endLine: 3, scope: [] }]) ?? []).map((d) => [
      d.kind,
      d.name,
      d.typeName,
      d.typeMultiplicity ?? "one",
    ]);

  it("marks every element-naming annotation many and a plain one one", () => {
    const src = [
      "function pick(candidates: SymbolDefinition[], fallback: SymbolDefinition, defs: Array<SymbolDefinition>,",
      "  ro: readonly SymbolDefinition[], all: ReadonlyArray<SymbolDefinition>, seen: Set<SymbolDefinition>,",
      "  pending: Promise<SymbolDefinition>, ...rest: SymbolDefinition[]): SymbolDefinition[] { const one: SymbolDefinition = fallback; }",
    ].join("\n");
    expect(multiplicityOf(src)).toEqual([
      ["return", "pick", "SymbolDefinition", "many"],
      ["param", "candidates", "SymbolDefinition", "many"],
      ["param", "fallback", "SymbolDefinition", "one"],
      ["param", "defs", "SymbolDefinition", "many"],
      ["param", "ro", "SymbolDefinition", "many"],
      ["param", "all", "SymbolDefinition", "many"],
      ["param", "seen", "SymbolDefinition", "many"],
      ["param", "pending", "Promise", "one"],
      ["param", "rest", "SymbolDefinition", "many"],
      ["local", "one", "SymbolDefinition", "one"],
    ]);
  });

  // bd tea-rags-mcp-bjzaf — `await` consumes an async function's Promise; a local bound without it holds the Promise.
  it("marks a local whose bound call is awaited, and only that one", () => {
    const code = [
      "async function run(id: string) {",
      "  const doc = await fetchDocument(id);",
      "  const pending = fetchDocument(id);",
      "  const forced = fetchDocument(id)!;",
      "  const n = 1;",
      "}",
    ].join("\n");
    const declarations = declarationsOf(code, [{ symbolId: "run", startLine: 1, endLine: 6, scope: [] }]);
    const unwrapped = Object.fromEntries(
      (declarations ?? []).filter((d) => d.kind === "local").map((d) => [d.name, d.boundCallUnwrapped]),
    );
    expect(unwrapped).toEqual({ doc: true, pending: undefined, forced: undefined, n: undefined });
  });

  it("keeps `many` through an async function's awaited Promise<T[]>", () => {
    const src = "async function pick(): Promise<Doc[]> {}";
    expect(multiplicityOf(src)).toEqual([["return", "pick", "Doc", "many"]]);
  });
});
