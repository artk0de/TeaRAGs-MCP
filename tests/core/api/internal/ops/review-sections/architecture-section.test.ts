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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiffScopeRead } from "../../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import type { ReviewEdgeExtractionDeps } from "../../../../../../src/core/api/internal/ops/review-edge-overlay.js";
import {
  architectureSectionProvider,
  buildSilentCouplingFacts,
  WiredGraphReader,
} from "../../../../../../src/core/api/internal/ops/review-sections/architecture-section.js";
import type {
  ReviewGraphDb,
  ReviewSectionContext,
} from "../../../../../../src/core/api/internal/ops/review-sections/review-section-provider.js";
import type {
  FileDependencyEdge,
  FileDependencyGraph,
  FileDependencyGraphFile,
  RelPath,
  TemporalCochangeBuildMeta,
  TemporalCochangeGraph,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../../../src/core/domains/language/index.js";

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

/**
 * A vitest mock whose signature IS the port method's — when `ReviewGraphDb`
 * gains or changes a member, the stub stops compiling here instead of
 * drifting from the port silently (the blind spot bd tea-rags-mcp-89k7k.11
 * closes; this file held exactly such a drift).
 */
type PortMock<K extends keyof ReviewGraphDb> = ReturnType<typeof vi.fn<NonNullable<ReviewGraphDb[K]>>>;

interface GraphDbStub {
  readFileDependencyGraph: PortMock<"readFileDependencyGraph">;
  readTemporalCochangeGraph: PortMock<"readTemporalCochangeGraph">;
  readTemporalSymbolCommits: PortMock<"readTemporalSymbolCommits">;
  readNonPublicMemberEdges: PortMock<"readNonPublicMemberEdges">;
  readTypeNameRows: PortMock<"readTypeNameRows">;
  close: ReturnType<typeof vi.fn>;
}

/** Full build provenance — the fields a real `cg_temporal_meta` row carries. */
function cochangeMeta(head = "h"): TemporalCochangeBuildMeta {
  return {
    head,
    fingerprint: "fixture-fingerprint",
    builtAt: 1_760_000_000,
    windowSince: 1_750_000_000,
    commitCount: 120,
    bundleCount: 110,
    admittedBundleCount: 100,
    maxFilesPerBundle: 30,
    minSupport: 3,
    maxPartnersPerFile: 10,
    admittedBurstCount: 90,
    burstWindowMinutes: 120,
    burstWindowMethod: "fallback",
  };
}

function graphDbStub(graph: FileDependencyGraph, cochangeEdges: TemporalCochangeGraph["edges"] = []): GraphDbStub {
  return {
    readFileDependencyGraph: vi.fn(async () => graph),
    readTemporalCochangeGraph: vi.fn(async () => ({ meta: cochangeMeta(), edges: cochangeEdges })),
    readTemporalSymbolCommits: vi.fn(async () => ({ relPath: "", symbols: [] })),
    readNonPublicMemberEdges: vi.fn(async () => []),
    readTypeNameRows: vi.fn(async () => []),
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
    touchedFiles: new Set(files),
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

/**
 * The subjects the change block collapsed for one key family — where a
 * finding both runs hold lands (bd tea-rags-mcp-89k7k.1.7). Git-driven pairs
 * land here by construction: an edge overlay cannot move them.
 */
function persistingSubjects(payload: unknown, family: string): string[] {
  const { change } = payload as { change: { persisting: { family: string; subject: string }[] } };
  return change.persisting.filter((entry) => entry.family === family).map((entry) => entry.subject);
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
        temporalCochange: { meta: cochangeMeta(), edges: [strongPair("src/app/a.ts", "src/other/c.ts")] },
      }),
    )) as Record<string, unknown>;

    // The run judged the overlay edge against the indexed graph and the facts:
    // stableDependencies (indexed lib I=1 markedly above app I=0), cycles (the
    // indexed b→a closes a→b), mainSequence (app's I moves 0→1), silentCoupling
    // (co-change partner outside the diff, no structural edge either way). The
    // pair reads git history an edge overlay cannot move, so both runs hold it
    // and it collapses into the change block (bd tea-rags-mcp-89k7k.1.7).
    const findings = payload.findings as { detector: string; subject: string }[];
    const subjects = (detector: string) => findings.filter((f) => f.detector === detector).map((f) => f.subject);
    expect(subjects("stableDependencies")).toEqual(["src/app/a.ts -> src/lib/b.ts"]);
    expect(subjects("cycles")).toEqual(["src/app/a.ts -> src/lib/b.ts"]);
    expect(subjects("mainSequence")).toEqual(["src/app"]);
    expect(persistingSubjects(payload, "silentCoupling.pair")).toEqual(["src/app/a.ts ~ src/other/c.ts"]);

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
      "layeringBackEdge",
      "hubLike",
    ]);
    expect(detectors.find((d) => d.detector === "facadeContract")).toMatchObject({ built: true, findingCount: 0 });
    // The hub-like reading is wired over the same partition (bd tea-rags-mcp-89k7k.1.19.4).
    expect(detectors.find((d) => d.detector === "hubLike")).toMatchObject({ built: true });
    // The section always wires the layering reading over the report's own
    // component partition (bd tea-rags-mcp-89k7k.1.19.3).
    expect(detectors.find((d) => d.detector === "layeringBackEdge")).toMatchObject({ built: true });
    expect(detectors.find((d) => d.detector === "splitCandidates")).toMatchObject({
      built: false,
      reason: "noBundleMembership",
      findingCount: 0,
    });
    expect(payload.truncated).toBeUndefined();
  });

  it("passes the declared test dependencies into the production-graph read — manifest-only evidence drops the support file from the findings (bd tea-rags-mcp-89k7k.35.3)", async () => {
    writeFile("src/lib/b.ts", "export const B = 1;\n");
    writeFile("src/app/a.ts", 'import { B } from "../lib/b";\nexport const A = B;\n');
    const graphOf = () =>
      graphDbStub({
        files: [
          graphFile("src/app/a.ts"),
          graphFile("src/lib/b.ts"),
          graphFile("src/other/c.ts"),
          graphFile("src/other/main.ts"),
        ],
        // The stale indexed edge the diff replaces: pre-diff, b imported a.
        edges: [graphEdge("src/lib/b.ts", "src/app/a.ts"), graphEdge("src/other/main.ts", "src/other/c.ts")],
      });
    // msw is imported by an imported production file (c.ts), so the data rule alone never makes it
    // test-only; only the manifest's devDependencies declaration does.
    const readIndexedFileImports = async () =>
      new Map([
        ["src/lib/b.test.ts", { isTest: true, specifiers: ["./b", "msw"] }],
        ["src/lib/b.ts", { isTest: false, specifiers: ["msw"] }],
        ["src/other/c.ts", { isTest: false, specifiers: ["msw"] }],
      ]);
    const cycleSubjects = async (readDeclaredTestDependencies?: () => ReadonlySet<string>) => {
      const payload = (await architectureSectionProvider.run(
        runContext({
          graphDb: graphOf(),
          scope: scopeOf(["src/app/a.ts"]),
          readIndexedFileImports,
          readDeclaredTestDependencies,
        }),
      )) as { findings: { detector: string; subject: string }[] };
      return payload.findings.filter((f) => f.detector === "cycles").map((f) => f.subject);
    };
    const readDeclaredTestDependencies = vi.fn(() => new Set(["msw"]));

    expect(await cycleSubjects()).toEqual(["src/app/a.ts -> src/lib/b.ts"]);
    expect(await cycleSubjects(readDeclaredTestDependencies)).toEqual([]);
    expect(readDeclaredTestDependencies).toHaveBeenCalledTimes(1);
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
        temporalCochange: { meta: cochangeMeta(), edges: [cochangePair("src/dto.ts", "src/ops.ts", 24, true)] },
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
        temporalCochange: { meta: cochangeMeta(), edges: pairEdges },
      }),
    )) as Record<string, unknown>;

    expect(persistingSubjects(payload, "silentCoupling.pair")).toEqual(["src/app/a.ts ~ src/other/c.ts"]);
    const detectors = payload.detectors as { detector: string; excluded?: Record<string, number> }[];
    expect(detectors.find((d) => d.detector === "silentCoupling")?.excluded).toEqual({
      testEndpoints: 1,
      generatedEndpoints: 0,
      documentationEndpoints: 1,
      versionManifestEndpoints: 0,
      unwalkedEndpoints: 1,
      notSignificant: 0,
      explainedByFacadeChain: 0,
    });
  });

  // A version manifest bumped alongside whatever shipped in the release
  // (bd tea-rags-mcp-s2nes) — live, `.claude-plugin/**/plugin.json` was reported
  // as the silent partner of the barrels a diff touched.
  it("counts a version-manifest partner of a changed file under excluded, never as a finding", async () => {
    writeFile("src/app/a.ts", "export const A = 1;\n");
    const pairEdges = [
      strongPair("src/app/a.ts", ".claude-plugin/tea-rags/.claude-plugin/plugin.json"),
      strongPair("package.json", "src/app/a.ts"),
      strongPair("src/app/a.ts", "src/other/c.ts"),
    ];
    const graph = graphDbStub(
      { files: [graphFile("src/app/a.ts"), graphFile("src/other/c.ts")], edges: [] },
      pairEdges,
    );

    const payload = (await architectureSectionProvider.run(
      runContext({
        graphDb: graph,
        scope: scopeOf(["src/app/a.ts"]),
        temporalCochange: { meta: cochangeMeta(), edges: pairEdges },
      }),
    )) as Record<string, unknown>;

    expect(persistingSubjects(payload, "silentCoupling.pair")).toEqual(["src/app/a.ts ~ src/other/c.ts"]);
    const detectors = payload.detectors as { detector: string; excluded?: Record<string, number> }[];
    expect(detectors.find((d) => d.detector === "silentCoupling")?.excluded?.versionManifestEndpoints).toBe(2);
  });

  it("ranks each family's findings by maintenance cost and tags them — the whole-repo report's ranking (bd tea-rags-mcp-r8hme.20)", async () => {
    // Two cycles the diff closes (each changed file's new import meets a stale
    // indexed edge back): introduced findings, so they survive the collapse
    // of persisting ones (bd tea-rags-mcp-89k7k.1.7) and reach the ranking.
    writeFile("src/other/c.ts", "export const C = 1;\n");
    writeFile("src/hot/y.ts", "export const Y = 1;\n");
    writeFile("src/app/a.ts", 'import { C } from "../other/c";\nexport const A = C;\n');
    writeFile("src/hot/x.ts", 'import { Y } from "./y";\nexport const X = Y;\n');
    const files = ["src/app/a.ts", "src/other/c.ts", "src/hot/x.ts", "src/hot/y.ts"];
    const indexedBackEdges = [graphEdge("src/other/c.ts", "src/app/a.ts"), graphEdge("src/hot/y.ts", "src/hot/x.ts")];
    const context = (readFileMaintenanceSignals?: ReviewSectionContext["readFileMaintenanceSignals"]) =>
      runContext({
        graphDb: graphDbStub({ files: files.map(graphFile), edges: indexedBackEdges }),
        scope: scopeOf(["src/app/a.ts", "src/hot/x.ts"]),
        ...(readFileMaintenanceSignals ? { readFileMaintenanceSignals } : {}),
      });
    const cyclesOf = (payload: unknown) =>
      (
        payload as { findings: { detector: string; subject: string; maintenanceCost?: { score: number } }[] }
      ).findings.filter((f) => f.detector === "cycles");

    const plain = cyclesOf(await architectureSectionProvider.run(context()));
    expect(plain.map((f) => f.subject)).toEqual(["src/app/a.ts -> src/other/c.ts", "src/hot/x.ts -> src/hot/y.ts"]);
    expect(plain.some((f) => f.maintenanceCost !== undefined)).toBe(false);

    const read = vi.fn(
      async () =>
        new Map(
          files.map((relPath) => [
            relPath,
            relPath.startsWith("src/hot/")
              ? { commitCount: 30, bugFixRate: 40, ageDays: 1 }
              : { commitCount: 1, bugFixRate: 0, ageDays: 300 },
          ]),
        ),
    );
    const ranked = cyclesOf(await architectureSectionProvider.run(context(read)));

    expect(ranked.map((f) => f.subject)).toEqual(["src/hot/x.ts -> src/hot/y.ts", "src/app/a.ts -> src/other/c.ts"]);
    // The score is the carriers' mean cost position shrunk toward 0.5 by the
    // spread of THIS review's findings around 0.5 (bd tea-rags-mcp-afyku): means
    // 5/6 and 1/6 over 2 carriers each → σ²_prior = 1/9 − 1/24 = 5/72, n₀ = 6/5,
    // so the hot pair reads 0.5 + (1/3) · 2 / (2 + 6/5).
    expect(ranked[0].maintenanceCost).toMatchObject({
      score: 0.708,
      meanPosition: 0.833,
      measuredFileCount: 2,
      hottestFile: { relPath: "src/hot/x.ts" },
    });
    expect(ranked[1].maintenanceCost).toMatchObject({ score: 0.292 });
    expect(read).toHaveBeenCalledTimes(1);
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
    // 105 markedly-less-stable edges + one closed cycle + app's main-sequence
    // move + the same 105 edges running up the layering (the stale t000 -> app
    // edge puts app at L0 under lib, bd tea-rags-mcp-89k7k.1.19.3).
    expect(byName.get("stableDependencies")).toBe(105);
    expect(byName.get("cycles")).toBe(1);
    expect(byName.get("mainSequence")).toBe(1);
    expect(byName.get("layeringBackEdge")).toBe(105);
    expect(payload.findings as unknown[]).toHaveLength(100);
    expect(payload.truncated).toBe(112);
  });

  it("an empty diff is a valid review: built, no findings", async () => {
    const graph = graphDbStub({ files: [graphFile("src/app/a.ts")], edges: [] });

    const payload = (await architectureSectionProvider.run(
      runContext({ graphDb: graph, scope: scopeOf([]) }),
    )) as Record<string, unknown>;

    expect(payload.findings).toEqual([]);
    expect((payload.detectors as { findingCount: number }[]).every((d) => d.findingCount === 0)).toBe(true);
  });

  // bd tea-rags-mcp-35v4v (live 2026-10-01): a 5-file probe diff produced 134
  // findings; the concatenated `slice(0, 100)` in family order let 117
  // silentCoupling findings push facadeContract (1) and splitCandidates (2)
  // ENTIRELY into `truncated` — the most diff-native families invisible while
  // their detector rows still counted them. Silent coupling now collapses into
  // the change block (git history an edge overlay cannot move, bd
  // tea-rags-mcp-89k7k.1.7), so the flood here is an introduced family.
  it("over the findings cap every family with a finding keeps a slot — a stableDependencies flood never starves facadeContract", async () => {
    // The facadeContract fixture (a facade dropping a re-export consumers
    // import) beside the cap fixture's flood: one changed file importing 110
    // targets, a stale indexed edge back lifting the targets' instability —
    // 110 introduced stableDependencies edges (and their layering back-edges).
    writeFile("src/lib/x.ts", "export const a = 1;\nexport const b = 2;\n");
    writeFile("src/lib/y.ts", "export const z = 1;\n");
    writeFile("src/lib/index.ts", 'export { a } from "./x";\nexport { z } from "./y";\n');
    const pad = (i: number) => String(i).padStart(3, "0");
    const flood = Array.from({ length: 110 }, (_, i) => `src/flood/t${pad(i)}.ts`);
    for (const relPath of flood) writeFile(relPath, "export const T = 1;\n");
    writeFile(
      "src/sink/a.ts",
      `${flood.map((_, i) => `import { T${i} } from "../flood/t${pad(i)}";\n`).join("")}export const A = 1;\n`,
    );
    const lift = floorAfferents("src/sink/a.ts");
    const graph = graphDbStub({
      files: [
        graphFile("src/sink/a.ts"),
        ...flood.map((relPath) => graphFile(relPath)),
        ...lift.files,
        graphFile("src/lib/index.ts"),
        graphFile("src/lib/x.ts"),
        graphFile("src/lib/y.ts"),
        graphFile("src/app/c1.ts"),
        graphFile("src/app/c2.ts"),
        graphFile("src/app/c3.ts"),
      ],
      edges: [
        graphEdge("src/flood/t000.ts", "src/sink/a.ts"),
        ...lift.edges,
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
      runContext({ graphDb: graph, scope: scopeOf(["src/lib/index.ts", "src/sink/a.ts"]) }),
    )) as Record<string, unknown>;

    // THE live bug: the plain slice kept the first 100 findings in family
    // order and facadeContract landed wholly in `truncated`.
    const findings = payload.findings as { detector: string }[];
    expect(findings.some((finding) => finding.detector === "facadeContract")).toBe(true);

    // The family-aware policy's invariants, whatever the fixture's family mix:
    // a row's findings are listed, truncated, or collapsed as persisting.
    expect(findings).toHaveLength(100);
    const detectors = (
      payload.detectors as {
        detector: string;
        findingCount: number;
        groupedFindingCount?: number;
        truncated?: number;
        persistingCount?: number;
      }[]
    ).map((status) => ({ ...status, findingCount: status.groupedFindingCount ?? status.findingCount }));
    const listedByDetector = new Map<string, number>();
    for (const finding of findings) {
      listedByDetector.set(finding.detector, (listedByDetector.get(finding.detector) ?? 0) + 1);
    }
    for (const status of detectors) {
      const listable = status.findingCount - (status.persistingCount ?? 0);
      if (listable === 0) continue;
      expect(listedByDetector.get(status.detector) ?? 0, `${status.detector} starved under the cap`).toBeGreaterThan(0);
      expect((status.truncated ?? 0) + (listedByDetector.get(status.detector) ?? 0)).toBe(listable);
    }
    const totalListable = detectors.reduce(
      (sum, status) => sum + status.findingCount - (status.persistingCount ?? 0),
      0,
    );
    expect(payload.truncated).toBe(totalListable - 100);
    // The flooding family's cut is counted on its own row, not hidden in the total.
    expect(detectors.find((status) => status.detector === "stableDependencies")?.truncated).toBeGreaterThan(0);
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

/** Runs git in the temp tree with a fixed identity — the fixture never reads the user's config. */
function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args], {
    cwd: workTree!,
    encoding: "utf8",
  }).trim();
}

/** Commits everything in the temp repository; returns the commit sha. */
function commitAll(message: string): string {
  git("add", "-A");
  git("commit", "-q", "--no-verify", "-m", message);
  return git("rev-parse", "HEAD");
}

// bd tea-rags-mcp-89k7k.1.16: "added by the diff" is judged against the
// merge-base the scope names, read from its blobs — never against wherever
// the index sits. The stubbed index below has ALREADY caught up to the tree.
describe("architectureSectionProvider.run — diff base wiring", () => {
  const indexedCycle = (): GraphDbStub =>
    graphDbStub({
      files: [graphFile("src/app/a.ts"), graphFile("src/lib/b.ts")],
      edges: [graphEdge("src/app/a.ts", "src/lib/b.ts"), graphEdge("src/lib/b.ts", "src/app/a.ts")],
    });

  function scopeAt(mergeBase: string): DiffScopeRead {
    return { ...scopeOf(["src/app/a.ts"]), mergeBase };
  }

  function cycleFindings(payload: unknown): { subject: string; preExisting?: true; detail: string }[] {
    return (
      payload as { findings: { detector: string; subject: string; preExisting?: true; detail: string }[] }
    ).findings.filter((finding) => finding.detector === "cycles");
  }

  beforeEach(() => {
    execFileSync("git", ["init", "-q"], { cwd: workTree! });
  });

  it("an index that caught up to the diff still reports the cycle the diff closed as new", async () => {
    writeFile("src/app/a.ts", "export const A = 1;\n");
    writeFile("src/lib/b.ts", 'import { A } from "../app/a";\nexport const B = A;\n');
    const base = commitAll("base");
    writeFile("src/app/a.ts", 'import { B } from "../lib/b";\nexport const A = 1;\nexport const C = B;\n');

    const payload = await architectureSectionProvider.run(
      runContext({ graphDb: indexedCycle(), scope: scopeAt(base) }),
    );

    const [finding, ...rest] = cycleFindings(payload);
    expect(rest).toEqual([]);
    expect(finding?.subject).toBe("src/app/a.ts -> src/lib/b.ts");
    expect(finding !== undefined && "preExisting" in finding).toBe(false);
  });

  it("an edge the merge-base already held stays preExisting, worded against the diff base", async () => {
    writeFile("src/app/a.ts", 'import { B } from "../lib/b";\nexport const A = 1;\n');
    writeFile("src/lib/b.ts", 'import { A } from "../app/a";\nexport const B = A;\n');
    const base = commitAll("base");
    writeFile("src/app/a.ts", 'import { B } from "../lib/b";\nexport const A = 2;\n');

    const payload = await architectureSectionProvider.run(
      runContext({
        graphDb: graphDbStub({
          files: [graphFile("src/lib/b.ts")],
          edges: [graphEdge("src/lib/b.ts", "src/app/a.ts")],
        }),
        scope: scopeAt(base),
      }),
    );

    // Held at the merge-base but absent from the index: only a diff-base read
    // stamps it preExisting, and a preExisting cycle without a remedy collapses
    // into the change block (bd tea-rags-mcp-89k7k.1.7) — read as added, it
    // would stay listed.
    expect(cycleFindings(payload)).toEqual([]);
    expect(persistingSubjects(payload, "cycles")).toEqual(["src/app/a.ts -> src/lib/b.ts"]);
  });

  it("a merge-base the repository cannot resolve falls back to the index — never reads every edge as added", async () => {
    writeFile("src/app/a.ts", 'import { B } from "../lib/b";\nexport const A = 1;\n');
    writeFile("src/lib/b.ts", 'import { A } from "../app/a";\nexport const B = A;\n');
    commitAll("base");

    const payload = await architectureSectionProvider.run(
      runContext({ graphDb: indexedCycle(), scope: scopeAt("0000000000000000000000000000000000000000") }),
    );

    // The index holds both edges: the fallback stamps the cycle preExisting and
    // it collapses; reading every edge as added would have listed it.
    expect(cycleFindings(payload)).toEqual([]);
    expect(persistingSubjects(payload, "cycles")).toEqual(["src/app/a.ts -> src/lib/b.ts"]);
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

    const findings = payload.findings as { detector: string; subject: string; evidence: unknown }[];
    expect(findings.filter((f) => f.detector === "facadeContract")).toEqual([
      {
        detector: "facadeContract",
        subject: "src/lib/index.ts",
        endpoints: { kind: "file", relPath: "src/lib/index.ts", component: "src/lib" },
        evidence: { droppedNames: [{ name: "b", consumers: ["src/app/c3.ts"] }] },
        detail: expect.stringContaining("stops re-exporting"),
        // The dry-run put `b` back on the surface and the break was gone (bd tea-rags-mcp-89k7k.1.19.6).
        remedy: { kind: "restoreExport", facadeRelPath: "src/lib/index.ts", names: ["b"] },
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

// bd tea-rags-mcp-89k7k.1.19.6: findings carry the dry-run-verified remedy.
describe("architectureSectionProvider.run — remedy wiring", () => {
  const SOURCE = "src/app/a.ts";
  const FACADE = "src/lib/index.ts";
  const INTERNAL = "src/lib/x.ts";

  /**
   * A measured `src/lib` module (three external importers, all through the
   * facade) and a source that already imports the facade; the tree adds a
   * deep import of `b` straight from the internal file. `named` = whether the
   * indexed edges recorded their export names (the export table).
   */
  function facadeBypassFixture(named: boolean): GraphDbStub {
    writeFile(INTERNAL, "export const a = 1;\nexport const b = 2;\n");
    writeFile("src/lib/y.ts", "export const z = 1;\n");
    writeFile(FACADE, 'export { a, b } from "./x";\nexport { z } from "./y";\n');
    writeFile(SOURCE, 'import { a } from "../lib/index";\nimport { b } from "../lib/x";\nexport const A = a + b;\n');
    const names = (imported: string[], reexported?: string[]) =>
      named ? { importedExportNames: imported, ...(reexported ? { reexportedExportNames: reexported } : {}) } : {};
    const edgeOf = (source: RelPath, target: RelPath, imported: string[], reexported?: string[]) => ({
      sourceRelPath: source,
      targetRelPath: target,
      callWeight: 1,
      ...names(imported, reexported),
    });
    return graphDbStub({
      files: [FACADE, INTERNAL, "src/lib/y.ts", SOURCE, "src/app/c1.ts", "src/app/c2.ts", "src/app/c3.ts"].map(
        graphFile,
      ),
      edges: [
        edgeOf(FACADE, INTERNAL, [], ["a", "b"]),
        edgeOf(FACADE, "src/lib/y.ts", [], ["z"]),
        edgeOf("src/app/c1.ts", FACADE, ["a"]),
        edgeOf("src/app/c2.ts", FACADE, ["a"]),
        edgeOf("src/app/c3.ts", FACADE, ["a", "b"]),
        edgeOf(SOURCE, FACADE, ["a"]),
      ],
    });
  }

  const leakOf = async (graphDb: GraphDbStub) => {
    const payload = (await architectureSectionProvider.run(runContext({ graphDb, scope: scopeOf([SOURCE]) }))) as {
      findings: { detector: string; remedy?: unknown }[];
    };
    const leaks = payload.findings.filter((finding) => finding.detector === "leakingAbstraction");
    expect(leaks).toHaveLength(1);
    return leaks[0];
  };

  it("a facade-bypassing import carries the verified retarget to the facade", async () => {
    const leak = await leakOf(facadeBypassFixture(true));

    expect(leak.remedy).toEqual({
      kind: "retargetImport",
      sourceRelPath: SOURCE,
      fromRelPath: INTERNAL,
      toRelPath: FACADE,
      importedNames: ["b"],
    });
  });

  it("a name only the diff declares still resolves its declarer (bd tea-rags-mcp-if14t)", async () => {
    const graphDb = facadeBypassFixture(true);
    // `fresh` is new in the tree: no indexed edge names it, only the changed source's own import does.
    writeFile(INTERNAL, "export const a = 1;\nexport const b = 2;\nexport const fresh = 3;\n");
    writeFile(
      SOURCE,
      'import { a } from "../lib/index";\nimport { fresh } from "../lib/x";\nexport const A = a + fresh;\n',
    );

    const leak = await leakOf(graphDb);

    expect(leak.remedy).toEqual({
      kind: "retargetImport",
      sourceRelPath: SOURCE,
      fromRelPath: INTERNAL,
      toRelPath: FACADE,
      importedNames: ["fresh"],
      addExport: { facadeRelPath: FACADE, names: ["fresh"] },
    });
  });

  it("no export table for the names — the finding goes out without a remedy", async () => {
    const leak = await leakOf(facadeBypassFixture(false));

    expect(leak).not.toHaveProperty("remedy");
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
      meta: cochangeMeta(),
      edges: [
        temporalPair("src/wide/x1.ts", "src/wide/x2.ts", 16, 16, 18),
        temporalPair("src/wide/y1.ts", "src/wide/y2.ts", 20, 22, 20),
        temporalPair("src/wide/x2.ts", "src/wide/y1.ts", 2, 18, 22),
      ],
      bundles,
    };
  }

  it("computes the phase-1 verdicts over the snapshot and reports the diff working across the seam", async () => {
    for (const relPath of ["src/wide/x2.ts", "src/wide/y1.ts", "src/wide/y2.ts"]) {
      writeFile(relPath, "export const W = 1;\n");
    }
    // The diff adds an x1 -> y1 edge across the seam (bd tea-rags-mcp-s2nes).
    writeFile("src/wide/x1.ts", 'import { W as Y } from "./y1";\nexport const W = Y;\n');
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

    const findings = payload.findings as { detector: string; subject: string; evidence: unknown }[];
    expect(findings.find((f) => f.detector === "splitCandidates")).toEqual({
      detector: "splitCandidates",
      subject: "src/wide",
      endpoints: { kind: "component", component: "src/wide" },
      evidence: {
        clusterCount: 2,
        touchedClusters: [
          { cluster: 1, fileCount: 2, changedFileCount: 1, changedFiles: ["src/wide/y1.ts"] },
          { cluster: 2, fileCount: 2, changedFileCount: 1, changedFiles: ["src/wide/x1.ts"] },
        ],
      },
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
        temporalCochange: { meta: cochangeMeta(), edges: [], bundles: new Map() },
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

  // bd tea-rags-mcp-2wsnt: a diff touching the stylesheet itself — the walked
  // partner sits outside the diff, so the rescue's read is the section's
  // context lookup, and a pair the report would rescue must not become a
  // finding here.
  it("does not report a diff-touching one-walked pair the recorded asset import links", async () => {
    writeFile("app/s1.module.css", ".s1 { color: red; }\n");
    const graph = graphDbStub({ files: [graphFile("app/s1.ts")], edges: [] });
    const readImportSpecifiers = vi.fn().mockResolvedValue(new Map([["app/s1.ts", ["./s1.module.css"]]]));

    const payload = (await architectureSectionProvider.run(
      runContext({
        graphDb: graph,
        scope: scopeOf(["app/s1.module.css"]),
        temporalCochange: { meta: cochangeMeta(), edges: [strongPair("app/s1.module.css", "app/s1.ts")] },
        readImportSpecifiers,
      }),
    )) as Record<string, unknown>;

    expect(readImportSpecifiers).toHaveBeenCalledTimes(1);
    expect(readImportSpecifiers.mock.calls[0][0]).toEqual(["app/s1.ts"]);
    const findings = payload.findings as { detector: string; subject: string }[];
    expect(findings.filter((f) => f.detector === "silentCoupling")).toEqual([]);
    const silent = (payload.detectors as { detector: string; built: boolean; findingCount: number }[]).find(
      (d) => d.detector === "silentCoupling",
    );
    expect(silent).toMatchObject({ built: true, findingCount: 0 });
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
  it("hands the run the production verdict: violations mapped to the port shape, excluded counters verbatim", async () => {
    const snapshot = {
      meta: cochangeMeta(),
      edges: [strongPair("src/a.ts", "src/b.ts"), cochangePair("CLAUDE.md", "src/c.ts", 8)],
    };
    const files = [graphFile("src/a.ts"), graphFile("src/b.ts"), graphFile("src/c.ts")];
    const facts = await buildSilentCouplingFacts(snapshot, files, [], []);
    // CLAUDE.md ~ src/c.ts is a documentation-endpoint pair — excluded by the
    // production taxonomy, never a violation; the strong src~src pair passes.
    expect(facts.violations).toEqual([
      { relPathA: "src/a.ts", relPathB: "src/b.ts", support: 9, strength: 0.5958436145024278 },
    ]);
    expect(facts.excluded).toMatchObject({ documentationEndpoints: 1 });
  });

  it("an absent or never-built snapshot degrades to the empty verdict — silence, not a zero", async () => {
    const absent = await buildSilentCouplingFacts(undefined, [], [], []);
    expect(absent.violations).toEqual([]);
    expect(absent.excluded).toEqual({
      testEndpoints: 0,
      generatedEndpoints: 0,
      documentationEndpoints: 0,
      versionManifestEndpoints: 0,
      unwalkedEndpoints: 0,
      notSignificant: 0,
      explainedByFacadeChain: 0,
    });
  });

  // bd tea-rags-mcp-2wsnt — the report's rbnkp rescue, diff-scoped: the
  // stylesheet is no codegraph file node, so the strong pair is one-walked;
  // the walked endpoint's recorded specifiers import it, so the report's
  // second pass links the pair and the review's facts must drop it the same
  // way — not report a finding the whole-repo report would have rescued.
  it("rescues a diff-touching one-walked pair the walked endpoint's recorded asset import links", async () => {
    const snapshot = { meta: cochangeMeta(), edges: [strongPair("app/s1.module.css", "app/s1.ts")] };
    const files = [graphFile("app/s1.ts")]; // walked census: an asset is no file node
    const readImportSpecifiers = vi.fn().mockResolvedValue(new Map([["app/s1.ts", ["./s1.module.css"]]]));

    const facts = await buildSilentCouplingFacts(
      snapshot,
      files,
      [],
      ["app/s1.module.css"], // the diff touches the stylesheet, not the importer
      readImportSpecifiers,
    );

    // The read is the report's shape: the walked endpoints of the diff-scoped
    // one-walked violations, and nothing else.
    expect(readImportSpecifiers).toHaveBeenCalledTimes(1);
    expect(readImportSpecifiers.mock.calls[0][0]).toEqual(["app/s1.ts"]);
    expect(facts.violations).toEqual([]);
  });

  it("reads specifiers only for the diff-touching one-walked pairs — a pair off the diff costs no read", async () => {
    const snapshot = {
      meta: cochangeMeta(),
      edges: [strongPair("app/s1.module.css", "app/s1.ts"), strongPair("web/t2.module.css", "web/t2.ts")],
    };
    const files = [graphFile("app/s1.ts"), graphFile("web/t2.ts")];
    const readImportSpecifiers = vi.fn().mockResolvedValue(new Map([["web/t2.ts", ["./t2.module.css"]]]));

    const facts = await buildSilentCouplingFacts(snapshot, files, [], ["web/t2.module.css"], readImportSpecifiers);

    expect(readImportSpecifiers).toHaveBeenCalledTimes(1);
    expect(readImportSpecifiers.mock.calls[0][0]).toEqual(["web/t2.ts"]);
    // The linked web pair drops; the unrescued app pair — off the diff, so
    // the run's judge never sees it — keeps its verdict verbatim.
    expect(facts.violations).toEqual([
      { relPathA: "app/s1.module.css", relPathB: "app/s1.ts", support: 9, strength: 0.5958436145024278 },
    ]);
  });

  it("no wired read keeps the single-pass verdict — the unit wiring never invents a lookup", async () => {
    const snapshot = { meta: cochangeMeta(), edges: [strongPair("app/s1.module.css", "app/s1.ts")] };
    const files = [graphFile("app/s1.ts")];

    const facts = await buildSilentCouplingFacts(snapshot, files, [], ["app/s1.module.css"]);

    expect(facts.violations).toHaveLength(1);
  });
});
