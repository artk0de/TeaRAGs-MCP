/**
 * The kernel identifier-declaration pass (bd tea-rags-mcp-4p3sb.2). The syntax
 * object lives in the test so the kernel contract is pinned language-free.
 */
import Parser from "tree-sitter";
import TS from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../src/core/contracts/types/ast.js";
import type { WalkContext } from "../../../../../src/core/contracts/types/language.js";
import {
  createIdentifierDeclarationFacetPass,
  fieldRule,
  innermostChunkSymbolId,
  type IdentifierDeclarationSyntax,
} from "../../../../../src/core/domains/language/kernel/identifier-declarations.js";

const syntax: IdentifierDeclarationSyntax = {
  rules: [
    fieldRule("required_parameter", "param", { name: "pattern", type: "type" }),
    fieldRule("variable_declarator", "local", {
      name: "name",
      type: "type",
      value: "value",
    }),
  ],
  annotationType: (n: AstNode) => {
    const typeName = n.text.replace(/^:\s*/, "").split("<")[0].trim();
    return typeName === "" ? undefined : { typeName };
  },
  constructorType: (v: AstNode) => {
    const typeName = v.type === "new_expression" ? v.childForFieldName("constructor")?.text : undefined;
    return typeName === undefined ? undefined : { typeName };
  },
};

function run(src: string, chunks: WalkContext["chunks"]) {
  const p = new Parser();
  p.setLanguage(TS.typescript);
  const tree = p.parse(src);
  return createIdentifierDeclarationFacetPass(syntax).run(tree.rootNode, {
    code: src,
    relPath: "a.ts",
    language: "typescript",
    chunks,
  });
}

describe("identifier declaration pass", () => {
  const chunks = [
    { symbolId: "Svc", startLine: 1, endLine: 6, scope: [] },
    { symbolId: "Svc#load", startLine: 2, endLine: 5, scope: ["Svc"] },
  ];
  const src = [
    "class Svc {",
    "  load(id: string, repo: Repo<Doc>) {",
    "    const doc = new Document(id);",
    "    const row = repo.get(id); const doc2: Document = row;",
    "  }",
    "}",
  ].join("\n");

  it("records params and locals with owner, line and syntactic type", () => {
    expect(run(src, chunks).identifierDeclarations).toEqual([
      {
        name: "id",
        kind: "param",
        line: 2,
        ownerSymbolId: "Svc#load",
        typeName: "string",
        typeSource: "annotation",
      },
      {
        name: "repo",
        kind: "param",
        line: 2,
        ownerSymbolId: "Svc#load",
        typeName: "Repo",
        typeSource: "annotation",
      },
      {
        name: "doc",
        kind: "local",
        line: 3,
        ownerSymbolId: "Svc#load",
        typeName: "Document",
        typeSource: "constructor",
      },
      { name: "row", kind: "local", line: 4, ownerSymbolId: "Svc#load" },
      {
        name: "doc2",
        kind: "local",
        line: 4,
        ownerSymbolId: "Svc#load",
        typeName: "Document",
        typeSource: "annotation",
      },
    ]);
  });

  it("returns an empty partial when nothing is declared", () => {
    expect(run("class A {}", [{ symbolId: "A", startLine: 1, endLine: 1, scope: [] }])).toEqual({});
  });

  it("dedupes reassignment within one owner", () => {
    const out = run("function f() { let x = 1; x = 2; let x2 = 3 }", [
      { symbolId: "f", startLine: 1, endLine: 1, scope: [] },
    ]);
    expect(out.identifierDeclarations?.map((d) => d.name)).toEqual(["x", "x2"]);
  });

  // bd tea-rags-mcp-4p3sb.16 — the hook reads the value of a local / field only.
  it("asks `boundCalleeOf` for local and field values, never for a param's default", () => {
    const withCallee: IdentifierDeclarationSyntax = {
      ...syntax,
      rules: [
        fieldRule("required_parameter", "param", { name: "pattern", type: "type", value: "value" }),
        ...syntax.rules.slice(1),
      ],
      boundCalleeOf: (v: AstNode) =>
        v.type === "call_expression" ? { member: v.text.replace(/\(.*$/, ""), receiver: "r" } : undefined,
    };
    const p = new Parser();
    p.setLanguage(TS.typescript);
    const code = "function f(a = g()) { const x = h(); const y = 1; }";
    const out = createIdentifierDeclarationFacetPass(withCallee).run(p.parse(code).rootNode, {
      code,
      relPath: "a.ts",
      language: "typescript",
      chunks: [{ symbolId: "f", startLine: 1, endLine: 1, scope: [] }],
    });
    expect(out.identifierDeclarations).toEqual([
      { name: "a", kind: "param", line: 1, ownerSymbolId: "f" },
      { name: "x", kind: "local", line: 1, ownerSymbolId: "f", boundCallee: { member: "h", receiver: "r" } },
      { name: "y", kind: "local", line: 1, ownerSymbolId: "f" },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.26 — a collection read as its element keeps that it holds many.
  it("carries `many` from the syntax's reading, and from a site that collects its annotation", () => {
    const manyAware: IdentifierDeclarationSyntax = {
      ...syntax,
      rules: [
        ...syntax.rules,
        {
          nodeType: "rest_pattern",
          collect: (node) => {
            const nameNode = node.namedChild(0);
            const typeNode = node.parent?.childForFieldName("type") ?? null;
            return nameNode === null ? [] : [{ nameNode, kind: "param", typeNode, typeMultiplicity: "many" }];
          },
        },
      ],
      annotationType: (n: AstNode) => {
        const text = n.text.replace(/^:\s*/, "").trim();
        return text.endsWith("[]") ? { typeName: text.slice(0, -2), typeMultiplicity: "many" } : { typeName: text };
      },
    };
    const p = new Parser();
    p.setLanguage(TS.typescript);
    const code = "function f(candidates: Doc[], fallback: Doc, ...rest: Doc) {}";
    const out = createIdentifierDeclarationFacetPass(manyAware).run(p.parse(code).rootNode, {
      code,
      relPath: "a.ts",
      language: "typescript",
      chunks: [{ symbolId: "f", startLine: 1, endLine: 1, scope: [] }],
    });
    expect(out.identifierDeclarations).toEqual([
      {
        name: "candidates",
        kind: "param",
        line: 1,
        ownerSymbolId: "f",
        typeName: "Doc",
        typeSource: "annotation",
        typeMultiplicity: "many",
      },
      { name: "fallback", kind: "param", line: 1, ownerSymbolId: "f", typeName: "Doc", typeSource: "annotation" },
      {
        name: "rest",
        kind: "param",
        line: 1,
        ownerSymbolId: "f",
        typeName: "Doc",
        typeSource: "annotation",
        typeMultiplicity: "many",
      },
    ]);
  });

  // bd tea-rags-mcp-4p3sb.21 — a function's declared return type, owned by the function itself.
  describe("return declarations", () => {
    const withReturns: IdentifierDeclarationSyntax = {
      ...syntax,
      rules: [
        ...syntax.rules,
        {
          nodeType: "method_definition",
          collect: (node: AstNode) => {
            const nameNode = node.childForFieldName("name");
            return nameNode === null
              ? []
              : [{ nameNode, kind: "return" as const, typeNode: node.childForFieldName("return_type") }];
          },
        },
      ],
    };
    function runReturns(code: string, chunks: WalkContext["chunks"]) {
      const p = new Parser();
      p.setLanguage(TS.typescript);
      return createIdentifierDeclarationFacetPass(withReturns).run(p.parse(code).rootNode, {
        code,
        relPath: "a.ts",
        language: "typescript",
        chunks,
      }).identifierDeclarations;
    }

    it("records a typed return under the chunk that IS the function, named by it", () => {
      const code = ["class Svc {", "  @memo", "  load(): Doc {", "    return x;", "  }", "}"].join("\n");
      expect(
        runReturns(code, [
          { symbolId: "Svc", startLine: 1, endLine: 6, scope: [] },
          { symbolId: "Svc#load~2", startLine: 2, endLine: 5, scope: ["Svc"] },
        ]),
      ).toEqual([
        {
          name: "load",
          kind: "return",
          line: 3,
          ownerSymbolId: "Svc#load~2",
          typeName: "Doc",
          typeSource: "annotation",
        },
      ]);
    });

    it("drops an untyped return and a function no chunk of its own names", () => {
      const code = ["class Svc {", "  load() { return 1; }", "  find(): Doc { return x; }", "}"].join("\n");
      expect(runReturns(code, [{ symbolId: "Svc", startLine: 1, endLine: 4, scope: [] }])).toBeUndefined();
    });
  });

  it("innermost chunk: smallest span, deeper scope on tie", () => {
    const c = [
      { symbolId: "A", startLine: 1, endLine: 10, scope: [] },
      { symbolId: "A#constructor", startLine: 1, endLine: 10, scope: ["A"] },
      { symbolId: "A#m", startLine: 3, endLine: 4, scope: ["A"] },
    ];
    expect(innermostChunkSymbolId(3, c)).toBe("A#m");
    expect(innermostChunkSymbolId(8, c)).toBe("A#constructor");
    expect(innermostChunkSymbolId(20, c)).toBeUndefined();
  });
});
