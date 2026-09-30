/**
 * Symbol-level commit sets from the chunk walk (bd tea-rags-mcp-3gz4f) — the
 * walk's own accumulators re-keyed from chunk ids to symbols: `#partN` window
 * suffixes collapse into the parent symbol, chunks without a symbolId (blocks,
 * docs) contribute nothing, and a chunk whose accumulator the walk never
 * seeded contributes nothing.
 */

import type { ChunkLookupEntry } from "../../../../types.js";
import type { ChunkAccumulator } from "./metrics.js";

const PART_WINDOW = /#part\d+$/;

/** The parent symbol of a payload symbolId: `Big#parse#part2` → `Big#parse`. */
export function parentSymbolId(symbolId: string): string {
  return symbolId.replace(PART_WINDOW, "");
}

export function collectSymbolCommitSets(
  relativeChunkMap: ReadonlyMap<string, readonly ChunkLookupEntry[]>,
  accumulators: ReadonlyMap<string, ChunkAccumulator>,
): Map<string, Map<string, Set<string>>> {
  const files = new Map<string, Map<string, Set<string>>>();
  for (const [relPath, entries] of relativeChunkMap) {
    let symbols: Map<string, Set<string>> | undefined;
    for (const { chunkId, symbolId } of entries) {
      if (!symbolId) continue;
      const commitShas = accumulators.get(chunkId)?.commitShas;
      if (!commitShas || commitShas.size === 0) continue;
      symbols ??= new Map();
      const key = parentSymbolId(symbolId);
      const set = symbols.get(key);
      if (!set) {
        symbols.set(key, new Set(commitShas));
      } else {
        for (const sha of commitShas) set.add(sha);
      }
    }
    if (symbols) files.set(relPath, symbols);
  }
  return files;
}
