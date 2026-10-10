/**
 * ReviewChangesOps — the requested sections run together, and the envelope
 * lists them in the requested order whatever order they finish in. The shared
 * graph handle closes only once every section has settled.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyGitRepoTemplate } from "../../../__helpers__/git-repo-template.js";
import { ReviewChangesOps } from "../../../../../src/core/api/internal/ops/review-changes-ops.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../../src/core/domains/language/index.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const CHANGED = "src/git/file-reader.ts";

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  });
}

const NAMING_ANSWER = {
  scope: "",
  byType: [],
  names: [],
  review: {
    workTree: "/irrelevant",
    base: "HEAD",
    mergeBase: "mb",
    changedFiles: 1,
    checked: 0,
    conforming: 0,
    novel: 0,
    findings: [],
    notJudged: 0,
  },
};

/** A promise the test settles by hand. */
function held<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ReviewChangesOps — sections run together", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    // The committed repository is built once per process and copied: its three
    // git spawns cost seconds each on a loaded machine (bd tea-rags-mcp-x1r2a).
    dir = realpathSync(
      copyGitRepoTemplate(
        "review-changes-concurrency:init",
        (root) => {
          const built = join(root, "repo");
          mkdirSync(join(built, "src/git"), { recursive: true });
          git(built, "init", "-q", "-b", "main");
          writeFileSync(join(built, CHANGED), "export function load(): void {}\n");
          git(built, "add", "-A");
          git(built, "commit", "-q", "-m", "init");
        },
        { prefix: "review-changes-concurrency-" },
      ).root,
    );
    repo = join(dir, "repo");
    writeFileSync(join(repo, CHANGED), "export function load(): void {}\nexport function scan(): void {}\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function build(getNamingLexicon: () => Promise<unknown>, readTemporalSymbolCommits: () => Promise<unknown>) {
    // Cohesion's graph read is the event "a later section started": awaited,
    // not polled under a time bound the review's own git spawns could outlast.
    // Sequential sections never reach it while naming is held — the test then
    // fails on its budget instead.
    const cohesionStarted = held<void>();
    const graph = {
      close: vi.fn(async () => undefined),
      readTemporalSymbolCommits: vi.fn(async () => {
        cohesionStarted.resolve();
        return readTemporalSymbolCommits();
      }),
    };
    const ops = new ReviewChangesOps({
      pool: { acquireReader: vi.fn(async () => ({ graphDb: graph, symbolTable: {} })), hasDatabase: vi.fn(() => true) },
      collectionRegistry: { get: () => ({}) } as unknown as CollectionRegistry,
      lexiconOps: { getNamingLexicon: vi.fn(getNamingLexicon) } as never,
      reviewEdgeExtraction: {
        languageFactory: new LanguageFactory({}),
        collectSymbols,
        composer: new DefaultSymbolIdComposer(),
      },
      windowMonths: 6,
    } as never);
    return { ops, graph, cohesionStarted: cohesionStarted.promise };
  }

  it("a later section starts while an earlier one is still running; the envelope keeps the requested order", async () => {
    const naming = held<unknown>();
    const { ops, graph, cohesionStarted } = build(
      async () => naming.promise,
      async () => ({ relPath: CHANGED, symbols: [] }),
    );
    const pending = ops.reviewChanges({ collection: "code_test", path: repo, sections: ["naming", "cohesion"] });

    await cohesionStarted;
    expect(graph.readTemporalSymbolCommits).toHaveBeenCalled();
    naming.resolve(NAMING_ANSWER);
    const result = await pending;

    expect(Object.keys(result.review.sections)).toEqual(["naming", "cohesion"]);
    expect(result.review.sections.naming).toMatchObject({ built: true });
    expect(result.review.sections.cohesion).toMatchObject({ built: true });
  });

  it("a failing section fails the review only after every section settled — the handle outlives them", async () => {
    const cohesion = held<unknown>();
    const { ops, graph, cohesionStarted } = build(
      async () => {
        throw new Error("naming broke");
      },
      async () => cohesion.promise,
    );
    const pending = ops.reviewChanges({ collection: "code_test", path: repo, sections: ["naming", "cohesion"] });
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    await cohesionStarted;
    expect(graph.readTemporalSymbolCommits).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(graph.close).not.toHaveBeenCalled();

    cohesion.resolve({ relPath: CHANGED, symbols: [] });
    expect(await outcome).toEqual(new Error("naming broke"));
    expect(graph.close).toHaveBeenCalledTimes(1);
  });
});
