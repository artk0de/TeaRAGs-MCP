import { describe, expect, it } from "vitest";

import type { GraphEdges } from "../../../../../src/core/contracts/types/codegraph.js";
import { fileEdgesFromResolvedCalls } from "../../../../../src/core/domains/language/kernel/index.js";

type MethodEdge = GraphEdges["methodEdges"][number];

const CALLER = "Sources/A.swift";

function edge(targetRelPath: string, extra: Partial<MethodEdge> = {}): MethodEdge {
  return {
    sourceSymbolId: "A#run",
    targetSymbolId: "B#go",
    targetRelPath,
    callExpression: "b.go()",
    ...extra,
  };
}

describe("fileEdgesFromResolvedCalls", () => {
  it("emits one edge per distinct target file, in first-seen order", () => {
    const edges = [edge("Sources/B.swift"), edge("Sources/C.swift"), edge("Sources/B.swift")];

    expect(fileEdgesFromResolvedCalls(CALLER, edges)).toEqual([
      { targetRelPath: "Sources/B.swift", importText: null },
      { targetRelPath: "Sources/C.swift", importText: null },
    ]);
  });

  it("drops calls that stay inside the caller file", () => {
    expect(fileEdgesFromResolvedCalls(CALLER, [edge(CALLER)])).toEqual([]);
  });

  it("drops a sub-1 dynamic fan-out edge but keeps a narrowed one", () => {
    const edges = [
      edge("Sources/Fan1.swift", { edgeKind: "dynamic", confidence: 0.5 }),
      edge("Sources/Fan2.swift", { edgeKind: "dynamic", confidence: 0.5 }),
      edge("Sources/Narrowed.swift", { edgeKind: "dynamic", confidence: 1 }),
    ];

    expect(fileEdgesFromResolvedCalls(CALLER, edges)).toEqual([
      { targetRelPath: "Sources/Narrowed.swift", importText: null },
    ]);
  });

  it("returns no edges for a file with no resolved calls", () => {
    expect(fileEdgesFromResolvedCalls(CALLER, [])).toEqual([]);
  });
});
