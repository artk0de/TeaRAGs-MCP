/**
 * The component graph (bd tea-rags-mcp-r8hme.7): Martin defined his stability
 * metrics for COMPONENTS, not files. A component is a module whose facade the
 * leaking-abstraction detector assessed, adoption notwithstanding (the one
 * DOMAIN partition, bd tea-rags-mcp-r8hme.52.7), owning its directory subtree
 * minus nested components; every other file belongs to its own directory.
 * Ca / Ce count distinct FILES across the border (Martin counts classes), and
 * file edges become component dependencies.
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
    // One partition (bd tea-rags-mcp-r8hme.52.7): a facade too few files import is still the unit its directory declares.
    expect(components.components.get("small")).toMatchObject({ kind: "module", facadeRelPath: "small/index.ts" });
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

/**
 * The DOMAIN partition (bd tea-rags-mcp-r8hme.30): every directory with a
 * facade file is a component regardless of what the adoption measurement said.
 * `small/` here holds a facade three importers would be needed to measure —
 * the partition claims its subtree for the facade the directory declares.
 * `go/` is a language-enforced package with no facade file at all. Since bd
 * tea-rags-mcp-r8hme.52.7 it is the ONLY partition: no adoption-narrowed
 * variant exists for any detector.
 */
describe("buildComponentGraph — the domain partition", () => {
  const domainGraph: FileDependencyGraph = {
    files: [
      file("lib/index.ts"),
      file("lib/a.ts"),
      file("small/index.ts"),
      file("small/util/su.ts"),
      file("go/pkg/p.go"),
      file("app/main.ts"),
    ],
    edges: [edge("app/main.ts", "small/index.ts")],
  };
  const domainModules = [
    module("lib", "active"),
    module("small", "too-few-importers"),
    { ...module("go", "language-enforced"), facadeRelPath: null },
  ];

  it("lets every facade directory own its subtree, adoption notwithstanding", () => {
    const components = buildComponentGraph(domainGraph, domainModules);

    expect(components.componentOf.get("small/util/su.ts")).toBe("small");
    expect(components.componentOf.get("go/pkg/p.go")).toBe("go");
    expect(components.components.get("small")).toMatchObject({
      kind: "module",
      facadeRelPath: "small/index.ts",
      fileCount: 2,
    });
    expect(components.components.get("go")).toMatchObject({ kind: "module", facadeRelPath: null });
  });

  it("admits every assessed module whatever its status — one partition, no adoption-narrowed variant", () => {
    const g: FileDependencyGraph = {
      files: [file("a/index.ts"), file("a/x/y.ts"), file("b/index.ts"), file("b/x/y.ts"), file("app/main.ts")],
      edges: [edge("app/main.ts", "a/index.ts"), edge("app/main.ts", "b/index.ts")],
    };
    const components = buildComponentGraph(g, [module("a", "facade-not-adopted"), module("b", "too-few-importers")]);

    expect(components.componentOf.get("a/x/y.ts")).toBe("a");
    expect(components.componentOf.get("b/x/y.ts")).toBe("b");
    expect(components.components.get("b")).toMatchObject({ kind: "module", facadeRelPath: "b/index.ts" });
  });
});

/**
 * The constant-namespace partition (bd tea-rags-mcp-r8hme.11): where a file's
 * path spells the constant it declares (Zeitwerk's contract), the component is
 * the constant NAMESPACE, not the directory — `app/models/billing/*` and
 * `app/services/billing/*` are one `Billing`. Derived from the declared
 * constants alone: no directory list, no language list.
 */
describe("buildComponentGraph — Ruby components are path-based; the constant namespace is a grouping (bd tea-rags-mcp-r8hme.52.15)", () => {
  function rubyFile(relPath: string, enclosingScopeNames: string[]) {
    return { relPath, language: "ruby", symbolCount: 1, enclosingScopeNames };
  }

  function zeitwerkGraph(): FileDependencyGraph {
    return {
      files: [
        rubyFile("app/models/billing/invoice.rb", ["Billing::Invoice"]),
        rubyFile("app/services/billing/charge_service.rb", ["Billing::ChargeService"]),
        // A memberless class: only the namespace it sits in is recorded.
        rubyFile("app/services/billing/refunds/request.rb", ["Billing::Refunds"]),
        rubyFile("app/models/billing/refunds/refund.rb", ["Billing::Refunds::Refund"]),
        rubyFile("app/models/user.rb", ["User"]),
        rubyFile("app/models/user/profile.rb", ["User::Profile"]),
        rubyFile("app/models/account.rb", ["Account"]),
        rubyFile("app/models/session.rb", ["Session"]),
        // A monkey patch: the path does not spell the constant.
        rubyFile("config/initializers/string_ext.rb", ["String"]),
        rubyFile("clock.rb", []),
        { relPath: "src/reranker.ts", language: "typescript", symbolCount: 1, enclosingScopeNames: ["Reranker"] },
      ],
      edges: [
        edge("app/models/billing/invoice.rb", "app/services/billing/charge_service.rb"),
        edge("app/models/billing/invoice.rb", "app/models/billing/refunds/refund.rb"),
        edge("app/models/billing/refunds/refund.rb", "app/models/user.rb"),
        edge("clock.rb", "app/models/billing/invoice.rb"),
        edge("app/models/account.rb", "app/models/session.rb"),
        // One directory, two namespaces: intra-component for the partition,
        // a dependency for the grouping.
        edge("app/models/user.rb", "app/models/account.rb"),
      ],
    };
  }

  it("partitions Ruby files by directory like every other language — a namespace never spans Rails layers", () => {
    const { componentOf, components } = buildComponentGraph(zeitwerkGraph(), []);

    expect(componentOf.get("app/models/billing/invoice.rb")).toBe("app/models/billing");
    expect(componentOf.get("app/services/billing/charge_service.rb")).toBe("app/services/billing");
    expect(componentOf.get("app/models/user.rb")).toBe("app/models");
    expect(componentOf.get("app/models/user/profile.rb")).toBe("app/models/user");
    expect([...components.values()].filter((c) => c.kind === "namespace")).toEqual([]);
  });

  it("reads Ruby component dependencies by directory nesting", () => {
    const { dependencies } = buildComponentGraph(zeitwerkGraph(), []);
    const relation = (source: string, target: string) =>
      dependencies.find((d) => d.sourceComponent === source && d.targetComponent === target)?.directoryRelation;

    expect(relation("app/models/billing", "app/models/billing/refunds")).toBe("descendant");
    expect(relation("app/models/billing", "app/services/billing")).toBe("disjoint");
  });

  it("groups the files that spell one constant namespace across directories, for the co-change reading", () => {
    const grouping = buildComponentGraph(zeitwerkGraph(), []).namespaceGrouping;

    expect(grouping?.componentOf.get("app/models/billing/invoice.rb")).toBe("::Billing");
    expect(grouping?.componentOf.get("app/services/billing/charge_service.rb")).toBe("::Billing");
    expect(grouping?.componentOf.get("app/models/billing/refunds/refund.rb")).toBe("::Billing::Refunds");
    expect(grouping?.componentOf.get("app/services/billing/refunds/request.rb")).toBe("::Billing::Refunds");
  });

  it("places a nested-module file in the namespace its compact sibling spells (bd tea-rags-mcp-r8hme.54)", () => {
    const graph: FileDependencyGraph = {
      files: [
        // `module Communication; module Api; module ChatThread`
        rubyFile("app/services/communication/api/chat_thread.rb", [
          "Communication",
          "Communication::Api",
          "Communication::Api::ChatThread",
        ]),
        // `module Communication::Api::Automations`
        rubyFile("app/services/communication/api/automations.rb", ["Communication::Api::Automations"]),
      ],
      edges: [],
    };

    const grouping = buildComponentGraph(graph, []).namespaceGrouping;

    expect(grouping?.componentOf.get("app/services/communication/api/chat_thread.rb")).toBe("::Communication::Api");
    expect(grouping?.componentOf.get("app/services/communication/api/automations.rb")).toBe("::Communication::Api");
  });

  it("groups a top-level constant with its own nested constants, and leaves a lone one in its directory", () => {
    const grouping = buildComponentGraph(zeitwerkGraph(), []).namespaceGrouping;

    expect(grouping?.componentOf.get("app/models/user.rb")).toBe("::User");
    expect(grouping?.componentOf.get("app/models/user/profile.rb")).toBe("::User");
    expect(grouping?.componentOf.get("app/models/account.rb")).toBe("app/models");
    expect(grouping?.componentOf.get("app/models/session.rb")).toBe("app/models");
  });

  it("keeps the directory in the grouping where the path does not spell the constant, or nothing is namespaced", () => {
    const grouping = buildComponentGraph(zeitwerkGraph(), []).namespaceGrouping;

    expect(grouping?.componentOf.get("config/initializers/string_ext.rb")).toBe("config/initializers");
    expect(grouping?.componentOf.get("clock.rb")).toBe("");
    expect(grouping?.componentOf.get("src/reranker.ts")).toBe("src");
  });

  it("aggregates the grouping's own dependencies, edges inside one directory included", () => {
    const pairs = buildComponentGraph(zeitwerkGraph(), []).namespaceGrouping?.dependencies.map(
      (d) => `${d.sourceComponent} -> ${d.targetComponent}`,
    );

    expect(pairs).toEqual([
      " -> ::Billing",
      "::Billing -> ::Billing::Refunds",
      "::Billing::Refunds -> ::User",
      "::User -> app/models",
    ]);
  });

  it("has no grouping when no file's path spells a namespace", () => {
    expect(buildComponentGraph(graph(), []).namespaceGrouping).toBeUndefined();
  });

  it("lets a judged facade module keep the files under it", () => {
    const g: FileDependencyGraph = {
      files: [
        { relPath: "lib/index.ts", language: "typescript", symbolCount: 1 },
        rubyFile("lib/billing/invoice.rb", ["Billing::Invoice"]),
        rubyFile("lib/billing/charge.rb", ["Billing::Charge"]),
      ],
      edges: [],
    };

    const built = buildComponentGraph(g, [module("lib", "active")]);
    expect(built.componentOf.get("lib/billing/invoice.rb")).toBe("lib");
    expect(built.namespaceGrouping?.componentOf.get("lib/billing/invoice.rb") ?? "lib").toBe("lib");
  });
});

/**
 * Facade aggregation stays out of the dependencies, but the graph remembers it
 * (bd tea-rags-mcp-r8hme.52.2): a nested component whose only in-edge is its
 * parent facade's re-export is reached through the parent's surface.
 */
describe("buildComponentGraph — facade aggregation record (bd tea-rags-mcp-r8hme.52.2)", () => {
  const modules = [
    module("lib", "active"),
    module("lib/inner", "facade-not-adopted"),
    module("small", "too-few-importers"),
  ];

  it("records each aggregation as a parent → nested component pair while excluded keeps its count", () => {
    const components = buildComponentGraph(graph(), modules);

    expect(components.facadeAggregations).toEqual([{ parentComponent: "lib", nestedComponent: "lib/inner" }]);
    expect(components.excluded.facadeAggregations).toBe(1);
  });

  it("names one pair once however many aggregation edges carry it", () => {
    const g = graph();
    g.edges.push(edge("lib/index.ts", "lib/inner/index.ts", { reexportedExportNames: ["Y"] }));

    expect(buildComponentGraph(g, modules).facadeAggregations).toEqual([
      { parentComponent: "lib", nestedComponent: "lib/inner" },
    ]);
  });

  it("marks an entry facade: a module facade no file imports and no external file reaches", () => {
    const g: FileDependencyGraph = {
      files: [file("cli/index.ts"), file("cli/run.ts"), file("lib/index.ts"), file("lib/a.ts")],
      edges: [edge("cli/index.ts", "cli/run.ts"), edge("cli/run.ts", "lib/index.ts")],
    };
    const entry = { ...module("cli", "facade-not-adopted"), externalImporterCount: 0, facadeImporterCount: 0 };
    const components = buildComponentGraph(g, [entry, module("lib", "active")]);

    expect(components.components.get("cli")?.entryFacade).toBe(true);
    expect(components.components.get("lib")).not.toHaveProperty("entryFacade");
  });

  it("does not mark a facade whose only importer is its parent facade's re-export", () => {
    const components = buildComponentGraph(graph(), [
      module("lib", "active"),
      { ...module("lib/inner", "facade-not-adopted"), externalImporterCount: 0 },
    ]);

    expect(components.components.get("lib/inner")).not.toHaveProperty("entryFacade");
  });
});

/**
 * An entry module (bd tea-rags-mcp-r8hme.52.4) is a root, not a domain
 * boundary: its facade is the target of no file edge and no external file
 * reaches it. It must not claim the orphan files below it — on the self-index
 * `src/index.ts` owned bootstrap, both adapters and the infra root, 105 files
 * with Ca 244, and sat in a 52-member knot. Its own directory's files stay one
 * component, marked `entryFacade`; the files under it fall to their own
 * directories (or nearer facades), as if the entry were absent.
 */
describe("entry facades do not own a subtree (bd tea-rags-mcp-r8hme.52.4)", () => {
  function entryModule(moduleDir: string, status: FacadeModuleAssessment["status"]): FacadeModuleAssessment {
    return { ...module(moduleDir, status), externalImporterCount: 0, facadeImporterCount: 0, adoption: 0 };
  }

  /** `root/index.ts` imports nothing-imports-it wiring over `root/boot` and `root/infra`. */
  function entryOverOrphans(): FileDependencyGraph {
    return {
      files: [file("root/index.ts"), file("root/main.ts"), file("root/boot/a.ts"), file("root/infra/b.ts")],
      edges: [
        edge("root/index.ts", "root/main.ts"),
        edge("root/main.ts", "root/boot/a.ts"),
        edge("root/boot/a.ts", "root/infra/b.ts"),
      ],
    };
  }

  it("lets the orphan directories under an entry facade become their own components", () => {
    const components = buildComponentGraph(entryOverOrphans(), [entryModule("root", "too-few-importers")]);

    expect(Object.fromEntries(components.componentOf)).toEqual({
      "root/index.ts": "root",
      "root/main.ts": "root",
      "root/boot/a.ts": "root/boot",
      "root/infra/b.ts": "root/infra",
    });
    expect(components.components.get("root")).toMatchObject({ kind: "module", entryFacade: true, fileCount: 2 });
    expect(components.components.get("root/boot")).not.toHaveProperty("entryFacade");
  });

  it("still lets a nearer facade under the entry own its subtree", () => {
    const g = entryOverOrphans();
    g.files.push(file("root/boot/index.ts"), file("root/boot/deep/c.ts"));
    g.edges.push(edge("root/main.ts", "root/boot/index.ts"), edge("root/boot/index.ts", "root/boot/deep/c.ts"));

    const components = buildComponentGraph(g, [
      entryModule("root", "too-few-importers"),
      { ...module("root/boot", "too-few-importers"), externalImporterCount: 1 },
    ]);

    expect(components.componentOf.get("root/boot/deep/c.ts")).toBe("root/boot");
    expect(components.componentOf.get("root/infra/b.ts")).toBe("root/infra");
  });

  it("keeps a facade with no importer of its facade file but deep external importers owning its subtree", () => {
    const g: FileDependencyGraph = {
      files: [file("lib/index.ts"), file("lib/deep/x.ts"), file("app/a.ts")],
      edges: [edge("app/a.ts", "lib/deep/x.ts")],
    };

    const components = buildComponentGraph(g, [module("lib", "facade-not-adopted")]);

    expect(components.componentOf.get("lib/deep/x.ts")).toBe("lib");
    expect(components.components.get("lib")).not.toHaveProperty("entryFacade");
  });

  it("keeps a facade reached only through its parent facade's re-export owning its subtree", () => {
    const g: FileDependencyGraph = {
      files: [file("lib/index.ts"), file("lib/inner/index.ts"), file("lib/inner/deep/z.ts"), file("app/a.ts")],
      edges: [
        edge("app/a.ts", "lib/index.ts"),
        edge("lib/index.ts", "lib/inner/index.ts", { reexportedExportNames: ["Z"] }),
        edge("lib/inner/index.ts", "lib/inner/deep/z.ts"),
      ],
    };

    const components = buildComponentGraph(g, [module("lib", "active"), entryModule("lib/inner", "too-few-importers")]);

    expect(components.componentOf.get("lib/inner/deep/z.ts")).toBe("lib/inner");
  });

  it("leaves a package with no facade file (Go) owning its subtree", () => {
    const g: FileDependencyGraph = {
      files: [file("pkg/a.go"), file("pkg/sub/b.go")],
      edges: [edge("pkg/a.go", "pkg/sub/b.go")],
    };
    const goPackage: FacadeModuleAssessment = {
      ...entryModule("pkg", "language-enforced"),
      facadeRelPath: null,
    };

    const components = buildComponentGraph(g, [goPackage]);

    expect(components.componentOf.get("pkg/sub/b.go")).toBe("pkg");
    expect(components.components.get("pkg")).not.toHaveProperty("entryFacade");
  });

  it("marks the entry whatever its module's adoption status — measured, not status-gated", () => {
    for (const status of ["facade-not-adopted", "too-few-importers"] as const) {
      const components = buildComponentGraph(entryOverOrphans(), [entryModule("root", status)]);

      expect(components.components.get("root")).toMatchObject({ kind: "module", entryFacade: true });
      expect(components.componentOf.get("root/boot/a.ts")).toBe("root/boot");
    }
  });
});

describe("buildComponentGraph componentRelabel (bd tea-rags-mcp-r8hme.21)", () => {
  it("pins relabelled files ahead of the module walk, so a group inside a module becomes its own component", () => {
    const graph: FileDependencyGraph = {
      files: [file("lib/index.ts"), file("lib/a.ts"), file("lib/b.ts"), file("app/x.ts")],
      edges: [edge("lib/a.ts", "lib/b.ts"), edge("app/x.ts", "lib/b.ts")],
    };
    const modules = [module("lib", "active")];

    const base = buildComponentGraph(graph, modules);
    const relabelled = buildComponentGraph(graph, modules, new Map([["lib/b.ts", "lib~split1"]]));

    expect(base.componentOf.get("lib/b.ts")).toBe("lib");
    expect(relabelled.componentOf.get("lib/b.ts")).toBe("lib~split1");
    expect(relabelled.components.get("lib~split1")).toMatchObject({
      kind: "directory",
      fileCount: 1,
      afferentCount: 2,
    });
    expect(relabelled.dependencies.map((d) => `${d.sourceComponent}->${d.targetComponent}`).sort()).toEqual([
      "app->lib~split1",
      "lib->lib~split1",
    ]);
  });
});
