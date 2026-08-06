import { describe, expect, it } from "vitest";

import type { CollectionEntry, RegistryAutoUpdateConfig } from "../../../../../src/core/contracts/types/registry.js";
import {
  AUTO_UPDATE_FAILURE_BACKOFF_MS,
  AUTO_UPDATE_RUN_TTL_MS,
  IndexFreshnessCheck,
} from "../../../../../src/core/domains/maintenance/freshness/index.js";
import type { RepoGitState } from "../../../../../src/core/infra/repo-git-state.js";

const NOW = 1_000_000_000;

const baseEntry: CollectionEntry = {
  collectionName: "code_abc",
  path: "/repo/a",
  name: "proj",
  embeddingModel: "m",
  embeddingDimensions: 384,
  qdrantUrl: "http://localhost:6333",
  indexedAt: "2026-08-06T00:00:00.000Z",
  teaRagsVersion: "1.0.0",
  chunksCount: 10,
};

const onMaster: RepoGitState = { branch: "master", commit: "abc123", transient: false };

function entry(over: Partial<CollectionEntry> = {}): CollectionEntry {
  return {
    ...baseEntry,
    autoUpdate: { enabled: true, targetBranch: "master" },
    ...over,
  };
}

function auto(over: Partial<RegistryAutoUpdateConfig> = {}): RegistryAutoUpdateConfig {
  return { enabled: true, targetBranch: "master", ...over };
}

function check(e: CollectionEntry, state: RepoGitState | null, now: number = NOW) {
  return new IndexFreshnessCheck({ readGitState: () => state, clock: () => now }).check(e);
}

describe("IndexFreshnessCheck", () => {
  it("disabled when the autoUpdate block is missing", () => {
    expect(check(entry({ autoUpdate: undefined }), onMaster).kind).toBe("disabled");
  });

  it("disabled when enabled=false", () => {
    expect(check(entry({ autoUpdate: auto({ enabled: false }) }), onMaster).kind).toBe("disabled");
  });

  it("not-a-repo when git state is unreadable", () => {
    expect(check(entry(), null).kind).toBe("not-a-repo");
  });

  it("transient during rebase/merge — even on the target branch", () => {
    expect(check(entry(), { ...onMaster, transient: true }).kind).toBe("transient");
  });

  it("branch-mismatch carries head and target", () => {
    expect(check(entry(), { ...onMaster, branch: "feature-x" })).toEqual({
      kind: "branch-mismatch",
      head: "feature-x",
      targetBranch: "master",
    });
  });

  it("branch-mismatch on detached HEAD (head null)", () => {
    expect(check(entry(), { ...onMaster, branch: null })).toEqual({
      kind: "branch-mismatch",
      head: null,
      targetBranch: "master",
    });
  });

  it("debounced within the run TTL after a successful run", () => {
    const lastRun = {
      at: new Date(NOW - AUTO_UPDATE_RUN_TTL_MS + 1000).toISOString(),
      outcome: "ok" as const,
      durationMs: 100,
      filesChanged: 1,
    };
    const verdict = check(entry({ autoUpdate: auto({ lastRun }) }), onMaster);
    expect(verdict).toEqual({ kind: "debounced", reason: "recent-run" });
  });

  it("eligible once the run TTL has expired", () => {
    const lastRun = {
      at: new Date(NOW - AUTO_UPDATE_RUN_TTL_MS - 1000).toISOString(),
      outcome: "ok" as const,
      durationMs: 100,
      filesChanged: 1,
    };
    expect(check(entry({ autoUpdate: auto({ lastRun }) }), onMaster).kind).toBe("eligible");
  });

  it("failure backoff extends the debounce window", () => {
    const failedAt = NOW - AUTO_UPDATE_RUN_TTL_MS - 1000; // past run TTL...
    const lastRun = {
      at: new Date(failedAt).toISOString(),
      outcome: "failed" as const,
      durationMs: 100,
      filesChanged: 0,
      error: "boom",
    };
    const e = entry({ autoUpdate: auto({ lastRun }) });
    // ...but still inside the failure backoff → debounced.
    expect(check(e, onMaster)).toEqual({ kind: "debounced", reason: "failure-backoff" });
    // Beyond the backoff → eligible again.
    expect(check(e, onMaster, failedAt + AUTO_UPDATE_FAILURE_BACKOFF_MS + 1000).kind).toBe("eligible");
  });

  it("eligible on the target branch with no debounce, carrying the entry", () => {
    const e = entry();
    expect(check(e, onMaster)).toEqual({ kind: "eligible", entry: e });
  });

  it("malformed lastRun.at never throws — treated as no debounce", () => {
    const lastRun = { at: "not-a-date", outcome: "ok" as const, durationMs: 1, filesChanged: 1 };
    expect(check(entry({ autoUpdate: auto({ lastRun }) }), onMaster).kind).toBe("eligible");
  });
});
