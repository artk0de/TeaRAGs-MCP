import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../__helpers__/git-working-tree-fixture.js";
import * as gitClient from "../../../../../src/core/adapters/vcs/git/git-cli/client.js";
import {
  createWorkingTreeDeltaReader,
  WORKING_TREE_DELTA_FILE_CAP,
  type WorkingTreeDeltaRead,
} from "../../../../../src/core/domains/explore/working-tree/index.js";
import { FileScanner } from "../../../../../src/core/domains/ingest/pipeline/scanner.js";

vi.mock("../../../../../src/core/adapters/vcs/git/git-cli/client.js", async (importOriginal) => importOriginal());

/**
 * `WorkingTreeDelta` (bd tea-rags-mcp-xi2r9.2): the index is commit A on main,
 * the tree is a linked worktree; every case drives real git.
 */
describe("WorkingTreeDeltaReader", () => {
  let fixture: GitWorkingTreeFixture;
  let indexedCommit: string;
  let tree: string;
  let accepts: (relativePath: string) => boolean;

  const write = (relativePath: string, content: string): void => {
    const target = join(tree, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  const measured = (read: WorkingTreeDeltaRead): { changed: string[]; deleted: string[] } => {
    if (read.kind !== "measured") throw new Error(`expected measured, got degraded: ${read.reason}`);
    return { changed: [...read.delta.changed].sort(), deleted: [...read.delta.deleted].sort() };
  };

  beforeEach(async () => {
    fixture = createGitWorkingTreeFixture();
    indexedCommit = fixture.commit(
      fixture.mainRoot,
      {
        ".gitignore": "ignored.ts\n",
        ".contextignore": "generated/\n",
        "src/keep.ts": "export const keep = 1;\n",
        "src/old-name.ts": "export const moved = 1;\n",
      },
      "A",
    );
    tree = fixture.addWorktree("feature");
    const scanner = new FileScanner({ supportedExtensions: [".ts"], ignorePatterns: [] });
    await scanner.loadIgnorePatterns(tree);
    accepts = (relativePath) => scanner.accepts(relativePath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.cleanup();
  });

  it("should measure an empty delta for a clean tree at the indexed commit", async () => {
    const read = await createWorkingTreeDeltaReader().read(tree, indexedCommit, accepts);

    expect(measured(read)).toEqual({ changed: [], deleted: [] });
  });

  it("should list a file modified and committed on the branch", async () => {
    fixture.commit(tree, { "src/keep.ts": "export const keep = 2;\n" });

    const read = await createWorkingTreeDeltaReader().read(tree, indexedCommit, accepts);

    expect(measured(read)).toEqual({ changed: ["src/keep.ts"], deleted: [] });
  });

  it("should list a staged-only change", async () => {
    write("src/keep.ts", "export const keep = 3;\n");
    fixture.git(tree, "add", "src/keep.ts");

    const read = await createWorkingTreeDeltaReader().read(tree, indexedCommit, accepts);

    expect(measured(read)).toEqual({ changed: ["src/keep.ts"], deleted: [] });
  });

  it("should list an unstaged-only change", async () => {
    write("src/keep.ts", "export const keep = 4;\n");

    const read = await createWorkingTreeDeltaReader().read(tree, indexedCommit, accepts);

    expect(measured(read)).toEqual({ changed: ["src/keep.ts"], deleted: [] });
  });

  it("should list an untracked file", async () => {
    write("src/fresh.ts", "export const fresh = 1;\n");

    const read = await createWorkingTreeDeltaReader().read(tree, indexedCommit, accepts);

    expect(measured(read)).toEqual({ changed: ["src/fresh.ts"], deleted: [] });
  });

  it("should list a deleted file", async () => {
    rmSync(join(tree, "src/keep.ts"));

    const read = await createWorkingTreeDeltaReader().read(tree, indexedCommit, accepts);

    expect(measured(read)).toEqual({ changed: [], deleted: ["src/keep.ts"] });
  });

  it("should read a git mv as the source deleted and the target changed", async () => {
    fixture.git(tree, "mv", "src/old-name.ts", "src/new-name.ts");

    const read = await createWorkingTreeDeltaReader().read(tree, indexedCommit, accepts);

    expect(measured(read)).toEqual({ changed: ["src/new-name.ts"], deleted: ["src/old-name.ts"] });
  });

  it("should leave out files the ingest rules ignore", async () => {
    write("ignored.ts", "export const gitIgnored = 1;\n");
    write("generated/model.ts", "export const contextIgnored = 1;\n");
    write("notes.md.bak", "not source\n");

    const read = await createWorkingTreeDeltaReader().read(tree, indexedCommit, accepts);

    expect(measured(read)).toEqual({ changed: [], deleted: [] });
  });

  it("should measure a tree at a commit the index never saw against the indexed commit", async () => {
    fixture.commit(tree, { "src/b-only.ts": "export const b = 1;\n" }, "B");

    const read = await createWorkingTreeDeltaReader().read(tree, indexedCommit, accepts);

    expect(measured(read)).toEqual({ changed: ["src/b-only.ts"], deleted: [] });
  });

  it("should rebase the delta onto a subdirectory root and leave out files outside it", async () => {
    // An index registered at a subdirectory (live P2-2): git names paths from
    // the toplevel, the index names them from its own root.
    write("src/keep.ts", "export const keep = 3;\n");
    write("src/fresh.ts", "export const fresh = 1;\n");
    write("outside.ts", "export const outside = 1;\n");
    fixture.git(tree, "rm", "-q", "src/old-name.ts");

    const read = await createWorkingTreeDeltaReader().read(join(tree, "src"), indexedCommit, accepts);

    expect(measured(read)).toEqual({ changed: ["fresh.ts", "keep.ts"], deleted: ["old-name.ts"] });
  });

  it("should degrade when the indexed commit is not in this repository", async () => {
    const unknown = "0123456789abcdef0123456789abcdef01234567";

    const read = await createWorkingTreeDeltaReader().read(tree, unknown, accepts);

    expect(read).toEqual({
      kind: "degraded",
      reason: "indexed commit 0123456 is not in this repository",
      remedy: "tea-rags index-codebase --project {alias}",
    });
  });

  it("should degrade when the index has no indexedCommit stamp", async () => {
    const read = await createWorkingTreeDeltaReader().read(tree, null, accepts);

    expect(read).toEqual({
      kind: "degraded",
      reason: "index has no indexedCommit stamp",
      remedy: "tea-rags index-codebase --project {alias}",
    });
  });

  it("should degrade when the delta exceeds the file cap", async () => {
    for (let i = 0; i <= WORKING_TREE_DELTA_FILE_CAP; i++) write(`src/bulk/f${i}.ts`, `export const f${i} = ${i};\n`);

    const read = await createWorkingTreeDeltaReader().read(tree, indexedCommit, accepts);

    expect(read).toEqual({
      kind: "degraded",
      reason: "delta of 201 files over the 200-file cap",
      remedy: "tea-rags worktree create <name> --from {alias} --path {tree}",
    });
  });

  it("should not re-read the changes when nothing changed between two reads", async () => {
    write("src/keep.ts", "export const keep = 5;\n");
    const reader = createWorkingTreeDeltaReader();
    const spy = vi.spyOn(gitClient, "readWorkingTreeChanges");

    const first = await reader.read(tree, indexedCommit, accepts);
    const second = await reader.read(tree, indexedCommit, accepts);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("should re-read when an already-modified file is edited again", async () => {
    write("src/keep.ts", "export const keep = 6;\n");
    const reader = createWorkingTreeDeltaReader();
    const spy = vi.spyOn(gitClient, "readWorkingTreeChanges");
    const first = await reader.read(tree, indexedCommit, accepts);

    write("src/keep.ts", "export const keep = 7; // a longer edit\n");
    const second = await reader.read(tree, indexedCommit, accepts);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(measured(second)).toEqual({ changed: ["src/keep.ts"], deleted: [] });
    if (first.kind !== "measured" || second.kind !== "measured") throw new Error("expected measured reads");
    expect(second.delta.fingerprint).not.toBe(first.delta.fingerprint);
  });
});
