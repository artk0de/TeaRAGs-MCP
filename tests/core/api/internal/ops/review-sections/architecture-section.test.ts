/**
 * The `architecture` review section (bd tea-rags-mcp-89k7k.1.4, F3 slice 2):
 * the wiring of `DiffDetectorRun` to the real indexed graph and the
 * report-extracted facts, over F1's overlay, with the per-review temp table's
 * GUARANTEED cleanup. What is pinned here is the RUN FLOW — sweep-on-create,
 * reviewId mint, extraction→put→overlay→run, the finally-drop on success AND
 * error — plus the payload contract (findings cap, notJudged from skip
 * reasons, detectors). The detector judgements themselves are
 * `diff-detector-run.test.ts`'s; the facts are `architecture-facts.test.ts`'s.
 *
 * The working tree is real (temp dir + real trio, the same wires
 * `review-edge-overlay.test.ts` uses) so the extraction is exercised
 * end-to-end; the indexed graph is a stub behind the graphDb spies.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiffScopeRead } from "../../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import type { ReviewEdgeExtractionDeps } from "../../../../../../src/core/api/internal/ops/review-edge-overlay.js";
import {
  architectureSectionProvider,
  mintReviewId,
  WiredCouplingReader,
  WiredGraphReader,
} from "../../../../../../src/core/api/internal/ops/review-sections/architecture-section.js";
import type { ReviewSectionContext } from "../../../../../../src/core/api/internal/ops/review-sections/review-section-provider.js";
import type {
  FileDependencyEdge,
  FileDependencyGraph,
  FileDependencyGraphFile,
  RelPath,
  TemporalCochangeGraph,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../../../src/core/domains/language/index.js";

const REVIEW_ID_PATTERN = /^\d{10}-\d{1,7}-[a-z0-9]{6}$/;

/** One temp working tree per test; removed afterwards. */
let workTree: string | undefined;

beforeEach(() => {
  workTree = mkdtempSync(join(tmpdir(), "architecture-section-"));
});

afterEach(() => {
  if (workTree !== undefined) rmSync(workTree, { recursive: true, force: true });
  workTree = undefined;
});

/** Writes `text` at `relPath` under the temp tree, making parent dirs. */
function writeFile(relPath: string, text: string): void {
  const absolute = join(workTree!, relPath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text);
}

/** The real extraction trio — the same wires the naming review extractor uses. */
function realDeps(): ReviewEdgeExtractionDeps {
  return { languageFactory: new LanguageFactory({}), collectSymbols, composer: new DefaultSymbolIdComposer() };
}

function graphFile(relPath: RelPath): FileDependencyGraphFile {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function graphEdge(sourceRelPath: RelPath, targetRelPath: RelPath): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight: 1 };
}

/** An indexed edge that recorded the names its import takes — the facade-contract demand side. */
function namedGraphEdge(
  sourceRelPath: RelPath,
  targetRelPath: RelPath,
  importedExportNames: string[],
): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight: 1, importedExportNames };
}

interface GraphDbStub {
  readFileDependencyGraph: ReturnType<typeof vi.fn>;
  putReviewFileEdges: ReturnType<typeof vi.fn>;
  dropReviewFileEdges: ReturnType<typeof vi.fn>;
  sweepExpiredReviewFileEdges: ReturnType<typeof vi.fn>;
  readTemporalCochangeGraph: ReturnType<typeof vi.fn>;
  readTemporalSymbolCommits: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function graphDbStub(graph: FileDependencyGraph, cochangeEdges: TemporalCochangeGraph["edges"] = []): GraphDbStub {
  return {
    readFileDependencyGraph: vi.fn(async () => graph),
    putReviewFileEdges: vi.fn(async () => undefined),
    dropReviewFileEdges: vi.fn(async () => undefined),
    sweepExpiredReviewFileEdges: vi.fn(async () => []),
    readTemporalCochangeGraph: vi.fn(async () => ({ meta: { head: "h" }, edges: cochangeEdges })),
    readTemporalSymbolCommits: vi.fn(async () => ({ relPath: "", symbols: [] })),
    close: vi.fn(async () => undefined),
  };
}

function cochangePair(a: RelPath, b: RelPath, support: number): TemporalCochangeGraph["edges"][number] {
  return {
    relPathA: a,
    relPathB: b,
    support,
    confidenceAB: 0.75,
    confidenceBA: 0.6,
    lift: 3,
    lastCoChangeAt: 1_700_000_000,
    sampleCommits: ["a1b2c3"],
  };
}

function scopeOf(files: readonly string[]): DiffScopeRead {
  return {
    workTree: workTree!,
    base: "HEAD",
    mergeBase: "mb",
    notices: [],
    changedFiles: files.length,
    wholeFiles: 0,
    files,
    addedRanges: new Map(),
    nonProduction: new Set(),
    skipped: 0,
  };
}

function runContext(overrides: Partial<ReviewSectionContext> & { graphDb: GraphDbStub }): ReviewSectionContext {
  const { graphDb, ...rest } = overrides;
  return {
    scope: scopeOf([]),
    graphDb,
    temporalCochange: undefined,
    temporalCochangeError: undefined,
    lexiconOps: undefined,
    reviewEdgeExtraction: realDeps(),
    addressing: {},
    collectionName: "code_test",
    windowMonths: 6,
    diffRequest: {},
    ...rest,
  };
}

describe("architectureSectionProvider.isBuilt", () => {
  it("needs the graph reader and the extraction trio — the same substrate conditions its siblings name", () => {
    const graphDb = graphDbStub({ files: [], edges: [] });
    expect(architectureSectionProvider.isBuilt(runContext({ graphDb }))).toEqual({ built: true });
    expect(architectureSectionProvider.isBuilt(runContext({ graphDb, reviewEdgeExtraction: undefined }))).toMatchObject(
      { built: false },
    );
    expect(architectureSectionProvider.isBuilt({ ...runContext({ graphDb }), graphDb: undefined })).toMatchObject({
      built: false,
    });
  });
});

describe("architectureSectionProvider.run", () => {
  it("runs the flow in order — sweep, mint, extract+put, judge — and drops the temp table in the finally", async () => {
    writeFile("src/lib/b.ts", "export const B = 1;\n");
    writeFile("src/app/a.ts", 'import { B } from "../lib/b";\nexport const A = B;\n');
    writeFile("docs/notes.md", "# Notes\n");
    const graph = graphDbStub(
      {
        files: [graphFile("src/app/a.ts"), graphFile("src/lib/b.ts"), graphFile("src/other/c.ts")],
        // The stale indexed edge the diff replaces: pre-diff, b imported a.
        edges: [graphEdge("src/lib/b.ts", "src/app/a.ts")],
      },
      [cochangePair("src/app/a.ts", "src/other/c.ts", 5)],
    );

    const payload = (await architectureSectionProvider.run(
      runContext({
        graphDb: graph,
        scope: scopeOf(["src/app/a.ts", "docs/notes.md", "src/gone.ts"]),
        temporalCochange: { meta: { head: "h" }, edges: [cochangePair("src/app/a.ts", "src/other/c.ts", 5)] },
      }),
    )) as Record<string, unknown>;

    // Sweep-on-create: once, before anything else, with the store's age bound.
    expect(graph.sweepExpiredReviewFileEdges).toHaveBeenCalledTimes(1);
    const [nowEpoch, maxAge] = graph.sweepExpiredReviewFileEdges.mock.calls[0] as [number, number];
    expect(maxAge).toBe(3600);
    expect(nowEpoch).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 120);

    // One minted reviewId carries the put and the drop; the edges put are the
    // successful working-tree reads only.
    expect(graph.putReviewFileEdges).toHaveBeenCalledTimes(1);
    const [putId, putEdges] = graph.putReviewFileEdges.mock.calls[0] as [string, { sourceRelPath: string }[]];
    expect(putId).toMatch(REVIEW_ID_PATTERN);
    expect(putEdges).toEqual([
      { sourceRelPath: "src/app/a.ts", targetRelPath: "src/lib/b.ts", importedExportNames: ["B"] },
    ]);
    expect(graph.dropReviewFileEdges).toHaveBeenCalledTimes(1);
    expect(graph.dropReviewFileEdges.mock.calls[0]?.[0]).toBe(putId);
    // sweep → put → drop, in that order.
    expect(graph.sweepExpiredReviewFileEdges.mock.invocationCallOrder[0]).toBeLessThan(
      graph.putReviewFileEdges.mock.invocationCallOrder[0],
    );
    expect(graph.putReviewFileEdges.mock.invocationCallOrder[0]).toBeLessThan(
      graph.dropReviewFileEdges.mock.invocationCallOrder[0],
    );

    // The run judged the overlay edge against the indexed graph and the facts:
    // stableDependencies (indexed lib I=1 markedly above app I=0), cycles (the
    // indexed b→a closes a→b), mainSequence (app's I moves 0→1), silentCoupling
    // (co-change partner outside the diff, no structural edge either way).
    const findings = payload.findings as { detector: string; subject: string }[];
    const subjects = (detector: string) => findings.filter((f) => f.detector === detector).map((f) => f.subject);
    expect(subjects("stableDependencies")).toEqual(["src/app/a.ts -> src/lib/b.ts"]);
    expect(subjects("cycles")).toEqual(["src/app/a.ts -> src/lib/b.ts"]);
    expect(subjects("mainSequence")).toEqual(["src/app"]);
    expect(subjects("silentCoupling")).toEqual(["src/app/a.ts ~ src/other/c.ts"]);

    // Skipped reads are notJudged entries, never edge-free zeros.
    expect(payload.notJudged).toEqual([
      { relPath: "docs/notes.md", reason: "noCodegraphLanguage" },
      { relPath: "src/gone.ts", reason: "unreadable", detail: expect.stringContaining("ENOENT") },
    ]);

    // The detector statuses ride along, splitCandidates honestly unbuilt — the
    // snapshot carries a build but no bundle membership (the phase-1 reason);
    // facadeContract is wired here (the section always builds the port) and
    // found nothing on this fixture.
    const detectors = payload.detectors as { detector: string; built: boolean; findingCount: number }[];
    expect(detectors.map((d) => d.detector)).toEqual([
      "stableDependencies",
      "leakingAbstraction",
      "cycles",
      "mainSequence",
      "silentCoupling",
      "facadeContract",
      "splitCandidates",
    ]);
    expect(detectors.find((d) => d.detector === "facadeContract")).toMatchObject({ built: true, findingCount: 0 });
    expect(detectors.find((d) => d.detector === "splitCandidates")).toMatchObject({
      built: false,
      reason: "noBundleMembership",
      findingCount: 0,
    });
    expect(payload.truncated).toBeUndefined();
  });

  it("caps findings at 100 and counts the rest in truncated", async () => {
    const targets = Array.from({ length: 105 }, (_, i) => `src/lib/t${String(i).padStart(3, "0")}.ts`);
    for (const target of targets) writeFile(target, `export const T = 1;\n`);
    writeFile(
      "src/app/a.ts",
      `${targets.map((_, i) => `import { T${i} } from "../lib/t${String(i).padStart(3, "0")}";\n`).join("")}export const A = 1;\n`,
    );
    const graph = graphDbStub({
      files: [graphFile("src/app/a.ts"), ...targets.map((relPath) => graphFile(relPath))],
      // One stale indexed edge: enough for lib I=1 / app I=0, and it closes the
      // a→t0 edge into a cycle.
      edges: [graphEdge("src/lib/t000.ts", "src/app/a.ts")],
    });

    const payload = (await architectureSectionProvider.run(
      runContext({ graphDb: graph, scope: scopeOf(["src/app/a.ts"]) }),
    )) as Record<string, unknown>;

    const detectors = payload.detectors as { detector: string; findingCount: number }[];
    const byName = new Map(detectors.map((d) => [d.detector, d.findingCount]));
    // 105 markedly-less-stable edges + one closed cycle + app's main-sequence move.
    expect(byName.get("stableDependencies")).toBe(105);
    expect(byName.get("cycles")).toBe(1);
    expect(byName.get("mainSequence")).toBe(1);
    expect(payload.findings as unknown[]).toHaveLength(100);
    expect(payload.truncated).toBe(7);
  });

  it("an empty diff is a valid review: built, no findings, empty put still minted and dropped", async () => {
    const graph = graphDbStub({ files: [graphFile("src/app/a.ts")], edges: [] });

    const payload = (await architectureSectionProvider.run(
      runContext({ graphDb: graph, scope: scopeOf([]) }),
    )) as Record<string, unknown>;

    expect(graph.putReviewFileEdges).toHaveBeenCalledTimes(1);
    expect(graph.putReviewFileEdges.mock.calls[0]?.[1]).toEqual([]);
    expect(graph.dropReviewFileEdges).toHaveBeenCalledTimes(1);
    expect(payload.findings).toEqual([]);
    expect((payload.detectors as { findingCount: number }[]).every((d) => d.findingCount === 0)).toBe(true);
  });

  it("drops the temp table even when the run fails — a poisoned indexed-graph read", async () => {
    const graph = graphDbStub({ files: [], edges: [] });
    graph.readFileDependencyGraph.mockRejectedValue(new Error("wal corrupt"));

    await expect(
      architectureSectionProvider.run(runContext({ graphDb: graph, scope: scopeOf(["src/app/a.ts"]) })),
    ).rejects.toThrow(/wal corrupt/);
    expect(graph.dropReviewFileEdges).toHaveBeenCalledTimes(1);
    expect(graph.dropReviewFileEdges.mock.calls[0]?.[0]).toMatch(REVIEW_ID_PATTERN);
  });

  it("drops the temp table even when the put fails", async () => {
    writeFile("src/app/a.ts", "export const A = 1;\n");
    const graph = graphDbStub({ files: [graphFile("src/app/a.ts")], edges: [] });
    graph.putReviewFileEdges.mockRejectedValue(new Error("daemon gone"));

    await expect(
      architectureSectionProvider.run(runContext({ graphDb: graph, scope: scopeOf(["src/app/a.ts"]) })),
    ).rejects.toThrow(/daemon gone/);
    expect(graph.dropReviewFileEdges).toHaveBeenCalledTimes(1);
  });

  it("a drop failure never masks the original answer", async () => {
    writeFile("src/app/a.ts", "export const A = 1;\n");
    const graph = graphDbStub({ files: [graphFile("src/app/a.ts")], edges: [] });
    graph.dropReviewFileEdges.mockRejectedValue(new Error("drop exploded"));

    const payload = (await architectureSectionProvider.run(
      runContext({ graphDb: graph, scope: scopeOf(["src/app/a.ts"]) }),
    )) as Record<string, unknown>;
    expect(payload.findings).toEqual([]);
  });
});

describe("architectureSectionProvider.run — facadeContract wiring", () => {
  it("emits a facadeContract finding end-to-end: the diff drops a re-export indexed consumers still import", async () => {
    // The tree's facade keeps `a` and `z` but no longer re-exports `b`.
    writeFile("src/lib/x.ts", "export const a = 1;\nexport const b = 2;\n");
    writeFile("src/lib/y.ts", "export const z = 1;\n");
    writeFile("src/lib/index.ts", 'export { a } from "./x";\nexport { z } from "./y";\n');
    // The indexed side keeps the module MEASURED (three external importers, all
    // through the facade — adoption 1), and one of them still imports `b`.
    const graph = graphDbStub({
      files: [
        graphFile("src/lib/index.ts"),
        graphFile("src/lib/x.ts"),
        graphFile("src/lib/y.ts"),
        graphFile("src/app/c1.ts"),
        graphFile("src/app/c2.ts"),
        graphFile("src/app/c3.ts"),
      ],
      edges: [
        namedGraphEdge("src/app/c1.ts", "src/lib/index.ts", ["a"]),
        namedGraphEdge("src/app/c2.ts", "src/lib/index.ts", ["a"]),
        namedGraphEdge("src/app/c3.ts", "src/lib/index.ts", ["a", "b"]),
      ],
    });

    const payload = (await architectureSectionProvider.run(
      runContext({ graphDb: graph, scope: scopeOf(["src/lib/index.ts"]) }),
    )) as Record<string, unknown>;

    const findings = payload.findings as { detector: string; subject: string; evidence: string[] }[];
    expect(findings.filter((f) => f.detector === "facadeContract")).toEqual([
      {
        detector: "facadeContract",
        subject: "src/lib/index.ts",
        evidence: ["b: consumed by src/app/c3.ts"],
        detail: expect.stringContaining("stops re-exporting"),
      },
    ]);
    const detectors = payload.detectors as { detector: string; built: boolean; findingCount: number }[];
    expect(detectors.find((d) => d.detector === "facadeContract")).toEqual({
      detector: "facadeContract",
      built: true,
      findingCount: 1,
    });
  });

  it("a non-facade diff reports the family built with zero findings", async () => {
    writeFile("src/lib/b.ts", "export const B = 1;\n");
    writeFile("src/app/a.ts", 'import { B } from "../lib/b";\nexport const A = B;\n');
    const graph = graphDbStub({
      files: [graphFile("src/app/a.ts"), graphFile("src/lib/b.ts")],
      edges: [],
    });

    const payload = (await architectureSectionProvider.run(
      runContext({ graphDb: graph, scope: scopeOf(["src/app/a.ts"]) }),
    )) as Record<string, unknown>;

    const detectors = payload.detectors as { detector: string; built: boolean; findingCount: number }[];
    expect(detectors.find((d) => d.detector === "facadeContract")).toEqual({
      detector: "facadeContract",
      built: true,
      findingCount: 0,
    });
  });
});

describe("architectureSectionProvider.run — splitCandidates wiring", () => {
  /** A co-change pair with explicit bundle counts — the strengths phase 1 clusters by. */
  function temporalPair(
    a: RelPath,
    b: RelPath,
    support: number,
    changesA: number,
    changesB: number,
  ): TemporalCochangeGraph["edges"][number] {
    return {
      relPathA: a,
      relPathB: b,
      support,
      confidenceAB: support / changesA,
      confidenceBA: support / changesB,
      lift: 2,
      lastCoChangeAt: 0,
      sampleCommits: [],
      structurallyLinked: false,
    };
  }

  /**
   * The snapshot that makes `src/wide` a split candidate: an x-group (support
   * 16) and a y-group (support 20) joined by a weak bridge (support 2, under
   * the majority floor) — the same shape the phase-1 verdict test splits.
   */
  function wideSplitSnapshot(): TemporalCochangeGraph {
    const bundles = new Map<number, readonly RelPath[]>();
    for (let i = 0; i < 16; i++) bundles.set(bundles.size, ["src/wide/x1.ts", "src/wide/x2.ts"]);
    for (let i = 0; i < 20; i++) bundles.set(bundles.size, ["src/wide/y1.ts", "src/wide/y2.ts"]);
    bundles.set(bundles.size, ["src/wide/x2.ts", "src/wide/y1.ts"]);
    bundles.set(bundles.size, ["src/wide/x2.ts", "src/wide/y1.ts"]);
    return {
      meta: { head: "h" },
      edges: [
        temporalPair("src/wide/x1.ts", "src/wide/x2.ts", 16, 16, 18),
        temporalPair("src/wide/y1.ts", "src/wide/y2.ts", 20, 22, 20),
        temporalPair("src/wide/x2.ts", "src/wide/y1.ts", 2, 18, 22),
      ],
      bundles,
    };
  }

  it("computes the phase-1 verdicts over the snapshot and reports the diff working across the seam", async () => {
    for (const relPath of ["src/wide/x1.ts", "src/wide/x2.ts", "src/wide/y1.ts", "src/wide/y2.ts"]) {
      writeFile(relPath, "export const W = 1;\n");
    }
    const graph = graphDbStub({
      files: ["src/wide/x1.ts", "src/wide/x2.ts", "src/wide/y1.ts", "src/wide/y2.ts"].map(graphFile),
      edges: [],
    });

    const payload = (await architectureSectionProvider.run(
      runContext({
        graphDb: graph,
        scope: scopeOf(["src/wide/x1.ts", "src/wide/y1.ts"]),
        temporalCochange: wideSplitSnapshot(),
      }),
    )) as Record<string, unknown>;

    const findings = payload.findings as { detector: string; subject: string; evidence: string[] }[];
    expect(findings.find((f) => f.detector === "splitCandidates")).toEqual({
      detector: "splitCandidates",
      subject: "src/wide",
      evidence: [
        "cluster 1: 1 of 2 changed files — src/wide/y1.ts",
        "cluster 2: 1 of 2 changed files — src/wide/x1.ts",
      ],
      detail:
        "the diff works across the seam of src/wide, a component whose history already splits into 2 co-change groups",
    });
    const detectors = payload.detectors as { detector: string; built: boolean; findingCount: number }[];
    expect(detectors.find((d) => d.detector === "splitCandidates")).toEqual({
      detector: "splitCandidates",
      built: true,
      findingCount: 1,
    });
  });

  it("a snapshot whose build persisted no bundle membership reports the family noBundleMembership", async () => {
    writeFile("src/wide/x1.ts", "export const W = 1;\n");
    const graph = graphDbStub({ files: [graphFile("src/wide/x1.ts")], edges: [] });

    const payload = (await architectureSectionProvider.run(
      runContext({
        graphDb: graph,
        scope: scopeOf(["src/wide/x1.ts"]),
        temporalCochange: { meta: { head: "h" }, edges: [], bundles: new Map() },
      }),
    )) as Record<string, unknown>;

    const detectors = payload.detectors as {
      detector: string;
      built: boolean;
      reason?: string;
      findingCount: number;
    }[];
    expect(detectors.find((d) => d.detector === "splitCandidates")).toEqual({
      detector: "splitCandidates",
      built: false,
      reason: "noBundleMembership",
      findingCount: 0,
    });
  });

  it("a null snapshot (no co-change build) reports the family noCochangeBuild", async () => {
    writeFile("src/wide/x1.ts", "export const W = 1;\n");
    const graph = graphDbStub({ files: [graphFile("src/wide/x1.ts")], edges: [] });

    const payload = (await architectureSectionProvider.run(
      runContext({
        graphDb: graph,
        scope: scopeOf(["src/wide/x1.ts"]),
        temporalCochange: null,
      }),
    )) as Record<string, unknown>;

    const detectors = payload.detectors as {
      detector: string;
      built: boolean;
      reason?: string;
      findingCount: number;
    }[];
    expect(detectors.find((d) => d.detector === "splitCandidates")).toEqual({
      detector: "splitCandidates",
      built: false,
      reason: "noCochangeBuild",
      findingCount: 0,
    });
  });
});

describe("mintReviewId", () => {
  it("mints the store's id shape exactly: epoch-pid-six lowercase alnum", () => {
    const now = Math.floor(Date.now() / 1000);
    const id = mintReviewId(now);
    expect(id).toMatch(REVIEW_ID_PATTERN);
    expect(id.startsWith(`${now}-`)).toBe(true);
    expect(mintReviewId(now)).not.toBe(mintReviewId(now));
  });
});

describe("WiredGraphReader", () => {
  it("serves indexed rows verbatim in both directions from one bulk read", () => {
    const reader = new WiredGraphReader([graphEdge("src/a.ts", "src/b.ts"), graphEdge("src/b.ts", "src/c.ts")]);
    expect(reader.edgesFrom("src/b.ts")).toEqual([{ source: "src/b.ts", target: "src/c.ts" }]);
    expect(reader.edgesTo("src/b.ts")).toEqual([{ source: "src/a.ts", target: "src/b.ts" }]);
    expect(reader.edgesFrom("src/none.ts")).toEqual([]);
    expect(reader.edgesTo("src/none.ts")).toEqual([]);
  });
});

describe("WiredCouplingReader", () => {
  it("adapts the co-change snapshot both ways: the file as relPathA or relPathB", () => {
    const reader = new WiredCouplingReader({
      meta: { head: "h" },
      edges: [cochangePair("src/a.ts", "src/b.ts", 4), cochangePair("src/a.ts", "src/z.ts", 2)],
    });
    expect(reader.partnersOf("src/a.ts")).toEqual([
      { partner: "src/b.ts", support: 4 },
      { partner: "src/z.ts", support: 2 },
    ]);
    expect(reader.partnersOf("src/b.ts")).toEqual([{ partner: "src/a.ts", support: 4 }]);
    expect(reader.partnersOf("src/none.ts")).toEqual([]);
  });

  it("an absent or never-built snapshot answers no partners — absence is silence, not a zero verdict", () => {
    expect(new WiredCouplingReader(undefined).partnersOf("src/a.ts")).toEqual([]);
    expect(new WiredCouplingReader(null).partnersOf("src/a.ts")).toEqual([]);
  });
});
