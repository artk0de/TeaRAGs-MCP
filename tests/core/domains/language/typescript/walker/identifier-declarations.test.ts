import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";

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
      { name: "more", kind: "param", line: 5, ownerSymbolId: "Svc#load", typeName: "string", typeSource: "annotation" },
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
