import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { extractFromTypescriptFile } from "../../../../../../src/core/domains/language/typescript/walker/walker.js";

/** Walk `code` as one whole-file chunk; `tsx` selects the JSX-capable grammar. */
function extract(code: string, tsx = false) {
  const parser = new Parser();
  const grammar = TsLang as { tsx: Parser.Language; typescript: Parser.Language };
  parser.setLanguage(tsx ? grammar.tsx : grammar.typescript);
  return extractFromTypescriptFile({
    tree: parser.parse(code),
    code,
    relPath: tsx ? "src/a.tsx" : "src/a.ts",
    language: "typescript",
    chunks: [{ symbolId: "X", startLine: 1, endLine: code.split("\n").length, scope: [] }],
  });
}

describe("TypeScript walker — anonymous and generic class heritage", () => {
  it("records no heritage and no field types for an anonymous default-exported class, but still walks its calls", () => {
    const out = extract(
      "export default class {\n  f: Foo;\n  constructor(private a: A) {}\n  m() { this.a.go(); }\n}\n",
    );

    expect(out.classExtends).toBeUndefined();
    expect(out.classFieldTypes).toEqual({});
    expect(out.chunks[0]?.calls).toEqual([{ callText: "this.a.go()", receiver: "this.a", member: "go", startLine: 4 }]);
  });

  it("records no heritage for an anonymous default-exported class with an extends clause", () => {
    const out = extract("export default class extends Base<T> {}\n");

    expect(out.classExtends).toBeUndefined();
    expect(out.inheritanceEdges).toBeUndefined();
  });

  it("strips type arguments and keeps the qualified base of generic parents", () => {
    const out = extract("class A extends ns.Base<T> {}\nclass B extends Base<T> implements I {}\n");

    expect(out.classExtends).toEqual({ A: "ns.Base", B: "Base" });
    expect(out.inheritanceEdges).toEqual([
      { source: "A", ancestor: "ns.Base", kind: "super", ordinal: 0 },
      { source: "B", ancestor: "Base", kind: "super", ordinal: 0 },
      { source: "B", ancestor: "I", kind: "implements", ordinal: 0 },
    ]);
  });
});

describe("TypeScript walker — call and import shapes", () => {
  it("emits a constructor call whose constructor expression is itself a call", () => {
    const out = extract("const x = new (make())();\nnew a.B();\n");

    expect(out.chunks[0]?.calls).toEqual([
      { callText: "new (make())()", receiver: "(make())", member: "constructor", startLine: 1 },
      { callText: "make()", receiver: null, member: "make", startLine: 1 },
      { callText: "new a.B()", receiver: "a.B", member: "constructor", startLine: 2 },
    ]);
  });

  it("emits no call for an XML-namespaced JSX host element", () => {
    const out = extract("function P() { return <svg:circle r='1' />; }\n", true);

    expect(out.chunks[0]?.calls).toEqual([]);
  });

  it("binds object-pattern require/import members but not array-pattern ones", () => {
    const out = extract(
      "const [a] = require('./x');\nconst { b, c: d } = await import('./y');\nconst z = require('./z');\n",
    );

    expect(out.imports).toEqual([
      { importText: "./x", startLine: 1 },
      {
        importText: "./y",
        startLine: 2,
        importedExportNames: ["b", "c"],
        importedNames: ["b", "d"],
        importedBindings: { b: "b", d: "c" },
      },
      { importText: "./z", startLine: 3, importedExportNames: ["*"], importedNames: ["z"] },
    ]);
  });

  it("routes type-only imports and re-exports away from runtime imports", () => {
    const out = extract(
      "import type { A } from './a';\nimport { type B, C as D } from './b';\nexport type { E } from './e';\nimport type F, { G } from './f';\n",
    );

    expect(out.imports.map((i) => i.importText)).toEqual(["./b"]);
    expect(out.typeOnlyImports?.map((i) => i.importText)).toEqual(["./a", "./e", "./f"]);
  });

  it("drops callback-parameter facts for a function that no chunk contains", () => {
    const code = "function f(cb) { cb(); }\n";
    const parser = new Parser();
    parser.setLanguage((TsLang as { typescript: Parser.Language }).typescript);
    const out = extractFromTypescriptFile({
      tree: parser.parse(code),
      code,
      relPath: "src/a.ts",
      language: "typescript",
      chunks: [{ symbolId: "Elsewhere", startLine: 50, endLine: 60, scope: [] }],
    });

    expect(out.callbackParams).toBeUndefined();
  });

  it("flags the parameter index a function invokes as a callback", () => {
    const out = extract("function f(cb, g = 1, ...rest) { cb(); }\nf(() => 1);\n");

    expect(out.callbackParams).toEqual({ X: [0] });
  });
});
