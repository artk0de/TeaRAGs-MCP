/**
 * resolveChunkOwnerSymbol — the ONE chunk→symbol rule every writer of
 * `codegraph.symbols.chunk.*` resolves through (bd tea-rags-mcp-9i2ow).
 *
 * Two writers used to pick the symbol differently, and each was wrong on a
 * different class of chunk. Measured on the self-index, 2026-09-14:
 *
 *  - the deferred chunk pass took the greatest symbol START at or before the
 *    chunk's start and never looked at the end, so the `#part2` chunk
 *    1093-1115 of `collectPythonImports` landed on the nested
 *    `collectPythonImports.reexport` (1075-1077), which does not contain it;
 *  - the payload healer signalled by the chunk's payload symbolId, so chunk
 *    282-303 — inside `collectPythonInheritanceEdges.walkScope` (257-300) —
 *    took the OUTER function's numbers.
 *
 * The fixtures below are those two files' symbol ranges.
 */

import { describe, expect, it } from "vitest";

import { resolveChunkOwnerSymbol } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/chunk-owner-symbol.js";

const IMPORTS_WALKER = [
  { symbolId: "collectPythonImports", startLine: 1033, endLine: 1140 },
  { symbolId: "collectPythonImports.reexport", startLine: 1075, endLine: 1077 },
];

const INHERITANCE_WALKER = [
  { symbolId: "collectPythonInheritanceEdges", startLine: 240, endLine: 320 },
  { symbolId: "collectPythonInheritanceEdges.walkScope", startLine: 257, endLine: 300 },
];

describe("resolveChunkOwnerSymbol (bd tea-rags-mcp-9i2ow)", () => {
  describe("the two measured walker.ts shapes", () => {
    it("keeps a later part of an outer function on the outer function, not on a nested symbol that ended earlier", () => {
      expect(
        resolveChunkOwnerSymbol(
          { startLine: 1093, endLine: 1115, anchorSymbolId: "collectPythonImports#part2" },
          IMPORTS_WALKER,
        ),
      ).toBe("collectPythonImports");
    });

    it("maps the same span without an anchor to the innermost symbol that contains it", () => {
      expect(resolveChunkOwnerSymbol({ startLine: 1093, endLine: 1115 }, IMPORTS_WALKER)).toBe("collectPythonImports");
    });

    it("narrows an outer-anchored chunk to the nested function whose range contains its start", () => {
      expect(
        resolveChunkOwnerSymbol(
          { startLine: 282, endLine: 303, anchorSymbolId: "collectPythonInheritanceEdges" },
          INHERITANCE_WALKER,
        ),
      ).toBe("collectPythonInheritanceEdges.walkScope");
    });

    it("narrows a `#part` chunk of the outer function the same way", () => {
      expect(
        resolveChunkOwnerSymbol(
          { startLine: 282, endLine: 303, anchorSymbolId: "collectPythonInheritanceEdges#part3" },
          INHERITANCE_WALKER,
        ),
      ).toBe("collectPythonInheritanceEdges.walkScope");
    });
  });

  describe("with an anchor", () => {
    const METHOD = [
      { symbolId: "helper", startLine: 1, endLine: 8 },
      { symbolId: "Foo#bar", startLine: 12, endLine: 30 },
      { symbolId: "Foo#bar.inner", startLine: 20, endLine: 25 },
    ];

    it("keeps a primary chunk whose leading comment starts above the method on the method", () => {
      // The chunk starts at 10, two lines above `def`/`function`; `helper`
      // is the greatest symbol start below it and must NOT win.
      expect(resolveChunkOwnerSymbol({ startLine: 10, endLine: 30, anchorSymbolId: "Foo#bar" }, METHOD)).toBe(
        "Foo#bar",
      );
    });

    it("ignores a nested symbol that does not contain the chunk's start", () => {
      expect(resolveChunkOwnerSymbol({ startLine: 26, endLine: 30, anchorSymbolId: "Foo#bar#part2" }, METHOD)).toBe(
        "Foo#bar",
      );
    });

    it("strips the chunker's `#partN` suffix before matching", () => {
      expect(resolveChunkOwnerSymbol({ startLine: 21, endLine: 24, anchorSymbolId: "Foo#bar#part2" }, METHOD)).toBe(
        "Foo#bar.inner",
      );
    });

    it("treats only a separator-joined extension as nested, never a shared name prefix", () => {
      const ranges = [
        { symbolId: "run", startLine: 1, endLine: 50 },
        { symbolId: "runner", startLine: 10, endLine: 20 },
      ];
      expect(resolveChunkOwnerSymbol({ startLine: 12, endLine: 15, anchorSymbolId: "run" }, ranges)).toBe("run");
    });

    it("returns the anchor when it has no range row, whatever else contains the start", () => {
      // Pre-migration rows carry NULL ranges and never reach the list; a symbol
      // codegraph never emitted is absent too. Either way the anchor stands.
      expect(resolveChunkOwnerSymbol({ startLine: 40, endLine: 60, anchorSymbolId: "Big#run#part2" }, [])).toBe(
        "Big#run",
      );
      expect(
        resolveChunkOwnerSymbol({ startLine: 40, endLine: 60, anchorSymbolId: "Big#run" }, [
          { symbolId: "Other", startLine: 1, endLine: 100 },
        ]),
      ).toBe("Big#run");
    });

    it("prefers the later-starting candidate when two nested spans are equally tight", () => {
      const ranges = [
        { symbolId: "A", startLine: 1, endLine: 100 },
        { symbolId: "A.x", startLine: 10, endLine: 20 },
        { symbolId: "A.y", startLine: 15, endLine: 25 },
      ];
      expect(resolveChunkOwnerSymbol({ startLine: 16, endLine: 18, anchorSymbolId: "A" }, ranges)).toBe("A.y");
    });

    it("keeps the anchor on a full tie with a nested symbol spanning exactly the same lines", () => {
      // TS/JS classes get a synthetic `#constructor` over the class node's own
      // range when none is declared; it is not a more specific owner.
      const ranges = [
        { symbolId: "Foo", startLine: 1, endLine: 40 },
        { symbolId: "Foo#constructor", startLine: 1, endLine: 40 },
      ];
      expect(resolveChunkOwnerSymbol({ startLine: 1, endLine: 40, anchorSymbolId: "Foo" }, ranges)).toBe("Foo");
    });
  });

  describe("without an anchor (block chunks)", () => {
    const FILE = [
      { symbolId: "helper", startLine: 1, endLine: 8 },
      { symbolId: "Foo", startLine: 12, endLine: 40 },
      { symbolId: "Foo#bar", startLine: 14, endLine: 30 },
    ];

    it("takes the innermost symbol containing the start", () => {
      expect(resolveChunkOwnerSymbol({ startLine: 16, endLine: 20 }, FILE)).toBe("Foo#bar");
      expect(resolveChunkOwnerSymbol({ startLine: 32, endLine: 38 }, FILE)).toBe("Foo");
    });

    it("owns nothing when no symbol contains the start, even with one starting earlier", () => {
      expect(resolveChunkOwnerSymbol({ startLine: 9, endLine: 11 }, FILE)).toBeUndefined();
      expect(resolveChunkOwnerSymbol({ startLine: 45, endLine: 50 }, FILE)).toBeUndefined();
    });

    it("owns nothing when the file has no ranges at all", () => {
      expect(resolveChunkOwnerSymbol({ startLine: 1, endLine: 5 }, [])).toBeUndefined();
    });
  });
});
