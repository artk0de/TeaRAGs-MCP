import type { SymbolId } from "../../../../../contracts/types/codegraph.js";
import type { PathEnumerateOptions, PathEnumerateResult } from "./types.js";

/**
 * Enumerate every simple call path `from`->`to` over a pre-built adjacency
 * map, bounded by `maxDepth` (edge count) and `maxPaths`. Pure: no I/O, no
 * mutation of the input. Cycle-safe — the on-stack `visited` set guarantees
 * no node repeats within a path, so a cyclic graph cannot loop forever.
 */
export function enumeratePaths(
  adjacency: ReadonlyMap<SymbolId, readonly SymbolId[]>,
  from: SymbolId,
  to: SymbolId,
  opts: PathEnumerateOptions,
): PathEnumerateResult {
  const paths: SymbolId[][] = [];
  let truncated = false;

  if (from === to) return { paths: [[from]], truncated: false };

  const stack: SymbolId[] = [from];
  const visited = new Set<SymbolId>([from]);

  const dfs = (node: SymbolId): void => {
    if (paths.length >= opts.maxPaths) {
      truncated = true;
      return;
    }
    if (stack.length - 1 >= opts.maxDepth) return; // depth = edges already taken
    for (const next of adjacency.get(node) ?? []) {
      if (paths.length >= opts.maxPaths) {
        truncated = true;
        return;
      }
      if (visited.has(next)) continue; // simple-path guard (also breaks cycles)
      stack.push(next);
      if (next === to) {
        paths.push([...stack]);
      } else {
        visited.add(next);
        dfs(next);
        visited.delete(next);
      }
      stack.pop();
    }
  };

  dfs(from);
  return { paths, truncated };
}
