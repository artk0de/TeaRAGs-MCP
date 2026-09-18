import type { FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";
import { computeMartinInstability, type MartinInstability } from "../payload-signals.js";

/**
 * Per-file Martin instability over the whole dependency graph, in one pass —
 * the same number the `codegraph.file.instability` payload carries.
 *
 * The payload gets fanIn / fanOut from `getFileMetricsBulk`: `COUNT(*)` of
 * `cg_symbols_edges_file` rows naming the file as target / source. Counting
 * `graph.edges` — every row of that table, an unwalked endpoint's included — is
 * the same count, and {@link computeMartinInstability} is the same arithmetic,
 * so the two agree for every file (pinned by `file-instability-parity.test.ts`).
 * It is the value a finalize over the graph AS IT STANDS writes, not the copy
 * in Qdrant, which the payload heal refreshes only for the files it re-derives.
 *
 * Keyed by every walked file and every edge endpoint; a walked file with no
 * edge reads `{ instability: 0, connectionCount: 0 }`, as its payload does.
 */
export function computeFileInstabilities(graph: FileDependencyGraph): Map<RelPath, MartinInstability> {
  const fanIn = new Map<RelPath, number>();
  const fanOut = new Map<RelPath, number>();
  for (const edge of graph.edges) {
    fanOut.set(edge.sourceRelPath, (fanOut.get(edge.sourceRelPath) ?? 0) + 1);
    fanIn.set(edge.targetRelPath, (fanIn.get(edge.targetRelPath) ?? 0) + 1);
  }
  const relPaths = new Set<RelPath>([...graph.files.map((f) => f.relPath), ...fanIn.keys(), ...fanOut.keys()]);
  const instabilities = new Map<RelPath, MartinInstability>();
  for (const relPath of relPaths) {
    instabilities.set(relPath, computeMartinInstability(fanIn.get(relPath) ?? 0, fanOut.get(relPath) ?? 0));
  }
  return instabilities;
}
