/**
 * CommitDriftMonitor — reports that the repository has moved on since the
 * index was built (bd tea-rags-mcp-zf3x0).
 *
 * The working-tree axis of `IndexDriftMonitor`. `BaseIndexingPipeline`
 * stamps the branch / commit / dirty triple at finalize
 * (`buildRegistryGitState` → `CollectionEntry.git`); this is the reader. HEAD
 * comes from `readRepoGitState`, which parses `.git` files directly — no `git`
 * spawn, so the check stays cheap enough for a query path.
 *
 * Complements the other axes rather than overlapping them: payload keys and
 * language versions ask whether the BUILD moved, this one asks whether the
 * CORPUS did. `transient` (mid-rebase/merge) is deliberately not consulted —
 * that flag gates whether auto-update may FIRE, and `IndexFreshnessCheck` is
 * the one place that policy lives.
 */

import { readRepoGitState, type RepoGitState } from "../../../infra/repo-git-state.js";
import type { CollectionRegistry } from "../registry/collection-registry.js";
import type { IndexDriftFinding, IndexDriftMonitor } from "./monitor.js";

const short = (sha: string): string => sha.slice(0, 7);

/** The stamp is written at finalize (`buildRegistryGitState`); this is the reader. */
export class CommitDriftMonitor implements IndexDriftMonitor {
  readonly axis = "commit" as const;

  constructor(
    private readonly registry: Pick<CollectionRegistry, "get">,
    private readonly readGitState: (path: string) => RepoGitState | null = readRepoGitState,
  ) {}

  check(collectionName: string): IndexDriftFinding[] {
    const entry = this.registry.get(collectionName);
    if (!entry?.git?.indexedCommit) return [];
    const stamp = entry.git;
    const state = this.readGitState(entry.path);
    if (!state?.commit) return [];
    // Only a moved HEAD is a finding. A dirty tree at index time is a note on
    // it: a dirty-only finding would never clear during a working session
    // (spec decision 7); uncommitted content is the merkle diff's business.
    if (state.commit === stamp.indexedCommit) return [];
    return [
      {
        axis: this.axis,
        subject: stamp.indexedBranch ?? "HEAD",
        indexed: `${short(stamp.indexedCommit)}${stamp.indexedDirty ? " (dirty)" : ""}`,
        current: short(state.commit),
        remedy: { kind: "incremental" },
        note: stamp.indexedDirty
          ? "HEAD moved since the last index run; the tree was dirty when it was indexed"
          : "HEAD moved since the last index run",
      },
    ];
  }
}
