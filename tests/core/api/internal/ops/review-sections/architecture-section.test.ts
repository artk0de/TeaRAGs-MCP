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
  buildSilentCouplingFacts,
  mintReviewId,
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

/**
 * Indexed files whose only role is to sit AROUND a fixture component so its
 * `connectionCount` reaches the SDP floor (bd tea-rags-mcp-r8hme.45): the
 * main-sequence family judges a touched component only at connections ≥ the
 * floor, and a one-edge fixture would land in the exclusion instead.
 * AFFERENT only — instability stays I=0, and files nothing points at cannot
 * close a cycle through the overlay.
 */
function floorAfferents(target: RelPath, count = 4): Pick<FileDependencyGraph, "files" | "edges"> {
  const files = Array.from({ length: count }, (_, i) => graphFile(`src/dep/d${i + 1}.ts`));
  return { files, edges: files.map((f) => graphEdge(f.relPath, target)) };
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

function cochangePair(
  a: RelPath,
  b: RelPath,
  support: number,
  structurallyLinked = false,
): TemporalCochangeGraph["edges"][number] {
  return {
    relPathA: a,
    relPathB: b,
    support,
    confidenceAB: 0.75,
    confidenceBA: 0.6,
    lift: 3,
    lastCoChangeAt: 1_700_000_000,
    sampleCommits: ["a1b2c3"],
    structurallyLinked,
  };
}

/**
 * A pair the production strength cut admits: wilson(9, 10) ≈ 0.596 clears the
 * 0.5 majority floor — `cochangePair`'s 0.75/0.6 confidences give ≈ 0.47 and
 * are (correctly) not strong under the machinery the wiring now consumes.
 */
function strongPair(
  a: RelPath,
  b: RelPath,
  support = 9,
  structurallyLinked = false,
): TemporalCochangeGraph["edges"][number] {
  return {
    ...cochangePair(a, b, support, structurallyLinked),
    confidenceAB: 0.9,
    confidenceBA: 0.9,
  };
}

function scopeOf(files: readonly string[], skipped = 0): DiffScopeRead {
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
    skipped,
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
    const lift = floorAfferents("src/app/a.ts");
    const graph = graphDbStub(
      {
        files: [graphFile("src/app/a.ts"), graphFile("src/lib/b.ts"), graphFile("src/other/c.ts"), ...lift.files],
        // The stale indexed edge the diff replaces: pre-diff, b imported a.
        // The four dep files lift app's component to the SDP connection floor
        // so the main-sequence family judges it (bd tea-rags-mcp-r8hme.45).
        edges: [graphEdge("src/lib/b.ts", "src/app/a.ts"), ...lift.edges],
      },
      [strongPair("src/app/a.ts", "src/other/c.ts")],
    );

    const payload = (await architectureSectionProvider.run(
      runContext({
        graphDb: graph,
        scope: scopeOf(["src/app/a.ts", "docs/notes.md", "src/gone.ts"]),
        temporalCochange: { meta: { head: "h" }, edges: [strongPair("src/app/a.ts", "src/other/c.ts")] },
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

  // The wiring-level twin of the production pin (silent-coupling.test.ts:188,
  // bd tea-rags-mcp-r8hme.12), live-measured as bead tea-rags-mcp-89k7k.4: a
  // dto/ops pair (support 24) reported as "strong co-change with NO structural
  // edge" while ops imports 18 DTO names via `import type`. That edge lives in
  // cg_symbols_edges_file_type_only — readFileDependencyGraph never returns it
  // — but the co-change snapshot's structurallyLinked flag is computed from the
  // production union that counts a type-only import as a link, so the pair must
  // arrive at the judgement already explained.
  it("does not report a pair linked only by a type-only import — the snapshot's linkage flag explains it", async () => {
    writeFile("src/dto.ts", "export type A = { x: number };\n");
    const graph = graphDbStub(
      {
        files: [graphFile("src/dto.ts"), graphFile("src/ops.ts")],
        edges: [],
      },
      [cochangePair("src/dto.ts", "src/ops.ts", 24, true)],
    );

    const payload = (await architectureSectionProvider.run(
      runContext({
        graphDb: graph,
        scope: scopeOf(["src/dto.ts"]),
        temporalCochange: { meta: { head: "h" }, edges: [cochangePair("src/dto.ts", "src/ops.ts", 24, true)] },
      }),
    )) as Record<string, unknown>;

    const findings = payload.findings as { detector: string; subject: string }[];
    expect(findings.filter((f) => f.detector === "silentCoupling")).toEqual([]);
    const detectors = payload.detectors as { detector: string; built: boolean; findingCount: number }[];
    expect(detectors.find((d) => d.detector === "silentCoupling")).toMatchObject({ built: true, findingCount: 0 });
  });

  // End-to-end exclusion wiring (bd tea-rags-mcp-89k7k.1.10): the diff-scoped
  // family must consume the production detector's verdict over the SAME
  // snapshot — historical src~test and CLAUDE.md~code pairs and unwalked pairs
  // are counted into the silentCoupling row's `excluded` block (the production
  // summary's vocabulary) and never reported; weak pairs below the strength
  // floor are not findings either. On the recorded agent diffs the review used
  // to answer 19–98 such pairs, burying the diff-relevant ones.
  it("reports only the production verdict's strong unlinked pairs on this diff, with production's excluded counters", async () => {
    writeFile("src/app/a.ts", "export const A = 1;\n");
    const pairEdges = [
      // (a) historical src~test pair
      cochangePair("src/app/a.ts", "tests/app/a.test.ts", 9),
      // (b) CLAUDE.md ~ code pair
      cochangePair("CLAUDE.md", "src/app/a.ts", 8),
      // (c) pair with no walked endpoint
      {
        ...cochangePair("config/settings.json", "config/settings.schema.json", 6),
        confidenceAB: 0.6,
        confidenceBA: 0.6,
      },
      // (d) the genuine strong src~src pair — wilson(9,10) ≈ 0.596 > 0.5 floor
      strongPair("src/app/a.ts", "src/other/c.ts"),
      // (e) src~src pair below the strength floor — wilson(4,8) ≈ 0.22
      { ...cochangePair("src/app/a.ts", "src/weak/e.ts", 4), confidenceAB: 0.5, confidenceBA: 0.5 },
    ];
    const graph = graphDbStub(
      {
        // The codegraph's walked files: tests, CLAUDE.md and the config pair
        // are not walked.
        files: [graphFile("src/app/a.ts"), graphFile("src/other/c.ts"), graphFile("src/weak/e.ts")],
        edges: [],
      },
      pairEdges,
    );

    const payload = (await architectureSectionProvider.run(
      runContext({
        graphDb: graph,
        scope: scopeOf(["src/app/a.ts", "config/settings.json"]),
        temporalCochange: { meta: { head: "h" }, edges: pairEdges },
      }),
    )) as Record<string, unknown>;

    const findings = payload.findings as { detector: string; subject: string }[];
    expect(findings.filter((f) => f.detector === "silentCoupling").map((f) => f.subject)).toEqual([
      "src/app/a.ts ~ src/other/c.ts",
    ]);
    const detectors = payload.detectors as { detector: string; excluded?: Record<string, number> }[];
    expect(detectors.find((d) => d.detector === "silentCoupling")?.excluded).toEqual({
      testEndpoints: 1,
      generatedEndpoints: 0,
      documentationEndpoints: 1,
      unwalkedEndpoints: 1,
      nonPositiveLift: 0,
    });
  });

  it("caps findings at 100 and counts the rest in truncated", async () => {
    const targets = Array.from({ length: 105 }, (_, i) => `src/lib/t${String(i).padStart(3, "0")}.ts`);
    for (const target of targets) writeFile(target, `export const T = 1;\n`);
    writeFile(
      "src/app/a.ts",
      `${targets.map((_, i) => `import { T${i} } from "../lib/t${String(i).padStart(3, "0")}";\n`).join("")}export const A = 1;\n`,
    );
    const lift = floorAfferents("src/app/a.ts");
    const graph = graphDbStub({
      files: [graphFile("src/app/a.ts"), ...targets.map((relPath) => graphFile(relPath)), ...lift.files],
      // One stale indexed edge: enough for lib I=1 / app I=0, and it closes the
      // a→t0 edge into a cycle. The dep files lift app to the SDP connection
      // floor so its main-sequence move stays judged (bd tea-rags-mcp-r8hme.45).
      edges: [graphEdge("src/lib/t000.ts", "src/app/a.ts"), ...lift.edges],
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

  // bd tea-rags-mcp-35v4v (live 2026-10-01): a 5-file probe diff produced 134
  // findings; the concatenated `slice(0, 100)` in family order let 117
  // silentCoupling findings push facadeContract (1) and splitCandidates (2)
  // ENTIRELY into `truncated` — the most diff-native families invisible while
  // their detector rows still counted them.
  it("over the findings cap every family with a finding keeps a slot — a silentCoupling flood never starves facadeContract", async () => {
    // The facadeContract fixture (a facade dropping a re-export consumers
    // import) beside a 110-partner silent-coupling flood: 111 findings > 100.
    writeFile("src/lib/x.ts", "export const a = 1;\nexport const b = 2;\n");
    writeFile("src/lib/y.ts", "export const z = 1;\n");
    writeFile("src/lib/index.ts", 'export { a } from "./x";\nexport { z } from "./y";\n');
    const partners = Array.from({ length: 110 }, (_, i) => `src/other/p${String(i).padStart(3, "0")}.ts`);
    const graph = graphDbStub(
      {
        files: [
          graphFile("src/lib/index.ts"),
          graphFile("src/lib/x.ts"),
          graphFile("src/lib/y.ts"),
          graphFile("src/app/c1.ts"),
          graphFile("src/app/c2.ts"),
          graphFile("src/app/c3.ts"),
        ],
        edges: [
          {
            sourceRelPath: "src/lib/index.ts",
            targetRelPath: "src/lib/x.ts",
            callWeight: 1,
            reexportedExportNames: ["a", "b"],
          },
          {
            sourceRelPath: "src/lib/index.ts",
            targetRelPath: "src/lib/y.ts",
            callWeight: 1,
            reexportedExportNames: ["z"],
          },
          namedGraphEdge("src/app/c1.ts", "src/lib/index.ts", ["a"]),
          namedGraphEdge("src/app/c2.ts", "src/lib/index.ts", ["a"]),
          namedGraphEdge("src/app/c3.ts", "src/lib/index.ts", ["a", "b"]),
        ],
      },
      partners.map((partner) => strongPair("src/lib/index.ts", partner)),
    );

    const payload = (await architectureSectionProvider.run(
      runContext({
        graphDb: graph,
        scope: scopeOf(["src/lib/index.ts"]),
        temporalCochange: { meta: { head: "h" }, edges: partners.map((p) => strongPair("src/lib/index.ts", p)) },
      }),
    )) as Record<string, unknown>;

    // THE live bug: the plain slice kept the first 100 findings in family
    // order and facadeContract landed wholly in `truncated`.
    const findings = payload.findings as { detector: string }[];
    expect(findings.some((finding) => finding.detector === "facadeContract")).toBe(true);

    // The family-aware policy's invariants, whatever the fixture's family mix.
    expect(findings).toHaveLength(100);
    const detectors = payload.detectors as { detector: string; findingCount: number; truncated?: number }[];
    const listedByDetector = new Map<string, number>();
    for (const finding of findings) {
      listedByDetector.set(finding.detector, (listedByDetector.get(finding.detector) ?? 0) + 1);
    }
    for (const status of detectors) {
      if (status.findingCount === 0) continue;
      expect(listedByDetector.get(status.detector) ?? 0, `${status.detector} starved under the cap`).toBeGreaterThan(0);
      expect((status.truncated ?? 0) + (listedByDetector.get(status.detector) ?? 0)).toBe(status.findingCount);
    }
    const totalFindings = detectors.reduce((sum, status) => sum + status.findingCount, 0);
    expect(payload.truncated).toBe(totalFindings - 100);
    // The flooding family's cut is counted on its own row, not hidden in the total.
    expect(detectors.find((status) => status.detector === "silentCoupling")?.truncated).toBeGreaterThan(0);
  });

  // bd tea-rags-mcp-89k7k.1.9: the change closes a -> b -> x -> a, but the
  // only file carrying the closing edge x -> a fell past the reader's file
  // cap — the overlay never sees it, so `cycles` would read as a clean zero.
  it("a scope over the file cap marks every built detector partial — a cycle closing through a skipped file is never a clean pass", async () => {
    writeFile("src/app/a.ts", 'import { B } from "../lib/b";\nexport const A = 1;\n');
    // Skipped past the cap in a real read; here the scope says so directly.
    writeFile("src/skip/x.ts", 'import { A } from "../app/a";\nexport const X = A;\n');
    const graph = graphDbStub({
      files: [graphFile("src/app/a.ts"), graphFile("src/lib/b.ts"), graphFile("src/skip/x.ts")],
      // The indexed b -> x hop: in the TREE the change closes a -> b -> x -> a
      // through x's new edge, which the truncated scope never reads.
      edges: [graphEdge("src/lib/b.ts", "src/skip/x.ts")],
    });

    const payload = (await architectureSectionProvider.run(
      runContext({ graphDb: graph, scope: scopeOf(["src/app/a.ts"], 1) }),
    )) as Record<string, unknown>;

    const detectors = payload.detectors as {
      detector: string;
      built: boolean;
      findingCount: number;
      scopeSkippedFiles?: number;
    }[];
    const cycles = detectors.find((status) => status.detector === "cycles");
    // An honest zero over unseen files — carried as PARTIAL with the skipped
    // count, never as a clean pass.
    expect(cycles).toMatchObject({ built: true, findingCount: 0, scopeSkippedFiles: 1 });
    for (const status of detectors) {
      if (!status.built) continue;
      expect(status.scopeSkippedFiles, `${status.detector} claimed a clean pass over a truncated diff`).toBe(1);
    }
  });

  it("an untruncated scope claims no partial marker — zeros are then clean passes", async () => {
    writeFile("src/app/a.ts", "export const A = 1;\n");
    const graph = graphDbStub({ files: [graphFile("src/app/a.ts")], edges: [] });

    const payload = (await architectureSectionProvider.run(
      runContext({ graphDb: graph, scope: scopeOf(["src/app/a.ts"]) }),
    )) as Record<string, unknown>;

    const detectors = payload.detectors as { scopeSkippedFiles?: number }[];
    expect(detectors.every((status) => status.scopeSkippedFiles === undefined)).toBe(true);
  });
});

describe("architectureSectionProvider.run — facadeContract wiring", () => {
  it("emits a facadeContract finding end-to-end: the diff drops a re-export indexed consumers still import", async () => {
    // The tree's facade keeps `a` and `z` but no longer re-exports `b`.
    writeFile("src/lib/x.ts", "export const a = 1;\nexport const b = 2;\n");
    writeFile("src/lib/y.ts", "export const z = 1;\n");
    writeFile("src/lib/index.ts", 'export { a } from "./x";\nexport { z } from "./y";\n');
    // The indexed side keeps the module MEASURED (three external importers, all
    // through the facade — adoption 1), and one of them still imports `b`. The
    // indexed facade still re-exports `a`, `b` and `z`: its pre-diff surface.
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
        {
          sourceRelPath: "src/lib/index.ts",
          targetRelPath: "src/lib/x.ts",
          callWeight: 1,
          reexportedExportNames: ["a", "b"],
        },
        {
          sourceRelPath: "src/lib/index.ts",
          targetRelPath: "src/lib/y.ts",
          callWeight: 1,
          reexportedExportNames: ["z"],
        },
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

describe("buildSilentCouplingFacts", () => {
  it("hands the run the production verdict: violations mapped to the port shape, excluded counters verbatim", () => {
    const snapshot = {
      meta: { head: "h" },
      edges: [strongPair("src/a.ts", "src/b.ts"), cochangePair("CLAUDE.md", "src/c.ts", 8)],
    };
    const files = [graphFile("src/a.ts"), graphFile("src/b.ts"), graphFile("src/c.ts")];
    const facts = buildSilentCouplingFacts(snapshot, files, []);
    // CLAUDE.md ~ src/c.ts is a documentation-endpoint pair — excluded by the
    // production taxonomy, never a violation; the strong src~src pair passes.
    expect(facts.violations).toEqual([
      { relPathA: "src/a.ts", relPathB: "src/b.ts", support: 9, strength: 0.5958436145024278 },
    ]);
    expect(facts.excluded).toMatchObject({ documentationEndpoints: 1 });
  });

  it("an absent or never-built snapshot degrades to the empty verdict — silence, not a zero", () => {
    const absent = buildSilentCouplingFacts(undefined, [], []);
    expect(absent.violations).toEqual([]);
    expect(absent.excluded).toEqual({
      testEndpoints: 0,
      generatedEndpoints: 0,
      documentationEndpoints: 0,
      unwalkedEndpoints: 0,
      nonPositiveLift: 0,
    });
  });
});
