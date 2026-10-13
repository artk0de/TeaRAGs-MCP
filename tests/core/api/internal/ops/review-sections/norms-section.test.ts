/**
 * The `norms` review section (bd tea-rags-mcp-xb669.3): every edge a change
 * ADDS judged by the dependency-norm verdict (`judgePlannedEdge`) against
 * ledgers built over the INDEXED graph only — an added edge is never its own
 * precedent. conforms → CONFORMS, misfit → MISFIT with the established
 * direction as `expectedPath`, insufficientSupport → NEW_PATTERN; an edge no
 * ledger can judge is UNJUDGED with its reason. Removed edges are a count.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiffScopeRead } from "../../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import {
  judgeAddedEdgeNorms,
  normsSectionProvider,
} from "../../../../../../src/core/api/internal/ops/review-sections/norms-section.js";
import type {
  ReviewGraphDb,
  ReviewSectionContext,
} from "../../../../../../src/core/api/internal/ops/review-sections/review-section-provider.js";
import type { NormsSectionResult } from "../../../../../../src/core/api/public/dto/review.js";
import type {
  DependencyNormFileRole,
  FileDependencyEdge,
  FileDependencyGraph,
  FileDependencyGraphFile,
  RelPath,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../../../src/core/domains/language/index.js";

const ALL_EXCLUSIONS = ["uncalled", "frameworkRouted", "constantReference", "displacedRole"];

function file(relPath: RelPath, language = "typescript"): FileDependencyGraphFile {
  return { relPath, language, symbolCount: 1 };
}

function edge(sourceRelPath: RelPath, targetRelPath: RelPath): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight: 1 };
}

const strong = (role: string): DependencyNormFileRole => ({ role, strong: true });

/**
 * Eight controllers each calling one service: controller → service is the
 * family's established direction (sign test p = 2⁻⁷, rejected by BH), plus a
 * repository nobody ever reached from a service.
 */
function indexedFixture(): { graph: FileDependencyGraph; fileRoles: Map<RelPath, DependencyNormFileRole> } {
  const files: FileDependencyGraphFile[] = [];
  const edges: FileDependencyEdge[] = [];
  const fileRoles = new Map<RelPath, DependencyNormFileRole>();
  for (let i = 1; i <= 8; i++) {
    const controller = `src/controllers/c${i}.ts`;
    const service = `src/services/s${i}.ts`;
    files.push(file(controller), file(service));
    edges.push(edge(controller, service));
    fileRoles.set(controller, strong("controller"));
    fileRoles.set(service, strong("service"));
  }
  files.push(file("src/repositories/r1.ts"), file("src/util/weak.ts"), file("src/util/untyped.ts"));
  files.push(file("app/models/user.rb", "ruby"));
  fileRoles.set("src/repositories/r1.ts", strong("repository"));
  fileRoles.set("src/util/weak.ts", { role: "helper", strong: false });
  fileRoles.set("app/models/user.rb", strong("model"));
  return { graph: { files, edges }, fileRoles };
}

function judged(
  added: readonly { source: string; target: string }[],
  extra: Partial<Parameters<typeof judgeAddedEdgeNorms>[0]> = {},
) {
  const { graph, fileRoles } = indexedFixture();
  return judgeAddedEdgeNorms({ addedEdges: added, removedEdgeCount: 0, indexedGraph: graph, fileRoles, ...extra });
}

describe("judgeAddedEdgeNorms", () => {
  it("CONFORMS an added edge along a direction the ledger holds", () => {
    const { addedEdgeVerdicts } = judged([{ source: "src/controllers/c1.ts", target: "src/services/s2.ts" }]);
    expect(addedEdgeVerdicts).toEqual([
      {
        source: "src/controllers/c1.ts",
        target: "src/services/s2.ts",
        verdict: "CONFORMS",
        roleSrc: "controller",
        roleDst: "service",
        pairSupport: 8,
        pValue: expect.any(Number),
        exclusionsUnchecked: ALL_EXCLUSIONS,
      },
    ]);
  });

  it("MISFITs an added edge against the established direction and names it as expectedPath", () => {
    const { addedEdgeVerdicts } = judged([{ source: "src/services/s1.ts", target: "src/controllers/c2.ts" }]);
    expect(addedEdgeVerdicts).toEqual([
      expect.objectContaining({
        verdict: "MISFIT",
        roleSrc: "service",
        roleDst: "controller",
        pairSupport: 0,
        expectedPath: { roleSrc: "controller", roleDst: "service", support: 8 },
        exclusionsUnchecked: ALL_EXCLUSIONS,
      }),
    ]);
    expect(addedEdgeVerdicts[0].pValue).toBeLessThan(0.05);
  });

  it("reads a role pair with no history as NEW_PATTERN", () => {
    const { addedEdgeVerdicts } = judged([{ source: "src/services/s1.ts", target: "src/repositories/r1.ts" }]);
    expect(addedEdgeVerdicts).toEqual([
      expect.objectContaining({ verdict: "NEW_PATTERN", roleSrc: "service", roleDst: "repository", pairSupport: 0 }),
    ]);
  });

  it("never counts the added edges as their own precedent — ledgers read the indexed graph only", () => {
    const added = Array.from({ length: 8 }, (_, i) => ({
      source: `src/services/s${i + 1}.ts`,
      target: "src/repositories/r1.ts",
    }));
    const { addedEdgeVerdicts } = judged(added);
    expect(addedEdgeVerdicts.map((row) => row.verdict)).toEqual(Array(8).fill("NEW_PATTERN"));
  });

  it("marks UNJUDGED with a reason: endpoint not indexed, untyped, weak role, cross-language", () => {
    const { addedEdgeVerdicts } = judged([
      { source: "src/controllers/c1.ts", target: "src/brand-new.ts" },
      { source: "src/controllers/c1.ts", target: "src/util/untyped.ts" },
      { source: "src/controllers/c1.ts", target: "src/util/weak.ts" },
      { source: "src/controllers/c1.ts", target: "app/models/user.rb" },
    ]);
    expect(addedEdgeVerdicts.map(({ target, verdict, reason }) => ({ target, verdict, reason }))).toEqual([
      { target: "src/brand-new.ts", verdict: "UNJUDGED", reason: "notIndexed" },
      { target: "src/util/untyped.ts", verdict: "UNJUDGED", reason: "untypedRole" },
      { target: "src/util/weak.ts", verdict: "UNJUDGED", reason: "weakRole" },
      { target: "app/models/user.rb", verdict: "UNJUDGED", reason: "crossLanguage" },
    ]);
    expect(addedEdgeVerdicts.every((row) => row.exclusionsUnchecked === undefined)).toBe(true);
  });

  it("applies an injected exclusion check: its class is UNJUDGED, its classes leave exclusionsUnchecked", () => {
    const { addedEdgeVerdicts } = judged(
      [
        { source: "src/controllers/c1.ts", target: "src/services/s2.ts" },
        { source: "src/controllers/c3.ts", target: "src/services/s4.ts" },
      ],
      {
        exclusions: {
          classes: ["constantReference", "displacedRole"],
          classify: ({ source }) => (source === "src/controllers/c1.ts" ? "constantReference" : undefined),
        },
      },
    );
    expect(addedEdgeVerdicts).toEqual([
      expect.objectContaining({
        source: "src/controllers/c3.ts",
        verdict: "CONFORMS",
        exclusionsUnchecked: ["uncalled", "frameworkRouted"],
      }),
      expect.objectContaining({ source: "src/controllers/c1.ts", verdict: "UNJUDGED", reason: "constantReference" }),
    ]);
  });

  it("counts an added edge touching a non-production file instead of judging it", () => {
    const result = judged(
      [
        { source: "tests/c1.test.ts", target: "src/services/s1.ts" },
        { source: "src/controllers/c1.ts", target: "src/services/s2.ts" },
      ],
      { isNonProduction: (relPath) => relPath.startsWith("tests/") },
    );
    expect(result.addedEdgeVerdicts.map((row) => row.source)).toEqual(["src/controllers/c1.ts"]);
    expect(result.nonProductionEdgeCount).toBe(1);
  });

  it("lists MISFITs first, caps the list and counts the rest", () => {
    const result = judged(
      [
        { source: "src/controllers/c1.ts", target: "src/services/s2.ts" },
        { source: "src/services/s1.ts", target: "src/repositories/r1.ts" },
        { source: "src/services/s1.ts", target: "src/controllers/c2.ts" },
      ],
      { removedEdgeCount: 4, cap: 2 },
    );
    expect(result.addedEdgeVerdicts.map((row) => row.verdict)).toEqual(["MISFIT", "NEW_PATTERN"]);
    expect(result.truncated).toBe(1);
    expect(result.verdictCounts).toEqual({ CONFORMS: 1, MISFIT: 1, NEW_PATTERN: 1, UNJUDGED: 0 });
    expect(result.removedEdgeCount).toBe(4);
    expect(result.built).toBe(true);
  });
});

/** One temp working tree per run test; removed afterwards. */
let workTree: string | undefined;

beforeEach(() => {
  workTree = mkdtempSync(join(tmpdir(), "norms-section-"));
});

afterEach(() => {
  if (workTree !== undefined) rmSync(workTree, { recursive: true, force: true });
  workTree = undefined;
});

function writeFile(relPath: string, text: string): void {
  const absolute = join(workTree!, relPath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text);
}

function scopeOf(files: readonly string[], touched: readonly string[] = files): DiffScopeRead {
  return {
    workTree: workTree!,
    base: "HEAD",
    mergeBase: "mb",
    notices: [],
    changedFiles: files.length,
    wholeFiles: 0,
    files,
    touchedFiles: new Set(touched),
    addedRanges: new Map(),
    nonProduction: new Set(),
    skipped: 0,
  };
}

function graphDbStub(graph: FileDependencyGraph) {
  return {
    readFileDependencyGraph: vi.fn<ReviewGraphDb["readFileDependencyGraph"]>().mockResolvedValue(graph),
    readTemporalCochangeGraph: vi.fn<ReviewGraphDb["readTemporalCochangeGraph"]>(),
    readTemporalSymbolCommits: vi.fn<ReviewGraphDb["readTemporalSymbolCommits"]>(),
    readNonPublicMemberEdges: vi.fn<ReviewGraphDb["readNonPublicMemberEdges"]>().mockResolvedValue([]),
    readTypeNameRows: vi.fn<ReviewGraphDb["readTypeNameRows"]>().mockResolvedValue([]),
  };
}

function runContext(overrides: Partial<ReviewSectionContext>): ReviewSectionContext {
  return {
    scope: scopeOf([]),
    graphDb: graphDbStub({ files: [], edges: [] }),
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
    ...overrides,
  };
}

describe("normsSectionProvider", () => {
  it("is not built without the indexed graph or the edge extraction", () => {
    expect(normsSectionProvider.isBuilt(runContext({}))).toEqual({ built: true });
    expect(normsSectionProvider.isBuilt(runContext({ graphDb: undefined }))).toMatchObject({ built: false });
    expect(normsSectionProvider.isBuilt(runContext({ reviewEdgeExtraction: undefined }))).toMatchObject({
      built: false,
    });
  });

  it("judges the tree's added edges against the index and counts the removed ones", async () => {
    writeFile("src/lib/b.ts", "export const B = 1;\n");
    writeFile("src/lib/c.ts", "export const C = 1;\n");
    writeFile(
      "src/app/a.ts",
      'import { B } from "../lib/b";\nimport { C } from "../lib/c";\nexport const A = B + C;\n',
    );
    const graphDb = graphDbStub({
      files: [
        file("src/app/a.ts"),
        file("src/lib/b.ts"),
        file("src/lib/c.ts"),
        file("src/lib/old.ts"),
        file("src/gone.ts"),
      ],
      edges: [
        edge("src/app/a.ts", "src/lib/b.ts"),
        edge("src/app/a.ts", "src/lib/old.ts"),
        edge("src/gone.ts", "src/lib/b.ts"),
      ],
    });
    const payload = (await normsSectionProvider.run(
      runContext({ scope: scopeOf(["src/app/a.ts"], ["src/app/a.ts", "src/gone.ts"]), graphDb }),
    )) as NormsSectionResult;
    expect(payload.built).toBe(true);
    // a → b was held in the index; a → c is the change's own edge — untyped, so UNJUDGED.
    expect(payload.addedEdgeVerdicts).toEqual([
      { source: "src/app/a.ts", target: "src/lib/c.ts", verdict: "UNJUDGED", reason: "untypedRole" },
    ]);
    // a → old dropped, the deleted file's one out-edge gone.
    expect(payload.removedEdgeCount).toBe(2);
  });
});
