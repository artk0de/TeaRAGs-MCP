/**
 * `ReviewChangesOps` (bd tea-rags-mcp-89k7k.1.4, F3 slice 1): the orchestration
 * behind `review_changes` — resolve the addressed tree, read the diff ONCE with
 * the F0 reader (real, against a temp git repo), acquire one codegraph reader,
 * then run the REQUESTED section providers and assemble the keyed map. The
 * sections' own judgement is unit-tested beside them; what is pinned here is
 * the selection contract (allowlist, default-all, unknown id fails loud),
 * absence-vs-not-built, and the envelope.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGitWorkingTreeFixture } from "../../../__helpers__/git-working-tree-fixture.js";
import { InvalidParameterError } from "../../../../../src/core/api/errors.js";
import { ReviewChangesOps } from "../../../../../src/core/api/internal/ops/review-changes-ops.js";
import type { ReviewChangesRequest } from "../../../../../src/core/api/public/dto/review.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../../src/core/domains/language/index.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const CHANGED = "src/git/file-reader.ts";
const PARTNER = "src/git/partner.ts";

const ORIGINAL = "export function load(): void {\n  use(read());\n}\n";
const CHANGED_TEXT =
  "export function load(): void {\n  use(read());\n}\n\nexport function scan(): void {\n  const meta: GitFileSignals = read();\n  use(meta);\n}\n";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  });
}

/** The naming lexicon stub: its `.review` is what the naming section spreads. */
function lexiconOpsStub() {
  return {
    getNamingLexicon: vi.fn().mockResolvedValue({
      scope: "",
      byType: [],
      names: [],
      review: {
        workTree: "/irrelevant",
        base: "HEAD",
        mergeBase: "mb",
        changedFiles: 1,
        checked: 2,
        conforming: 2,
        novel: 0,
        findings: [],
        notJudged: 0,
      },
    }),
  };
}

interface GraphStub {
  cochangeEdges: {
    relPathA: string;
    relPathB: string;
    support: number;
    confidenceAB: number;
    confidenceBA: number;
    lift: number;
    lastCoChangeAt: number;
    sampleCommits: string[];
    structurallyLinked: boolean;
  }[];
  symbolCommits: Record<string, { relPath: string; symbols: { symbolId: string; commitShas: string[] }[] }>;
  close: ReturnType<typeof vi.fn>;
  readTemporalCochangeGraph: ReturnType<typeof vi.fn>;
  readTemporalSymbolCommits: ReturnType<typeof vi.fn>;
  readFileDependencyGraph: ReturnType<typeof vi.fn>;
  putReviewFileEdges: ReturnType<typeof vi.fn>;
  dropReviewFileEdges: ReturnType<typeof vi.fn>;
  sweepExpiredReviewFileEdges: ReturnType<typeof vi.fn>;
}

function graphDbStub(overrides: Partial<GraphStub> = {}): GraphStub {
  const stub: GraphStub = {
    cochangeEdges: [
      {
        relPathA: CHANGED,
        relPathB: PARTNER,
        support: 6,
        confidenceAB: 0.75,
        confidenceBA: 0.6,
        lift: 3,
        lastCoChangeAt: 1_700_000_000,
        sampleCommits: ["a1b2c3"],
        structurallyLinked: false,
      },
    ],
    symbolCommits: {
      [CHANGED]: {
        relPath: CHANGED,
        symbols: [
          { symbolId: "load", commitShas: ["c1", "c2", "c3", "loadOnly"] },
          { symbolId: "scan", commitShas: ["c2", "c3", "scanOnly"] },
        ],
      },
    },
    close: vi.fn(async () => undefined),
    readTemporalCochangeGraph: vi.fn(async () => ({ meta: { head: "h" }, edges: stub.cochangeEdges })),
    readTemporalSymbolCommits: vi.fn(
      async (relPath: string) => stub.symbolCommits[relPath] ?? { relPath, symbols: [] },
    ),
    // The architecture section's indexed side: an empty graph is a valid
    // substrate (no components, no edges — no findings), and the temp-table
    // lifecycle runs as spies.
    readFileDependencyGraph: vi.fn(async () => ({ files: [], edges: [] })),
    putReviewFileEdges: vi.fn(async () => undefined),
    dropReviewFileEdges: vi.fn(async () => undefined),
    sweepExpiredReviewFileEdges: vi.fn(async () => []),
    ...overrides,
  };
  return stub;
}

function makeOps(graph: GraphStub, registryEntry: unknown = {}) {
  return new ReviewChangesOps({
    pool: {
      acquireReader: vi.fn(async () => ({ graphDb: graph, symbolTable: {} })),
      hasDatabase: vi.fn(() => true),
    },
    collectionRegistry: { get: () => registryEntry } as unknown as CollectionRegistry,
    lexiconOps: lexiconOpsStub(),
    reviewEdgeExtraction: {
      languageFactory: new LanguageFactory({}),
      collectSymbols,
      composer: new DefaultSymbolIdComposer(),
    },
    windowMonths: 6,
  });
}

/** The same ops against a registry that stamped an index at another commit. */
function makeLaggingOps(graph: GraphStub) {
  return makeOps(graph, { git: { indexedCommit: "0".repeat(40) } });
}

describe("ReviewChangesOps", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "review-changes-ops-")));
    repo = join(dir, "repo");
    mkdirSync(join(repo, "src/git"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, CHANGED), ORIGINAL);
    writeFileSync(join(repo, PARTNER), "export const partner = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    writeFileSync(join(repo, CHANGED), CHANGED_TEXT);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const request = (overrides: Partial<ReviewChangesRequest> = {}): ReviewChangesRequest => ({
    collection: "code_test",
    path: repo,
    ...overrides,
  });

  it("no sections param → every registered section built, envelope carries the read", async () => {
    const graph = graphDbStub();
    const result = await makeOps(graph).reviewChanges(request());

    expect(Object.keys(result.review.sections).sort()).toEqual([
      "architecture",
      "cohesion",
      "incompleteChange",
      "naming",
    ]);
    for (const id of ["architecture", "cohesion", "incompleteChange", "naming"] as const) {
      expect(result.review.sections[id]?.built, id).toBe(true);
    }
    expect(result.review.workTree).toBe(repo);
    expect(result.review.mergeBase).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(result.review.changedFiles).toBe(1);
    expect(result.review.skipped).toBe(0);
    expect(result.review.notices).toBeUndefined();
    expect(result.review.truncated).toBeUndefined();
    // naming spread the lexicon's review verbatim
    expect(result.review.sections.naming).toMatchObject({ checked: 2, conforming: 2 });
    // incompleteChange found the partner outside the diff
    expect(result.review.sections.incompleteChange).toMatchObject({
      partners: [{ file: CHANGED, missingPartner: PARTNER, support: 6, confidence: 0.75 }],
    });
    // cohesion analyzed the changed file
    expect(result.review.sections.cohesion).toMatchObject({ analyzedFiles: 1, nullReports: 0 });
    // architecture judged the change over an empty indexed graph: the one
    // finding the fixture can make is silentCoupling (the co-change partner
    // outside the diff, no structural edge anywhere) — and its temp table was
    // minted, put and dropped exactly once.
    expect(result.review.sections.architecture).toMatchObject({
      built: true,
      findings: [{ detector: "silentCoupling", subject: `${CHANGED} ~ ${PARTNER}` }],
    });
    expect(graph.putReviewFileEdges).toHaveBeenCalledTimes(1);
    expect(graph.dropReviewFileEdges).toHaveBeenCalledTimes(1);
    expect(graph.putReviewFileEdges.mock.calls[0]?.[0]).toMatch(/^\d{10}-\d{1,7}-[a-z0-9]{6}$/);
    expect(graph.dropReviewFileEdges.mock.calls[0]?.[0]).toBe(graph.putReviewFileEdges.mock.calls[0]?.[0]);
    // the reader is released after the review
    expect(graph.close).toHaveBeenCalledTimes(1);
  });

  it("a section allowlist omits the others entirely — absence is not not-built", async () => {
    const graph = graphDbStub();
    const result = await makeOps(graph).reviewChanges(request({ sections: ["cohesion"] }));

    expect(Object.keys(result.review.sections)).toEqual(["cohesion"]);
    // The temporal graph read is skipped when incompleteChange was not asked for.
    expect(graph.readTemporalCochangeGraph).not.toHaveBeenCalled();
    expect(result.review.sections.cohesion?.built).toBe(true);
  });

  it("an unknown section id fails loud, naming the id and the registered set", async () => {
    const ops = makeOps(graphDbStub());
    await expect(ops.reviewChanges(request({ sections: ["nope" as "cohesion"] }))).rejects.toBeInstanceOf(
      InvalidParameterError,
    );
    await expect(ops.reviewChanges(request({ sections: ["nope" as "cohesion"] }))).rejects.toThrow(
      /nope.*registered: naming.*architecture/s,
    );
  });

  it("a collection with no codegraph database reports the graph sections not built — naming still answers", async () => {
    const ops = new ReviewChangesOps({
      pool: {
        acquireReader: vi.fn(async () => {
          throw new Error("no database");
        }),
        hasDatabase: vi.fn(() => false),
      },
      collectionRegistry: { get: () => ({}) } as unknown as CollectionRegistry,
      lexiconOps: lexiconOpsStub(),
      windowMonths: 6,
    });
    const result = await ops.reviewChanges(request());
    expect(result.review.sections.naming?.built).toBe(true);
    expect(result.review.sections.cohesion?.built).toBe(false);
    expect(result.review.sections.incompleteChange?.built).toBe(false);
    expect(result.review.sections.incompleteChange?.reason).toMatch(/codegraph/);
    expect(result.review.sections.architecture?.built).toBe(false);
  });

  it("a graph that exists but cannot be read fails loud, not as a clean review", async () => {
    const ops = new ReviewChangesOps({
      pool: {
        acquireReader: vi.fn(async () => {
          throw new Error("lock held");
        }),
        hasDatabase: vi.fn(() => true),
      },
      collectionRegistry: { get: () => ({}) } as unknown as CollectionRegistry,
      lexiconOps: lexiconOpsStub(),
      windowMonths: 6,
    });
    await expect(ops.reviewChanges(request())).rejects.toThrow(/lock held/);
  });

  it("a temporal graph that cannot be read is a not-built incompleteChange, not a failed review", async () => {
    const graph = graphDbStub();
    graph.readTemporalCochangeGraph.mockRejectedValue(new Error("wal corrupt"));
    const result = await makeOps(graph).reviewChanges(request());
    expect(result.review.sections.incompleteChange).toMatchObject({ built: false });
    expect(result.review.sections.incompleteChange?.reason).toMatch(/wal corrupt/);
    expect(result.review.sections.cohesion?.built).toBe(true);
    // architecture degrades its coupling port to silence (the run's absence
    // contract) instead of failing four working detectors on one unreadable
    // read — the error itself is incompleteChange's to report.
    expect(result.review.sections.architecture).toMatchObject({ built: true, findings: [] });
  });

  it("a file with no symbol commits is a cohesion notJudged entry — absence, never a zero", async () => {
    writeFileSync(join(repo, "src/git/second.ts"), "export const second = 2;\n");
    const result = await makeOps(graphDbStub()).reviewChanges(request({ files: [CHANGED, "src/git/second.ts"] }));
    expect(result.review.sections.cohesion?.notJudged).toEqual([
      { relPath: "src/git/second.ts", reason: "noCohesionData" },
    ]);
    expect(result.review.sections.cohesion?.analyzedFiles).toBe(1);
  });

  it("the registry's indexedCommit behind the tree's HEAD surfaces as indexLag", async () => {
    const result = await makeLaggingOps(graphDbStub()).reviewChanges(request());
    expect(result.review.indexLag).toEqual({
      indexedCommit: "0".repeat(40),
      treeCommit: git(repo, "rev-parse", "HEAD").trim(),
    });
  });

  it("an empty diff still reviews: notice present, sections built with empty payloads", async () => {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "change committed");
    const graph = graphDbStub();
    const result = await makeOps(graph).reviewChanges(request());

    expect(result.review.changedFiles).toBe(0);
    expect(result.review.notices?.[0]).toMatch(/^no changes/);
    expect(result.review.sections.incompleteChange).toMatchObject({ built: true, partners: [] });
    expect(result.review.sections.cohesion).toMatchObject({ built: true, analyzedFiles: 0, nullReports: 0 });
    expect(result.review.sections.naming?.built).toBe(true);
    expect(result.review.sections.architecture).toMatchObject({ built: true, findings: [] });
  });

  it("ReviewChangesOps.empty answers every requested section not built — the codegraph-off fallback", () => {
    const empty = ReviewChangesOps.empty({ sections: ["naming"] });
    expect(empty.review.sections.naming).toMatchObject({ built: false });
    expect(empty.review.sections.naming?.reason).toMatch(/codegraph/);
    const all = ReviewChangesOps.empty({});
    expect(Object.keys(all.review.sections).sort()).toEqual(["architecture", "cohesion", "incompleteChange", "naming"]);
  });

  it("a diff over the cap reports skipped and truncated in the envelope", async () => {
    mkdirSync(join(repo, "notes"));
    for (let i = 0; i < 202; i++) writeFileSync(join(repo, `notes/n${String(i).padStart(3, "0")}.md`), "x\n");
    const result = await makeOps(graphDbStub()).reviewChanges(request());
    expect(result.review.skipped).toBe(3);
    expect(result.review.truncated).toEqual({ cap: 200, skipped: 3 });
  });

  // bd tea-rags-mcp-xi2r9: a subagent knows only its working directory. `path` alone at a
  // linked worktree reviews that tree against its repository's registered index — never the
  // unregistered collection the worktree path would hash to.
  it("a path alone at a linked worktree of a registered project reviews that worktree", async () => {
    const fixture = createGitWorkingTreeFixture();
    try {
      const tree = fixture.addWorktree("feature");
      writeFileSync(join(tree, "src/index.ts"), "export const base = 2;\n");
      const main = { name: "main", collectionName: "code_main", path: fixture.mainRoot };
      const resolveActiveCollection = vi.fn(async (name: string) => name as never);
      const ops = new ReviewChangesOps({
        pool: {
          acquireReader: vi.fn(async () => ({ graphDb: graphDbStub(), symbolTable: {} })),
          hasDatabase: vi.fn(() => true),
        },
        collectionRegistry: {
          get: () => undefined,
          findByPath: (path: string) => (path === main.path ? main : null),
          list: () => [main],
        } as unknown as CollectionRegistry,
        resolveActiveCollection,
        lexiconOps: lexiconOpsStub(),
        windowMonths: 6,
      });

      const result = await ops.reviewChanges({ path: tree });

      expect(result.review.workTree).toBe(tree);
      expect(result.review.changedFiles).toBe(1);
      expect(resolveActiveCollection).toHaveBeenCalledWith("code_main");
    } finally {
      fixture.cleanup();
    }
  });
});
