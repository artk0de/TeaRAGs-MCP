/**
 * The diff-scoped `cycles` family over the TREE graph (bd tea-rags-mcp-ah66x):
 * a changed file's out-edges are its overlay re-read, an unchanged file's (and
 * a changed file whose re-read was skipped) are the indexed ones. A cycle that
 * closes through ANOTHER changed file's new edge is the diff's own cycle; one
 * the overlay removed is not traversed. The base side (`preExisting`) is the
 * run's `heldBeforeChange`, unchanged.
 */
import { describe, expect, it } from "vitest";

import {
  baseEdgesOf,
  catalogOf,
  graphOf,
  overlayOf,
  runWith,
  type FixtureEdge,
} from "../__helpers__/diff-run-fixtures.js";
import { DiffDetectorRun } from "../../../../../../src/core/api/internal/ops/diff-detector-run.js";
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
