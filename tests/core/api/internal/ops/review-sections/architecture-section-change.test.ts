/**
 * The architecture section's change block (bd tea-rags-mcp-89k7k.1.7, owner
 * decision 2026-10-13 "collapse persisting"): the full detector set over the
 * index and over the index with the tree's edges overlaid, compared by key.
 * `findings` keeps what the change introduced; what persists or was resolved
 * is listed compactly in `change`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readProductionArchitectureGraph } from "../../../../../../src/core/api/internal/ops/architecture-facts.js";
import type { DiffScopeRead } from "../../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import { architectureSectionProvider } from "../../../../../../src/core/api/internal/ops/review-sections/architecture-section.js";
import { normsSectionProvider } from "../../../../../../src/core/api/internal/ops/review-sections/norms-section.js";
import type { ReviewSectionContext } from "../../../../../../src/core/api/internal/ops/review-sections/review-section-provider.js";
import type { ArchitectureSectionPayload } from "../../../../../../src/core/api/public/dto/review.js";
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

let workTree: string;

beforeEach(() => {
  workTree = mkdtempSync(join(tmpdir(), "architecture-section-change-"));
});

afterEach(() => {
  rmSync(workTree, { recursive: true, force: true });
});

function writeFile(relPath: string, text: string): void {
  const absolute = join(workTree, relPath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text);
}

const file = (relPath: RelPath): FileDependencyGraphFile => ({ relPath, language: "typescript", symbolCount: 1 });
const edge = (sourceRelPath: RelPath, targetRelPath: RelPath): FileDependencyEdge => ({
  sourceRelPath,
  targetRelPath,
  callWeight: 1,
});

function graphDbStub(graph: FileDependencyGraph) {
  return {
    readFileDependencyGraph: vi.fn(async () => graph),
    readTemporalCochangeGraph: vi.fn(async () => ({ meta: null, edges: [] })),
    readTemporalSymbolCommits: vi.fn(async () => ({ relPath: "", symbols: [] })),
    readNonPublicMemberEdges: vi.fn(async () => []),
    readTypeNameRows: vi.fn(async () => []),
  };
}

function scopeOf(files: readonly string[], extra: Partial<DiffScopeRead> = {}): DiffScopeRead {
  return {
    workTree,
    base: "HEAD",
    mergeBase: "mb",
    notices: [],
    changedFiles: files.length,
    wholeFiles: 0,
    files,
    touchedFiles: new Set(files),
    addedRanges: new Map(),
    nonProduction: new Set(),
    skipped: 0,
    ...extra,
  };
}

function runContext(graph: FileDependencyGraph, scope: DiffScopeRead, extra: Partial<ReviewSectionContext> = {}) {
  const context: ReviewSectionContext = {
    scope,
    graphDb: graphDbStub(graph),
    temporalCochange: null,
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
    ...extra,
  };
  return context;
}

/**
 * `src/core` is stable (five importing files, no efferents); `src/ui` is
 * unstable (five files importing out) — both past the SDP connection floor,
 * which counts distinct files.
 * An edge core → ui is a Stable Dependencies violation; `extraFiles` add
 * files the `extraEdges` need.
 */
function stableUnstableGraph(extraEdges: FileDependencyEdge[] = [], extraFiles: RelPath[] = []): FileDependencyGraph {
  const files = [file("src/core/k.ts"), file("src/ui/v.ts"), ...extraFiles.map(file)];
  const edges: FileDependencyEdge[] = [...extraEdges];
  for (let i = 1; i <= 5; i++) {
    files.push(file(`src/dep${i}/d.ts`), file(`src/ui/w${i}.ts`), file(`src/ext${i}/e.ts`));
    edges.push(edge(`src/dep${i}/d.ts`, "src/core/k.ts"), edge(`src/ui/w${i}.ts`, `src/ext${i}/e.ts`));
  }
  return { files, edges };
}

function writeUiTree(): void {
  writeFile("src/ui/v.ts", "export const V = 1;\n");
}

async function run(context: ReviewSectionContext): Promise<ArchitectureSectionPayload> {
  return (await architectureSectionProvider.run(context)) as ArchitectureSectionPayload;
}

describe("architecture section change block (bd tea-rags-mcp-89k7k.1.7)", () => {
  it("lists an SDP violation the diff's added edge creates as introduced, in findings", async () => {
    writeUiTree();
    writeFile("src/core/k.ts", 'import { V } from "../ui/v";\nexport const K = V;\n');

    const payload = await run(runContext(stableUnstableGraph(), scopeOf(["src/core/k.ts"])));

    expect(payload.findings.filter((f) => f.detector === "stableDependencies")).not.toEqual([]);
    expect(payload.change?.introducedCount).toBeGreaterThanOrEqual(1);
    expect(payload.change?.persisting.filter((p) => p.family === "stableDependencies")).toEqual([]);
  });

  it("lists the violation an edge the diff removes as resolved", async () => {
    writeUiTree();
    writeFile("src/core/k.ts", "export const K = 1;\n");

    const payload = await run(
      runContext(stableUnstableGraph([edge("src/core/k.ts", "src/ui/v.ts")]), scopeOf(["src/core/k.ts"])),
    );

    expect(payload.change?.resolved).toContainEqual({
      family: "stableDependencies",
      subject: "src/core → src/ui",
    });
  });

  it("collapses a violation both runs hold out of findings into persisting", async () => {
    writeUiTree();
    writeFile("src/core/j.ts", 'import { V } from "../ui/v";\nexport const J = V;\n');
    writeFile("src/core/k.ts", 'import { V } from "../ui/v";\nexport const K = V;\n');

    // core/j.ts already carried core → ui in the index; the diff adds a second carrier.
    const graph = stableUnstableGraph([edge("src/core/j.ts", "src/ui/v.ts")], ["src/core/j.ts"]);
    const payload = await run(runContext(graph, scopeOf(["src/core/k.ts"])));

    expect(payload.findings.filter((f) => f.detector === "stableDependencies")).toEqual([]);
    expect(payload.change?.persisting).toContainEqual(expect.objectContaining({ family: "stableDependencies" }));
    const row = payload.detectors.find((d) => d.detector === "stableDependencies");
    expect(row?.persistingCount).toBeGreaterThanOrEqual(1);
  });

  it("reads a git mv of an unchanged importer as persisting, not resolved + introduced", async () => {
    writeUiTree();
    writeFile("src/core/moved.ts", 'import { V } from "../ui/v";\nexport const K = V;\n');

    const graph = stableUnstableGraph([edge("src/core/old.ts", "src/ui/v.ts")], ["src/core/old.ts"]);
    const payload = await run(
      runContext(
        graph,
        scopeOf(["src/core/moved.ts", "src/core/old.ts"], {
          renamedFrom: new Map([["src/core/moved.ts", "src/core/old.ts"]]),
        }),
      ),
    );

    expect(payload.change?.resolved).toEqual([]);
    expect(payload.change?.introducedCount).toBe(0);
    expect(payload.change?.nonLocal).toEqual([]);
  });

  it("marks introduced as maybe already committed when the index lacks the merge-base", async () => {
    writeUiTree();
    writeFile("src/core/k.ts", 'import { V } from "../ui/v";\nexport const K = V;\n');
    const indexLag = { indexedCommit: "older", treeCommit: "mb" };

    const payload = await run(runContext(stableUnstableGraph(), scopeOf(["src/core/k.ts"]), { indexLag }));

    expect(payload.change).toMatchObject({ indexLag, maybeAlreadyCommitted: true });
  });

  it("states no lag when the index is current", async () => {
    writeUiTree();
    writeFile("src/core/k.ts", "export const K = 1;\n");

    const payload = await run(runContext(stableUnstableGraph(), scopeOf(["src/core/k.ts"])));

    expect(payload.change).toBeDefined();
    expect(payload.change?.indexLag).toBeUndefined();
    expect(payload.change?.maybeAlreadyCommitted).toBeUndefined();
  });
});

describe("architecture section impact tiers (bd tea-rags-mcp-r8hme.53 T2)", () => {
  /**
   * `pair` co-changing in eight one-commit bundles (commits `p0..p7`) beside
   * ten solo changes of four other files: the configuration null expects well
   * under one co-change for any pair, so eight is far beyond it.
   */
  function cochangeWith(pair: readonly [string, string]): TemporalCochangeGraph {
    const bundles: (readonly string[])[] = [];
    for (let i = 0; i < 8; i++) bundles.push(pair);
    for (const solo of ["src/dep1/d.ts", "src/dep2/d.ts", "src/ext1/e.ts", "src/ext2/e.ts"]) {
      for (let i = 0; i < 10; i++) bundles.push([solo]);
    }
    return {
      meta: null,
      edges: [],
      bundles: new Map(bundles.map((files, id) => [id, files])),
      bundleCommits: new Map(bundles.map((_, id) => [id, [id < 8 ? `p${id}` : `s${id}`]])),
    };
  }

  const ownCommits = Array.from({ length: 8 }, (_, i) => `p${i}`);
  const liveTier = (tier: string | undefined) => tier === "active" || tier === "critical";

  it("carries the overlaid run's tier onto the SDP finding the diff introduces", async () => {
    writeUiTree();
    writeFile("src/core/k.ts", 'import { V } from "../ui/v";\nexport const K = V;\n');

    const payload = await run(
      runContext(stableUnstableGraph(), scopeOf(["src/core/k.ts"]), {
        temporalCochange: cochangeWith(["src/core/k.ts", "src/ui/v.ts"]),
      }),
    );

    expect(liveTier(payload.findings.find((f) => f.detector === "stableDependencies")?.tier)).toBe(true);
  });

  it("never lets the diff's own commits make the pair active — the review judges the query family", async () => {
    writeUiTree();
    writeFile("src/core/k.ts", 'import { V } from "../ui/v";\nexport const K = V;\n');

    const payload = await run(
      runContext(stableUnstableGraph(), scopeOf(["src/core/k.ts"], { diffCommits: ownCommits }), {
        temporalCochange: cochangeWith(["src/core/k.ts", "src/ui/v.ts"]),
      }),
    );

    expect(payload.findings.find((f) => f.detector === "stableDependencies")?.tier).toBe("structural");
  });

  it("lifts a persisting active violation the diff touches out of persisting into touchedActive", async () => {
    writeUiTree();
    writeFile("src/core/j.ts", 'import { V } from "../ui/v";\nexport const J = 2;\nexport const W = V;\n');

    const graph = stableUnstableGraph([edge("src/core/j.ts", "src/ui/v.ts")], ["src/core/j.ts"]);
    const payload = await run(
      runContext(graph, scopeOf(["src/core/j.ts"]), {
        temporalCochange: cochangeWith(["src/core/j.ts", "src/ui/v.ts"]),
      }),
    );

    const touched = payload.change?.touchedActive ?? [];
    expect(touched).toEqual([expect.objectContaining({ family: "stableDependencies", subject: "src/core → src/ui" })]);
    expect(liveTier(touched[0]?.tier)).toBe(true);
    expect(payload.change?.persisting.filter((p) => p.family === "stableDependencies")).toEqual([]);
  });

  it("keeps a structural persisting violation collapsed", async () => {
    writeUiTree();
    writeFile("src/core/j.ts", 'import { V } from "../ui/v";\nexport const J = 2;\nexport const W = V;\n');

    const graph = stableUnstableGraph([edge("src/core/j.ts", "src/ui/v.ts")], ["src/core/j.ts"]);
    const payload = await run(
      runContext(graph, scopeOf(["src/core/j.ts"]), {
        temporalCochange: cochangeWith(["src/dep3/d.ts", "src/ext3/e.ts"]),
      }),
    );

    expect(payload.change?.touchedActive).toEqual([]);
    expect(payload.findings.filter((f) => f.detector === "stableDependencies")).toEqual([]);
  });
});

describe("architecture and norms over one shared production graph (bd tea-rags-mcp-pqdw4)", () => {
  /** Freeze every plain object and array reachable from `value` — a consumer that mutates it throws. */
  function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  }

  it("neither section mutates the shared graph: a deep-frozen one yields the same payloads as each section's own read", async () => {
    writeUiTree();
    writeFile("src/core/k.ts", 'import { V } from "../ui/v";\nexport const K = V;\n');
    const scope = scopeOf(["src/core/k.ts"]);
    const sections = async (extra: Partial<ReviewSectionContext>) =>
      Promise.all([
        architectureSectionProvider.run(runContext(stableUnstableGraph(), scope, extra)),
        normsSectionProvider.run(runContext(stableUnstableGraph(), scope, extra)),
      ]);
    const shared = deepFreeze(await readProductionArchitectureGraph(graphDbStub(stableUnstableGraph())));

    const own = await sections({});
    const frozen = await sections({ readProductionGraph: async () => shared });

    expect((own[0] as ArchitectureSectionPayload).findings).not.toEqual([]);
    expect(frozen).toEqual(own);
  });
});
