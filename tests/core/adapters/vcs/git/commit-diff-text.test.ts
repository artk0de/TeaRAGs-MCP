/**
 * Real-git tests for `readCommitDiffText` — the zero-context patch text of
 * named commits, one spawn, each commit headed by a NUL and its SHA (bd
 * tea-rags-mcp-v2525). The co-change build reads it to tell an identifier
 * rename sweep from an edit.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importGitHistory } from "../../../__helpers__/git-history-import.js";
import { GitCliAdapter } from "../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";

const TMP_BASE = realpathSync(tmpdir());
const NUL = String.fromCharCode(0);

describe("readCommitDiffText (real git)", () => {
  let tmp: string;
  let shas: Record<string, string>;

  beforeEach(() => {
    tmp = mkdtempSync(join(TMP_BASE, "git-diff-text-"));
    if (!resolve(tmp).startsWith(TMP_BASE + sep)) throw new Error(`refusing git in non-temp cwd: ${tmp}`);
    const who = { name: "Test", email: "t@example.com" };
    shas = importGitHistory(tmp, [
      {
        label: "c1",
        message: "c1",
        author: who,
        authorDate: "2024-01-01T00:00:00Z",
        writes: { "a.ts": "x\nFoo\ny\n" },
      },
      {
        label: "c2",
        message: "c2",
        author: who,
        authorDate: "2024-02-01T00:00:00Z",
        writes: { "a.ts": "x\nBar\ny\n" },
      },
      { label: "c3", message: "c3", author: who, authorDate: "2024-03-01T00:00:00Z", writes: { "b.ts": "z\n" } },
    ]);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prints each named commit's -U0 patch under a NUL + SHA header, in the order named", async () => {
    const text = await new GitCliAdapter(tmp).readCommitDiffText([shas.c3, shas.c2]);

    const sections = text.split(NUL).filter((section) => section.trim() !== "");
    expect(sections.map((section) => section.split("\n")[0])).toEqual([shas.c3, shas.c2]);
    expect(sections[1]).toContain("@@ -2 +2 @@");
    expect(sections[1]).toContain("\n-Foo\n+Bar");
  });

  it("answers an empty string for no commits without spawning git", async () => {
    await expect(new GitCliAdapter(tmp).readCommitDiffText([])).resolves.toBe("");
  });
});
