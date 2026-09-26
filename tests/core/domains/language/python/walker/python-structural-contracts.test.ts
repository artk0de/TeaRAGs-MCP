/**
 * bd tea-rags-mcp-39xca.14 — a `typing.Protocol` class is a structural contract
 * (PEP 544): any class carrying its methods satisfies it without subclassing.
 * The walker declares each Protocol's methods with their positional parameter
 * count, `self` / `cls` dropped.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { StructuralContractDecl } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function contracts(src: string): StructuralContractDecl[] | undefined {
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return extractFromPythonFile({ tree: parser.parse(src), code: src, relPath: "x.py", language: "python", chunks: [] })
    .structuralContracts;
}

describe("Python Protocol contracts (39xca.14)", () => {
  it("declares a Protocol's methods with positional counts, receiver dropped", () => {
    const src = [
      "from typing import Protocol",
      "",
      "class Repository(Protocol):",
      "    def find(self, key, default=None): ...",
      "    @classmethod",
      "    def build(cls, config): ...",
      "    def all(self, *filters): ...",
    ].join("\n");

    expect(contracts(src)).toEqual([
      {
        name: "Repository",
        members: [
          { name: "find", params: 2 },
          { name: "build", params: 1 },
          { name: "all", params: Number.MAX_SAFE_INTEGER },
        ],
      },
    ]);
  });

  it("recognises qualified and generic Protocol bases, and names a nested one by its scope", () => {
    const src = [
      "import typing",
      "import typing_extensions",
      "class A(typing.Protocol):",
      "    def a(self): ...",
      "class B(typing_extensions.Protocol[T]):",
      "    def b(self): ...",
      "class Outer:",
      "    class Inner(Protocol):",
      "        def c(self, x): ...",
    ].join("\n");

    expect(contracts(src)?.map((c) => c.name)).toEqual(["A", "B", "Outer.Inner"]);
  });

  it("declares nothing for an ordinary class or a Protocol with no methods", () => {
    const src = ["class Plain(Base):", "    def run(self): ...", "class Marker(Protocol):", "    name: str"].join("\n");

    expect(contracts(src)).toBeUndefined();
  });
});
