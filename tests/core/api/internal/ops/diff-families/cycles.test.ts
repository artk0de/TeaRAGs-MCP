/**
 * The diff-scoped `cycles` family over the TREE graph (bd tea-rags-mcp-ah66x):
 * a changed file's out-edges are its overlay re-read, an unchanged file's (and
 * a changed file whose re-read was skipped) are the indexed ones. A cycle that
 * closes through ANOTHER changed file's new edge is the diff's own cycle; one
 * the overlay removed is not traversed. The base side (`preExisting`) is the
 * run's `heldBeforeChange`, unchanged.
 */
import { describe, expect, it, vi } from "vitest";

import {
  baseEdgesOf,
  catalogOf,
  graphOf,
  overlayOf,
  runWith,
  type FixtureEdge,
} from "../__helpers__/diff-run-fixtures.js";
import { DiffDetectorRun } from "../../../../../../src/core/api/internal/ops/diff-detector-run.js";
import { cyclesDetector } from "../../../../../../src/core/api/internal/ops/diff-families/cycles.js";
import { ReviewEdgeOverlay } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";
import { tarjanScc } from "../../../../../../src/core/primitives/graph/index.js";

function cycleSubjects(result: ReturnType<typeof runWith>): string[] {
  return result.findings
    .filter((finding) => finding.detector === "cycles")
    .map((finding) => finding.subject)
    .sort();
}

describe("cycles over the tree graph", () => {
  it("reports a cycle two changed files close together through each other's new edges", () => {
    const result = runWith(
      { graph: graphOf([["src/b.ts", "src/c.ts"]]) },
      ["src/a.ts", "src/c.ts"],
      [
        ["src/a.ts", "src/b.ts"],
        ["src/c.ts", "src/a.ts"],
      ],
    );
    expect(cycleSubjects(result)).toEqual(["src/a.ts -> src/b.ts", "src/c.ts -> src/a.ts"]);
    const closing = result.findings.find((finding) => finding.subject === "src/a.ts -> src/b.ts");
    expect(closing?.evidence).toEqual({ path: ["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"] });
    expect(closing?.preExisting).toBeUndefined();
  });

  it("reports a cycle made wholly of two changed files' new edges, with no indexed graph at all", () => {
    const run = new DiffDetectorRun({ catalog: catalogOf(new Map()) });
    const changed = ["src/a.ts", "src/b.ts"];
    const result = run.run(
      { changedFiles: changed },
      overlayOf(
        [
          ["src/a.ts", "src/b.ts"],
          ["src/b.ts", "src/a.ts"],
        ],
        changed,
      ),
    );
    expect(cycleSubjects(result)).toEqual(["src/a.ts -> src/b.ts", "src/b.ts -> src/a.ts"]);
  });

  it("does not walk a closing edge the overlay removed from a changed file", () => {
    // The index still holds b -> a; b's re-read dropped it.
    const result = runWith(
      { graph: graphOf([["src/b.ts", "src/a.ts"]]) },
      ["src/a.ts", "src/b.ts"],
      [
        ["src/a.ts", "src/b.ts"],
        ["src/b.ts", "src/x.ts"],
      ],
    );
    expect(cycleSubjects(result)).toEqual([]);
  });

  it("keeps a skipped re-read's indexed edges — a missing read is never an edge-free file", () => {
    const run = new DiffDetectorRun({ catalog: catalogOf(new Map()), graph: graphOf([["src/b.ts", "src/a.ts"]]) });
    const overlay = new ReviewEdgeOverlay([
      { relPath: "src/a.ts", edges: [{ sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts" }] },
      { relPath: "src/b.ts", edges: [], skip: { reason: "parseFailed" } },
    ]);
    const result = run.run({ changedFiles: ["src/a.ts", "src/b.ts"] }, overlay);
    expect(cycleSubjects(result)).toEqual(["src/a.ts -> src/b.ts"]);
  });

  it("does not close a cycle through a file the diff deleted — its indexed edges are gone from the tree", () => {
    // The index still holds b -> d -> a; d no longer exists in the tree.
    const run = new DiffDetectorRun({
      catalog: catalogOf(new Map()),
      graph: graphOf([
        ["src/b.ts", "src/d.ts"],
        ["src/d.ts", "src/a.ts"],
      ]),
    });
    const overlay = new ReviewEdgeOverlay(
      [{ relPath: "src/a.ts", edges: [{ sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts" }] }],
      { deleted: ["src/d.ts"] },
    );
    const scope = { changedFiles: ["src/a.ts"] };
    expect(cycleSubjects(run.run(scope, overlay))).toEqual([]);
    // The what-if re-run judges the same tree: an edit never resurrects a deleted file.
    expect(cycleSubjects({ findings: run.rejudge(scope, overlay, []).findings } as ReturnType<typeof runWith>)).toEqual(
      [],
    );
  });

  it("keeps the single-file cycle through unchanged files as before", () => {
    const result = runWith(
      {
        graph: graphOf([
          ["src/b.ts", "src/c.ts"],
          ["src/c.ts", "src/a.ts"],
        ]),
      },
      ["src/a.ts"],
      [["src/a.ts", "src/b.ts"]],
    );
    expect(cycleSubjects(result)).toEqual(["src/a.ts -> src/b.ts"]);
  });
});

// Parity with the whole-repo cycle detector (the file-level `tarjanScc` the
// codegraph persists as `find_cycles`' substrate): over the OVERLAID graph, an
// overlay edge is reported iff its endpoints share a non-trivial SCC; the ones
// the base lacked are the diff's own (no preExisting), the ones the base held
// are stamped preExisting — every cyclic edge of the BASE graph among them.
describe("cycles parity with the whole-repo SCC detector", () => {
  const NODES = ["n0", "n1", "n2", "n3", "n4", "n5"].map((name) => `src/${name}.ts`);

  /** Deterministic LCG — the property runs the same graphs on every run. */
  function randomOf(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  function randomEdges(random: () => number, sources: readonly string[], density: number): FixtureEdge[] {
    const edges: FixtureEdge[] = [];
    for (const source of sources) {
      for (const target of NODES) if (target !== source && random() < density) edges.push([source, target]);
    }
    return edges;
  }

  /** `source -> target` keys of the edges lying inside a non-trivial SCC. */
  function cyclicEdgeKeys(edges: readonly FixtureEdge[]): Set<string> {
    const adjacency = new Map<string, string[]>(NODES.map((node) => [node, []]));
    for (const [source, target] of edges) adjacency.get(source)?.push(target);
    const sccOf = new Map<string, number>();
    tarjanScc(adjacency).forEach((scc, index) => {
      if (scc.length > 1) for (const node of scc) sccOf.set(node, index);
    });
    return new Set(
      edges
        .filter(([source, target]) => sccOf.has(source) && sccOf.get(source) === sccOf.get(target))
        .map(([source, target]) => `${source} -> ${target}`),
    );
  }

  it("matches tarjanScc over the overlaid graph minus the base graph's cycles, on 200 seeded graphs", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = randomOf(seed);
      const baseEdges = randomEdges(random, NODES, 0.25);
      const changed = NODES.filter(() => random() < 0.4);
      if (changed.length === 0) continue;
      const changedSet = new Set(changed);
      const treeEdgesOfChanged = randomEdges(random, changed, 0.3);
      const overlaid = [...baseEdges.filter(([source]) => !changedSet.has(source)), ...treeEdgesOfChanged];

      const result = runWith(
        {
          graph: graphOf(baseEdges),
          maxTraceHops: NODES.length,
          baseEdges: baseEdgesOf(
            Object.fromEntries(
              changed.map((source) => [
                source,
                baseEdges.filter(([from]) => from === source).map(([, target]) => target),
              ]),
            ),
          ),
        },
        changed,
        treeEdgesOfChanged,
      );
      const findings = result.findings.filter((finding) => finding.detector === "cycles");

      const treeCyclic = cyclicEdgeKeys(overlaid);
      const baseKeys = new Set(baseEdges.map(([source, target]) => `${source} -> ${target}`));
      const baseCyclic = cyclicEdgeKeys(baseEdges);
      const overlayKeys = treeEdgesOfChanged.map(([source, target]) => `${source} -> ${target}`);

      const introduced = findings.filter((finding) => finding.preExisting !== true).map((finding) => finding.subject);
      const held = findings.filter((finding) => finding.preExisting === true).map((finding) => finding.subject);
      const context = `seed ${seed}`;
      expect(introduced.sort(), context).toEqual(
        overlayKeys.filter((key) => treeCyclic.has(key) && !baseKeys.has(key)).sort(),
      );
      expect(held.sort(), context).toEqual(
        overlayKeys.filter((key) => treeCyclic.has(key) && baseKeys.has(key)).sort(),
      );
      for (const key of overlayKeys.filter((overlayKey) => treeCyclic.has(overlayKey) && baseCyclic.has(overlayKey))) {
        expect(held, context).toContain(key);
      }
    }
  });
});

// The judge's cost contract (bd tea-rags-mcp-h2zwo): the remedy dry-run
// re-judges once per proposed remedy, so one judge must read the tree graph
// once — never once per BFS step per overlay edge — and its findings, closing
// paths included, must equal the per-edge BFS it replaced.
describe("cycles judge cost and path parity", () => {
  const NODES = ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"].map((name) => `src/${name}.ts`);

  function randomOf(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  function randomEdges(random: () => number, sources: readonly string[], density: number): FixtureEdge[] {
    const edges: FixtureEdge[] = [];
    for (const source of sources) {
      for (const target of NODES) if (target !== source && random() < density) edges.push([source, target]);
    }
    return edges;
  }

  /** The per-edge BFS the judge shipped with before h2zwo — the path oracle. */
  function referenceClosingPath(
    targetsOf: (relPath: string) => readonly string[],
    maxTraceHops: number,
    from: string,
    goal: string,
  ): readonly string[] | undefined {
    const visited = new Set<string>([from]);
    const queue: { node: string; path: readonly string[]; depth: number }[] = [{ node: from, path: [from], depth: 0 }];
    while (queue.length > 0) {
      const frame = queue.shift();
      if (frame === undefined) break;
      for (const target of targetsOf(frame.node)) {
        if (frame.depth + 1 > maxTraceHops) break;
        if (target === goal) return [goal, ...frame.path, goal];
        if (visited.has(target)) continue;
        visited.add(target);
        queue.push({ node: target, path: [...frame.path, target], depth: frame.depth + 1 });
      }
    }
    return undefined;
  }

  it("reads each file's indexed edges at most once per judge", () => {
    const indexed = graphOf([
      ["src/b.ts", "src/c.ts"],
      ["src/c.ts", "src/d.ts"],
      ["src/d.ts", "src/b.ts"],
      ["src/d.ts", "src/e.ts"],
    ]);
    // Only the cycles judge's reads count — the other families read the graph too.
    let insideCycles = false;
    const reads = new Map<string, number>();
    const graph = {
      ...indexed,
      edgesFrom: (relPath: string) => {
        if (insideCycles) reads.set(relPath, (reads.get(relPath) ?? 0) + 1);
        return indexed.edgesFrom(relPath);
      },
    };
    const { judge } = cyclesDetector;
    const spy = vi.spyOn(cyclesDetector, "judge").mockImplementation((context) => {
      insideCycles = true;
      try {
        return judge(context);
      } finally {
        insideCycles = false;
      }
    });
    try {
      const result = runWith(
        { graph },
        ["src/a.ts", "src/x.ts"],
        [
          ["src/a.ts", "src/b.ts"],
          ["src/a.ts", "src/c.ts"],
          ["src/a.ts", "src/d.ts"],
          ["src/x.ts", "src/b.ts"],
          ["src/x.ts", "src/e.ts"],
        ],
      );
      expect(cycleSubjects(result)).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(reads.size).toBeGreaterThan(0);
    for (const [relPath, count] of reads) expect(count, relPath).toBe(1);
  });

  it("reports the reference BFS's closing paths over deletions, skipped reads and hop caps, on 300 seeded graphs", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = randomOf(seed);
      const indexedEdges = randomEdges(random, NODES, 0.22);
      const changed = NODES.filter(() => random() < 0.4);
      if (changed.length === 0) continue;
      const deleted = NODES.filter((node) => !changed.includes(node) && random() < 0.12);
      const skipped = new Set(changed.filter(() => random() < 0.2));
      const treeEdgesOfChanged = randomEdges(random, changed, 0.3);
      const maxTraceHops = 1 + Math.floor(random() * NODES.length);

      const overlay = new ReviewEdgeOverlay(
        changed.map((relPath) => ({
          relPath,
          edges: treeEdgesOfChanged
            .filter(([source]) => source === relPath)
            .map(([sourceRelPath, targetRelPath]) => ({ sourceRelPath, targetRelPath })),
          ...(skipped.has(relPath) ? { skip: { reason: "parseFailed" as const } } : {}),
        })),
        { deleted },
      );
      const graph = graphOf(indexedEdges);
      const run = new DiffDetectorRun({ catalog: catalogOf(new Map()), graph, maxTraceHops });
      const findings = run
        .run({ changedFiles: changed }, overlay)
        .findings.filter((finding) => finding.detector === "cycles");

      const targetsOf = (relPath: string): readonly string[] =>
        overlay
          .treeEdgesFrom(relPath, (from) => graph.edgesFrom(from).map((edge) => ({ targetRelPath: edge.target })))
          .map((edge) => edge.targetRelPath);
      const expected: { subject: string; path: readonly string[] }[] = [];
      const seen = new Set<string>();
      for (const relPath of changed) {
        for (const edge of overlay.edgesFrom(relPath)) {
          const key = `${relPath} -> ${edge.targetRelPath}`;
          if (edge.targetRelPath === relPath || seen.has(key)) continue;
          seen.add(key);
          const path = referenceClosingPath(targetsOf, maxTraceHops, edge.targetRelPath, relPath);
          if (path !== undefined) expected.push({ subject: key, path });
        }
      }
      expect(
        findings.map((finding) => ({ subject: finding.subject, path: finding.evidence.path })),
        `seed ${seed}`,
      ).toEqual(expected);
    }
  });
});
