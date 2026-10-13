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

import type { DiffScopeRead } from "../../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import { architectureSectionProvider } from "../../../../../../src/core/api/internal/ops/review-sections/architecture-section.js";
import type { ReviewSectionContext } from "../../../../../../src/core/api/internal/ops/review-sections/review-section-provider.js";
import type { ArchitectureSectionPayload } from "../../../../../../src/core/api/public/dto/review.js";
import type {
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
