/**
 * P3 descriptors, end to end (bd tea-rags-mcp-m99j1.1.20, Task 18).
 *
 * Python distinguishes ACCESS from CALL: `self.output_field` on a
 * `@cached_property` is the value the def returns, while `self.method_field`
 * on a plain method is a bound method — its return belongs to
 * `self.method_field()`. So an attribute hop reads only what the attribute
 * holds (a field, a descriptor's return, a framework-synthesized attribute) and
 * a call hop reads the return. A method accessed without a call is untyped,
 * which keeps the chain on the passes after it rather than pinning an edge on
 * the method's return class.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  FileExtraction,
  SymbolResolutionTarget,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const FIELDS = "app/fields.py";
const EXPR = "app/expressions.py";

function walk(relPath: string, lines: readonly string[], declaredDependencies?: ReadonlySet<string>): FileExtraction {
  const src = lines.join("\n");
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return new PythonLanguage().walker.walk({
    tree: parser.parse(src),
    code: src,
    relPath,
    language: "python",
    chunks: [],
    ...(declaredDependencies === undefined ? {} : { declaredDependencies }),
  });
}

function table(): InMemoryGlobalSymbolTable {
  const files: Record<string, readonly string[]> = {
    [FIELDS]: ["Field", "Field#db_type", "CharField", "CharField#db_type"],
    [EXPR]: ["Expr", "Expr#output_field", "Expr#method_field", "Expr#use"],
  };
  const out = new InMemoryGlobalSymbolTable();
  for (const [relPath, ids] of Object.entries(files)) {
    out.upsertFile(
      relPath,
      ids.map((symbolId) => {
        const parts = symbolId.split(/[#.]/);
        return { symbolId, fqName: symbolId, shortName: parts[parts.length - 1], relPath, scope: parts.slice(0, -1) };
      }),
    );
  }
  return out;
}

function ctxFor(ext: FileExtraction): CallContext {
  return {
    callerFile: EXPR,
    callerScope: ["Expr", "use"],
    imports: ext.imports.map((i) => ({ importText: i.importText, startLine: i.startLine })),
    symbolTable: table(),
    ...(ext.classFieldTypes === undefined ? {} : { classFieldTypes: ext.classFieldTypes }),
    ...(ext.structuredReturnTypes === undefined ? {} : { structuredReturnTypes: ext.structuredReturnTypes }),
  };
}

function resolve(ext: FileExtraction, receiver: string, line: number): SymbolResolutionTarget | null {
  const ref: CallRef = { callText: `${receiver}.db_type(c)`, receiver, member: "db_type", startLine: line };
  return new PythonCallResolver().resolve(ref, ctxFor(ext));
}

const DECORATED_HEADER = (decoratorImport: string, decorator: string): string[] => [
  decoratorImport,
  "from app.fields import Field",
  "",
  "class Expr:",
  `    ${decorator}`,
  "    def output_field(self) -> Field:",
  "        return Field()",
  "",
  "    def method_field(self) -> Field:",
  "        return Field()",
  "",
  "    def use(self, c):",
  "        self.output_field.db_type(c)",
  "        self.method_field.db_type(c)",
  "        self.method_field().db_type(c)",
];

describe("Python descriptors — attribute access reads what the attribute holds", () => {
  it("`@cached_property def output_field(self) -> Field` + `self.output_field.db_type(c)` → Field#db_type", () => {
    const ext = walk(EXPR, DECORATED_HEADER("from functools import cached_property", "@cached_property"));
    expect(resolve(ext, "self.output_field", 13)?.targetSymbolId).toBe("Field#db_type");
  });

  it("`@property` → Field#db_type", () => {
    const ext = walk(EXPR, DECORATED_HEADER("import functools", "@property"));
    expect(resolve(ext, "self.output_field", 13)?.targetSymbolId).toBe("Field#db_type");
  });

  it("a `django.utils.functional.cached_property` import, Django declared → Field#db_type", () => {
    const ext = walk(
      EXPR,
      DECORATED_HEADER("from django.utils.functional import cached_property", "@cached_property"),
      new Set(["django"]),
    );
    expect(resolve(ext, "self.output_field", 13)?.targetSymbolId).toBe("Field#db_type");
  });

  it("a plain method accessed without a call is not typed", () => {
    const ext = walk(EXPR, DECORATED_HEADER("from functools import cached_property", "@cached_property"));
    expect(resolve(ext, "self.method_field", 14)?.targetSymbolId).not.toBe("Field#db_type");
  });

  it("the same method CALLED still types through its return", () => {
    const ext = walk(EXPR, DECORATED_HEADER("from functools import cached_property", "@cached_property"));
    expect(resolve(ext, "self.method_field()", 15)?.targetSymbolId).toBe("Field#db_type");
  });

  it("a chain hop through a plain method without a call is not typed either", () => {
    const ext = walk(EXPR, [
      "from app.fields import Field",
      "",
      "class Expr:",
      "    def method_field(self) -> Field:",
      "        return Field()",
      "",
      "    def use(self, other: Expr, c):",
      "        other.method_field.db_type(c)",
      "        other.method_field().db_type(c)",
    ]);
    const at = (receiver: string, line: number): string | null | undefined =>
      new PythonCallResolver().resolve(
        { callText: `${receiver}.db_type(c)`, receiver, member: "db_type", startLine: line },
        {
          ...ctxFor(ext),
          localBindings: { other: [{ line: 7, type: "Expr", endLine: 9 }] },
        },
      )?.targetSymbolId;
    expect(at("other.method_field", 8)).not.toBe("Field#db_type");
    expect(at("other.method_field()", 9)).toBe("Field#db_type");
  });
});
