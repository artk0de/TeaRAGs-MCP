/**
 * WorkingTreeOverlay (bd tea-rags-mcp-xi2r9.1) — the per-request view of the
 * tree a read answers for: its {@link WorkingTreeDelta} against the commit the
 * base index was built at, and the {@link WorkingTreeMarker} the answer carries.
 *
 * The marker is never omitted and `view` never throws: a tree that cannot be
 * measured — no commit stamp, an unknown commit, a delta over the cap, a git
 * failure — still yields a marker, with `degraded` saying why and what fixes
 * it. A degraded view touches no path, so nothing is substituted or hidden.
 */
import type { CollectionEntry } from "../../../contracts/types/registry.js";
import type { WorkingTree, WorkingTreeMarker } from "../../../contracts/types/working-tree.js";
import { readRepoGitState } from "../../../infra/repo-git-state.js";
import type { WorkingTreeDeltaReader } from "./delta.js";

export interface WorkingTreeView {
  marker: WorkingTreeMarker;
  /** changed ∪ deleted; empty when degraded (nothing substituted, nothing hidden) */
  touchedPaths: ReadonlySet<string>;
  deletedPaths: ReadonlySet<string>;
}

/** The registry surface the overlay reads: an index's git stamp and alias. */
export interface WorkingTreeIndexLookup {
  get: (collectionName: string) => CollectionEntry | null | undefined;
}

export interface WorkingTreeOverlayDeps {
  registry: WorkingTreeIndexLookup;
  deltaReader: WorkingTreeDeltaReader;
  /** The ingest admission rule for files under `root` (`FileScanner#accepts`). */
  createFileFilter: (root: string) => Promise<(relativePath: string) => boolean>;
}

const NO_TREE_REASON = "no working tree resolved for this index";
const NO_TREE_REMEDY = "pass path=<your working directory>";
const UNREADABLE_REMEDY = "check that {tree} is a readable git checkout";

const EMPTY_PATHS: ReadonlySet<string> = new Set();

export class WorkingTreeOverlay {
  constructor(private readonly deps: WorkingTreeOverlayDeps) {}

  /** Never throws for git trouble: a failure becomes `marker.degraded`. */
  async view(tree: WorkingTree, alias: string | undefined): Promise<WorkingTreeView> {
    const { collectionName } = tree.baseIndex;
    const entry = this.deps.registry.get(collectionName) ?? undefined;
    const indexedCommit = entry?.git?.indexedCommit ? entry.git.indexedCommit : null;
    const marker: WorkingTreeMarker = {
      tree: tree.root,
      indexedCommit,
      treeCommit: null,
      indexedDirty: entry?.git?.indexedDirty ?? false,
      changedFiles: 0,
      deletedFiles: 0,
      floors: [],
    };
    const fill = (template: string): string =>
      template.replaceAll("{alias}", alias ?? entry?.name ?? collectionName).replaceAll("{tree}", tree.root);
    const degraded = (reason: string, remedy: string): WorkingTreeView => ({
      marker: { ...marker, degraded: { reason, remedy: fill(remedy) } },
      touchedPaths: EMPTY_PATHS,
      deletedPaths: EMPTY_PATHS,
    });

    if (tree.root === "") return degraded(NO_TREE_REASON, NO_TREE_REMEDY);
    try {
      marker.treeCommit = readRepoGitState(tree.root)?.commit || null;
      const accepts = await this.deps.createFileFilter(tree.root);
      const read = await this.deps.deltaReader.read(tree.root, indexedCommit, accepts);
      if (read.kind === "degraded") return degraded(read.reason, read.remedy);
      const { changed, deleted } = read.delta;
      return {
        marker: { ...marker, changedFiles: changed.length, deletedFiles: deleted.length },
        touchedPaths: new Set([...changed, ...deleted]),
        deletedPaths: new Set(deleted),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return degraded(`cannot read the working tree delta: ${message.split("\n")[0]}`, UNREADABLE_REMEDY);
    }
  }
}
