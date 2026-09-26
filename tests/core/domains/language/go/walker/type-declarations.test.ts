/**
 * Go walker type/constant declaration facts (spec §1b, W3c): every walk
 * publishes `FileExtraction.typeDeclarations` — one fact per package-level
 * type spec (struct / defined type → class, interface → interface,
 * `type X = Y` → type_alias) and per name of a package-level `const`
 * (iota blocks included). `conforms` lists the EMBEDDED types of a struct or
 * interface: Go has no `extends`, embedding is its closest supertype relation.
 * Declarations local to a function body are not facts.
 */
import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

/** Walk `src` through the seam production runs (materialize, `collectSymbols`, `walker.walk`). */
function extract(src: string): FileExtraction {
  const language = new GoLanguage();
  const parser = new Parser();
  parser.setLanguage(GoLang);
  const rootNode = materializeTree(parser.parse(src).rootNode, src);
  const tree = { rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  return language.walker.walk({ tree, code: src, relPath: "pkg/a.go", language: "go", chunks });
}

describe("Go walker — type declaration facts", () => {
  it("publishes structs, defined types, interfaces and aliases with their kinds", () => {
    const src = [
      "package pkg",
      "type S struct{ n int }",
      "type I interface{ Get() int }",
      "type ID int",
      "type Handler func(int) error",
      "type Alias = S",
      "type List[T any] struct{ items []T }",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "S", symbolKind: "class", line: 2, reopens: false },
      { typeId: "I", symbolKind: "interface", line: 3, reopens: false },
      { typeId: "ID", symbolKind: "class", line: 4, reopens: false },
      { typeId: "Handler", symbolKind: "class", line: 5, reopens: false },
      { typeId: "Alias", symbolKind: "type_alias", line: 6, reopens: false },
      { typeId: "List", symbolKind: "class", line: 7, reopens: false },
    ]);
  });

  it("publishes each spec of a grouped type declaration, two on one line apart", () => {
    const src = [
      "package pkg",
      "type (",
      "\tReader interface{ Read() error }",
      "\tRow struct{}",
      "\tKey = string",
      ")",
      "type ( A struct{}; B = A )",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "Reader", symbolKind: "interface", line: 3, reopens: false },
      { typeId: "Row", symbolKind: "class", line: 4, reopens: false },
      { typeId: "Key", symbolKind: "type_alias", line: 5, reopens: false },
      { typeId: "A", symbolKind: "class", line: 7, reopens: false },
      { typeId: "B", symbolKind: "type_alias", line: 7, reopens: false },
    ]);
  });

  it("publishes every name of a package-level const, iota blocks and multi-name specs included", () => {
    const src = [
      "package pkg",
      "const Max = 10",
      "const (",
      "\tRed Color = iota",
      "\tGreen",
      "\tBlue",
      ")",
      "const Lo, Hi = 1, 2",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      { typeId: "Max", symbolKind: "constant", line: 2, reopens: false },
      { typeId: "Red", symbolKind: "constant", line: 4, reopens: false },
      { typeId: "Green", symbolKind: "constant", line: 5, reopens: false },
      { typeId: "Blue", symbolKind: "constant", line: 6, reopens: false },
      { typeId: "Lo", symbolKind: "constant", line: 8, reopens: false },
      { typeId: "Hi", symbolKind: "constant", line: 8, reopens: false },
    ]);
  });

  it("lists embedded types as conforms, in field order, pointer and generic arguments dropped", () => {
    const src = [
      "package pkg",
      "type Service struct {",
      "\tBase",
      "\t*Logger",
      "\tio.Reader",
      "\tCache[string]",
      "\tname string",
      "}",
      "type ReadCloser interface {",
      "\tfmt.Stringer",
      "\tCloser",
      "\t~int | ~string",
      "\tRead() error",
      "}",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([
      {
        typeId: "Service",
        symbolKind: "class",
        line: 2,
        reopens: false,
        conforms: ["Base", "Logger", "io.Reader", "Cache"],
      },
      { typeId: "ReadCloser", symbolKind: "interface", line: 9, reopens: false, conforms: ["fmt.Stringer", "Closer"] },
    ]);
  });

  it("does not publish types, consts or vars declared inside a function or method body", () => {
    const src = [
      "package pkg",
      "var Global = 1",
      "type S struct{}",
      "func f() {",
      "\tconst local = 1",
      "\ttype inner struct{}",
      "\t_ = func() { const deeper = 2 }",
      "}",
      "func (s S) m() { const inMethod = 3 }",
      "",
    ].join("\n");

    expect(extract(src).typeDeclarations).toEqual([{ typeId: "S", symbolKind: "class", line: 3, reopens: false }]);
  });

  it("omits the channel on a file that declares no type or constant", () => {
    expect(extract("package pkg\nfunc f() {}\n")).not.toHaveProperty("typeDeclarations");
  });
});

describe("Go walker — type declaration facts leave the rest of the extraction unchanged", () => {
  // Pinned from the walker BEFORE the typeDeclarations channel existed: the
  // chunk set, symbol kinds, calls, bindings and imports must be byte-identical.
  const src = [
    "package pkg",
    "",
    'import "fmt"',
    "",
    "const Max = 3",
    "",
    "type Base struct{}",
    "",
    "type S struct {",
    "\tBase",
    "\tn int",
    "}",
    "",
    "type Getter interface{ Get() int }",
    "",
    "func New() *S { return &S{} }",
    "",
    "func (s *S) Get() int {",
    "\tx := New()",
    "\tfmt.Println(x.n)",
    "\treturn s.n",
    "}",
    "",
  ].join("\n");

  it("keeps chunks, symbols, CallRefs, bindings and imports as they were", () => {
    const { typeDeclarations, ...rest } = extract(src);

    expect(typeDeclarations?.map((f) => f.typeId)).toEqual(["Max", "Base", "S", "Getter"]);
    expect(JSON.parse(JSON.stringify(rest))).toEqual(BASELINE_EXTRACTION);
  });
});

const BASELINE_EXTRACTION = {
  relPath: "pkg/a.go",
  language: "go",
  imports: [{ importText: "fmt", startLine: 3 }],
  chunks: [
    { symbolId: "Base", scope: [], startLine: 7, endLine: 7, calls: [], symbolKind: "class", visibility: "public" },
    { symbolId: "S", scope: [], startLine: 9, endLine: 12, calls: [], symbolKind: "class", visibility: "public" },
    {
      symbolId: "Getter",
      scope: [],
      startLine: 14,
      endLine: 14,
      calls: [],
      symbolKind: "interface",
      visibility: "public",
    },
    { symbolId: "New", scope: [], startLine: 16, endLine: 16, calls: [], symbolKind: "function", visibility: "public" },
    {
      symbolId: "S#Get",
      scope: [],
      startLine: 18,
      endLine: 22,
      calls: [
        { callText: "New()", receiver: null, member: "New", startLine: 19 },
        { callText: "fmt.Println(x.n)", receiver: "fmt", member: "Println", startLine: 20 },
      ],
      symbolKind: "method",
      localBindings: { s: [{ line: 18, type: "S" }] },
      callResultBindings: { x: [{ line: 19, callee: "New" }] },
      visibility: "public",
    },
  ],
  fileScope: [],
  functionReturnTypes: { "pkg::New": "S", Get: "int" },
  classFieldTypesByClassKey: {
    "pkg/a.go::Base": {},
    "pkg/a.go::S": { Base: "Base", "embedded:Base": "Base", n: "int" },
  },
  typeAbstractness: { abstractTypeCount: 1, concreteTypeCount: 2 },
  identifierDeclarations: [
    { name: "n", kind: "field", line: 11, ownerSymbolId: "S", typeName: "int", typeSource: "annotation" },
    { name: "New", kind: "return", line: 16, ownerSymbolId: "New", typeName: "S", typeSource: "annotation" },
    { name: "Get", kind: "return", line: 18, ownerSymbolId: "S#Get", typeName: "int", typeSource: "annotation" },
    { name: "x", kind: "local", line: 19, ownerSymbolId: "S#Get", boundCallee: { member: "New" } },
  ],
};
