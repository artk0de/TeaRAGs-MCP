/**
 * The architecture section hands `DiffDetectorRun` the whole-repo readings
 * the families judge against (bd tea-rags-mcp-89k7k.1.19.2/.3/.4): the
 * MEASURED main-sequence distance threshold (mainSequence `preExisting`), the
 * inferred layering (layeringBackEdge) and the hub-like reading over the
 * measured foundation (hubLike). A section that drops one of them still
 * builds every row — mainSequence just never attributes `preExisting`, and a
 * hub reading without the foundation counts contracts edges into Ce — so the
 * inputs are pinned here, against the same measurements recomputed from the
 * same indexed graph.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveArchitectureComponentFacts,
  measureLayeringFoundationAndTerminalComponents,
  measureMainSequenceDistances,
  readProductionArchitectureGraph,
} from "../../../../../../src/core/api/internal/ops/architecture-facts.js";
import type * as DiffDetectorRunModule from "../../../../../../src/core/api/internal/ops/diff-detector-run.js";
import type { DiffDetectorRunDeps } from "../../../../../../src/core/api/internal/ops/diff-detector-run.js";
import type { DiffScopeRead } from "../../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import { architectureSectionProvider } from "../../../../../../src/core/api/internal/ops/review-sections/architecture-section.js";
import type { ReviewSectionContext } from "../../../../../../src/core/api/internal/ops/review-sections/review-section-provider.js";
import type {
  FileDependencyEdge,
  FileDependencyGraph,
  FileDependencyGraphFile,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../../../src/core/domains/language/index.js";
import {
  readHubLikeDependency,
  readLayering,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/index.js";

const captured = vi.hoisted(() => ({ deps: [] as DiffDetectorRunDeps[] }));

vi.mock("../../../../../../src/core/api/internal/ops/diff-detector-run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DiffDetectorRunModule>();
  class CapturingDiffDetectorRun extends actual.DiffDetectorRun {
    constructor(deps: DiffDetectorRunDeps) {
      captured.deps.push(deps);
      super(deps);
    }
  }
  return { ...actual, DiffDetectorRun: CapturingDiffDetectorRun };
});

let workTree: string;

beforeEach(() => {
  workTree = mkdtempSync(join(tmpdir(), "architecture-section-run-inputs-"));
  captured.deps.length = 0;
});

afterEach(() => {
  rmSync(workTree, { recursive: true, force: true });
});

function writeFile(relPath: string, text: string): void {
  const absolute = join(workTree, relPath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text);
}

function graphFile(relPath: string, abstractTypeCount = 0): FileDependencyGraphFile {
  return {
    relPath,
    language: "typescript",
    symbolCount: 1,
    ...(abstractTypeCount > 0 ? { typeAbstractness: { abstractTypeCount, concreteTypeCount: 0 } } : {}),
  };
}

function graphEdge(sourceRelPath: string, targetRelPath: string): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight: 1 };
}

/**
 * `src/contracts` — five pure-interface files nothing below: the measured
 * foundation. `src/lib/l1.ts` reaches the foundation ONLY (a Ce file the hub
 * reading must drop); `src/lib/l2.ts` reaches `src/app` too. `src/app` is
 * reached by four `src/dep` files and reaches lib and contracts.
 */
function indexedGraph(): FileDependencyGraph {
  const contracts = Array.from({ length: 5 }, (_, i) => graphFile(`src/contracts/c${i + 1}.ts`, 1));
  const deps = Array.from({ length: 4 }, (_, i) => graphFile(`src/dep/d${i + 1}.ts`));
  return {
    files: [
      ...contracts,
      ...deps,
      graphFile("src/lib/l1.ts"),
      graphFile("src/lib/l2.ts"),
      graphFile("src/app/a.ts"),
      graphFile("src/app/b.ts"),
    ],
    edges: [
      ...contracts.slice(1).map((c) => graphEdge("src/lib/l1.ts", c.relPath)),
      graphEdge("src/lib/l2.ts", "src/contracts/c1.ts"),
      graphEdge("src/lib/l2.ts", "src/app/b.ts"),
      graphEdge("src/app/a.ts", "src/lib/l1.ts"),
      graphEdge("src/app/b.ts", "src/contracts/c2.ts"),
      ...deps.map((d) => graphEdge(d.relPath, "src/app/a.ts")),
    ],
  };
}

function graphDbStub(graph: FileDependencyGraph) {
  return {
    readFileDependencyGraph: vi.fn(async () => graph),
    readTemporalCochangeGraph: vi.fn(async () => ({ meta: null, edges: [] })),
    readTemporalSymbolCommits: vi.fn(async () => ({ relPath: "", symbols: [] })),
    readNonPublicMemberEdges: vi.fn(async () => []),
    readTypeNameRows: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  };
}

function runContext(graph: FileDependencyGraph): ReviewSectionContext {
  const scope: DiffScopeRead = {
    workTree,
    base: "HEAD",
    mergeBase: "mb",
    notices: [],
    changedFiles: 1,
    wholeFiles: 0,
    files: ["src/app/a.ts"],
    touchedFiles: new Set(["src/app/a.ts"]),
    addedRanges: new Map(),
    nonProduction: new Set(),
    skipped: 0,
  };
  return {
    scope,
    graphDb: graphDbStub(graph),
    temporalCochange: undefined,
    temporalCochangeError: undefined,
    lexiconOps: undefined,
    reviewEdgeExtraction: {
      languageFactory: new LanguageFactory({}),
      collectSymbols,
      composer: new DefaultSymbolIdComposer(),
    },
    addressing: {},
    collectionName: "code_test",
    windowMonths: 6,
    diffRequest: {},
  };
}

/** Runs the section once over the fixture and answers the deps it built the run with, plus the expected readings. */
async function runSection() {
  writeFile("src/app/a.ts", `import { L } from "../lib/l1";\nexport const A = L;\n`);
  const graph = indexedGraph();
  await architectureSectionProvider.run(runContext(graph));
  expect(captured.deps).toHaveLength(1);
  const [deps] = captured.deps;

  const production = await readProductionArchitectureGraph(graphDbStub(graph));
  const facts = deriveArchitectureComponentFacts(production.graph);
  return { deps, production, facts };
}

describe("architectureSectionProvider.run — the readings it hands DiffDetectorRun", () => {
  it("passes the MEASURED main-sequence distance threshold — what mainSequence preExisting compares against", async () => {
    const { deps, production, facts } = await runSection();

    const measured = measureMainSequenceDistances(facts.components, production.graph.files).distanceThreshold;
    expect(typeof measured).toBe("number");
    expect(deps?.mainSequenceDistanceThreshold).toBe(measured);
  });

  it("passes the inferred layering over the report's component partition", async () => {
    const { deps, facts } = await runSection();

    const expected = readLayering(facts.components);
    const components = [...facts.components.components.keys()];
    expect(components.length).toBeGreaterThan(1);
    for (const component of components) {
      expect(deps?.layering?.positionOf(component)).toEqual(expected.positionOf(component));
      expect(deps?.layering?.filesOf(component)).toEqual(expected.filesOf(component));
    }
  });

  it("passes the hub-like reading over the measured foundation — Ce leaves foundation edges out", async () => {
    const { deps, production, facts } = await runSection();

    const foundationComponents = measureLayeringFoundationAndTerminalComponents(production.graph, facts);
    const contractsComponent = facts.components.componentOf.get("src/contracts/c1.ts");
    expect(contractsComponent).toBeDefined();
    if (contractsComponent === undefined) return;
    // The fixture's foundation is measured, not empty: dropping it would move lib's Ce.
    expect(foundationComponents.has(contractsComponent)).toBe(true);
    expect(deps?.hubLike?.isFoundation(contractsComponent)).toBe(true);

    const expected = readHubLikeDependency(facts.components, { foundationComponents });
    for (const component of facts.components.components.keys()) {
      expect(deps?.hubLike?.fanCountsOf(component)).toEqual(expected.fanCountsOf(component));
    }
    const libComponent = facts.components.componentOf.get("src/lib/l1.ts");
    if (libComponent === undefined) throw new Error("fixture: lib component missing");
    // l1 reaches the foundation only; l2 also reaches app — one Ce file, not two.
    expect(deps?.hubLike?.fanCountsOf(libComponent)?.efferentCount).toBe(1);
  });
});
