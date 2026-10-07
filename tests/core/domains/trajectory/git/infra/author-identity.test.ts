/**
 * bd tea-rags-mcp-nsxzh — one person, one author. The git trajectory keys an
 * author by the commit's (mailmap-applied) EMAIL, lowercased; two display
 * names sharing an email are one identity everywhere the trajectory counts or
 * groups authors, and two emails stay two identities even when the name is
 * the same.
 */
import { describe, expect, it, vi } from "vitest";

import type { VcsGitAdapter } from "../../../../../../src/core/adapters/vcs/git/adapter.js";
import type {
  BlameLine,
  CommitFileNumstat,
  CommitInfo,
  FileChurnData,
} from "../../../../../../src/core/adapters/vcs/types.js";
import { assembleOverlays } from "../../../../../../src/core/domains/trajectory/git/infra/assemble-overlays.js";
import {
  authorIdentityKey,
  buildAuthorNameDirectory,
  canonicalizeAuthorNames,
  tallyAuthors,
} from "../../../../../../src/core/domains/trajectory/git/infra/author-identity.js";
import { computeBlameOwnership } from "../../../../../../src/core/domains/trajectory/git/infra/blame-ownership.js";
import { FileChurnDiscovery } from "../../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery.js";
import type { ChunkAccumulator } from "../../../../../../src/core/domains/trajectory/git/infra/metrics.js";
import { computeDominantAuthor } from "../../../../../../src/core/domains/trajectory/git/infra/metrics/extractors.js";
import { assembleFileSignals } from "../../../../../../src/core/domains/trajectory/git/infra/metrics/file-assembler.js";
import {
  groupIntoSessions,
  partitionIntoAuthorSessions,
} from "../../../../../../src/core/domains/trajectory/git/infra/metrics/sessions.js";

const BASE_TS = 1_700_000_000;
const MIN = 60;

function commit(sha: string, author: string, authorEmail: string, timestamp = BASE_TS): CommitInfo {
  return { sha, author, authorEmail, timestamp, body: "feat: x", parents: [] };
}

function blame(lineNumber: number, author: string, authorEmail: string): BlameLine {
  return { lineNumber, sha: `s${lineNumber}`, author, authorEmail, timestamp: BASE_TS };
}

// The tea-rags case: one person committing under two names with one address.
const ART = "art@example.com";

describe("authorIdentityKey", () => {
  it("is the lowercased, trimmed email", () => {
    expect(authorIdentityKey({ author: "artk0de", authorEmail: " Art@Example.COM " })).toBe(ART);
    expect(authorIdentityKey({ author: "Arthur Korochansky", authorEmail: ART })).toBe(ART);
  });

  it("falls back to the name when no email is known, never colliding with an email key", () => {
    const key = authorIdentityKey({ author: "Alice", authorEmail: "" });
    expect(key).not.toBe("");
    expect(key).not.toBe(authorIdentityKey({ author: "Bob", authorEmail: "" }));
  });
});

describe("tallyAuthors", () => {
  it("merges names sharing an email and names the identity by its most frequent name", () => {
    const tally = tallyAuthors([
      { author: "Arthur Korochansky", authorEmail: ART },
      { author: "artk0de", authorEmail: "ART@example.com" },
      { author: "artk0de", authorEmail: ART },
      { author: "bob", authorEmail: "bob@example.com" },
    ]);
    expect(tally).toEqual([
      { key: ART, name: "artk0de", email: ART, count: 3 },
      { key: "bob@example.com", name: "bob", email: "bob@example.com", count: 1 },
    ]);
  });

  it("breaks a name tie by code-point order, independent of input order", () => {
    const a = tallyAuthors([
      { author: "zed", authorEmail: ART },
      { author: "Arthur", authorEmail: ART },
    ]);
    const b = tallyAuthors([
      { author: "Arthur", authorEmail: ART },
      { author: "zed", authorEmail: ART },
    ]);
    expect(a[0].name).toBe("Arthur");
    expect(b[0].name).toBe("Arthur");
  });

  it("orders identities by count desc, then by display name code-point order", () => {
    const tally = tallyAuthors([
      { author: "b", authorEmail: "b@x" },
      { author: "a", authorEmail: "a@x" },
    ]);
    expect(tally.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("keeps two emails under one name as two identities", () => {
    const tally = tallyAuthors([
      { author: "Test", authorEmail: "agent1@x" },
      { author: "Test", authorEmail: "agent2@x" },
    ]);
    expect(tally).toHaveLength(2);
  });
});

describe("recent ownership (computeDominantAuthor) keys by identity", () => {
  it("counts two names with one email as one author", () => {
    const result = computeDominantAuthor([
      commit("1", "artk0de", ART),
      commit("2", "artk0de", ART),
      commit("3", "Arthur Korochansky", "Art@Example.com"),
      commit("4", "bob", "bob@example.com"),
    ]);
    expect(result.author).toBe("artk0de");
    expect(result.email).toBe(ART);
    expect(result.pct).toBe(75);
    expect(result.authors).toEqual(["artk0de", "bob"]);
    expect(result.contributorCount).toBe(2);
  });

  it("keeps distinct emails distinct", () => {
    const result = computeDominantAuthor([commit("1", "Test", "a1@x"), commit("2", "Test", "a2@x")]);
    expect(result.contributorCount).toBe(2);
    expect(result.pct).toBe(50);
  });
});

describe("blame ownership keys by identity", () => {
  it("merges two names with one email at file and chunk level", () => {
    const lines = [
      blame(1, "artk0de", ART),
      blame(2, "Arthur Korochansky", ART),
      blame(3, "Arthur Korochansky", ART),
      blame(4, "bob", "bob@example.com"),
    ];
    const { file, chunks } = computeBlameOwnership(lines, [{ chunkId: "c", startLine: 1, endLine: 3 }]);
    expect(file.blameDominantAuthor).toBe("Arthur Korochansky");
    expect(file.blameDominantAuthorPct).toBe(75);
    expect(file.blameAuthors).toEqual(["Arthur Korochansky", "bob"]);
    expect(file.blameContributorCount).toBe(2);
    expect(chunks.get("c")).toEqual({
      blameDominantAuthor: "Arthur Korochansky",
      blameDominantAuthorPct: 100,
      blameAuthors: ["Arthur Korochansky"],
      blameContributorCount: 1,
    });
  });

  it("keeps distinct emails distinct", () => {
    const { file } = computeBlameOwnership([blame(1, "Test", "a1@x"), blame(2, "Test", "a2@x")]);
    expect(file.blameContributorCount).toBe(2);
  });
});

describe("sessions key by identity", () => {
  it("puts one person's burst under two names into one session", () => {
    const rows = [commit("a", "artk0de", ART, BASE_TS), commit("b", "Arthur Korochansky", ART, BASE_TS + 5 * MIN)];
    expect(partitionIntoAuthorSessions(rows, (c) => c, 30)).toHaveLength(1);
    expect(groupIntoSessions(rows, 30)).toHaveLength(1);
  });

  it("keeps two emails under one name in separate sessions", () => {
    const rows = [commit("a", "Test", "a1@x", BASE_TS), commit("b", "Test", "a2@x", BASE_TS + 5 * MIN)];
    expect(partitionIntoAuthorSessions(rows, (c) => c, 30)).toHaveLength(2);
  });

  it("squash-aware file signals keep one author for one identity", () => {
    const churn: FileChurnData = {
      commits: [
        commit("a", "artk0de", ART, BASE_TS),
        commit("b", "Arthur Korochansky", ART, BASE_TS + 5 * MIN),
        commit("c", "bob", "bob@example.com", BASE_TS + 6 * MIN),
      ],
      linesAdded: 3,
      linesDeleted: 0,
    };
    const signals = assembleFileSignals(churn, 10, { squashAwareSessions: true, sessionGapMinutes: 30 });
    expect(signals.commitCount).toBe(2); // one session per identity, not three
    expect(signals.recentContributorCount).toBe(2);
    expect(signals.recentDominantAuthorEmail).toBe(ART);
  });
});

describe("chunk contributor count keys by identity", () => {
  it("bounds the chunk count by the file's identity count, not its name count", () => {
    // Two chunk-side identities, but the file window holds ONE identity under
    // two names: the file bound must be 1, not 2.
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a", "b"]),
      authors: new Set([ART, "bob@example.com"]),
      bugFixCount: 0,
      lastModifiedAt: BASE_TS,
      taskIds: new Set(),
      linesAdded: 2,
      linesDeleted: 0,
      commitTimestamps: [BASE_TS, BASE_TS + 1],
      commitAuthors: [ART, ART],
    } as unknown as ChunkAccumulator;
    const overlays = assembleOverlays({
      relativeChunkMap: new Map([["f.ts", [{ chunkId: "c", startLine: 1, endLine: 2 } as never]]]),
      accumulators: new Map([["c", acc]]),
      fileChurnDataMap: new Map([
        [
          "f.ts",
          {
            commits: [commit("a", "artk0de", ART), commit("b", "Arthur Korochansky", ART)],
            linesAdded: 2,
            linesDeleted: 0,
          },
        ],
      ]),
    });
    expect(overlays.get("f.ts")?.get("c")?.recentContributorCount).toBe(1);
  });
});

describe("one canonical display name per identity for the whole run", () => {
  const NOW_SEC = Math.floor(Date.now() / 1000);

  function numstat(sha: string, author: string, email: string, path: string, ago: number): CommitFileNumstat {
    const ts = NOW_SEC - ago;
    return {
      commit: commit(sha, author, email, ts),
      committerTimestamp: ts,
      files: [{ path, added: 1, deleted: 0 }],
    };
  }

  function discoveryOver(entries: CommitFileNumstat[]): FileChurnDiscovery {
    const adapter = {
      repoRoot: "/repo",
      getHead: vi.fn().mockResolvedValue("h".repeat(40)),
      isAncestor: vi.fn().mockResolvedValue(false),
      readCommitFileNumstat: vi.fn().mockResolvedValue(entries),
    };
    return new FileChurnDiscovery(adapter as unknown as VcsGitAdapter, { maxAgeMonths: 12, timeoutMs: 1000 });
  }

  // File A's records favour "artk0de", file B's favour "Arthur Korochansky";
  // repo-wide "Arthur Korochansky" has the most commits (3 vs 2).
  const entries = [
    numstat("a1", "artk0de", ART, "a.ts", 100),
    numstat("a2", "artk0de", ART, "a.ts", 200),
    numstat("a3", "Arthur Korochansky", ART, "a.ts", 300),
    numstat("b1", "Arthur Korochansky", ART, "b.ts", 400),
    numstat("b2", "Arthur Korochansky", ART, "b.ts", 500),
    numstat("o1", "bob", "bob@example.com", "b.ts", 600),
  ];

  it("shows the repo-wide most frequent name on every file, so one exact-name filter matches all of them", async () => {
    const churn = await discoveryOver(entries).fileChurn();
    const sigsA = assembleFileSignals(churn.get("a.ts") as never, 10);
    const sigsB = assembleFileSignals(churn.get("b.ts") as never, 10);

    expect(sigsA.recentDominantAuthor).toBe("Arthur Korochansky");
    expect(sigsB.recentDominantAuthor).toBe("Arthur Korochansky");
    // The `author=` / `contributor=` filter is an exact match on the NAME.
    const files = [sigsA, sigsB];
    expect(files.filter((f) => f.recentDominantAuthor === "Arthur Korochansky")).toHaveLength(2);
    expect(files.filter((f) => f.recentAuthors.includes("Arthur Korochansky"))).toHaveLength(2);
  });

  it("applies the same name to blame lines, file and chunk level", async () => {
    const names = await discoveryOver(entries).authorNames();
    const lines = canonicalizeAuthorNames(
      [blame(1, "artk0de", ART), blame(2, "artk0de", ART), blame(3, "bob", "bob@example.com")],
      names,
    ) as BlameLine[];
    const owner = computeBlameOwnership(lines, [{ chunkId: "c", startLine: 1, endLine: 2 }]);
    expect(owner.file.blameDominantAuthor).toBe("Arthur Korochansky");
    expect(owner.chunks.get("c")?.blameDominantAuthor).toBe("Arthur Korochansky");
    expect(owner.file.blameAuthors).toEqual(["Arthur Korochansky", "bob"]);
  });

  it("keeps the mailmap name: an identity already unified upstream has ONE name the directory cannot override", async () => {
    const mapped = entries.map((e) => ({
      ...e,
      commit: e.commit.authorEmail === ART ? { ...e.commit, author: "Art K" } : e.commit,
    }));
    const churn = await discoveryOver(mapped).fileChurn();
    expect(assembleFileSignals(churn.get("a.ts") as never, 10).recentDominantAuthor).toBe("Art K");
    expect(assembleFileSignals(churn.get("b.ts") as never, 10).recentDominantAuthor).toBe("Art K");
  });

  it("falls back to the per-tally name for an identity outside the window (blame-only)", () => {
    const directory = buildAuthorNameDirectory([commit("x", "Arthur Korochansky", ART)]);
    const lines = canonicalizeAuthorNames(
      [blame(1, "old", "old@example.com"), blame(2, "Old", "old@example.com"), blame(3, "old", "old@example.com")],
      directory,
    );
    expect(tallyAuthors(lines)[0].name).toBe("old");
  });

  it("does not mutate its input and returns the same array when nothing changes", () => {
    const directory = buildAuthorNameDirectory([commit("x", "N", ART)]);
    const same = [blame(1, "N", ART)];
    expect(canonicalizeAuthorNames(same, directory)).toBe(same);
    const differing = [blame(1, "n", ART)];
    const out = canonicalizeAuthorNames(differing, directory);
    expect(out[0].author).toBe("N");
    expect(differing[0].author).toBe("n");
  });
});
