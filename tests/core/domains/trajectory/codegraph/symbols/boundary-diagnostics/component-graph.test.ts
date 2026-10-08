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
  buildDomainComponentGraph,
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

/**
 * The DOMAIN partition (bd tea-rags-mcp-r8hme.30): every directory with a
 * facade file is a component regardless of what the adoption measurement said.
 * `small/` here holds a facade three importers would be needed to measure —
 * the facade partition leaves its subtree to plain directories, the domain
 * partition claims it for the facade the directory declares. `go/` is a
 * language-enforced package with no facade file at all.
 */
describe("buildDomainComponentGraph", () => {
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
    const components = buildDomainComponentGraph(domainGraph, domainModules);

    expect(components.componentOf.get("small/util/su.ts")).toBe("small");
    expect(components.componentOf.get("go/pkg/p.go")).toBe("go");
    expect(components.components.get("small")).toMatchObject({
      kind: "module",
      facadeRelPath: "small/index.ts",
      fileCount: 2,
    });
    expect(components.components.get("go")).toMatchObject({ kind: "module", facadeRelPath: null });
  });

  it("keeps the facade-adoption partition as the default: an unmeasured facade owns nothing", () => {
    const components = buildComponentGraph(domainGraph, domainModules);

    expect(components.componentOf.get("small/util/su.ts")).toBe("small/util");
    expect(components.components.get("small")).toMatchObject({ kind: "directory", facadeRelPath: null });
    expect(components.components.has("go")).toBe(false);
  });
});

/**
 * The constant-namespace partition (bd tea-rags-mcp-r8hme.11): where a file's
 * path spells the constant it declares (Zeitwerk's contract), the component is
 * the constant NAMESPACE, not the directory — `app/models/billing/*` and
 * `app/services/billing/*` are one `Billing`. Derived from the declared
 * constants alone: no directory list, no language list.
 */
describe("buildComponentGraph — constant-namespace partition", () => {
  function rubyFile(relPath: string, outerScopeNames: string[]) {
    return { relPath, language: "ruby", symbolCount: 1, outerScopeNames };
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
        { relPath: "src/reranker.ts", language: "typescript", symbolCount: 1, outerScopeNames: ["Reranker"] },
      ],
      edges: [
        edge("app/models/billing/invoice.rb", "app/services/billing/charge_service.rb"),
        edge("app/models/billing/invoice.rb", "app/models/billing/refunds/refund.rb"),
        edge("app/models/billing/refunds/refund.rb", "app/models/user.rb"),
        edge("clock.rb", "app/models/billing/invoice.rb"),
        edge("app/models/account.rb", "app/models/session.rb"),
      ],
    };
  }

  it("joins the files that spell one constant namespace into one component, across directories", () => {
    const { componentOf, components } = buildComponentGraph(zeitwerkGraph(), []);

    expect(componentOf.get("app/models/billing/invoice.rb")).toBe("::Billing");
    expect(componentOf.get("app/services/billing/charge_service.rb")).toBe("::Billing");
    expect(componentOf.get("app/models/billing/refunds/refund.rb")).toBe("::Billing::Refunds");
    expect(componentOf.get("app/services/billing/refunds/request.rb")).toBe("::Billing::Refunds");
    expect(components.get("::Billing")).toMatchObject({ componentDir: "::Billing", kind: "namespace", fileCount: 2 });
    expect(components.get("::Billing::Refunds")).toMatchObject({ kind: "namespace", fileCount: 2 });
  });

  it("puts a top-level constant with its own nested constants, and leaves a lone one in its directory", () => {
    const { componentOf } = buildComponentGraph(zeitwerkGraph(), []);

    expect(componentOf.get("app/models/user.rb")).toBe("::User");
    expect(componentOf.get("app/models/user/profile.rb")).toBe("::User");
    expect(componentOf.get("app/models/account.rb")).toBe("app/models");
    expect(componentOf.get("app/models/session.rb")).toBe("app/models");
  });

  it("keeps the directory where the path does not spell the constant, or nothing is namespaced", () => {
    const { componentOf } = buildComponentGraph(zeitwerkGraph(), []);

    expect(componentOf.get("config/initializers/string_ext.rb")).toBe("config/initializers");
    expect(componentOf.get("clock.rb")).toBe("");
    expect(componentOf.get("src/reranker.ts")).toBe("src");
  });

  it("reads a nested namespace as containment and a namespace beside a directory as disjoint", () => {
    const { dependencies } = buildComponentGraph(zeitwerkGraph(), []);
    const relation = (source: string, target: string) =>
      dependencies.find((d) => d.sourceComponent === source && d.targetComponent === target)?.directoryRelation;

    expect(relation("::Billing", "::Billing::Refunds")).toBe("descendant");
    expect(relation("::Billing::Refunds", "::User")).toBe("disjoint");
    // The repository root is not an ancestor of a namespace.
    expect(relation("", "::Billing")).toBe("disjoint");
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

    expect(buildComponentGraph(g, [module("lib", "active")]).componentOf.get("lib/billing/invoice.rb")).toBe("lib");
  });
});
