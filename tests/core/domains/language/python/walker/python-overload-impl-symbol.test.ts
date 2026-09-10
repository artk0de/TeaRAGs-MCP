/**
 * `@typing.overload` stubs must yield the symbol to the implementation that
 * follows them (bd tea-rags-mcp-0qyze).
 *
 * `collectSymbols` dedups by symbolId keeping the FIRST occurrence, and an
 * overload group spells the same `Cls#m` once per stub before the real def. The
 * first stub therefore won the range, the implementation got NO chunk at all,
 * and every call in the implementation body fell through to the enclosing CLASS
 * chunk — whose `scope` is `[]`, which is exactly the input
 * `pythonEnclosingClass` reads as "no enclosing class". On polar that cost 112
 * `self.client.build_request()` / `self.client.send_request()` rows across 22
 * generated SDK service files.
 *
 * A group with no implementation (a Protocol / ABC body, where the stubs ARE
 * the declaration) keeps the first stub — yielding there would delete the
 * symbol outright.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { pyNameOf } from "../../../../../../src/core/domains/language/python/walker/name-of.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(PyLang as unknown as Parser.Language);
  return parser.parse(src);
}

const composer = new DefaultSymbolIdComposer();

function symbols(src: string): { symbolId: string; startLine: number; endLine: number; scope: string[] }[] {
  return collectSymbols(parse(src), pyNameOf, ".", false, composer);
}

/** The generated-SDK shape: an overload group, then the implementation that calls out. */
const OVERLOADED_SERVICE = [
  "import typing",
  "",
  "class FilesSync(SyncServiceBase):",
  "    @typing.overload",
  "    def create(self, *, name: str) -> File: ...",
  "",
  "    @typing.overload",
  "    def create(self, *, body: bytes) -> File: ...",
  "",
  "    def create(self, **kwargs) -> File:",
  "        request = self.client.build_request(**kwargs)",
  "        return self.client.send_request(request)",
  "",
].join("\n");

describe("@typing.overload stubs yield their symbol to the implementation (0qyze)", () => {
  it("ranges Cls#m over the implementation, not over the first stub", () => {
    const create = symbols(OVERLOADED_SERVICE).filter((s) => s.symbolId === "FilesSync#create");

    expect(create).toHaveLength(1);
    expect(create[0].startLine).toBe(10);
    expect(create[0].endLine).toBe(12);
    expect(create[0].scope).toEqual(["FilesSync"]);
  });

  it("carries the class scope on calls made from the implementation body", () => {
    const chunks = symbols(OVERLOADED_SERVICE);
    const out = extractFromPythonFile({
      tree: parse(OVERLOADED_SERVICE),
      code: OVERLOADED_SERVICE,
      relPath: "sdk/services/files.py",
      language: "python",
      chunks,
    });
    const impl = out.chunks.find((c) => c.symbolId === "FilesSync#create");

    expect(impl?.scope).toEqual(["FilesSync"]);
    expect((impl?.calls ?? []).map((c) => c.member)).toEqual(expect.arrayContaining(["build_request", "send_request"]));
    // The class chunk keeps its own body calls and gains none of the method's.
    const cls = out.chunks.find((c) => c.symbolId === "FilesSync");
    expect((cls?.calls ?? []).map((c) => c.member)).not.toContain("build_request");
  });

  it("recognises a bare @overload import the same way as @typing.overload", () => {
    const src = [
      "from typing import overload",
      "",
      "class C:",
      "    @overload",
      "    def m(self, a: int) -> int: ...",
      "",
      "    def m(self, a):",
      "        return self.helper(a)",
      "",
    ].join("\n");

    expect(symbols(src).find((s) => s.symbolId === "C#m")?.startLine).toBe(7);
  });

  it("yields to an implementation that carries a decorator of its own", () => {
    const src = [
      "import typing",
      "",
      "class C:",
      "    @typing.overload",
      "    def m(self, a: int) -> int: ...",
      "",
      "    @staticmethod",
      "    def m(a):",
      "        return a",
      "",
    ].join("\n");
    const m = symbols(src).filter((s) => s.symbolId.endsWith("m"));

    expect(m).toHaveLength(1);
    expect(m[0].symbolId).toBe("C.m");
    expect(m[0].startLine).toBe(8);
  });

  it("keeps the first stub when the group has no implementation", () => {
    const src = [
      "import typing",
      "",
      "class Proto(typing.Protocol):",
      "    @typing.overload",
      "    def m(self, a: int) -> int: ...",
      "",
      "    @typing.overload",
      "    def m(self, a: str) -> str: ...",
      "",
    ].join("\n");
    const m = symbols(src).filter((s) => s.symbolId === "Proto#m");

    expect(m).toHaveLength(1);
    expect(m[0].startLine).toBe(5);
  });

  it("leaves @property / @staticmethod / @classmethod groups alone", () => {
    const src = [
      "class C:",
      "    @property",
      "    def value(self):",
      "        return self._v",
      "",
      "    @staticmethod",
      "    def build():",
      "        return C()",
      "",
      "    @classmethod",
      "    def of(cls):",
      "        return cls()",
      "",
    ].join("\n");
    const ids = symbols(src).map((s) => s.symbolId);

    expect(ids).toContain("C#value");
    expect(ids).toContain("C.build");
    expect(ids).toContain("C.of");
  });

  it("yields only to a same-named implementation, never to an unrelated later def", () => {
    const src = [
      "import typing",
      "",
      "class C:",
      "    @typing.overload",
      "    def m(self, a: int) -> int: ...",
      "",
      "    def other(self):",
      "        return 1",
      "",
    ].join("\n");
    const m = symbols(src).filter((s) => s.symbolId === "C#m");

    expect(m).toHaveLength(1);
    expect(m[0].startLine).toBe(5);
  });
});
