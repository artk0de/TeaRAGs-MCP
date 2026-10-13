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
    expect(
      invalid([{ move: { files: ["lib/f1.ts"], toComponent: "core" } }, { merge: { components: ["app", "lib"] } }]),
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
