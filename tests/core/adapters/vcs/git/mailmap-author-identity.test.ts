/**
 * bd tea-rags-mcp-nsxzh — the git adapter reports the author AFTER the repo's
 * `.mailmap` is applied, on both the log path (`%aN` / `%aE`) and the blame
 * path (`git blame --porcelain` applies the mailmap to `author` /
 * `author-mail` itself). Real git against a tiny temp repo, same harness as
 * `commit-file-numstat.test.ts`.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importGitHistory } from "../../../__helpers__/git-history-import.js";
import { GitCliAdapter } from "../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";

const TMP_BASE = realpathSync(tmpdir());

const WORK = { name: "Arthur Korochansky", email: "arthur@work.example" };
const HOME = { name: "artk0de", email: "art@home.example" };
const OTHER = { name: "Bob", email: "bob@example.com" };

const CANONICAL = "Arthur Korochansky <arthur@work.example>";

describe("author identity honours .mailmap (real git)", () => {
  let tmp: string;
  let adapter: GitCliAdapter;

  beforeEach(() => {
    tmp = mkdtempSync(join(TMP_BASE, "git-mailmap-"));
    if (!resolve(tmp).startsWith(TMP_BASE + sep)) {
      throw new Error(`mailmap-author-identity.test: refusing git in non-temp cwd: ${tmp}`);
    }
    importGitHistory(
      tmp,
      [
        { label: "c1", message: "c1", author: WORK, authorDate: "2024-01-01T00:00:00Z", writes: { "a.ts": "1\n" } },
        { label: "c2", message: "c2", author: HOME, authorDate: "2024-01-02T00:00:00Z", writes: { "a.ts": "1\n2\n" } },
        {
          label: "c3",
          message: "c3",
          author: OTHER,
          authorDate: "2024-01-03T00:00:00Z",
          // The mailmap maps the HOME address onto the WORK identity.
          writes: { "a.ts": "1\n2\n3\n", ".mailmap": `${CANONICAL} <${HOME.email}>\n` },
        },
      ],
      { config: { "user.email": "t@example.com", "user.name": "Test", "commit.gpgsign": "false" } },
    );
    adapter = new GitCliAdapter(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("log readers return the mailmap-canonical name and email", async () => {
    const commits = await adapter.getCommitsSince(new Date("2023-01-01T00:00:00Z"));
    expect(commits.map((c) => [c.commit.author, c.commit.authorEmail])).toEqual([
      [OTHER.name, OTHER.email],
      [WORK.name, WORK.email],
      [WORK.name, WORK.email],
    ]);

    const churn = await adapter.readNumstatLog(new Date("2023-01-01T00:00:00Z"));
    const authors = new Set(churn.get("a.ts")?.commits.map((c) => `${c.author} <${c.authorEmail}>`));
    expect([...authors].sort()).toEqual([CANONICAL, `${OTHER.name} <${OTHER.email}>`].sort());
  });

  it("blame returns the mailmap-canonical name and email", async () => {
    const lines = await adapter.blameFile("a.ts");
    expect(lines.map((l) => `${l.author} <${l.authorEmail}>`)).toEqual([
      CANONICAL,
      CANONICAL,
      `${OTHER.name} <${OTHER.email}>`,
    ]);
  });
});
