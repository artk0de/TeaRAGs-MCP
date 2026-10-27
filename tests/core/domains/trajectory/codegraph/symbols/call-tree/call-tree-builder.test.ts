import { describe, expect, it, vi } from "vitest";

import {
  buildCallTree,
  type CallTreeExpansion,
  type CallTreeHop,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/call-tree/index.js";

const hop = (symbolId: string, extra: Partial<CallTreeHop> = {}): CallTreeHop => ({
  symbolId,
  relPath: `${symbolId.split("#")[0].toLowerCase()}.ts`,
  edgeKind: "exact",
  confidence: 1,
  ...extra,
});

/** A frontier reader over a fixed adjacency; records every frontier it was asked for. */
function reader(adjacency: Record<string, CallTreeExpansion>) {
  const read = vi.fn(async (frontier: readonly string[]) => {
    const out = new Map<string, CallTreeExpansion>();
    for (const id of frontier) if (adjacency[id]) out.set(id, adjacency[id]);
    return out;
  });
  return read;
}

describe("buildCallTree (bd tea-rags-mcp-afdpc)", () => {
  it("depth 2: BFS rows carry depth, parent and the edge into the node; expanded nodes carry external", async () => {
    const read = reader({
      "A#a": { hops: [hop("C#c"), hop("D#d", { edgeKind: "cone", confidence: 0.5 })], external: 3 },
      "B#b": { hops: [hop("E#e")], external: 0 },
    });

    const nodes = await buildCallTree("Root#run", [hop("A#a"), hop("B#b")], read, 2);

    expect(nodes).toEqual([
      { ...hop("A#a"), depth: 1, parent: "Root#run", external: 3 },
      { ...hop("B#b"), depth: 1, parent: "Root#run" },
      { ...hop("C#c"), depth: 2, parent: "A#a" },
      { ...hop("D#d", { edgeKind: "cone", confidence: 0.5 }), depth: 2, parent: "A#a" },
      { ...hop("E#e"), depth: 2, parent: "B#b" },
    ]);
  });

  it("reads one frontier per expanded level, never one node at a time", async () => {
    const read = reader({
      "A#a": { hops: [hop("C#c")], external: 0 },
      "B#b": { hops: [hop("D#d")], external: 0 },
      "C#c": { hops: [hop("E#e")], external: 0 },
    });

    await buildCallTree("Root#run", [hop("A#a"), hop("B#b")], read, 3);

    expect(read.mock.calls).toEqual([[["A#a", "B#b"]], [["C#c", "D#d"]]]);
  });

  it("dedupes: a symbol seen earlier is a back-reference row, never expanded twice", async () => {
    const read = reader({
      "A#a": { hops: [hop("Shared#s"), hop("Root#run")], external: 0 },
      "B#b": { hops: [hop("Shared#s")], external: 0 },
      "Shared#s": { hops: [hop("Leaf#l")], external: 0 },
    });

    const nodes = await buildCallTree("Root#run", [hop("A#a"), hop("B#b")], read, 3);

    expect(nodes.map((n) => [n.symbolId, n.parent, n.depth, n.seen ?? false])).toEqual([
      ["A#a", "Root#run", 1, false],
      ["B#b", "Root#run", 1, false],
      ["Shared#s", "A#a", 2, false],
      ["Root#run", "A#a", 2, true],
      ["Shared#s", "B#b", 2, true],
      ["Leaf#l", "Shared#s", 3, false],
    ]);
    expect(read.mock.calls[1]).toEqual([["Shared#s"]]);
  });

  it("depth 1 reads no frontier and returns the anchor's hops", async () => {
    const read = reader({});

    const nodes = await buildCallTree("Root#run", [hop("A#a")], read, 1);

    expect(nodes).toEqual([{ ...hop("A#a"), depth: 1, parent: "Root#run" }]);
    expect(read).not.toHaveBeenCalled();
  });
});
