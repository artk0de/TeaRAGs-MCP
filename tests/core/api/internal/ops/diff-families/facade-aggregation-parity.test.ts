/**
 * Facade aggregation parity (bd tea-rags-mcp-e1bf2): a module facade
 * re-exporting a descendant module's facade is the child joining the parent's
 * surface, not a dependency. The whole-repo component graph drops it through
 * `isFacadeAggregationEdge`; every diff family that judges a component
 * dependency (stableDependencies, mainSequence, layeringBackEdge, hubLike)
 * must drop it through the SAME predicate — one fact, one reading. The
 * control is the same pair carried by a plain import: both pipelines judge it.
 */
import { describe, expect, it } from "vitest";

import { baseEdgesOf, catalogOf, graphOf, type ComponentFact } from "../__helpers__/diff-run-fixtures.js";
import {
  DiffDetectorRun,
  type DiffDetectorFindings,
} from "../../../../../../src/core/api/internal/ops/diff-detector-run.js";
import type { ReviewFileEdge } from "../../../../../../src/core/contracts/types/codegraph-storage.js";
import type { FileDependencyGraph } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { DiffDetectorFamily } from "../../../../../../src/core/contracts/types/diff-detector-finding.js";
import {
  buildComponentGraph,
  ReviewEdgeOverlay,
  type FacadeModuleAssessment,
  type HubLikeDependencyReading,
  type LayeringReading,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

const PARENT_FACADE = "src/lib/index.ts";
const NESTED_FACADE = "src/lib/inner/index.ts";
const PARENT = "src/lib";
const NESTED = "src/lib/inner";

/** The same parent → nested pair, as an aggregating re-export and as a plain import. */
const SHAPES = [
  {
    shape: "facade aggregation (re-export)",
    edge: { sourceRelPath: PARENT_FACADE, targetRelPath: NESTED_FACADE, reexportedExportNames: ["Y"] },
    judged: false,
  },
  {
    shape: "plain import of the nested facade",
    edge: { sourceRelPath: PARENT_FACADE, targetRelPath: NESTED_FACADE, importedExportNames: ["Y"] },
    judged: true,
  },
] as const satisfies readonly { shape: string; edge: ReviewFileEdge; judged: boolean }[];

function module(moduleDir: string): FacadeModuleAssessment {
  return {
    moduleDir,
    facadeRelPath: `${moduleDir}/index.ts`,
    externalImporterCount: 3,
    facadeImporterCount: 3,
    deepImporterCount: 0,
    adoption: 1,
    status: "active",
  };
}

/** Whether the whole-repo component graph turns the file edge into a parent → nested dependency. */
function wholeRepoDepends(edge: ReviewFileEdge): boolean {
  const graph: FileDependencyGraph = {
    files: [PARENT_FACADE, NESTED_FACADE].map((relPath) => ({ relPath, language: "typescript", symbolCount: 1 })),
    edges: [{ ...edge, callWeight: 1 }],
  };
  return buildComponentGraph(graph, [module(PARENT), module(NESTED)]).dependencies.some(
    (dependency) => dependency.sourceComponent === PARENT && dependency.targetComponent === NESTED,
  );
}

/** parent stable and on the main sequence at Ca 8, Ce 1; nested markedly less stable. */
const PARENT_FACT: ComponentFact = {
  name: PARENT,
  instability: 1 / 9,
  distanceFromMainSequence: 0,
  connectionCount: 9,
  afferentCount: 8,
  efferentCount: 1,
};
const NESTED_FACT: ComponentFact = { name: NESTED, instability: 0.9, distanceFromMainSequence: 0, connectionCount: 20 };

/** parent L0 under nested L1, never composition — so only the aggregation exclusion can spare the edge. */
const layering: LayeringReading = {
  positionOf: (component) =>
    component === PARENT
      ? { level: 0, depth: 0, inKnot: false }
      : component === NESTED
        ? { level: 1, depth: 0, inKnot: false }
        : undefined,
  knotClosedBy: () => undefined,
  isComposition: () => false,
  filesOf: (component) => (component === PARENT ? [PARENT_FACADE] : component === NESTED ? [NESTED_FACADE] : []),
};

/** parent one afferent file below the stubbed hub cut, never containment. */
const hubLike: HubLikeDependencyReading = {
  fanCountsOf: (component) =>
    component === PARENT
      ? { afferentCount: 8, efferentCount: 10, connectionCount: 18 }
      : component === NESTED
        ? { afferentCount: 7, efferentCount: 11, connectionCount: 18 }
        : undefined,
  isFoundation: () => false,
  isContainment: () => false,
  isInheritance: () => false,
  isHub: (fan) => fan.afferentCount >= 8 && fan.efferentCount >= 11,
};

function diffRun(edge: ReviewFileEdge): DiffDetectorFindings {
  return new DiffDetectorRun({
    graph: graphOf([]),
    catalog: catalogOf(
      new Map<string, ComponentFact>([
        [PARENT_FACADE, PARENT_FACT],
        [NESTED_FACADE, NESTED_FACT],
      ]),
    ),
    baseEdges: baseEdgesOf({ [PARENT_FACADE]: [] }),
    layering,
    hubLike,
  }).run({ changedFiles: [PARENT_FACADE] }, new ReviewEdgeOverlay([{ relPath: PARENT_FACADE, edges: [edge] }]));
}

const COMPONENT_DEPENDENCY_FAMILIES: readonly DiffDetectorFamily[] = [
  "stableDependencies",
  "mainSequence",
  "layeringBackEdge",
  "hubLike",
];

describe("facade aggregation: the diff run and the whole-repo component graph agree (bd tea-rags-mcp-e1bf2)", () => {
  for (const { shape, edge, judged } of SHAPES) {
    it(`${shape}: whole-repo ${judged ? "keeps" : "drops"} the dependency`, () => {
      expect(wholeRepoDepends(edge)).toBe(judged);
    });

    for (const family of COMPONENT_DEPENDENCY_FAMILIES) {
      it(`${shape}: ${family} ${judged ? "judges" : "spares"} it, as the whole-repo graph does`, () => {
        const findings = diffRun(edge).findings.filter((finding) => finding.detector === family);
        expect(findings.length > 0).toBe(wholeRepoDepends(edge));
      });
    }
  }
});
