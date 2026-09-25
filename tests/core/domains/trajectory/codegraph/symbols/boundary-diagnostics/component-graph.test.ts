/**
 * The component graph (bd tea-rags-mcp-r8hme.7): Martin defined his stability
 * metrics for COMPONENTS, not files. A component is a module whose facade the
 * leaking-abstraction detector judges (active, or measured and not adopted),
 * owning its directory subtree minus nested components; every other file
 * belongs to its own directory. Ca / Ce count distinct FILES across the border
 * (Martin counts classes), and file edges become component dependencies.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildComponentGraph,
  COMPONENT_CONTAINMENT_REASON,
  type FacadeModuleAssessment,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function edge(
  sourceRelPath: string,
  targetRelPath: string,
  extra: Partial<FileDependencyEdge> = {},
): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight: 1, ...extra };
}

function module(moduleDir: string, status: FacadeModuleAssessment["status"]): FacadeModuleAssessment {
  return {
    moduleDir,
    facadeRelPath: `${moduleDir}/index.ts`,
    externalImporterCount: 3,
    facadeImporterCount: 3,
    deepImporterCount: 0,
    adoption: 1,
    status,
  };
}

/**
 * `lib/` is a judged module holding `lib/index.ts`, `lib/a.ts` and the plain
 * subdirectory `lib/util/`; `lib/inner/` is a nested judged module; `small/`
 * has a facade too few files import, so it is a plain directory component.
 */
function graph(): FileDependencyGraph {
  return {
    files: [
      file("lib/index.ts"),
      file("lib/a.ts"),
      file("lib/util/u.ts"),
      file("lib/inner/index.ts"),
      file("lib/inner/x.ts"),
      file("small/index.ts"),
      file("app/main.ts"),
      file("app/other.ts"),
    ],
    edges: [
      edge("app/main.ts", "lib/index.ts"),
      edge("app/other.ts", "lib/a.ts", { callWeight: 2 }),
      edge("app/main.ts", "small/index.ts"),
      // Inside one component: not a dependency.
      edge("lib/a.ts", "lib/util/u.ts"),
      // A parent facade re-exporting a nested facade: aggregation.
      edge("lib/index.ts", "lib/inner/index.ts", { reexportedExportNames: ["X"] }),
      // A parent file using a nested component: containment.
      edge("lib/a.ts", "lib/inner/x.ts"),
      // A nested component reaching up into its parent.
      edge("lib/inner/x.ts", "lib/util/u.ts"),
      edge("app/main.ts", "vendor/unwalked.ts"),
      edge("app/main.ts", "app/main.ts"),
    ],
  };
}

describe("buildComponentGraph", () => {
  const modules = [
    module("lib", "active"),
    module("lib/inner", "facade-not-adopted"),
    module("small", "too-few-importers"),
  ];

  it("partitions files into judged modules and, outside them, their own directories", () => {
    const components = buildComponentGraph(graph(), modules);

    expect(Object.fromEntries(components.componentOf)).toEqual({
      "lib/index.ts": "lib",
      "lib/a.ts": "lib",
      "lib/util/u.ts": "lib",
      "lib/inner/index.ts": "lib/inner",
      "lib/inner/x.ts": "lib/inner",
      "small/index.ts": "small",
      "app/main.ts": "app",
      "app/other.ts": "app",
    });
    expect(components.components.get("lib")).toMatchObject({ kind: "module", facadeRelPath: "lib/index.ts" });
    expect(components.components.get("small")).toMatchObject({ kind: "directory", facadeRelPath: null });
  });

  it("counts Ca and Ce over distinct files across the border, containment included", () => {
    const components = buildComponentGraph(graph(), modules);

    // lib: dependents app/main.ts, app/other.ts, lib/inner/x.ts; its own lib/a.ts reaches lib/inner.
    expect(components.components.get("lib")).toMatchObject({
      fileCount: 3,
      afferentCount: 3,
      efferentCount: 1,
      connectionCount: 4,
      instability: 1 / 4,
    });
    // app: two files depend outward, nothing depends on it — the unwalked edge does not count.
    expect(components.components.get("app")).toMatchObject({ afferentCount: 0, efferentCount: 2, instability: 1 });
  });

  it("aggregates file edges into component dependencies carrying their file evidence and call weight", () => {
    const deps = buildComponentGraph(graph(), modules).dependencies.map((d) => ({
      edge: `${d.sourceComponent} -> ${d.targetComponent}`,
      relation: d.directoryRelation,
      callWeight: d.callWeight,
      files: d.fileEdges.map((e) => `${e.sourceRelPath} -> ${e.targetRelPath}`),
    }));

    expect(deps).toEqual([
      {
        edge: "app -> lib",
        relation: "disjoint",
        callWeight: 3,
        files: ["app/main.ts -> lib/index.ts", "app/other.ts -> lib/a.ts"],
      },
      { edge: "app -> small", relation: "disjoint", callWeight: 1, files: ["app/main.ts -> small/index.ts"] },
      { edge: "lib -> lib/inner", relation: "descendant", callWeight: 1, files: ["lib/a.ts -> lib/inner/x.ts"] },
      { edge: "lib/inner -> lib", relation: "ancestor", callWeight: 1, files: ["lib/inner/x.ts -> lib/util/u.ts"] },
    ]);
  });

  it("counts the file edges that never become a component dependency, by reason", () => {
    expect(buildComponentGraph(graph(), modules).excluded).toEqual({
      selfEdges: 1,
      unwalkedEndpoints: 1,
      intraComponent: 1,
      facadeAggregations: 1,
    });
    expect(COMPONENT_CONTAINMENT_REASON).toBe(
      "containment: a component depending on a component nested inside its directory - composition, not a peer dependency",
    );
  });
});
