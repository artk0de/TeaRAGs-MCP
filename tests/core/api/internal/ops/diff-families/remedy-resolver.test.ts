/**
 * `DiffFindingRemedyResolver` (bd tea-rags-mcp-89k7k.1.19.5, spec D2/D10): the
 * cheap, edge-only repair of a diff finding, emitted only when a dry-run
 * re-judgement over the edited overlay shows the finding gone and no finding
 * added. The fake `rejudge` here re-runs the real `DiffDetectorRun` over the
 * fixture edges with the edits applied.
 */
import { describe, expect, it, vi } from "vitest";

import { baseEdgesOf, catalogOf, graphOf, type ComponentFact } from "../__helpers__/diff-run-fixtures.js";
import {
  DiffDetectorRun,
  type DiffDetectorContractReader,
  type DiffDetectorRunDeps,
} from "../../../../../../src/core/api/internal/ops/diff-detector-run.js";
import type {
  DiffEdgeEdit,
  DiffRejudge,
  ExportTableReader,
} from "../../../../../../src/core/api/internal/ops/diff-families/index.js";
import {
  DiffFindingRemedyResolver,
  stampDiffFindingRemedies,
} from "../../../../../../src/core/api/internal/ops/diff-families/remedy-resolver.js";
import type {
  DiffDetectorFinding,
  DiffDetectorStatus,
  DiffFindingRemedy,
} from "../../../../../../src/core/contracts/types/diff-detector-finding.js";
import {
  ReviewEdgeOverlay,
  type HubLikeDependencyFanCounts,
  type HubLikeDependencyReading,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

/** A file edge plus the names its import statements take and re-export. */
type NamedEdge = readonly [
  source: string,
  target: string,
  names?: { imported?: readonly string[]; reexported?: readonly string[] },
];

function overlayOfNamed(edges: readonly NamedEdge[], changed: readonly string[]): ReviewEdgeOverlay {
  return new ReviewEdgeOverlay(
    changed.map((relPath) => ({
      relPath,
      edges: edges
        .filter(([source]) => source === relPath)
        .map(([sourceRelPath, targetRelPath, names]) => ({
          sourceRelPath,
          targetRelPath,
          ...(names?.imported !== undefined ? { importedExportNames: [...names.imported] } : {}),
          ...(names?.reexported !== undefined ? { reexportedExportNames: [...names.reexported] } : {}),
        })),
    })),
  );
}

/** The edits applied to the fixture edges: a retarget keeps the import's names; an export lands on the facade's first edge. */
function applyEdits(edges: readonly NamedEdge[], edits: readonly DiffEdgeEdit[]): NamedEdge[] {
  let edited = [...edges];
  for (const { replace, addExport } of edits) {
    if (replace !== undefined) {
      edited = edited.map((edge) =>
        edge[0] === replace.source && edge[1] === replace.from ? [edge[0], replace.to, edge[2]] : edge,
      );
    }
    if (addExport !== undefined) {
      const at = edited.findIndex(([source]) => source === addExport.facadeRelPath);
      if (at >= 0) {
        const [source, target, names] = edited[at];
        edited[at] = [source, target, { ...names, reexported: [...(names?.reexported ?? []), ...addExport.names] }];
      }
    }
  }
  return edited;
}

/** One diff, judged as is (`findings`) and through the what-if seam over the same deps (`rejudge`). */
function diffOf(deps: DiffDetectorRunDeps, changedFiles: readonly string[], edges: readonly NamedEdge[]) {
  const judge = (over: readonly NamedEdge[]) =>
    new DiffDetectorRun(deps).run({ changedFiles }, overlayOfNamed(over, changedFiles));
  const rejudge: DiffRejudge = (edits) => judge(applyEdits(edges, edits));
  return { overlay: overlayOfNamed(edges, changedFiles), findings: judge(edges).findings, rejudge };
}

function exportsOf(
  declarers: Readonly<Record<string, readonly string[]>>,
  surfaces: Readonly<Record<string, readonly string[]>> = {},
): ExportTableReader {
  return {
    declarersOf: (name) => declarers[name],
    indexedSurfaceOf: (relPath) => surfaces[relPath],
  };
}

function componentsOf(
  files: Readonly<Record<string, readonly [name: string, instability: number]>>,
): Map<string, Omit<ComponentFact, "connectionCount">> {
  return new Map(
    Object.entries(files).map(([relPath, [name, instability]]) => [
      relPath,
      { name, instability, distanceFromMainSequence: 0 },
    ]),
  );
}

const only = (findings: readonly DiffDetectorFinding[], detector: DiffDetectorFinding["detector"]) => {
  const matching = findings.filter((finding) => finding.detector === detector);
  expect(matching).toHaveLength(1);
  return matching[0];
};

describe("DiffFindingRemedyResolver", () => {
  describe("leakingAbstraction", () => {
    const SOURCE = "src/app/a.ts";
    const FACADE = "src/lib/index.ts";
    const INTERNAL = "src/lib/x.ts";
    const deps: DiffDetectorRunDeps = {
      catalog: catalogOf(
        componentsOf({ [SOURCE]: ["app", 0.5], [FACADE]: ["lib", 0.5], [INTERNAL]: ["lib", 0.5] }),
        new Map([["lib", FACADE]]),
      ),
      baseEdges: baseEdgesOf({ [SOURCE]: [FACADE] }),
    };
    const edges: NamedEdge[] = [
      [SOURCE, FACADE, { imported: ["Y"] }],
      [SOURCE, INTERNAL, { imported: ["X"] }],
    ];

    it("retargets the deep import to the facade that already re-exports the name, no export added", () => {
      const diff = diffOf(deps, [SOURCE], edges);
      const resolver = new DiffFindingRemedyResolver({
        overlay: diff.overlay,
        exports: exportsOf({ X: [INTERNAL] }, { [FACADE]: ["X", "Y"] }),
        rejudge: diff.rejudge,
      });

      expect(resolver.resolve(only(diff.findings, "leakingAbstraction"), diff.findings)).toEqual({
        kind: "retargetImport",
        sourceRelPath: SOURCE,
        fromRelPath: INTERNAL,
        toRelPath: FACADE,
        importedNames: ["X"],
      });
    });

    it("adds the one missing export line to the facade when it does not re-export the name", () => {
      const diff = diffOf(deps, [SOURCE], edges);
      const resolver = new DiffFindingRemedyResolver({
        overlay: diff.overlay,
        exports: exportsOf({ X: [INTERNAL] }, { [FACADE]: ["Y"] }),
        rejudge: diff.rejudge,
      });

      expect(resolver.resolve(only(diff.findings, "leakingAbstraction"), diff.findings)).toEqual({
        kind: "retargetImport",
        sourceRelPath: SOURCE,
        fromRelPath: INTERNAL,
        toRelPath: FACADE,
        importedNames: ["X"],
        addExport: { facadeRelPath: FACADE, names: ["X"] },
      });
    });
  });

  describe("stableDependencies", () => {
    const SOURCE = "src/app/a.ts";
    const BARREL = "src/lib/index.ts";
    const edges: NamedEdge[] = [[SOURCE, BARREL, { imported: ["T"] }]];

    it("retargets a type taken through an unstable barrel to the contracts file declaring it", () => {
      const CONTRACT = "src/contracts/t.ts";
      const deps: DiffDetectorRunDeps = {
        catalog: catalogOf(
          componentsOf({ [SOURCE]: ["app", 0.2], [BARREL]: ["lib", 0.9], [CONTRACT]: ["contracts", 0.1] }),
        ),
      };
      const diff = diffOf(deps, [SOURCE], edges);
      const resolver = new DiffFindingRemedyResolver({
        overlay: diff.overlay,
        exports: exportsOf({ T: [CONTRACT] }),
        rejudge: diff.rejudge,
      });

      expect(resolver.resolve(only(diff.findings, "stableDependencies"), diff.findings)).toEqual({
        kind: "retargetImport",
        sourceRelPath: SOURCE,
        fromRelPath: BARREL,
        toRelPath: CONTRACT,
        importedNames: ["T"],
      });
    });

    it("declines when the dry-run reports a finding the diff did not have", () => {
      const UTIL = "src/util/t.ts";
      const deps: DiffDetectorRunDeps = {
        catalog: catalogOf(componentsOf({ [SOURCE]: ["app", 0.2], [BARREL]: ["lib", 0.9], [UTIL]: ["util", 0.95] })),
      };
      const diff = diffOf(deps, [SOURCE], edges);
      const resolver = new DiffFindingRemedyResolver({
        overlay: diff.overlay,
        exports: exportsOf({ T: [UTIL] }),
        rejudge: diff.rejudge,
      });

      expect(resolver.resolve(only(diff.findings, "stableDependencies"), diff.findings)).toBeUndefined();
    });

    it("declines when an imported name is declared in two files", () => {
      const deps: DiffDetectorRunDeps = {
        catalog: catalogOf(
          componentsOf({
            [SOURCE]: ["app", 0.2],
            [BARREL]: ["lib", 0.9],
            "src/contracts/t.ts": ["contracts", 0.1],
            "src/contracts/u.ts": ["contracts", 0.1],
          }),
        ),
      };
      const diff = diffOf(deps, [SOURCE], edges);
      const rejudge = vi.fn(diff.rejudge);
      const resolver = new DiffFindingRemedyResolver({
        overlay: diff.overlay,
        exports: exportsOf({ T: ["src/contracts/t.ts", "src/contracts/u.ts"] }),
        rejudge,
      });

      expect(resolver.resolve(only(diff.findings, "stableDependencies"), diff.findings)).toBeUndefined();
      expect(rejudge).not.toHaveBeenCalled();
    });
  });

  it("cycles: retargets an import closing a cycle through a barrel to the declaring file off the cycle path", () => {
    const deps: DiffDetectorRunDeps = {
      catalog: catalogOf(new Map()),
      graph: graphOf([
        ["src/b/index.ts", "src/c.ts"],
        ["src/c.ts", "src/a.ts"],
      ]),
    };
    const diff = diffOf(deps, ["src/a.ts"], [["src/a.ts", "src/b/index.ts", { imported: ["D"] }]]);
    const resolver = new DiffFindingRemedyResolver({
      overlay: diff.overlay,
      exports: exportsOf({ D: ["src/d.ts"] }),
      rejudge: diff.rejudge,
    });

    expect(resolver.resolve(only(diff.findings, "cycles"), diff.findings)).toEqual({
      kind: "retargetImport",
      sourceRelPath: "src/a.ts",
      fromRelPath: "src/b/index.ts",
      toRelPath: "src/d.ts",
      importedNames: ["D"],
    });
  });

  it("hubLike: retargets to a file of a component the source already depends on, which also exports the name", () => {
    const SOURCE = "src/app/a.ts";
    const HUB_FILE = "src/lib/l.ts";
    const REACHED = "src/core/other.ts";
    const quiet: HubLikeDependencyFanCounts = { afferentCount: 1, efferentCount: 1, connectionCount: 2 };
    const hubLike: HubLikeDependencyReading = {
      fanCountsOf: (component) =>
        component === "lib" ? { afferentCount: 7, efferentCount: 11, connectionCount: 18 } : quiet,
      isFoundation: () => false,
      isHub: (fan) => fan.afferentCount >= 8 && fan.efferentCount >= 11,
    };
    const deps: DiffDetectorRunDeps = {
      catalog: catalogOf(componentsOf({ [SOURCE]: ["app", 0.5], [HUB_FILE]: ["lib", 0.5], [REACHED]: ["core", 0.5] })),
      baseEdges: baseEdgesOf({ [SOURCE]: [REACHED] }),
      hubLike,
    };
    const diff = diffOf(
      deps,
      [SOURCE],
      [
        [SOURCE, REACHED, { imported: ["Other"] }],
        [SOURCE, HUB_FILE, { imported: ["L"] }],
      ],
    );
    const resolver = new DiffFindingRemedyResolver({
      overlay: diff.overlay,
      exports: exportsOf({ L: [HUB_FILE] }, { [REACHED]: ["L", "Other"] }),
      rejudge: diff.rejudge,
    });

    expect(resolver.resolve(only(diff.findings, "hubLike"), diff.findings)).toEqual({
      kind: "retargetImport",
      sourceRelPath: SOURCE,
      fromRelPath: HUB_FILE,
      toRelPath: REACHED,
      importedNames: ["L"],
    });
  });

  it("facadeContract: restores the dropped names consumers still import", () => {
    const FACADE = "src/lib/index.ts";
    const contract: DiffDetectorContractReader = {
      facadeComponentOf: (relPath) => (relPath === FACADE ? "src/lib" : undefined),
      indexedConsumersOf: (facade) =>
        facade === FACADE ? [{ source: "src/app/a.ts", importedNames: ["a", "b"] }] : [],
      indexedSurfaceOf: (facade) => (facade === FACADE ? ["a", "b"] : undefined),
    };
    const diff = diffOf(
      { catalog: catalogOf(new Map()), contract },
      [FACADE],
      [[FACADE, "src/lib/x.ts", { reexported: ["a"] }]],
    );
    const resolver = new DiffFindingRemedyResolver({
      overlay: diff.overlay,
      exports: exportsOf({}),
      rejudge: diff.rejudge,
    });

    expect(resolver.resolve(only(diff.findings, "facadeContract"), diff.findings)).toEqual({
      kind: "restoreExport",
      facadeRelPath: FACADE,
      names: ["b"],
    });
  });

  it("silentCoupling and splitCandidates never carry a remedy and never dry-run", () => {
    const rejudge = vi.fn<DiffRejudge>(() => ({ findings: [] }));
    const resolver = new DiffFindingRemedyResolver({
      overlay: new ReviewEdgeOverlay([]),
      exports: exportsOf({}),
      rejudge,
    });
    const coupling: DiffDetectorFinding = {
      detector: "silentCoupling",
      subject: "src/a.ts ~ src/b.ts",
      detail: "co-change",
      endpoints: { kind: "filePair", sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts" },
      evidence: { support: 5, strength: 0.8 },
    };
    const split: DiffDetectorFinding = {
      detector: "splitCandidates",
      subject: "core",
      detail: "split",
      endpoints: { kind: "component", component: "core" },
      evidence: { clusterCount: 2, touchedClusters: [] },
    };

    expect(resolver.resolve(coupling, [coupling, split])).toBeUndefined();
    expect(resolver.resolve(split, [coupling, split])).toBeUndefined();
    expect(rejudge).not.toHaveBeenCalled();
  });
});

// bd tea-rags-mcp-89k7k.1.19.6: the section's stamping pass over one run.
describe("stampDiffFindingRemedies", () => {
  const leak: DiffDetectorFinding = {
    detector: "leakingAbstraction",
    subject: "src/app/a.ts -> src/lib/x.ts",
    detail: "leak",
    endpoints: { kind: "fileEdge", sourceRelPath: "src/app/a.ts", targetRelPath: "src/lib/x.ts" },
    evidence: { facadeRelPath: "src/lib/index.ts" },
  };
  const coupling: DiffDetectorFinding = {
    detector: "silentCoupling",
    subject: "src/a.ts ~ src/b.ts",
    detail: "co-change",
    endpoints: { kind: "filePair", sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts" },
    evidence: { support: 5, strength: 0.8 },
  };
  const remedy: DiffFindingRemedy = {
    kind: "retargetImport",
    sourceRelPath: "src/app/a.ts",
    fromRelPath: "src/lib/x.ts",
    toRelPath: "src/lib/index.ts",
    importedNames: ["X"],
  };
  const statuses: DiffDetectorStatus[] = [
    { detector: "leakingAbstraction", built: true, findingCount: 1 },
    { detector: "silentCoupling", built: true, findingCount: 1 },
  ];

  it("stamps the resolver's remedy on a finding that can carry one and never asks for the others", () => {
    const resolve = vi.fn((finding: DiffDetectorFinding) => (finding === leak ? remedy : undefined));

    const stamped = stampDiffFindingRemedies({ findings: [leak, coupling], detectors: statuses }, { resolve });

    expect(stamped.findings).toEqual([{ ...leak, remedy }, coupling]);
    expect(stamped.detectors).toEqual(statuses);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(leak, [leak, coupling]);
  });

  it("a resolver throw never fails the pass: the finding goes out without a remedy, its family's row says why", () => {
    const resolve = vi.fn((): DiffFindingRemedy | undefined => {
      throw new Error("export table read failed");
    });

    const stamped = stampDiffFindingRemedies({ findings: [leak, coupling], detectors: statuses }, { resolve });

    expect(stamped.findings).toEqual([leak, coupling]);
    expect(stamped.findings[0]).not.toHaveProperty("remedy");
    expect(stamped.detectors).toEqual([
      {
        detector: "leakingAbstraction",
        built: true,
        findingCount: 1,
        reason: "remedy resolver failed: export table read failed",
      },
      statuses[1],
    ]);
  });
});
