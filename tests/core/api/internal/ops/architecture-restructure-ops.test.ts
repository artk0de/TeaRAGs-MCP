/**
 * bd tea-rags-mcp-r8hme.21: `get_architecture_report` restructure mode — a
 * what-if move / merge / split judged with the full detector set on the base
 * facts and on the relabelled facts, the two violation sets diffed by key.
 *
 * Fixture (the component graph `architecture-graph-facts.test.ts` judges):
 * core and base are stable (six importers each), lib is unstable and calls
 * back into core. Moving lib/f1 + lib/f2 into base removes core's only
 * dependencies on lib — the SDP violation core → lib resolves — and drags
 * lib's back edge into base: the layering knot moves from core to base.
 */
import { describe, expect, it, vi } from "vitest";

import { ArchitectureRestructureOps } from "../../../../../src/core/api/internal/ops/architecture-restructure-ops.js";
import type { GetArchitectureReportRequest } from "../../../../../src/core/api/public/dto/architecture.js";
import {
  InvalidParameterError,
  UnknownRestructureComponentError,
  UnknownRestructureEdgeError,
  UnknownRestructureFileError,
} from "../../../../../src/core/api/public/errors.js";
import type { FileDependencyGraph, TemporalCochangeGraph } from "../../../../../src/core/contracts/types/codegraph.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function graph(): FileDependencyGraph {
  const files = [file("core/a.ts"), file("core/b.ts"), file("base/a.ts"), file("other/o.ts"), file("vendor/v.ts")];
  const edges: FileDependencyGraph["edges"] = [];
  const add = (sourceRelPath: string, targetRelPath: string, callWeight = 1) => {
    edges.push({ sourceRelPath, targetRelPath, callWeight });
  };
  add("core/a.ts", "lib/f1.ts", 2);
  add("core/b.ts", "lib/f2.ts");
  add("base/a.ts", "lib/f4.ts", 3);
  add("other/o.ts", "lib/f3.ts");
  for (let i = 1; i <= 6; i++) {
    files.push(file(`app/c${i}.ts`), file(`users/u${i}.ts`));
    add(`app/c${i}.ts`, "core/b.ts");
    add(`users/u${i}.ts`, "base/a.ts");
  }
  for (let i = 1; i <= 5; i++) {
    files.push(file(`lib/f${i}.ts`));
    add(`lib/f${i}.ts`, "vendor/v.ts");
  }
  add("lib/f5.ts", "core/a.ts");
  return { files, edges };
}

function graphDb() {
  const cochange: TemporalCochangeGraph = { meta: null, edges: [] };
  return {
    readFileDependencyGraph: vi.fn().mockResolvedValue(graph()),
    readNonPublicMemberEdges: vi.fn().mockResolvedValue([]),
    readTemporalCochangeGraph: vi.fn().mockResolvedValue(cochange),
    readTypeNameRows: vi.fn().mockResolvedValue([]),
  };
}

const MOVE_INTO_BASE: GetArchitectureReportRequest["restructure"] = [
  { move: { files: ["lib/f1.ts", "lib/f2.ts"], toComponent: "base" } },
];

describe("ArchitectureRestructureOps#simulate", () => {
  it("diffs the base run against the relabelled run by violation key", async () => {
    const answer = await new ArchitectureRestructureOps().simulate(graphDb(), { restructure: MOVE_INTO_BASE });

    expect(answer.mode).toBe("restructure");
    expect(answer.hypothesis).toEqual([{ op: "move", relabelledFiles: 2, components: ["base"] }]);
    const delta = answer.delta!;
    expect(delta.resolved).toContainEqual({ family: "stableDependencies", subject: "core → lib" });
    expect(delta.introduced.map((s) => s.family)).toEqual(["layering.knot"]);
    expect(delta.byFamily["stableDependencies"]).toEqual({ introduced: 0, resolved: 1 });
    expect(delta.byFamily["layering.knot"]).toEqual({ introduced: 1, resolved: 1 });
    expect(delta.introducedCount).toBe(1);
    expect(delta.resolvedCount).toBe(delta.resolved.length);
    expect(delta.net).toBe(delta.introducedCount - delta.resolvedCount);
    // base → lib persists: lib/f4 stays in lib
    expect(delta.persistingCount).toBe(1);
  });

  it("caps the listed subjects by limit and keeps the counts whole", async () => {
    const answer = await new ArchitectureRestructureOps().simulate(graphDb(), {
      restructure: MOVE_INTO_BASE,
      limit: 1,
    });
    expect(answer.delta!.resolved).toHaveLength(1);
    expect(answer.delta!.resolvedCount).toBeGreaterThan(1);
  });

  it("a split relabels components only — its groups become sibling components", async () => {
    const answer = await new ArchitectureRestructureOps().simulate(graphDb(), {
      restructure: [{ split: { component: "lib", groups: [["lib/f5.ts"]] } }],
    });
    expect(answer.hypothesis).toEqual([{ op: "split", relabelledFiles: 1, components: ["lib~split1"] }]);
    expect(answer.delta!.resolved.map((s) => s.subject)).toContain("lib → core");
  });

  it("rejects unknown files and components with typed errors", async () => {
    const ops = new ArchitectureRestructureOps();
    await expect(
      ops.simulate(graphDb(), { restructure: [{ move: { files: ["lib/nope.ts"], toComponent: "base" } }] }),
    ).rejects.toBeInstanceOf(UnknownRestructureFileError);
    await expect(
      ops.simulate(graphDb(), { restructure: [{ merge: { components: ["core", "ghost"] } }] }),
    ).rejects.toBeInstanceOf(UnknownRestructureComponentError);
    await expect(
      ops.simulate(graphDb(), { restructure: [{ merge: { components: ["core"] } }] }),
    ).rejects.toBeInstanceOf(InvalidParameterError);
  });

  it("is a narrow mode: report-only options and plannedEdges are rejected, never dropped", async () => {
    const ops = new ArchitectureRestructureOps();
    for (const riding of [
      { pathPattern: "lib/**" },
      { domain: "lib" },
      { norms: true },
      { changeReasons: true },
      { layerMap: {} },
      { knotOf: "core" },
      { offset: 1 },
      { plannedEdges: [{ source: "a.ts", target: "b.ts" }] },
    ] as Partial<GetArchitectureReportRequest>[]) {
      await expect(ops.simulate(graphDb(), { restructure: MOVE_INTO_BASE, ...riding })).rejects.toBeInstanceOf(
        InvalidParameterError,
      );
    }
  });

  it("rejects a restructurePlan riding along — the plan is its own mode (bd tea-rags-mcp-cm9gt.2)", async () => {
    await expect(
      new ArchitectureRestructureOps().simulate(graphDb(), {
        restructure: MOVE_INTO_BASE,
        restructurePlan: { candidates: [{ id: "c", ops: MOVE_INTO_BASE }] },
      }),
    ).rejects.toBeInstanceOf(InvalidParameterError);
  });

  it("caps the op list — one hypothesis per call", async () => {
    const tooMany = Array.from({ length: 21 }, () => MOVE_INTO_BASE[0]);
    await expect(new ArchitectureRestructureOps().simulate(graphDb(), { restructure: tooMany })).rejects.toBeInstanceOf(
      InvalidParameterError,
    );
    await expect(new ArchitectureRestructureOps().simulate(graphDb(), { restructure: [] })).rejects.toBeInstanceOf(
      InvalidParameterError,
    );
  });
});

/**
 * bd tea-rags-mcp-cm9gt.1: edge ops on the same fixture. base → lib rests on
 * ONE file edge, base/a → lib/f4, so cutting it resolves that SDP violation;
 * an inversion routes both ends through a new stable contracts-side file.
 */
describe("ArchitectureRestructureOps#simulate — edge ops", () => {
  it("removeEdge of the edge behind an SDP violation resolves it", async () => {
    const answer = await new ArchitectureRestructureOps().simulate(graphDb(), {
      restructure: [{ removeEdge: { from: "base/a.ts", to: "lib/f4.ts" } }],
    });
    expect(answer.hypothesis).toEqual([
      { op: "removeEdge", relabelledFiles: 0, components: [], edge: { from: "base/a.ts", to: "lib/f4.ts" } },
    ]);
    expect(answer.delta!.resolved).toContainEqual({ family: "stableDependencies", subject: "base → lib" });
  });

  it("addEdge from a stable to an unstable component introduces an SDP violation", async () => {
    const answer = await new ArchitectureRestructureOps().simulate(graphDb(), {
      // vendor: five importers, no dependency — the stablest component; lib depends on it
      restructure: [{ addEdge: { from: "vendor/v.ts", to: "lib/f1.ts" } }],
    });
    expect(answer.delta!.introduced).toContainEqual({ family: "stableDependencies", subject: "vendor → lib" });
  });

  it("an inversion — cut A→B, add I, A→I, B→I — nets fewer violations", async () => {
    const answer = await new ArchitectureRestructureOps().simulate(graphDb(), {
      restructure: [
        { removeEdge: { from: "base/a.ts", to: "lib/f4.ts" } },
        { addFile: { file: "contracts/f4-port.ts" } },
        { addEdge: { from: "base/a.ts", to: "contracts/f4-port.ts" } },
        { addEdge: { from: "lib/f4.ts", to: "contracts/f4-port.ts" } },
      ],
    });
    expect(answer.delta!.resolved).toContainEqual({ family: "stableDependencies", subject: "base → lib" });
    expect(answer.delta!.net).toBeLessThan(0);
  });

  it("rejects an absent edge, an unknown endpoint and an existing file with typed errors naming the op", async () => {
    const ops = new ArchitectureRestructureOps();
    const second = async (op: NonNullable<GetArchitectureReportRequest["restructure"]>[number]) =>
      ops.simulate(graphDb(), { restructure: [MOVE_INTO_BASE[0], op] });
    await expect(second({ removeEdge: { from: "core/a.ts", to: "core/b.ts" } })).rejects.toSatisfy(
      (error) => error instanceof UnknownRestructureEdgeError && error.message.includes("restructure[1]"),
    );
    await expect(second({ addEdge: { from: "core/a.ts", to: "lib/nope.ts" } })).rejects.toSatisfy(
      (error) => error instanceof UnknownRestructureFileError && error.message.includes("restructure[1]"),
    );
    await expect(second({ addFile: { file: "core/a.ts" } })).rejects.toSatisfy(
      (error) => error instanceof InvalidParameterError && error.message.includes("restructure[1]"),
    );
  });
});

describe("ArchitectureRestructureOps.unavailable", () => {
  it("answers the mode with no delta when no codegraph can be read", () => {
    expect(ArchitectureRestructureOps.unavailable({ restructure: MOVE_INTO_BASE })).toEqual({
      mode: "restructure",
      hypothesis: [],
      unavailable: "noCodegraph",
    });
  });
});
