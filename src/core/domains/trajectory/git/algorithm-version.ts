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
 */
export const GIT_TRAJECTORY_ALGORITHM_VERSION = 2;
