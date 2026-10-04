import type { SymbolId } from "../../../../../contracts/types/codegraph.js";
import type { PathEnumerateOptions, PathEnumerateResult } from "./types.js";

/**
 * Enumerate every simple call path `fromSymbolId`->`toSymbolId` over a
 * pre-built adjacency map, bounded by `maxDepth` (edge count) and `maxPaths`.
 * Pure: no I/O, no mutation of the input. Cycle-safe — the on-stack `visited`
 * set guarantees no node repeats within a path, so a cyclic graph cannot loop
 * forever.
 */
export function enumeratePaths(
  adjacency: ReadonlyMap<SymbolId, readonly SymbolId[]>,
  fromSymbolId: SymbolId,
  toSymbolId: SymbolId,
  opts: PathEnumerateOptions,
): PathEnumerateResult {
  const paths: SymbolId[][] = [];
  let truncated = false;

  if (fromSymbolId === toSymbolId) return { paths: [[fromSymbolId]], truncated: false };

  const stack: SymbolId[] = [fromSymbolId];
  const visited = new Set<SymbolId>([fromSymbolId]);

  const dfs = (nodeSymbolId: SymbolId): void => {
    if (paths.length >= opts.maxPaths) {
      truncated = true;
      return;
    }
    if (stack.length - 1 >= opts.maxDepth) return; // depth = edges already taken
    for (const next of adjacency.get(nodeSymbolId) ?? []) {
      if (paths.length >= opts.maxPaths) {
        truncated = true;
        return;
      }
      if (visited.has(next)) continue; // simple-path guard (also breaks cycles)
      stack.push(next);
      if (next === toSymbolId) {
        paths.push([...stack]);
      } else {
        visited.add(next);
        dfs(next);
        visited.delete(next);
      }
      stack.pop();
    }
  };

  dfs(fromSymbolId);
  return { paths, truncated };
}
