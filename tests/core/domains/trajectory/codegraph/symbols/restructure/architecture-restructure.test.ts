/**
 * bd tea-rags-mcp-r8hme.21: a what-if restructuring is a list of declarative
 * ops (move / merge / split) compiled against the report's BASE component
 * partition into relabelled facts — moved files get a path inside their new
 * component, every relabelled file gets the component it now belongs to.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyGraph,
  NonPublicMemberEdge,
  TemporalCochangeGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  applyArchitectureRestructure,
  architectureRestructureEdgeKey,
  compileArchitectureRestructure,
  type ArchitectureRestructurePartition,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

const FILES = [
  "core/a.ts",
  "core/b.ts",
  "core/index.ts",
  "lib/f1.ts",
  "lib/f2.ts",
  "lib/b.ts",
  "lib/index.ts",
  "app/c1.ts",
  "app/c2.ts",
  "app/c3.ts",
];

function partition(): ArchitectureRestructurePartition {
  const componentOf = new Map(FILES.map((relPath) => [relPath, relPath.slice(0, relPath.indexOf("/"))]));
  componentOf.set("rb/billing.rb", "::Billing");
  return { componentOf };
}

function compiled(ops: Parameters<typeof compileArchitectureRestructure>[0]) {
  const result = compileArchitectureRestructure(ops, partition());
  if (result.kind !== "compiled") throw new Error(`expected compiled, got ${result.kind}`);
  return result;
}

describe("compileArchitectureRestructure", () => {
  it("moves files into the target component's directory, keeping their base name", () => {
    const result = compiled([{ move: { files: ["lib/f1.ts"], toComponent: "core" } }]);
    expect([...result.relabel.renamedFrom]).toEqual([["core/f1.ts", "lib/f1.ts"]]);
    expect([...result.relabel.componentOf]).toEqual([["core/f1.ts", "core"]]);
    expect(result.ops).toEqual([{ op: "move", relabelledFiles: 1, components: ["core"] }]);
  });

  it("never lets a moved file take an existing path or become the target's facade", () => {
    const result = compiled([{ move: { files: ["lib/b.ts", "lib/index.ts"], toComponent: "core" } }]);
    expect(result.relabel.renamedFrom.get("core/b~moved.ts")).toBe("lib/b.ts");
    expect(result.relabel.renamedFrom.get("core/index~moved.ts")).toBe("lib/index.ts");
  });

  it("merges every later component's files into the first one", () => {
    const result = compiled([{ merge: { components: ["core", "lib"] } }]);
    expect([...result.relabel.renamedFrom.values()].sort()).toEqual([
      "lib/b.ts",
      "lib/f1.ts",
      "lib/f2.ts",
      "lib/index.ts",
    ]);
    expect(new Set(result.relabel.componentOf.values())).toEqual(new Set(["core"]));
    expect(result.ops).toEqual([{ op: "merge", relabelledFiles: 4, components: ["core"] }]);
  });

  it("splits groups into sibling components without moving their paths", () => {
    const result = compiled([{ split: { component: "app", groups: [["app/c1.ts"], ["app/c2.ts"]] } }]);
    expect(result.relabel.renamedFrom.size).toBe(0);
    expect([...result.relabel.componentOf]).toEqual([
      ["app/c1.ts", "app~split1"],
      ["app/c2.ts", "app~split2"],
    ]);
    expect(result.ops).toEqual([{ op: "split", relabelledFiles: 2, components: ["app~split1", "app~split2"] }]);
  });

  it("names unknown files and components instead of simulating a no-op", () => {
    expect(
      compileArchitectureRestructure([{ move: { files: ["lib/f1.ts", "nope.ts"], toComponent: "core" } }], partition()),
    ).toEqual({ kind: "unknownFile", opIndex: 0, files: ["nope.ts"] });
    expect(
      compileArchitectureRestructure([{ move: { files: ["lib/f1.ts"], toComponent: "ghost" } }], partition()),
    ).toEqual({ kind: "unknownComponent", opIndex: 0, component: "ghost" });
    expect(compileArchitectureRestructure([{ merge: { components: ["core", "ghost"] } }], partition())).toEqual({
      kind: "unknownComponent",
      opIndex: 0,
      component: "ghost",
    });
  });

  it("rejects ops that cannot be compiled to one honest hypothesis", () => {
    const invalid = (ops: Parameters<typeof compileArchitectureRestructure>[0]) =>
      compileArchitectureRestructure(ops, partition()).kind;
    expect(invalid([{ move: { files: ["lib/f1.ts"], toComponent: "::Billing" } }])).toBe("invalidOp");
    expect(invalid([{ move: { files: ["core/a.ts"], toComponent: "core" } }])).toBe("invalidOp");
    expect(invalid([{ merge: { components: ["core"] } }])).toBe("invalidOp");
    expect(invalid([{ split: { component: "app", groups: [["core/a.ts"]] } }])).toBe("invalidOp");
    expect(invalid([{ split: { component: "app", groups: [["app/c1.ts", "app/c2.ts", "app/c3.ts"]] } }])).toBe(
      "invalidOp",
    );
  });
});

/**
 * bd tea-rags-mcp-cm9gt: ops apply IN ORDER — each against the partition the
 * ops before it produced — so report merges sharing a component chain, and a
 * file's final path and component are the composition of its relabels.
 */
describe("compileArchitectureRestructure — ops compose in order", () => {
  it("chains merges: a later merge names the component an earlier merge produced", () => {
    const result = compiled([{ merge: { components: ["core", "lib"] } }, { merge: { components: ["core", "app"] } }]);
    expect([...result.relabel.renamedFrom.values()].sort()).toEqual([
      "app/c1.ts",
      "app/c2.ts",
      "app/c3.ts",
      "lib/b.ts",
      "lib/f1.ts",
      "lib/f2.ts",
      "lib/index.ts",
    ]);
    expect(new Set(result.relabel.componentOf.values())).toEqual(new Set(["core"]));
    expect(result.ops).toEqual([
      { op: "merge", relabelledFiles: 4, components: ["core"] },
      { op: "merge", relabelledFiles: 3, components: ["core"] },
    ]);
  });

  it("chains merges: a later merge folds the component an earlier merge produced", () => {
    const result = compiled([{ merge: { components: ["core", "lib"] } }, { merge: { components: ["app", "core"] } }]);
    expect([...result.relabel.renamedFrom.values()].sort()).toEqual([
      "core/a.ts",
      "core/b.ts",
      "core/index.ts",
      "lib/b.ts",
      "lib/f1.ts",
      "lib/f2.ts",
      "lib/index.ts",
    ]);
    expect(result.relabel.renamedFrom.get("app/f1.ts")).toBe("lib/f1.ts");
    expect(result.relabel.renamedFrom.get("app/a.ts")).toBe("core/a.ts");
    expect([...result.relabel.renamedFrom.keys()].every((relPath) => relPath.startsWith("app/"))).toBe(true);
    expect(new Set(result.relabel.componentOf.values())).toEqual(new Set(["app"]));
    expect(result.ops).toEqual([
      { op: "merge", relabelledFiles: 4, components: ["core"] },
      { op: "merge", relabelledFiles: 7, components: ["app"] },
    ]);
  });

  it("a folded component is gone from the current partition: naming it again is unknownComponent", () => {
    expect(
      compileArchitectureRestructure(
        [{ merge: { components: ["core", "lib"] } }, { merge: { components: ["app", "lib"] } }],
        partition(),
      ),
    ).toEqual({ kind: "unknownComponent", opIndex: 1, component: "lib" });
  });

  it("a move after a merge maps the FINAL path to the BASE path through both renames", () => {
    const result = compiled([
      { merge: { components: ["core", "lib"] } },
      { move: { files: ["core/f1.ts"], toComponent: "app" } },
    ]);
    expect(result.relabel.renamedFrom.get("app/f1.ts")).toBe("lib/f1.ts");
    expect(result.relabel.renamedFrom.has("core/f1.ts")).toBe(false);
    expect(result.relabel.componentOf.get("app/f1.ts")).toBe("app");
    expect(result.relabel.componentOf.has("core/f1.ts")).toBe(false);
  });

  it("a later op may name a moved file by its base path", () => {
    const result = compiled([
      { merge: { components: ["core", "lib"] } },
      { move: { files: ["lib/f2.ts"], toComponent: "app" } },
    ]);
    expect(result.relabel.renamedFrom.get("app/f2.ts")).toBe("lib/f2.ts");
  });

  it("a file moved back to its base home carries no rename", () => {
    const result = compiled([
      { move: { files: ["lib/f1.ts"], toComponent: "core" } },
      { move: { files: ["core/f1.ts"], toComponent: "lib" } },
    ]);
    expect(result.relabel.renamedFrom.size).toBe(0);
    expect([...result.relabel.componentOf]).toEqual([["lib/f1.ts", "lib"]]);
  });

  it("a merge after a move folds only what the move left behind", () => {
    const result = compiled([
      { move: { files: ["lib/f1.ts"], toComponent: "core" } },
      { merge: { components: ["app", "lib"] } },
    ]);
    expect(result.relabel.renamedFrom.get("core/f1.ts")).toBe("lib/f1.ts");
    expect(result.relabel.componentOf.get("core/f1.ts")).toBe("core");
    expect(result.ops[1]).toEqual({ op: "merge", relabelledFiles: 3, components: ["app"] });
  });

  it("splits a component a merge produced, and keeps the rename of its moved files", () => {
    const result = compiled([
      { merge: { components: ["core", "lib"] } },
      { split: { component: "core", groups: [["core/f1.ts"]] } },
    ]);
    expect(result.relabel.renamedFrom.get("core/f1.ts")).toBe("lib/f1.ts");
    expect(result.relabel.componentOf.get("core/f1.ts")).toBe("core~split1");
  });

  it("a second split of one component names fresh parts", () => {
    const result = compiled([
      { split: { component: "app", groups: [["app/c1.ts"]] } },
      { split: { component: "app", groups: [["app/c2.ts"]] } },
    ]);
    expect(result.ops.map((op) => op.components)).toEqual([["app~split1"], ["app~split2"]]);
  });

  it("keeps the rules that still hold against the current partition", () => {
    const kind = (ops: Parameters<typeof compileArchitectureRestructure>[0]) =>
      compileArchitectureRestructure(ops, partition()).kind;
    // a move into the component the file is already in — after the merge put it there
    expect(
      kind([{ merge: { components: ["core", "lib"] } }, { move: { files: ["core/f1.ts"], toComponent: "core" } }]),
    ).toBe("invalidOp");
    // a split part is a label, not a directory: nothing relocates into it
    expect(
      kind([
        { split: { component: "app", groups: [["app/c1.ts"]] } },
        { move: { files: ["lib/f1.ts"], toComponent: "app~split1" } },
      ]),
    ).toBe("invalidOp");
  });
});

describe("applyArchitectureRestructure", () => {
  it("renames every file-keyed fact and carries the component relabel", () => {
    const graph: FileDependencyGraph = {
      files: [
        { relPath: "lib/f1.ts", language: "typescript", symbolCount: 1 },
        {
          relPath: "core/a.ts",
          language: "typescript",
          symbolCount: 1,
          typeHeritage: [{ typeName: "A", supertypes: [{ name: "F", declaringRelPaths: ["lib/f1.ts"] }] }],
        },
      ],
      edges: [{ sourceRelPath: "core/a.ts", targetRelPath: "lib/f1.ts", callWeight: 2 }],
    };
    const memberEdges = [{ sourceRelPath: "core/a.ts", targetRelPath: "lib/f1.ts" }] as NonPublicMemberEdge[];
    const cochange = {
      meta: null,
      edges: [{ relPathA: "core/a.ts", relPathB: "lib/f1.ts" }],
      bundles: new Map([[1, ["core/a.ts", "lib/f1.ts"]]]),
      bundleFileLines: new Map([[1, new Map([["lib/f1.ts", { added: 1, deleted: 0 }]])]]),
    } as unknown as TemporalCochangeGraph;
    const facts = { production: { graph }, memberEdges, cochange };
    const { relabel } = compiled([{ move: { files: ["lib/f1.ts"], toComponent: "core" } }]);

    const relabelled = applyArchitectureRestructure(facts, relabel);

    expect(relabelled.production.graph.files.map((f) => f.relPath)).toEqual(["core/f1.ts", "core/a.ts"]);
    expect(relabelled.production.graph.files[1].typeHeritage?.[0].supertypes[0].declaringRelPaths).toEqual([
      "core/f1.ts",
    ]);
    expect(relabelled.production.graph.edges[0]).toEqual({
      sourceRelPath: "core/a.ts",
      targetRelPath: "core/f1.ts",
      callWeight: 2,
    });
    expect(relabelled.memberEdges[0].targetRelPath).toBe("core/f1.ts");
    expect(relabelled.cochange.edges[0].relPathB).toBe("core/f1.ts");
    expect(relabelled.cochange.bundles?.get(1)).toEqual(["core/a.ts", "core/f1.ts"]);
    expect([...(relabelled.cochange.bundleFileLines?.get(1)?.keys() ?? [])]).toEqual(["core/f1.ts"]);
    expect(relabelled.componentRelabel).toBe(relabel.componentOf);
    // the base facts are never mutated
    expect(graph.files[0].relPath).toBe("lib/f1.ts");
  });
});

/**
 * bd tea-rags-mcp-cm9gt.1: edge ops — a code remedy (inversion, interface
 * extraction, back-edge cut) changes edges, not file homes. They name BASE
 * paths, never relabel, and apply before the rename map.
 */
describe("compileArchitectureRestructure — edge ops", () => {
  const edgeBase = {
    fileEdges: new Set([
      architectureRestructureEdgeKey("core/a.ts", "lib/f1.ts"),
      architectureRestructureEdgeKey("app/c1.ts", "core/b.ts"),
    ]),
  };
  const compile = (ops: Parameters<typeof compileArchitectureRestructure>[0]) =>
    compileArchitectureRestructure(ops, partition(), edgeBase);

  it("compiles addFile, addEdge and removeEdge into edge edits without relabelling", () => {
    const result = compile([
      { removeEdge: { from: "core/a.ts", to: "lib/f1.ts" } },
      { addFile: { file: "contracts/port.ts" } },
      { addFile: { file: "core/port.ts", component: "core" } },
      { addEdge: { from: "core/a.ts", to: "contracts/port.ts" } },
      { addEdge: { from: "lib/f1.ts", to: "contracts/port.ts" } },
    ]);
    if (result.kind !== "compiled") throw new Error(`expected compiled, got ${result.kind}`);
    expect(result.ops).toEqual([
      { op: "removeEdge", relabelledFiles: 0, components: [], edge: { from: "core/a.ts", to: "lib/f1.ts" } },
      // no component named: the judge derives it from the path, the compiler does not guess
      { op: "addFile", relabelledFiles: 0, components: [], file: "contracts/port.ts" },
      { op: "addFile", relabelledFiles: 0, components: ["core"], file: "core/port.ts" },
      { op: "addEdge", relabelledFiles: 0, components: [], edge: { from: "core/a.ts", to: "contracts/port.ts" } },
      { op: "addEdge", relabelledFiles: 0, components: [], edge: { from: "lib/f1.ts", to: "contracts/port.ts" } },
    ]);
    expect(result.relabel.renamedFrom.size).toBe(0);
    expect([...result.relabel.componentOf]).toEqual([["core/port.ts", "core"]]);
    expect(result.relabel.edgeEdits.addedFiles).toEqual([
      { relPath: "contracts/port.ts" },
      { relPath: "core/port.ts", component: "core" },
    ]);
    expect(result.relabel.edgeEdits.addedEdges).toEqual([
      { from: "core/a.ts", to: "contracts/port.ts" },
      { from: "lib/f1.ts", to: "contracts/port.ts" },
    ]);
    expect([...result.relabel.edgeEdits.removedEdges]).toEqual([
      architectureRestructureEdgeKey("core/a.ts", "lib/f1.ts"),
    ]);
  });

  it("edge ops never claim files: a move of an edge endpoint in the same hypothesis compiles", () => {
    const result = compile([
      { removeEdge: { from: "core/a.ts", to: "lib/f1.ts" } },
      { move: { files: ["lib/f1.ts"], toComponent: "core" } },
    ]);
    expect(result.kind).toBe("compiled");
  });

  it("names the failure of each edge op", () => {
    expect(compile([{ addFile: { file: "core/a.ts" } }])).toMatchObject({ kind: "invalidOp", opIndex: 0 });
    expect(compile([{ addFile: { file: "x/n.ts" } }, { addFile: { file: "x/n.ts" } }])).toMatchObject({
      kind: "invalidOp",
      opIndex: 1,
    });
    expect(compile([{ addFile: { file: "x/n.ts", component: "ghost" } }])).toEqual({
      kind: "unknownComponent",
      opIndex: 0,
      component: "ghost",
    });
    expect(compile([{ addEdge: { from: "nope.ts", to: "ghost.ts" } }])).toEqual({
      kind: "unknownFile",
      opIndex: 0,
      files: ["nope.ts", "ghost.ts"],
    });
    expect(compile([{ addEdge: { from: "core/a.ts", to: "core/a.ts" } }])).toMatchObject({ kind: "invalidOp" });
    expect(compile([{ addEdge: { from: "core/a.ts", to: "lib/f1.ts" } }])).toMatchObject({
      kind: "invalidOp",
      detail: expect.stringContaining("edge already present"),
    });
    const fresh = { addEdge: { from: "core/a.ts", to: "lib/f2.ts" } };
    expect(compile([fresh, fresh])).toMatchObject({ kind: "invalidOp", opIndex: 1 });
    expect(compile([{ removeEdge: { from: "nope.ts", to: "core/a.ts" } }])).toEqual({
      kind: "unknownFile",
      opIndex: 0,
      files: ["nope.ts"],
    });
    expect(compile([{ removeEdge: { from: "core/a.ts", to: "core/b.ts" } }])).toEqual({
      kind: "unknownEdge",
      opIndex: 0,
      from: "core/a.ts",
      to: "core/b.ts",
    });
  });

  it("removing an edge twice is unknownEdge; removing an added edge is invalidOp", () => {
    const twice = { removeEdge: { from: "core/a.ts", to: "lib/f1.ts" } };
    expect(compile([twice, twice])).toEqual({ kind: "unknownEdge", opIndex: 1, from: "core/a.ts", to: "lib/f1.ts" });
    expect(
      compile([
        { addEdge: { from: "core/a.ts", to: "lib/f2.ts" } },
        { removeEdge: { from: "core/a.ts", to: "lib/f2.ts" } },
      ]),
    ).toMatchObject({ kind: "invalidOp", opIndex: 1 });
  });

  it("an added file is a known endpoint for later edge ops only", () => {
    expect(compile([{ addEdge: { from: "core/a.ts", to: "x/n.ts" } }, { addFile: { file: "x/n.ts" } }])).toMatchObject({
      kind: "unknownFile",
      opIndex: 0,
    });
  });

  it("without an edge base every removeEdge is unknownEdge", () => {
    expect(
      compileArchitectureRestructure([{ removeEdge: { from: "core/a.ts", to: "lib/f1.ts" } }], partition()),
    ).toMatchObject({ kind: "unknownEdge", opIndex: 0 });
  });
});

describe("applyArchitectureRestructure — edge edits", () => {
  const base = (): FileDependencyGraph => ({
    files: [
      { relPath: "core/a.ts", language: "typescript", symbolCount: 1 },
      { relPath: "lib/f1.ts", language: "typescript", symbolCount: 2 },
      { relPath: "lib/f2.ts", language: "typescript", symbolCount: 1 },
    ],
    edges: [
      { sourceRelPath: "core/a.ts", targetRelPath: "lib/f1.ts", callWeight: 2 },
      { sourceRelPath: "core/a.ts", targetRelPath: "lib/f1.ts", callWeight: 0 },
      { sourceRelPath: "core/a.ts", targetRelPath: "lib/f2.ts", callWeight: 1 },
    ],
  });
  const cochange = { meta: null, edges: [] } as unknown as TemporalCochangeGraph;
  const edgeBase = {
    fileEdges: new Set(base().edges.map((e) => architectureRestructureEdgeKey(e.sourceRelPath, e.targetRelPath))),
  };

  function applied(ops: Parameters<typeof compileArchitectureRestructure>[0]) {
    const result = compileArchitectureRestructure(ops, partition(), edgeBase);
    if (result.kind !== "compiled") throw new Error(`expected compiled, got ${result.kind}`);
    const graph = base();
    const facts = { production: { graph }, memberEdges: [], cochange };
    return { graph, relabelled: applyArchitectureRestructure(facts, result.relabel) };
  }

  it("drops every base edge of a removed pair and keeps the rest", () => {
    const { relabelled, graph } = applied([{ removeEdge: { from: "core/a.ts", to: "lib/f1.ts" } }]);
    expect(relabelled.production.graph.edges).toEqual([
      { sourceRelPath: "core/a.ts", targetRelPath: "lib/f2.ts", callWeight: 1 },
    ]);
    expect(graph.edges).toHaveLength(3);
  });

  it("appends an added file (the language its extension carries in the graph) and an added edge once with callWeight 1", () => {
    const { relabelled } = applied([
      { addFile: { file: "contracts/port.ts" } },
      { addEdge: { from: "core/a.ts", to: "contracts/port.ts" } },
    ]);
    const added = relabelled.production.graph.files.find((f) => f.relPath === "contracts/port.ts");
    expect(added).toEqual({
      relPath: "contracts/port.ts",
      language: "typescript",
      symbolCount: 1,
      typeAbstractness: { abstractTypeCount: 0, concreteTypeCount: 1 },
    });
    expect(relabelled.production.graph.edges.filter((e) => e.targetRelPath === "contracts/port.ts")).toEqual([
      { sourceRelPath: "core/a.ts", targetRelPath: "contracts/port.ts", callWeight: 1 },
    ]);
  });

  it("an abstract added file carries an all-abstract census, the reading main sequence and the foundation take", () => {
    const { relabelled } = applied([
      { addFile: { file: "contracts/port.ts", abstract: true } },
      { addFile: { file: "contracts/impl.ts", abstract: false } },
    ]);
    const censusOf = (relPath: string) =>
      relabelled.production.graph.files.find((f) => f.relPath === relPath)?.typeAbstractness;
    expect(censusOf("contracts/port.ts")).toEqual({ abstractTypeCount: 1, concreteTypeCount: 0 });
    expect(censusOf("contracts/impl.ts")).toEqual({ abstractTypeCount: 0, concreteTypeCount: 1 });
  });

  it("compiles the abstract flag into the added-file edit", () => {
    const result = compileArchitectureRestructure(
      [{ addFile: { file: "contracts/port.ts", abstract: true } }, { addFile: { file: "contracts/impl.ts" } }],
      partition(),
    );
    if (result.kind !== "compiled") throw new Error(`expected compiled, got ${result.kind}`);
    expect(result.relabel.edgeEdits.addedFiles).toEqual([
      { relPath: "contracts/port.ts", abstract: true },
      { relPath: "contracts/impl.ts" },
    ]);
  });

  it("a move in the same hypothesis renames an endpoint of an added edge", () => {
    const { relabelled } = applied([
      { addFile: { file: "contracts/port.ts" } },
      { addEdge: { from: "lib/f2.ts", to: "contracts/port.ts" } },
      { move: { files: ["lib/f2.ts"], toComponent: "core" } },
    ]);
    expect(relabelled.production.graph.edges).toContainEqual({
      sourceRelPath: "core/f2.ts",
      targetRelPath: "contracts/port.ts",
      callWeight: 1,
    });
  });
});
