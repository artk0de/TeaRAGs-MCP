/**
 * CommitDriftMonitor (bd tea-rags-mcp-zf3x0).
 *
 * The stamp side of the working-tree axis: `BaseIndexingPipeline` records the
 * branch/commit/dirty triple at finalize, and this monitor reads it back
 * against the repository's live HEAD. Only a MOVED HEAD is a finding — a dirty
 * tree at index time is a note on it, because a dirty-only finding could never
 * clear while a developer works (spec decision 7).
 */

import { describe, expect, it } from "vitest";

import { CommitDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/commit-drift-monitor.js";

const entry = {
  path: "/p",
  git: { indexedBranch: "main", indexedCommit: "abcdef1234567890", indexedDirty: false },
};

const dirtyEntry = { ...entry, git: { ...entry.git, indexedDirty: true } };

describe("CommitDriftMonitor", () => {
  it("reports a moved HEAD with the incremental remedy", () => {
    const monitor = new CommitDriftMonitor({ get: () => entry } as never, () => ({
      branch: "main",
      commit: "0123456789abcdef",
      transient: false,
    }));

    expect(monitor.check("c")).toEqual([
      {
        axis: "commit",
        subject: "main",
        indexed: "abcdef1",
        current: "0123456",
        remedy: { kind: "incremental" },
        note: "HEAD moved since the last index run",
      },
    ]);
  });

  it("annotates a moved HEAD when the tree was dirty at index time", () => {
    const monitor = new CommitDriftMonitor({ get: () => dirtyEntry } as never, () => ({
      branch: "main",
      commit: "0123456789abcdef",
      transient: false,
    }));

    expect(monitor.check("c")[0]).toMatchObject({
      indexed: "abcdef1 (dirty)",
      note: "HEAD moved since the last index run; the tree was dirty when it was indexed",
    });
  });

  it("is silent when HEAD did not move, even if the tree was dirty at index time", () => {
    // A developer's tree is dirty for the whole session; a dirty-only finding could never clear (spec decision 7).
    const monitor = new CommitDriftMonitor({ get: () => dirtyEntry } as never, () => ({
      branch: "main",
      commit: entry.git.indexedCommit,
      transient: false,
    }));

    expect(monitor.check("c")).toEqual([]);
  });

  it("is silent without a stamp, outside a repo, or when nothing moved", () => {
    expect(new CommitDriftMonitor({ get: () => ({ path: "/p" }) } as never, () => null).check("c")).toEqual([]);
    expect(new CommitDriftMonitor({ get: () => entry } as never, () => null).check("c")).toEqual([]);
    expect(
      new CommitDriftMonitor({ get: () => entry } as never, () => ({
        branch: "main",
        commit: entry.git.indexedCommit,
        transient: false,
      })).check("c"),
    ).toEqual([]);
  });

  it("reports against the STORED branch when live HEAD is detached", () => {
    // A detached HEAD has no branch to name, but the index was built on one —
    // `subject` is the stamp's branch, so the reader still learns which branch
    // the index represents rather than a bare "HEAD".
    const monitor = new CommitDriftMonitor({ get: () => entry } as never, () => ({
      branch: null,
      commit: "0123456789abcdef",
      transient: false,
    }));

    expect(monitor.check("c")).toEqual([
      {
        axis: "commit",
        subject: "main",
        indexed: "abcdef1",
        current: "0123456",
        remedy: { kind: "incremental" },
        note: "HEAD moved since the last index run",
      },
    ]);
  });

  it("falls back to HEAD as the subject when the index itself was built detached", () => {
    const detachedStamp = { ...entry, git: { ...entry.git, indexedBranch: null } };
    const monitor = new CommitDriftMonitor({ get: () => detachedStamp } as never, () => ({
      branch: null,
      commit: "0123456789abcdef",
      transient: false,
    }));

    expect(monitor.check("c")[0]).toMatchObject({ subject: "HEAD" });
  });

  it("still reports mid-rebase — `transient` gates auto-update, not the report", () => {
    // `RepoGitState.transient` is documented as "a rebase / merge / bisect is in
    // progress — auto-update must NOT fire", and `IndexFreshnessCheck` is the
    // one place that gate lives. Suppressing here would duplicate that policy
    // and would make `get_index_status` read clean mid-rebase while the index
    // is genuinely behind, so the monitor reports the truth and leaves firing
    // to the freshness check.
    const monitor = new CommitDriftMonitor({ get: () => entry } as never, () => ({
      branch: null,
      commit: "0123456789abcdef",
      transient: true,
    }));

    expect(monitor.check("c")).toEqual([
      {
        axis: "commit",
        subject: "main",
        indexed: "abcdef1",
        current: "0123456",
        remedy: { kind: "incremental" },
        note: "HEAD moved since the last index run",
      },
    ]);
  });

  it("is silent when the stamped commit could not be resolved (unborn ref)", () => {
    const unborn = { ...entry, git: { ...entry.git, indexedCommit: "" } };

    expect(
      new CommitDriftMonitor({ get: () => unborn } as never, () => ({
        branch: "main",
        commit: "0123456789abcdef",
        transient: false,
      })).check("c"),
    ).toEqual([]);
  });

  it("is silent when the collection is not registered at all", () => {
    expect(new CommitDriftMonitor({ get: () => null } as never, () => null).check("c")).toEqual([]);
  });
});
