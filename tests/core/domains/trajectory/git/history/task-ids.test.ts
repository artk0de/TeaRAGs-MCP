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

/** `n` distinct hash-shaped 5-char suffixes: letters plus a digit, no position constant across them. */
const hashSuffixes = (n: number): string[] => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  return Array.from({ length: n }, (_, i) => {
    const chars = Array.from({ length: 4 }, (__, p) => alphabet[(i * 7 + p * 11 + i * p * 5) % 26]);
    return `${chars.join("")}${i % 10}`;
  });
};

/** One commit per suffix, each naming `<prefix>-<suffix>` in its body. */
const hashIdBodies = (prefix: string, suffixes: string[]): string[] =>
  suffixes.map((suffix, i) => `feat(api): change ${i}\n\nCloses ${prefix}-${suffix}`);

describe("hash-suffixed task ids (bd tea-rags-mcp-0ik6q)", () => {
  const suffixes = hashSuffixes(12);
  const learned = learnTaskIdVocabulary(hashIdBodies("acme-tracker", suffixes), []);

  it("learns a prefix named by 10+ commits with distinct hash-shaped suffixes", () => {
    expect([...(learned.hashIdPrefixes ?? [])]).toEqual(["acme-tracker"]);
  });

  it("extracts the full form, a dotted child keeping its full id", () => {
    expect(extractTaskIds("fix: x\n\nsee acme-tracker-k3p9q and acme-tracker-89k7k.35.21", learned)).toEqual([
      "acme-tracker-k3p9q",
      "acme-tracker-89k7k.35.21",
    ]);
  });

  it("extracts the short form trailing the subject under the learned prefix", () => {
    expect(extractTaskIds("perf(api): overlap concept searches (wijz7)", learned)).toEqual(["acme-tracker-wijz7"]);
  });

  it("extracts nothing below the commit threshold", () => {
    const thin = learnTaskIdVocabulary(hashIdBodies("acme-tracker", suffixes.slice(0, 9)), []);
    expect(thin.hashIdPrefixes?.size ?? 0).toBe(0);
    expect(extractTaskIds("fix: x (wijz7)\n\nacme-tracker-k3p9q", thin)).toEqual([]);
  });

  it("ignores the ids of a prefix it did not learn", () => {
    expect(extractTaskIds("fix: x\n\nsee other-tool-k3p9q", learned)).toEqual([]);
  });

  it("ignores a 5-char token without a digit", () => {
    expect(extractTaskIds("docs: tidy the guide (typos)", learned)).toEqual([]);
    expect(extractTaskIds("docs: x\n\nacme-tracker-words", learned)).toEqual([]);
  });

  it("ignores a conventional-commit scope", () => {
    expect(extractTaskIds("fix(wijz7): subject", learned)).toEqual([]);
  });

  it("ignores a parenthesized token in the middle of the subject", () => {
    expect(extractTaskIds("fix: retry (wijz7) on failure", learned)).toEqual([]);
  });

  it("ignores a trailing token in the body rather than the subject", () => {
    expect(extractTaskIds("fix: subject\n\nbody line (wijz7)", learned)).toEqual([]);
  });

  it("does not learn a prefix whose suffixes are plain numbers", () => {
    const numeric = Array.from({ length: 20 }, (_, i) => `chore: sync\n\ncrowdin-new-locales-${90000 + i * 37}`);
    expect(learnTaskIdVocabulary(numeric, []).hashIdPrefixes?.size ?? 0).toBe(0);
  });

  it("does not learn a prefix whose suffixes share a stem", () => {
    const parts = Array.from({ length: 12 }, (_, i) => `refactor: step\n\nweekly-js-ts-part${i % 9}`);
    expect(learnTaskIdVocabulary(parts, []).hashIdPrefixes?.size ?? 0).toBe(0);
  });

  it("does not learn a prefix that only re-names another prefix's ids", () => {
    const borrowed = suffixes.slice(0, 10).map((suffix) => `chore: clean\n\nremove worktree-${suffix}`);
    const both = learnTaskIdVocabulary([...hashIdBodies("acme-tracker", suffixes), ...borrowed], []);
    expect([...(both.hashIdPrefixes ?? [])]).toEqual(["acme-tracker"]);
  });

  it("does not learn a branch prefix named after ids the dominant prefix cites only in the short form", () => {
    const shortOnly = hashSuffixes(24).slice(12);
    const bodies = [
      ...hashIdBodies("acme-tracker", suffixes),
      ...shortOnly.map((suffix, i) => `fix(api): change ${i} (${suffix})`),
      ...shortOnly.slice(0, 10).map((suffix) => `Merge branch 'worktree-${suffix}'`),
    ];
    expect([...(learnTaskIdVocabulary(bodies, []).hashIdPrefixes ?? [])]).toEqual(["acme-tracker"]);
  });

  it("drops the short form when two prefixes are learned", () => {
    const other = hashSuffixes(24).slice(12);
    const two = learnTaskIdVocabulary(
      [...hashIdBodies("acme-tracker", suffixes), ...hashIdBodies("side-tracker", other)],
      [],
    );
    expect(two.hashIdPrefixes?.size).toBe(2);
    expect(extractTaskIds("perf(api): overlap (wijz7)", two)).toEqual([]);
  });
});
