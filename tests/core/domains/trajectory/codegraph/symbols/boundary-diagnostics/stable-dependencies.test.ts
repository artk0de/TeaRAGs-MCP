/**
 * Stable Dependencies Principle detector (bd tea-rags-mcp-thc7s).
 *
 * Martin: for every dependency A → B, I(A) ≥ I(B) — a module may only depend
 * on something at least as stable as itself. The detector flags the edges
 * where the target is LESS stable than the source by more than a tolerance,
 * judged on the same file graph and the same instability the
 * `codegraph.file.instability` payload signal is built from.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
  FileDependencyGraphFile,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  classifyDirectoryRelation,
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  DEFAULT_SDP_TOLERANCE,
  detectStableDependencyViolations,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";
import { CODEGRAPH_SYMBOLS_FILE_SIGNALS } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/payload-signals.js";

function walked(relPath: string, symbolCount = 1): FileDependencyGraphFile {
  return { relPath, language: "typescript", symbolCount };
}

function edge(sourceRelPath: string, targetRelPath: string, callWeight = 1): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight };
}

/** `count` walked files `${prefix}{1..count}.ts`, each importing `target` once. */
function importersOf(target: string, count: number, prefix: string): FileDependencyGraph {
  const files: FileDependencyGraphFile[] = [];
  const edges: FileDependencyEdge[] = [];
  for (let i = 1; i <= count; i++) {
    const relPath = `${prefix}${i}.ts`;
    files.push(walked(relPath));
    edges.push(edge(relPath, target));
  }
  return { files, edges };
}

/** `count` walked files `${prefix}{1..count}.ts`, each imported by `source` once. */
function importsOf(source: string, count: number, prefix: string): FileDependencyGraph {
  const files: FileDependencyGraphFile[] = [];
  const edges: FileDependencyEdge[] = [];
  for (let i = 1; i <= count; i++) {
    const relPath = `${prefix}${i}.ts`;
    files.push(walked(relPath));
    edges.push(edge(source, relPath));
  }
  return { files, edges };
}

function merge(...parts: FileDependencyGraph[]): FileDependencyGraph {
  return { files: parts.flatMap((p) => p.files), edges: parts.flatMap((p) => p.edges) };
}

/**
 * `core/stable.ts` — imported by 5 files, imports 1: I = 1/6, connectionCount 6.
 * `lib/volatile.ts` — imported by stable only, imports 4: I = 4/5, connectionCount 5.
 * stable → volatile is the textbook violation: delta 4/5 − 1/6.
 */
function stableOnVolatile(callWeight = 3): FileDependencyGraph {
  return merge(
    {
      files: [walked("core/stable.ts"), walked("lib/volatile.ts")],
      edges: [edge("core/stable.ts", "lib/volatile.ts", callWeight)],
    },
    importersOf("core/stable.ts", 5, "app/user"),
    importsOf("lib/volatile.ts", 4, "vendor/dep"),
  );
}

describe("detectStableDependencyViolations", () => {
  it("flags a stable file depending on a less stable one, with both instabilities, delta, support and weight", () => {
    const report = detectStableDependencyViolations(stableOnVolatile());

    expect(report.violations).toEqual([
      {
        sourceRelPath: "core/stable.ts",
        targetRelPath: "lib/volatile.ts",
        sourceInstability: 1 / 6,
        targetInstability: 4 / 5,
        instabilityDelta: 4 / 5 - 1 / 6,
        sourceConnectionCount: 6,
        targetConnectionCount: 5,
        callWeight: 3,
        directoryRelation: "disjoint",
      },
    ]);
  });

  it("never flags a dependency pointing toward stability", () => {
    // user{n} (I = 1) → stable (I = 1/6) and volatile (I = 4/5) → dep{n} (I = 0)
    // both run downhill; only stable → volatile runs uphill.
    const report = detectStableDependencyViolations(stableOnVolatile(), { minConnectionCount: 0 });

    expect(report.violations.map((v) => `${v.sourceRelPath} -> ${v.targetRelPath}`)).toEqual([
      "core/stable.ts -> lib/volatile.ts",
    ]);
  });

  it("treats the tolerance as a strict bound and lets the caller move it", () => {
    // source: fanIn 7, fanOut 3 → I = 0.3 ; target: fanIn 5, fanOut 5 → I = 0.5 ; delta = 0.2
    const graph = merge(
      { files: [walked("a/source.ts"), walked("b/target.ts")], edges: [edge("a/source.ts", "b/target.ts")] },
      importersOf("a/source.ts", 7, "in/s"),
      importsOf("a/source.ts", 2, "out/s"),
      importersOf("b/target.ts", 4, "in/t"),
      importsOf("b/target.ts", 5, "out/t"),
    );

    expect(DEFAULT_SDP_TOLERANCE).toBe(0.2);
    expect(detectStableDependencyViolations(graph).violations).toEqual([]);
    expect(detectStableDependencyViolations(graph, { tolerance: 0.1 }).violations).toHaveLength(1);
    expect(detectStableDependencyViolations(stableOnVolatile(), { tolerance: 0.7 }).violations).toEqual([]);
  });

  it("counts an edge to an unwalked file into the walked endpoint's instability but never judges that edge", () => {
    // volatile gains a 5th import, to a file the walk never extracted: I = 5/6.
    // stable gains an import of an unwalked file too: I = 2/7.
    const graph = merge(stableOnVolatile(), {
      files: [],
      edges: [edge("lib/volatile.ts", "generated/schema.ts"), edge("core/stable.ts", "generated/other.ts")],
    });

    const report = detectStableDependencyViolations(graph);

    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].sourceInstability).toBe(2 / 7);
    expect(report.violations[0].targetInstability).toBe(5 / 6);
    expect(report.summary.excluded.unwalkedEndpoints).toBe(2);
  });

  it("does not judge an endpoint whose instability rests on fewer edges than the instability signal's confidence floor", () => {
    const instability = CODEGRAPH_SYMBOLS_FILE_SIGNALS.find((d) => d.key === "codegraph.file.instability");
    expect(DEFAULT_SDP_MIN_CONNECTION_COUNT).toBe(instability?.stats?.confidence?.score?.threshold);

    // volatile loses one import: connectionCount 4 < 5.
    const graph = stableOnVolatile();
    const thinned: FileDependencyGraph = {
      files: graph.files,
      edges: graph.edges.filter((e) => e.targetRelPath !== "vendor/dep4.ts"),
    };

    const report = detectStableDependencyViolations(thinned);

    expect(report.violations).toEqual([]);
    expect(report.summary.excluded.lowConnectionCount).toBeGreaterThan(0);
    expect(detectStableDependencyViolations(thinned, { minConnectionCount: 4 }).violations).toHaveLength(1);
  });

  it("skips the out-edges of a pass-through file — no symbols and no call — but judges files that define or call", () => {
    // mod/index.ts re-exports mod/impl.ts: 6 importers, 1 re-export → I = 1/7.
    // mod/impl.ts: imported only by the barrel, imports 4 → I = 4/5.
    const barrel = merge(
      { files: [walked("mod/index.ts", 0), walked("mod/impl.ts")], edges: [edge("mod/index.ts", "mod/impl.ts", 0)] },
      importersOf("mod/index.ts", 6, "app/client"),
      importsOf("mod/impl.ts", 4, "vendor/x"),
    );

    const report = detectStableDependencyViolations(barrel);
    expect(report.violations).toEqual([]);
    // The re-export edge, and the 6 client edges INTO the barrel.
    expect(report.summary.excluded.passThroughEndpoints).toBe(1 + 6);

    // Same topology, but the symbol-less file CALLS into its target: not a pass-through.
    const calling: FileDependencyGraph = {
      files: barrel.files,
      edges: barrel.edges.map((e) => (e.sourceRelPath === "mod/index.ts" ? { ...e, callWeight: 1 } : e)),
    };
    expect(detectStableDependencyViolations(calling).violations).toHaveLength(1);

    // Same topology, a file that DEFINES symbols but carries no call is judged too
    // (a JSX element, a constant, a class used as a value).
    const defining: FileDependencyGraph = {
      files: barrel.files.map((f) => (f.relPath === "mod/index.ts" ? { ...f, symbolCount: 2 } : f)),
      edges: barrel.edges,
    };
    const judged = detectStableDependencyViolations(defining);
    expect(judged.violations).toHaveLength(1);
    expect(judged.violations[0].callWeight).toBe(0);
  });

  it("does not judge a dependency ON a pass-through file — its fanOut is its re-exports, not coupling", () => {
    // app/consumer.ts: 5 importers, 1 import → I = 1/6.
    // lib/index.ts, a barrel: imported by the consumer + 2 others, re-exports 4 files → I = 4/7.
    // The consumer depending on the barrel is how a module's public surface is meant to be used.
    const reExports = importsOf("lib/index.ts", 4, "lib/part");
    const graph = merge(
      {
        files: [walked("app/consumer.ts"), walked("lib/index.ts", 0), walked("other/a.ts"), walked("other/b.ts")],
        edges: [
          edge("app/consumer.ts", "lib/index.ts", 0),
          edge("other/a.ts", "lib/index.ts", 0),
          edge("other/b.ts", "lib/index.ts", 0),
        ],
      },
      importersOf("app/consumer.ts", 5, "in/c"),
      // A re-export carries no call.
      { files: reExports.files, edges: reExports.edges.map((e) => ({ ...e, callWeight: 0 })) },
    );
    const barrelAsTarget = graph.edges.filter((e) => e.targetRelPath === "lib/index.ts").length;

    const report = detectStableDependencyViolations(graph, { minConnectionCount: 0 });

    expect(report.violations).toEqual([]);
    // Its 4 re-export edges (as source) and its 3 inbound edges (as target).
    expect(report.summary.excluded.passThroughEndpoints).toBe(4 + barrelAsTarget);
  });

  it("never judges a self-edge", () => {
    const graph = merge(stableOnVolatile(), { files: [], edges: [edge("core/stable.ts", "core/stable.ts")] });

    const report = detectStableDependencyViolations(graph);

    expect(report.summary.excluded.selfEdges).toBe(1);
    expect(report.violations.every((v) => v.sourceRelPath !== v.targetRelPath)).toBe(true);
  });

  it("orders by delta, then call weight, then path", () => {
    // Two sources of identical shape (I = 1/6) over two targets of identical shape (I = 4/5),
    // plus a third target that is even less stable (I = 5/6).
    const graph = merge(
      {
        files: [walked("s/a.ts"), walked("s/b.ts"), walked("t/x.ts"), walked("t/y.ts"), walked("t/z.ts")],
        edges: [edge("s/a.ts", "t/x.ts", 1), edge("s/b.ts", "t/y.ts", 7), edge("s/b.ts", "t/z.ts", 1)],
      },
      importersOf("s/a.ts", 5, "in/a"),
      importersOf("s/b.ts", 10, "in/b"),
      importsOf("t/x.ts", 4, "out/x"),
      importsOf("t/y.ts", 4, "out/y"),
      importsOf("t/z.ts", 5, "out/z"),
    );

    const report = detectStableDependencyViolations(graph);

    // s/b: fanIn 10, fanOut 2 → I = 1/6 ; s/a: fanIn 5, fanOut 1 → I = 1/6.
    expect(report.violations.map((v) => `${v.sourceRelPath} -> ${v.targetRelPath}`)).toEqual([
      "s/b.ts -> t/z.ts",
      "s/b.ts -> t/y.ts",
      "s/a.ts -> t/x.ts",
    ]);
  });

  it("summarises what it read, what it judged and what it excluded", () => {
    const report = detectStableDependencyViolations(stableOnVolatile(), { tolerance: 0.3, minConnectionCount: 5 });

    expect(report.summary).toEqual({
      tolerance: 0.3,
      minConnectionCount: 5,
      edgeCount: 10,
      consideredEdgeCount: 1,
      violationCount: 1,
      excluded: { selfEdges: 0, unwalkedEndpoints: 0, passThroughEndpoints: 0, lowConnectionCount: 9 },
    });
  });
});

describe("classifyDirectoryRelation", () => {
  it.each([
    ["a/x.ts", "a/y.ts", "same"],
    ["x.ts", "y.ts", "same"],
    ["a/x.ts", "a/b/y.ts", "descendant"],
    ["x.ts", "a/y.ts", "descendant"],
    ["a/b/x.ts", "a/y.ts", "ancestor"],
    ["a/x.ts", "y.ts", "ancestor"],
    ["a/x.ts", "c/y.ts", "disjoint"],
    ["a/x.ts", "ab/y.ts", "disjoint"],
    ["a/b/x.ts", "a/c/y.ts", "disjoint"],
  ] as const)("%s -> %s is %s", (source, target, relation) => {
    expect(classifyDirectoryRelation(source, target)).toBe(relation);
  });
});
