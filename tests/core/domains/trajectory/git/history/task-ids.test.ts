import { describe, expect, it } from "vitest";

import {
  extractTaskIds,
  isForgeRemoteUrl,
  learnTaskIdVocabulary,
  type TaskIdVocabulary,
} from "../../../../../../src/core/domains/trajectory/git/history/task-ids.js";

const vocabulary = (keys: string[], forgeIssueRefs = false): TaskIdVocabulary => ({
  projectKeys: new Set(keys),
  forgeIssueRefs,
});

/** `count` commit bodies, each naming `KEY-<n>` in an anchored subject lead. */
const anchoredBodies = (key: string, count: number, numbers: (i: number) => number): string[] =>
  Array.from({ length: count }, (_, i) => `[${key}-${numbers(i)}] change ${i}`);

describe("learnTaskIdVocabulary", () => {
  it("does not accept a key anchored in only 9 commits", () => {
    const learned = learnTaskIdVocabulary(
      anchoredBodies("TD", 9, (i) => 100 + i),
      [],
    );
    expect(learned.projectKeys.has("TD")).toBe(false);
  });

  it("does not accept a key anchored in 10 commits with one distinct number", () => {
    const learned = learnTaskIdVocabulary(
      anchoredBodies("TD", 10, () => 7),
      [],
    );
    expect(learned.projectKeys.has("TD")).toBe(false);
  });

  it("accepts a key anchored in 10 commits with 2 distinct numbers", () => {
    const learned = learnTaskIdVocabulary(
      anchoredBodies("TD", 10, (i) => (i % 2 === 0 ? 1 : 2)),
      [],
    );
    expect(learned.projectKeys.has("TD")).toBe(true);
  });

  it("learns from every anchored position", () => {
    const bodies = [
      ...Array.from({ length: 2 }, (_, i) => `TD-${i + 1}: subject`),
      ...Array.from({ length: 2 }, (_, i) => `fix(TD-${i + 3}): subject`),
      ...Array.from({ length: 2 }, (_, i) => `Merge branch 'feature/TD-${i + 5}-x' into 'main'`),
      ...Array.from({ length: 2 }, (_, i) => `chore: tidy\n\nCloses TD-${i + 7}`),
      `docs: x\n\nsee TD-9`,
      `docs: y\n\nPart of TD-10`,
    ];
    expect(learnTaskIdVocabulary(bodies, []).projectKeys.has("TD")).toBe(true);
  });

  it("never accepts a key seen only in free text", () => {
    const bodies = Array.from({ length: 40 }, (_, i) => `feat: support UTF-${i % 3 === 0 ? 8 : 16} paths`);
    expect(learnTaskIdVocabulary(bodies, []).projectKeys.has("UTF")).toBe(false);
  });

  it("enables #N references only with a GitHub or GitLab remote", () => {
    expect(learnTaskIdVocabulary([], ["git@github.com:org/repo.git"]).forgeIssueRefs).toBe(true);
    expect(learnTaskIdVocabulary([], ["git@gitlab.example.dev:org/repo.git"]).forgeIssueRefs).toBe(true);
    expect(learnTaskIdVocabulary([], ["https://bitbucket.org/org/repo.git"]).forgeIssueRefs).toBe(false);
    expect(learnTaskIdVocabulary([], []).forgeIssueRefs).toBe(false);
  });
});

describe("isForgeRemoteUrl", () => {
  it("reads the host of scp-like and URL remotes", () => {
    expect(isForgeRemoteUrl("git@github.com:artk0de/TeaRAGs-MCP.git")).toBe(true);
    expect(isForgeRemoteUrl("https://gitlab.com/group/project.git")).toBe(true);
    expect(isForgeRemoteUrl("ssh://git@gitlab.corp.dev:2222/group/project.git")).toBe(true);
    expect(isForgeRemoteUrl("/srv/git/project.git")).toBe(false);
    expect(isForgeRemoteUrl("https://example.com/github/project.git")).toBe(false);
  });
});

describe("extractTaskIds", () => {
  it("counts an accepted key anywhere in the message", () => {
    expect(extractTaskIds("fix: resolve TD-1234 issue", vocabulary(["TD"]))).toEqual(["TD-1234"]);
  });

  it("never counts a key the vocabulary did not accept", () => {
    expect(extractTaskIds("feat: UTF-8 and SHA-256 under LEVEL-2", vocabulary(["TD"]))).toEqual([]);
  });

  it("preserves TD-style recall in every position", () => {
    const ids = extractTaskIds("[TD-101] subject\n\nalso touches TD-102, TD-103", vocabulary(["TD"]));
    expect(ids).toEqual(["TD-101", "TD-102", "TD-103"]);
  });

  it("counts #N in a closing context with a forge remote", () => {
    expect(extractTaskIds("fixes #12", vocabulary([], true))).toEqual(["#12"]);
    expect(extractTaskIds("feat: thing (#34)", vocabulary([], true))).toEqual(["#34"]);
    expect(extractTaskIds("see PR #56 and pull request #57", vocabulary([], true))).toEqual(["#56", "#57"]);
    expect(extractTaskIds("thanks [#78](https://github.com/o/r/issues/78)", vocabulary([], true))).toEqual(["#78"]);
  });

  it("does not count #N used as numbering", () => {
    expect(extractTaskIds("1. step #2 then #3", vocabulary([], true))).toEqual([]);
  });

  it("does not count #N without a forge remote", () => {
    expect(extractTaskIds("fixes #12", vocabulary([], false))).toEqual([]);
  });

  it("never counts !N merge-request footers", () => {
    expect(extractTaskIds("merged\n\nSee merge request group/repo!789", vocabulary(["TD"], true))).toEqual([]);
  });

  it("extracts Azure DevOps IDs", () => {
    expect(extractTaskIds("AB#456 done", vocabulary([]))).toEqual(["AB#456"]);
  });

  it("returns empty for empty input", () => {
    expect(extractTaskIds("", vocabulary(["TD"], true))).toEqual([]);
  });
});
