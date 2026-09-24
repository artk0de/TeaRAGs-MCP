/**
 * FileLevelGrouper — collapses chunk hits into one result per file.
 *
 * The representative is the highest-scored hit of each file, carried with its
 * full chunk payload so the reranker can still read chunk signals. The payload
 * is reduced to file scope only after ranking — see `./file-scope.ts`. The
 * collapsed hits are discarded: an outline of them covered nearly the whole
 * file and duplicated `find_symbol(relativePath)` (bd tea-rags-mcp-947xf).
 *
 * Pure data transformer, no I/O.
 */

import type { ExploreResult } from "../strategies/index.js";

/** Payload key a file-level result is grouped on — its identity. */
export const FILE_GROUP_KEY = "relativePath";

export const FileLevelGrouper = {
  /** Keep the highest-scored hit per file (input is score-ordered). */
  group(results: ExploreResult[], limit: number): ExploreResult[] {
    const byPath = new Map<string, ExploreResult>();
    for (const result of results) {
      const path = (result.payload?.[FILE_GROUP_KEY] as string | undefined) ?? "";
      if (!byPath.has(path)) byPath.set(path, result);
    }
    return [...byPath.values()].slice(0, limit);
  },
};
