/**
 * Layer map (bd tea-rags-mcp-r8hme.26): the layering model read as a VIEW —
 * levels per node inside a scope, at directory or file granularity, with the
 * edges crossing the boundary kept as boundary-out / boundary-in findings that
 * carry the EXTERNAL component's global level, and the move-candidate signal
 * (inner fan-in 0, every outward edge pointing into one other domain).
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildComponentGraph,
  buildLayerMap,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function edge(sourceRelPath: string, targetRelPath: string, callWeight = 1): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight };
}

/**
 * `core` ← `weather` ← `tiles`, with `vpn` beside `weather` and `app` on top
 * reaching into tiles. Two tiles files reach the outside world: one into
 * `weather`, one into `vpn` — the spike's shape.
 */
function graph(): FileDependencyGraph {
  return {
    files: [
      file("core/c.ts"),
      file("weather/w.ts"),
      file("vpn/v.ts"),
      file("tiles/a.ts"),
      file("tiles/b.ts"),
      file("tiles/c.ts"),
      file("app/m.ts"),
    ],
    edges: [
      edge("weather/w.ts", "core/c.ts", 2),
      edge("vpn/v.ts", "core/c.ts"),
      edge("tiles/a.ts", "weather/w.ts", 3),
      edge("tiles/b.ts", "vpn/v.ts"),
      edge("tiles/c.ts", "tiles/a.ts"),
      edge("app/m.ts", "tiles/a.ts", 4),
    ],
  };
}

function judge(g: FileDependencyGraph = graph(), options = {}) {
  return buildLayerMap(buildComponentGraph(g, []), g, options);
}

describe("buildLayerMap — whole repo, directory granularity", () => {
  it("lists every component with its level, coupling and knots", () => {
    const map = judge();

    expect(map.granularity).toBe("directory");
    expect(map.scope).toBeUndefined();
    expect(map.levelCount).toBe(4);
    expect(map.nodes).toEqual([
      { node: "core", level: 0, depth: 3, inKnot: false, innerAfferentCount: 2, innerEfferentCount: 0 },
      { node: "vpn", level: 1, depth: 2, inKnot: false, innerAfferentCount: 1, innerEfferentCount: 1 },
      { node: "weather", level: 1, depth: 2, inKnot: false, innerAfferentCount: 1, innerEfferentCount: 1 },
      { node: "tiles", level: 2, depth: 1, inKnot: false, innerAfferentCount: 1, innerEfferentCount: 2 },
      { node: "app", level: 3, depth: 0, inKnot: false, innerAfferentCount: 0, innerEfferentCount: 1 },
    ]);
    expect(map.knots).toEqual([]);
    expect(map.boundaryOut).toEqual([]);
    expect(map.boundaryIn).toEqual([]);
    expect(map.moveCandidates).toEqual([]);
  });

  it("skips an edge whose endpoint the graph never walked, instead of minting a phantom node (bd tea-rags-mcp-r8hme.30)", () => {
    const g = graph();
    g.edges.push(edge("app/m.ts", "vendor/unwalked.ts", 2), edge("ghost.ts", "core/c.ts"));

    const map = judge(g);

    // The component graph excludes unwalked endpoints from its dependencies;
    // the map levels the same dependencies, so an endpoint outside
    // `componentOf` is not a node, an inner edge, or a boundary to nowhere.
    expect(map.nodes.map((n) => n.node)).toEqual(["core", "vpn", "weather", "tiles", "app"]);
    expect(map.summary.nodeCount).toBe(5);
    expect(map.summary.innerEdgeCount).toBe(5);
    expect(map.boundaryOut).toEqual([]);
    expect(map.boundaryIn).toEqual([]);
  });

  it("excludes facade-aggregation edges, leveling the same dependencies the detector judges (bd tea-rags-mcp-r8hme.30)", () => {
    const g = graph();
    g.files.push(file("app/index.ts"), file("app/nested/index.ts"));
    // The `app` facade re-exports its nested `app/nested` facade: aggregation,
    // not a dependency — without the exclusion it levels app below app/nested.
    g.edges.push({ ...edge("app/index.ts", "app/nested/index.ts", 0), reexportedExportNames: ["Nested"] });

    const map = judge(g);

    expect(map.summary.innerEdgeCount).toBe(5);
    expect(map.nodes.find((n) => n.node === "app")).toMatchObject({ level: 3, innerAfferentCount: 0 });
  });

  it("marks a knot whose every edge joins a directory to one nested inside it as composition, like the summary does (bd tea-rags-mcp-r8hme.30)", () => {
    const g = graph();
    g.files.push(file("app/index.ts"), file("app/nested/index.ts"));
    // `app` reaches into `app/nested` and `app/nested` reaches back up: a
    // parent and its own sub-part cycling — composition. `core` and `weather`
    // are disjoint peers: a real knot.
    g.edges.push(
      edge("app/index.ts", "app/nested/index.ts", 1),
      edge("app/nested/index.ts", "app/m.ts", 1),
      edge("core/c.ts", "weather/w.ts", 1),
    );

    const map = judge(g);

    expect(map.knots.map((k) => [k.components, k.composition])).toEqual([
      [["app", "app/nested"], true],
      [["core", "weather"], false],
    ]);
  });
});

describe("buildLayerMap — scoped to one domain, file granularity", () => {
  it("levels the induced subgraph and keeps crossing edges as boundary findings with global levels", () => {
    const map = judge(graph(), { scopePathPattern: "tiles/**", granularity: "file" });

    expect(map.scope).toBe("tiles/**");
    expect(map.granularity).toBe("file");
    expect(map.levelCount).toBe(2);
    expect(map.nodes).toEqual([
      { node: "tiles/a.ts", level: 0, depth: 1, inKnot: false, innerAfferentCount: 1, innerEfferentCount: 0 },
      { node: "tiles/b.ts", level: 0, depth: 0, inKnot: false, innerAfferentCount: 0, innerEfferentCount: 0 },
      { node: "tiles/c.ts", level: 1, depth: 0, inKnot: false, innerAfferentCount: 0, innerEfferentCount: 1 },
    ]);
    expect(map.boundaryOut).toEqual([
      { sourceNode: "tiles/b.ts", externalComponent: "vpn", externalLevel: 1, callWeight: 1 },
      { sourceNode: "tiles/a.ts", externalComponent: "weather", externalLevel: 1, callWeight: 3 },
    ]);
    expect(map.boundaryIn).toEqual([
      { targetNode: "tiles/a.ts", externalComponent: "app", externalLevel: 3, callWeight: 4 },
    ]);
  });

  it("names a file as a move candidate when nothing inside depends on it and its outward edges point into one domain", () => {
    const map = judge(graph(), { scopePathPattern: "tiles/**", granularity: "file" });

    // `b` sits at inner L0 with no inner afferents and reaches only into vpn.
    expect(map.moveCandidates).toEqual([{ node: "tiles/b.ts", level: 0, externalComponent: "vpn", callWeight: 1 }]);
  });

  it("collapses deeper directories at directoryDepth, keeping the boundary aggregate per outside component", () => {
    const deep = graph();
    deep.files.push(file("tiles/deep/x.ts"), file("tiles/deep/y.ts"));
    deep.edges.push(
      edge("tiles/deep/x.ts", "weather/w.ts", 2),
      edge("tiles/deep/y.ts", "vpn/v.ts"),
      edge("tiles/deep/x.ts", "tiles/deep/y.ts"),
    );

    const map = judge(deep, { scopePathPattern: "tiles/**", granularity: "directory", directoryDepth: 1 });

    expect(map.nodes.map((n) => n.node).sort()).toEqual(["tiles", "tiles/deep"]);
    expect(map.boundaryOut).toEqual([
      { sourceNode: "tiles", externalComponent: "vpn", externalLevel: 1, callWeight: 1 },
      { sourceNode: "tiles/deep", externalComponent: "vpn", externalLevel: 1, callWeight: 1 },
      { sourceNode: "tiles", externalComponent: "weather", externalLevel: 1, callWeight: 3 },
      { sourceNode: "tiles/deep", externalComponent: "weather", externalLevel: 1, callWeight: 2 },
    ]);
  });
});

describe("buildLayerMap — knots inside the scope", () => {
  it("reports an inner knot with its feedback arc set and levels after the cut", () => {
    const tangled = graph();
    tangled.edges.push(edge("tiles/c.ts", "tiles/b.ts", 2), edge("tiles/b.ts", "tiles/c.ts"));

    const map = judge(tangled, { scopePathPattern: "tiles/**", granularity: "file" });

    expect(map.knots).toHaveLength(1);
    const knot = map.knots[0];
    expect(knot.components.sort()).toEqual(["tiles/b.ts", "tiles/c.ts"]);
    expect(knot.cutEdgeCount).toBe(1);
    expect(knot.levelsAfterCut).toBe(2);
    // Canonical ELS (bd tea-rags-mcp-89k7k.12): neither vertex peels, the
    // weighted delta picks c (out 2 − in 1 = +1) over b (−1), c joins the
    // right block first and b peels after it, so the canonical sequence
    // [b, c] leaves c→b — the arc INTO the max-delta vertex's partner — as
    // the one cut. The inverted assembly named the opposite arc b→c. The
    // levelsAfterCut count is unaffected: over the members b→c→a reads
    // levels {1, 2} with this cut and {0, 1} with the old one, two distinct
    // either way.
    expect(knot.feedbackArcSet).toEqual([
      {
        sourceComponent: "tiles/c.ts",
        targetComponent: "tiles/b.ts",
        callWeight: 2,
        fileEdges: [{ sourceRelPath: "tiles/c.ts", targetRelPath: "tiles/b.ts", callWeight: 2 }],
      },
    ]);
  });
});

describe("buildLayerMap — degenerate inputs", () => {
  it("reads an empty scope as an empty map", () => {
    const map = judge(graph(), { scopePathPattern: "nowhere/**", granularity: "file" });

    expect(map).toMatchObject({
      nodes: [],
      knots: [],
      boundaryOut: [],
      boundaryIn: [],
      moveCandidates: [],
      levelCount: 0,
    });
  });

  it("keeps every node of an unscoped file map clean of boundary findings", () => {
    const map = judge(graph(), { granularity: "file" });

    expect(map.boundaryOut).toEqual([]);
    expect(map.boundaryIn).toEqual([]);
    expect(map.levelCount).toBe(4);
    expect(map.nodes).toHaveLength(7);
  });
});
