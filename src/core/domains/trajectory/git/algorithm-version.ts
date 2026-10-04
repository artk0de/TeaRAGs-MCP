/**
 * Revision of the git trajectory's computation — `GitEnrichmentProvider`'s
 * `EnrichmentProvider.algorithmVersion` (bd tea-rags-mcp-xi2r9).
 *
 * Bump it, ONCE per release, when the same history now writes different
 * `git.file` / `git.chunk` values: the stamp every existing index carries then
 * falls behind, and drift reports recommend `--force-enrichments git`. A change
 * that leaves every value byte-identical needs no bump. An index stamped before
 * the stamp existed reads as 1.
 *
 * - 1 — every index written before the stamp.
 * - 2 — the chunk walk visits commits in log order and retires ranges a newer
 *   commit inserted wholesale; a dirty file's working rows are carried onto
 *   HEAD before the walk, and rows of only uncommitted lines get the zero block.
 * - 3 — every `git.file` counter is a window figure (bd tea-rags-mcp-i6tkc): a
 *   file with no commit in the file window is stamped by the live file phase
 *   with zero counters, no bugFixRate and exact whole-history age stamps, where
 *   the backfill used to give it lifetime counters.
 */
export const GIT_TRAJECTORY_ALGORITHM_VERSION = 3;
