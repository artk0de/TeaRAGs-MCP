/**
 * The architecture section's diff-base read asks git whether the merge-base is
 * an ancestor of HEAD only when the answer is not already known (bd
 * tea-rags-mcp-0qaht.63): a merge-base that IS HEAD — the default review of an
 * uncommitted change — is its own ancestor, and the spawn it would cost is
 * hundreds of milliseconds under an endpoint-security agent. The base blobs are
 * still read: an edge the merge-base held stays preExisting.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as VcsModule from "../../../../../../src/core/adapters/vcs/index.js";
import type { DiffScopeRead } from "../../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import { architectureSectionProvider } from "../../../../../../src/core/api/internal/ops/review-sections/architecture-section.js";
import type { ReviewSectionContext } from "../../../../../../src/core/api/internal/ops/review-sections/review-section-provider.js";
import type { FileDependencyGraph } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../../../src/core/domains/language/index.js";

vi.mock("../../../../../../src/core/adapters/vcs/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof VcsModule>();
  return { ...actual, isAncestor: vi.fn(actual.isAncestor) };
});

const vcs = await import("../../../../../../src/core/adapters/vcs/index.js");

let workTree: string;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: workTree,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  }).trim();
}

function writeFile(relPath: string, text: string): void {
  const absolute = join(workTree, relPath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, text);
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

function scopeAt(mergeBase: string): DiffScopeRead {
  return {
    workTree,
    base: "HEAD",
    mergeBase,
    notices: [],
    changedFiles: 1,
    wholeFiles: 0,
    files: ["src/app/a.ts"],
    touchedFiles: new Set(["src/app/a.ts"]),
    addedRanges: new Map(),
    nonProduction: new Set(),
    skipped: 0,
  };
}

function runContext(scope: DiffScopeRead): ReviewSectionContext {
  return {
    scope,
    graphDb: graphDbStub({
      files: [{ relPath: "src/lib/b.ts", language: "typescript", symbolCount: 1 }],
      edges: [{ sourceRelPath: "src/lib/b.ts", targetRelPath: "src/app/a.ts", callWeight: 1 }],
    }),
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

/**
 * Where the cycle the merge-base held lands: stamped preExisting from the base
 * blobs, it carries no remedy, so it collapses out of `findings` into the
 * change block (bd tea-rags-mcp-89k7k.1.7). Read as added, it would stay
 * listed in `findings` instead.
 */
function cycleLocations(payload: unknown): { listed: number; persisting: string[] } {
  const { findings, change } = payload as {
    findings: { detector: string }[];
    change: { persisting: { family: string; subject: string }[] };
  };
  return {
    listed: findings.filter((finding) => finding.detector === "cycles").length,
    persisting: change.persisting.filter((entry) => entry.family === "cycles").map((entry) => entry.subject),
  };
}

const PRE_EXISTING_CYCLE = { listed: 0, persisting: ["src/app/a.ts -> src/lib/b.ts"] };

describe("architectureSectionProvider.run — diff-base ancestry", () => {
  beforeEach(() => {
    workTree = mkdtempSync(join(tmpdir(), "architecture-base-ancestry-"));
    git("init", "-q", "-b", "main");
    writeFile("src/app/a.ts", 'import { B } from "../lib/b";\nexport const A = 1;\n');
    writeFile("src/lib/b.ts", 'import { A } from "../app/a";\nexport const B = A;\n');
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "base");
    writeFile("src/app/a.ts", 'import { B } from "../lib/b";\nexport const A = 2;\n');
    vi.mocked(vcs.isAncestor).mockClear();
  });

  afterEach(() => {
    rmSync(workTree, { recursive: true, force: true });
  });

  it("a merge-base at HEAD is its own ancestor — git is not asked, the base blobs are still read", async () => {
    const payload = await architectureSectionProvider.run(runContext(scopeAt(git("rev-parse", "HEAD"))));

    expect(vcs.isAncestor).not.toHaveBeenCalled();
    expect(cycleLocations(payload)).toEqual(PRE_EXISTING_CYCLE);
  });

  it("a merge-base other than HEAD is still checked through git", async () => {
    const base = git("rev-parse", "HEAD");
    writeFile("src/lib/c.ts", "export const C = 1;\n");
    git("add", "src/lib/c.ts");
    git("commit", "-q", "--no-verify", "-m", "next");

    const payload = await architectureSectionProvider.run(runContext(scopeAt(base)));

    expect(vcs.isAncestor).toHaveBeenCalledTimes(1);
    expect(cycleLocations(payload)).toEqual(PRE_EXISTING_CYCLE);
  });
});
