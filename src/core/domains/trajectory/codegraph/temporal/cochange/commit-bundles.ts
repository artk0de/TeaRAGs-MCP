/**
 * Commit bundling — the unit of co-change (bd tea-rags-mcp-x4rpp; burst rule
 * bd tea-rags-mcp-3vg0x).
 *
 * A bundle is ONE commit: "changed together" means committed together, so two
 * files never pair because the same author touched them an hour apart. Each
 * bundle is tagged with its author BURST — the maximal run of one author
 * identity's commits whose consecutive gaps stay under the window W
 * (`estimateBurstWindow`) — and the extractor counts a file or a pair at most
 * once per burst, so a WIP spray re-committing the same two files five times
 * is one co-change, not five.
 *
 * Bursts come from `partitionIntoAuthorSessions`, the git trajectory's one
 * (author identity, gap) grouping rule, with the co-change build's own W. The
 * earlier rule — the members of a 30-minute session UNIONED into one bundle —
 * paired files no commit ever held together and chained concurrent agent
 * commits into blobs; it is gone, and the build no longer reads
 * `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS`.
 */

import type { CommitInfo } from "../../../../../adapters/vcs/index.js";
import type { CochangeFileLineCounts, RelPath } from "../../../../../contracts/types/codegraph.js";
import {
  EMPTY_TASK_ID_VOCABULARY,
  extractTaskIds,
  partitionIntoAuthorSessions,
  type TaskIdVocabulary,
} from "../../../git/history/index.js";

/** One scoped commit: the files it touched, as project-relative HEAD paths, each once. */
export interface CochangeCommit {
  commit: CommitInfo;
  files: RelPath[];
  /**
   * The +/- line counts the commit made to each file, keyed by the same HEAD
   * path as `files` (bd tea-rags-mcp-dm61n). A file without a count is absent;
   * absent = no counts were read.
   */
  fileLines?: ReadonlyMap<RelPath, CochangeFileLineCounts>;
}

/** The files one commit changed together, and the author burst it belongs to. */
export interface CochangeBundle {
  /** The commit's SHA — exactly one; an array because the stored row is a list. */
  shas: string[];
  /** Unix seconds of the commit. */
  timestamp: number;
  /** Distinct files, code-point sorted. */
  files: RelPath[];
  /** Author-burst id: bundles sharing it count a file or a pair once. Opaque, unique per burst. */
  burst: number;
  /**
   * The task ids the commit's message names — the git trajectory's
   * `extractTaskIds`, the same reader behind `git.*.taskIds` (bd
   * tea-rags-mcp-09c4m). Absent = the message was not read.
   */
  taskIds?: string[];
  /** The commit's per-file line counts (`CochangeCommit#fileLines`); absent = none read. */
  fileLines?: ReadonlyMap<RelPath, CochangeFileLineCounts>;
}

/**
 * One bundle per commit, oldest first, each tagged with its author burst under
 * `burstWindowMinutes` (consecutive commits of one identity less than W apart).
 */
export function bundleCochangeCommits(
  commits: readonly CochangeCommit[],
  burstWindowMinutes: number,
  /** The build's task-id vocabulary, learned once over its window (bd tea-rags-mcp-8rcox). */
  taskIdVocabulary: TaskIdVocabulary = EMPTY_TASK_ID_VOCABULARY,
): CochangeBundle[] {
  const bursts = partitionIntoAuthorSessions(commits, (c) => c.commit, burstWindowMinutes);
  const bundles = bursts.flatMap((members, burst) =>
    members.map((m) => ({
      shas: [m.commit.sha],
      timestamp: m.commit.timestamp,
      files: [...new Set(m.files)].sort(compareCodePoints),
      burst,
      taskIds: extractTaskIds(m.commit.body, taskIdVocabulary),
      ...(m.fileLines ? { fileLines: m.fileLines } : {}),
    })),
  );
  return bundles.sort((a, b) => a.timestamp - b.timestamp || compareCodePoints(a.shas[0], b.shas[0]));
}

/** Locale-independent, so every machine orders paths the same way. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
