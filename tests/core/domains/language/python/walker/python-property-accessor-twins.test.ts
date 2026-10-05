/**
 * A property's setter / deleter body belongs to the property's symbol (bd
 * tea-rags-mcp-m99j1.1.76).
 *
 * `@property def x` and `@x.setter def x` compose the SAME symbolId `Cls#x`, by
 * design: accessor pairs share one id, and `collectSymbols` keeps the first
 * range — the getter's. The setter therefore had no range of its own, and every
 * call in its body fell through to the enclosing CLASS chunk, whose `scope` is
 * the class's declaration scope, which `pythonEnclosingClass` reads as "no
 * enclosing class". django `contrib/gis/geos/point.py`: the getters'
 * `self._cs.getOrdinate(...)` resolved, the setters' `self._cs.setOrdinate(...)`
 * did not.
 *
 * The id stays shared and the chunk keeps the getter's range; only the call
 * sites and the def-local channels of the accessor twin join that chunk.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type { ChunkExtraction, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { pyNameOf } from "../../../../../../src/core/domains/language/python/walker/name-of.js";
import { extractFromPythonFile } from "../../../../../../src/core/domains/language/python/walker/walker.js";

const composer = new DefaultSymbolIdComposer();

/** The production seam: one parse, `collectSymbols` + `pyNameOf`, then the walker. */
function extract(lines: readonly string[]): FileExtraction {
  const src = lines.join("\n");
  const parser = new Parser();
  parser.setLanguage(PyLang);
  const tree = parser.parse(src);
  return extractFromPythonFile({
    tree,
    code: src,
    relPath: "geos/point.py",
    language: "python",
    chunks: collectSymbols(tree, pyNameOf, ".", false, composer),
  });
}

function chunk(out: FileExtraction, symbolId: string): ChunkExtraction {
  const found = out.chunks.filter((c) => c.symbolId === symbolId);
  expect(found).toHaveLength(1);
  return found[0];
}

function callLines(c: ChunkExtraction): number[] {
  return c.calls.map((call) => call.startLine).sort((a, b) => a - b);
}

const POINT = [
  "class Point:", //                         1
  "    @property", //                        2
  "    def x(self):", //                     3
  "        return self._cs.getOrdinate(0)", // 4
  "", //                                     5
  "    @x.setter", //                        6
  "    def x(self, value):", //              7
  "        self._cs.setOrdinate(0, value)", // 8
  "", //                                     9
  "    @x.deleter", //                      10
  "    def x(self):", //                    11
  "        self._cs.clear()", //            12
  "", //                                    13
];

describe("property accessor twins (m99j1.1.76)", () => {
  it("attributes setter and deleter body calls to the shared property chunk", () => {
    const x = chunk(extract(POINT), "Point#x");
    expect(callLines(x)).toEqual([4, 8, 12]);
    expect(x.scope).toEqual(["Point"]);
  });

  it("keeps the shared chunk on the getter's range", () => {
    const x = chunk(extract(POINT), "Point#x");
    expect([x.startLine, x.endLine]).toEqual([3, 4]);
  });

  it("takes the accessor bodies' calls away from the class chunk, leaving the decorator calls there", () => {
    const cls = chunk(extract(POINT), "Point");
    const texts = cls.calls.map((c) => c.callText);
    expect(texts).not.toContain("self._cs.setOrdinate(0, value)");
    expect(texts).not.toContain("self._cs.clear()");
    expect(texts).toContain("@x.setter");
  });

  it("carries a local the setter binds onto the shared chunk at the setter's line", () => {
    const out = extract([
      "class Seq:", //                 1
      "    def put(self, v):", //       2
      "        return v", //            3
      "", //                           4
      "class Point:", //               5
      "    @property", //               6
      "    def x(self):", //            7
      "        return 1", //            8
      "", //                           9
      "    @x.setter", //              10
      "    def x(self, value):", //    11
      "        cs = Seq()", //         12
      "        cs.put(value)", //      13
      "",
    ]);
    const x = chunk(out, "Point#x");
    expect(callLines(x)).toEqual([12, 13]);
    expect(x.localBindings?.cs?.map((b) => [b.line, b.type])).toEqual([[12, "Seq"]]);
    expect(x.assignedLocals).toContain("cs");
  });

  it("leaves a def nested in a setter to its own chunk", () => {
    const out = extract([
      "class Point:", //                 1
      "    @property", //                 2
      "    def x(self):", //              3
      "        return 1", //              4
      "", //                             5
      "    @x.setter", //                6
      "    def x(self, value):", //      7
      "        def norm(v):", //         8
      "            return abs(v)", //    9
      "        self._v = norm(value)", // 10
      "",
    ]);
    expect(callLines(chunk(out, "Point#x"))).toEqual([10]);
    expect(callLines(chunk(out, "Point#x#norm"))).toEqual([9]);
  });

  // m99j1.1.80 changed this invariant: a def decorated `@y.setter` is not an
  // accessor of `x`, but it IS a plain redefinition of `Point#x`, so its body
  // joins the shared chunk through the redefinition pass instead of the class.
  it("joins a same-named def whose decorator names a DIFFERENT property as a plain redefinition", () => {
    const out = extract([
      "class Point:", //                1
      "    @property", //                2
      "    def x(self):", //             3
      "        return 1", //             4
      "", //                            5
      "    @y.setter", //               6
      "    def x(self, value):", //     7
      "        self._cs.put(value)", // 8
      "",
    ]);
    expect(callLines(chunk(out, "Point#x"))).toEqual([8]);
    expect(chunk(out, "Point").calls.map((c) => c.startLine)).not.toContain(8);
  });

  // m99j1.1.80 changed this invariant: a plain redefinition now joins the shared
  // chunk (python-redefinition-twins.test.ts owns the shapes).
  it("attributes a plain same-named redefinition to the shared chunk", () => {
    const out = extract([
      "class Point:", //                1
      "    def x(self):", //             2
      "        return 1", //             3
      "", //                            4
      "    def x(self, value):", //     5
      "        self._cs.put(value)", // 6
      "",
    ]);
    expect(callLines(chunk(out, "Point#x"))).toEqual([6]);
    expect(chunk(out, "Point").calls.map((c) => c.startLine)).not.toContain(6);
  });

  it("leaves a setter with no def-declared getter (x = property(...)) exactly as before", () => {
    const out = extract([
      "class Point:", //                  1
      "    x = property(lambda s: 1)", // 2
      "", //                              3
      "    @x.setter", //                 4
      "    def x(self, value):", //       5
      "        self._cs.put(value)", //   6
      "",
    ]);
    // The setter is the first `def x`, so it owns `Point#x` itself.
    expect(callLines(chunk(out, "Point#x"))).toEqual([6]);
  });
});
