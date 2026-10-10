/**
 * The working-tree git signal source's git-read economy (bd
 * tea-rags-mcp-0qaht.51): every git child costs a process spawn, and an
 * endpoint-security agent serializes those machine-wide (hundreds of
 * milliseconds each under load). A tree whose HEAD is still the index's stamp
 * has no commits on either side of it — `stamp...HEAD` is empty by definition —
 * so the range is not asked of git. What is pinned here is WHICH reads run; the
 * answers are `working-tree-git-signals.test.ts`'s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../__helpers__/git-working-tree-fixture.js";
import * as gitCli from "../../../../../src/core/adapters/vcs/git/git-cli/history.js";
import { createWorkingTreeGitSignalSource } from "../../../../../src/core/api/internal/infra/working-tree-git-signals.js";

vi.mock("../../../../../src/core/adapters/vcs/git/git-cli/history.js", async (importOriginal) => importOriginal());

const DEPS = {
  vcsAdapter: "git" as const,
  timeoutMs: 30_000,
  chunk: { maxAgeMonths: 6, timeoutMs: 30_000, maxFileLines: 5000, concurrency: 4 },
};

describe("createWorkingTreeGitSignalSource — a stamp at HEAD", () => {
  let fixture: GitWorkingTreeFixture;
  let tree: string;

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture([{ commit: { "src/a.ts": "export const a = 1;\n" }, message: "add a" }]);
    tree = fixture.mainRoot;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.cleanup();
  });

  it("lists no path committed since a stamp HEAD still is, without asking git for the range", async () => {
    const spy = vi.spyOn(gitCli, "readPathCommitsSince");
    const head = fixture.git(tree, "rev-parse", "HEAD").trim();

    expect(await createWorkingTreeGitSignalSource(DEPS).pathsCommittedSince(tree, head)).toEqual(new Set());
    expect(spy).not.toHaveBeenCalled();
  });

  it("computes a path's signals against a stamp HEAD still is, without asking git for the range", async () => {
    const spy = vi.spyOn(gitCli, "readPathCommitsSince");
    const head = fixture.git(tree, "rev-parse", "HEAD").trim();

    const signals = await createWorkingTreeGitSignalSource(DEPS).signalsOf(
      tree,
      [{ relativePath: "src/a.ts", treePath: "src/a.ts", maxEndLine: 1, fileSignals: true, chunks: [] }],
      head,
    );

    expect(signals.get("src/a.ts")?.file).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
