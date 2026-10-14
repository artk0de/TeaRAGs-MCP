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
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { copyGitRepoTemplate } from "../../../__helpers__/git-repo-template.js";
import {
  createGitWorkingTreeFixture,
  prebuildGitWorkingTreeFixture,
  type GitWorkingTreeSeedStep,
} from "../../../__helpers__/git-working-tree-fixture.js";
import {
  ReviewChangesOps,
  type ReviewChangesOpsDeps,
} from "../../../../../src/core/api/internal/ops/review-changes-ops.js";
import type { ReviewChangesRequest } from "../../../../../src/core/api/public/dto/review.js";
import { InvalidParameterError } from "../../../../../src/core/api/public/errors.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../../src/core/domains/language/index.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const CHANGED = "src/git/file-reader.ts";
const PARTNER = "src/git/partner.ts";
/** The fixture repository with the linked worktree `wt-feature` added at its tip. */
const LINKED_WORKTREE: GitWorkingTreeSeedStep[] = [{ addWorktree: "feature" }];

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
  readNonPublicMemberEdges: ReturnType<typeof vi.fn>;
  readTypeNameRows: ReturnType<typeof vi.fn>;
  readFileDependencyGraph: ReturnType<typeof vi.fn>;
  listAllSymbols?: ReturnType<typeof vi.fn>;
  listFileContentHashes?: ReturnType<typeof vi.fn>;
}

function graphDbStub(overrides: Partial<GraphStub> = {}): GraphStub {
  const stub: GraphStub = {
    cochangeEdges: [
      {
        relPathA: CHANGED,
        relPathB: PARTNER,
        // Confidence 0.9/0.9 → wilson(9, 10) ≈ 0.596: the pair must clear
        // the production strength floor (> 0.5) to become a violation — the
        // review consumes the detector's verdict, weaker pairs are not
        // findings (bd tea-rags-mcp-89k7k.1.10).
        support: 9,
        confidenceAB: 0.9,
        confidenceBA: 0.9,
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
    readNonPublicMemberEdges: vi.fn(async () => []),
    readTypeNameRows: vi.fn(async () => []),
    readTemporalSymbolCommits: vi.fn(
      async (relPath: string) => stub.symbolCommits[relPath] ?? { relPath, symbols: [] },
    ),
    // The architecture section's indexed side: the walked census names the
    // co-change endpoints (otherwise the production taxonomy excludes the
    // pair as unwalked), and no components/edges — no other findings. The
    // temp-table lifecycle runs as spies.
    readFileDependencyGraph: vi.fn(async () => ({
      files: [
        { relPath: CHANGED, language: "typescript", symbolCount: 1 },
        { relPath: PARTNER, language: "typescript", symbolCount: 1 },
      ],
      edges: [],
    })),
    ...overrides,
  };
  return stub;
}

function makeOps(graph: GraphStub, registryEntry: unknown = {}, extraDeps: Partial<ReviewChangesOpsDeps> = {}) {
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
    ...extraDeps,
  });
}

/** The same ops against a registry that stamped an index at another commit. */
function makeLaggingOps(graph: GraphStub) {
  return makeOps(graph, { git: { indexedCommit: "0".repeat(40) } });
}

describe("ReviewChangesOps", () => {
  let dir: string;
  let repo: string;

  beforeAll(() => {
    prebuildGitWorkingTreeFixture(LINKED_WORKTREE);
  });

  beforeEach(() => {
    // The committed repository is built once per process and copied: its git
    // spawns cost seconds each on a loaded machine (bd tea-rags-mcp-x1r2a).
    dir = realpathSync(
      copyGitRepoTemplate(
        "review-changes-ops:init",
        (root) => {
          const built = join(root, "repo");
          mkdirSync(join(built, "src/git"), { recursive: true });
          git(built, "init", "-q", "-b", "main");
          // A test's own commit would otherwise fork a detached `git maintenance run --auto`.
          git(built, "config", "maintenance.auto", "false");
          writeFileSync(join(built, CHANGED), ORIGINAL);
          writeFileSync(join(built, PARTNER), "export const partner = 1;\n");
          git(built, "add", "-A");
          git(built, "commit", "-q", "-m", "init");
        },
        // The review reads the copy through porcelain git only, which re-hashes
        // what a stale stat cache flags — the refresh would be one more spawn
        // per test (bd tea-rags-mcp-0qaht.63).
        { prefix: "review-changes-ops-", refreshIndex: false },
      ).root,
    );
    repo = join(dir, "repo");
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
      "norms",
    ]);
    for (const id of ["architecture", "cohesion", "incompleteChange", "naming", "norms"] as const) {
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
      partners: [{ file: CHANGED, missingPartner: PARTNER, support: 9, confidence: 0.9 }],
    });
    // cohesion analyzed the changed file
    expect(result.review.sections.cohesion).toMatchObject({ analyzedFiles: 1, nullReports: 0 });
    // architecture judged the change over an empty indexed graph: the one
    // violation the fixture can make is silentCoupling (the co-change partner
    // outside the diff, no structural edge anywhere) — co-change history no
    // edge overlay moves, so it collapses into the change block as persisting
    // (bd tea-rags-mcp-89k7k.1.7).
    expect(result.review.sections.architecture).toMatchObject({
      built: true,
      findings: [],
      change: {
        introducedCount: 0,
        persisting: [{ family: "silentCoupling.pair", subject: `${CHANGED} ~ ${PARTNER}` }],
      },
    });
    // the reader is released after the review
    expect(graph.close).toHaveBeenCalledTimes(1);
  });

  // bd tea-rags-mcp-2wsnt: the payload specifier read rides the deps to the
  // architecture section, bound to the review's collection — the same read
  // the whole-repo report's asset-import rescue uses. A diff-touching
  // one-walked pair (the stylesheet is no walked file) is linked and drops;
  // the both-walked pair never was a rescue candidate and stays.
  it("threads the payload specifier read to the architecture section, bound to the collection", async () => {
    const graph = graphDbStub({
      cochangeEdges: [
        {
          relPathA: CHANGED,
          relPathB: "src/git/theme.css",
          support: 9,
          confidenceAB: 0.9,
          confidenceBA: 0.9,
          lift: 3,
          lastCoChangeAt: 1_700_000_000,
          sampleCommits: ["a1b2c3"],
          structurallyLinked: false,
        },
        {
          relPathA: CHANGED,
          relPathB: PARTNER,
          support: 9,
          confidenceAB: 0.9,
          confidenceBA: 0.9,
          lift: 3,
          lastCoChangeAt: 1_700_000_000,
          sampleCommits: ["a1b2c3"],
          structurallyLinked: false,
        },
      ],
    });
    const readImportSpecifiers = vi.fn().mockResolvedValue(new Map([[CHANGED, ["./theme.css"]]]));

    const result = await makeOps(graph, {}, { readImportSpecifiers }).reviewChanges(
      request({ sections: ["architecture"] }),
    );

    expect(readImportSpecifiers).toHaveBeenCalledTimes(1);
    const [calledCollection, calledRelPaths] = readImportSpecifiers.mock.calls[0];
    expect(calledCollection).toBe("code_test");
    // The walked endpoint of the diff-touching one-walked pair — the diff
    // names the stylesheet, so the importer itself is read, not the asset.
    expect(calledRelPaths).toEqual([CHANGED]);
    // Silent coupling persists by construction (bd tea-rags-mcp-89k7k.1.7), so
    // the rescue's verdict is read off the change block: the linked stylesheet
    // pair dropped, the unlinked one stayed.
    const { change } = result.review.sections.architecture as {
      change: { persisting: { subject: string }[] };
    };
    const subjects = change.persisting.map((entry) => entry.subject);
    expect(subjects).toContain(`${CHANGED} ~ ${PARTNER}`);
    expect(subjects).not.toContain(`${CHANGED} ~ src/git/theme.css`);
  });

  it("threads the maintenance-signal read to the architecture section, bound to the collection (bd tea-rags-mcp-r8hme.20)", async () => {
    // A cycle the change closes (its new import meets the indexed edge back):
    // an introduced finding, so it survives the collapse of persisting ones
    // (bd tea-rags-mcp-89k7k.1.7) and carries the maintenance cost.
    writeFileSync(
      join(repo, CHANGED),
      `import { partner } from "./partner";\n${CHANGED_TEXT}export const P = partner;\n`,
    );
    const graph = graphDbStub({
      readFileDependencyGraph: vi.fn(async () => ({
        files: [
          { relPath: CHANGED, language: "typescript", symbolCount: 1 },
          { relPath: PARTNER, language: "typescript", symbolCount: 1 },
        ],
        edges: [{ sourceRelPath: PARTNER, targetRelPath: CHANGED, callWeight: 1 }],
      })),
    });
    const readFileMaintenanceSignals = vi.fn().mockResolvedValue(
      new Map([
        [CHANGED, { commitCount: 8, bugFixRate: 25, ageDays: 2 }],
        [PARTNER, { commitCount: 1, bugFixRate: 0, ageDays: 90 }],
      ]),
    );

    const result = await makeOps(graph, {}, { readFileMaintenanceSignals }).reviewChanges(
      request({ sections: ["architecture"] }),
    );

    expect(readFileMaintenanceSignals).toHaveBeenCalledExactlyOnceWith("code_test");
    const { findings } = result.review.sections.architecture as {
      findings: { detector: string; subject: string; maintenanceCost?: { score: number } }[];
    };
    const cycle = findings.find((f) => f.detector === "cycles");
    expect(cycle?.subject).toBe(`${CHANGED} -> ${PARTNER}`);
    expect(cycle?.maintenanceCost?.score).toBe(0.5);
  });

  it("reads the review collection's test imports once, for the architecture section's test-support exclusion (bd tea-rags-mcp-89k7k.35.3)", async () => {
    const readIndexedFileImports = vi.fn().mockResolvedValue(new Map());

    await makeOps(graphDbStub(), {}, { readIndexedFileImports }).reviewChanges(request({ sections: ["architecture"] }));

    expect(readIndexedFileImports).toHaveBeenCalledExactlyOnceWith("code_test");
  });

  it("reads the index's symbol rows once per review, shared by every section that walks the diff (bd tea-rags-mcp-vdhjc)", async () => {
    const listAllSymbols = vi.fn(async () => []);
    const listFileContentHashes = vi.fn(async () => [{ relPath: CHANGED, contentHash: null }]);
    const graph = graphDbStub({ listAllSymbols, listFileContentHashes });

    const result = await makeOps(graph).reviewChanges(request({ sections: ["architecture", "norms"] }));

    expect(result.review.sections.architecture?.built).toBe(true);
    expect(result.review.sections.norms?.built).toBe(true);
    expect(listAllSymbols).toHaveBeenCalledTimes(1);
    expect(listFileContentHashes).toHaveBeenCalledTimes(1);
  });

  it("walks the diff once per review: architecture and norms share one change-edge read (bd tea-rags-mcp-nehn5)", async () => {
    const walksFor = async (sections: ReviewChangesRequest["sections"]): Promise<number> => {
      const walk = vi.fn(collectSymbols);
      const ops = makeOps(
        graphDbStub(),
        {},
        {
          reviewEdgeExtraction: {
            languageFactory: new LanguageFactory({}),
            collectSymbols: walk,
            composer: new DefaultSymbolIdComposer(),
          },
        },
      );
      await ops.reviewChanges(request({ sections }));
      return walk.mock.calls.length;
    };

    const alone = await walksFor(["architecture"]);
    const both = await walksFor(["architecture", "norms"]);

    expect(alone).toBeGreaterThan(0);
    expect(both).toBe(alone);
  });

  it("keeps the symbol rows across reviews until a write moves the database stamp (bd tea-rags-mcp-nehn5)", async () => {
    const listAllSymbols = vi.fn(async () => []);
    const listFileContentHashes = vi.fn(async () => [{ relPath: CHANGED, contentHash: null }]);
    const graph = graphDbStub({ listAllSymbols, listFileContentHashes });
    let stamp = "gen-1";
    const ops = makeOps(graph, {}, {
      pool: {
        acquireReader: vi.fn(async () => ({ graphDb: graph, symbolTable: {} })),
        hasDatabase: vi.fn(() => true),
        databaseWriteStamp: vi.fn(() => stamp),
      },
    } as Partial<ReviewChangesOpsDeps>);

    const first = await ops.reviewChanges(request({ sections: ["architecture", "norms"] }));
    const second = await ops.reviewChanges(request({ sections: ["architecture", "norms"] }));
    stamp = "gen-2";
    await ops.reviewChanges(request({ sections: ["architecture", "norms"] }));

    expect(second.review.sections).toEqual(first.review.sections);
    expect(listAllSymbols).toHaveBeenCalledTimes(2);
  });

  it("reads no symbol rows for a review whose sections walk no diff edges", async () => {
    const listAllSymbols = vi.fn(async () => []);
    const graph = graphDbStub({ listAllSymbols });

    await makeOps(graph).reviewChanges(request({ sections: ["cohesion"] }));

    expect(listAllSymbols).not.toHaveBeenCalled();
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
    expect(Object.keys(all.review.sections).sort()).toEqual([
      "architecture",
      "cohesion",
      "incompleteChange",
      "naming",
      "norms",
    ]);
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
    const fixture = createGitWorkingTreeFixture(LINKED_WORKTREE);
    try {
      const tree = fixture.seeded.worktrees.feature;
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
