/**
 * File→file edges derived from a file's RESOLVED call edges (bd
 * tea-rags-mcp-y99pg.38).
 *
 * For a language whose `import` names a module rather than a file, the import
 * statement cannot say which file a caller depends on — but its resolved calls
 * already do. The caller file depends on every distinct OTHER file its calls
 * land in; a call that stays inside the file is no dependency.
 *
 * Only edges a reader would navigate count. A dynamic-dispatch fan-out below
 * full confidence names m candidates of which the call reaches ONE, and an
 * unweighted file edge has no room for that discount — m file edges would read
 * as m real dependencies, the same over-count `isNavigationVisibleEdge` hides
 * from `get_callers`. A narrowed (`confidence: 1`) dispatch edge stays.
 *
 * `importText` is `null`: no import statement stands behind the edge, and the
 * column is nullable for exactly that reason.
 */

import type { GraphEdges } from "../../../contracts/types/codegraph.js";

type MethodEdge = GraphEdges["methodEdges"][number];

function isCertainEdge(edge: MethodEdge): boolean {
  return edge.edgeKind !== "dynamic" || (edge.confidence ?? 1) >= 1;
}

export function fileEdgesFromResolvedCalls(
  callerRelPath: string,
  methodEdges: readonly MethodEdge[],
): GraphEdges["fileEdges"] {
  const targets = new Set<string>();
  for (const edge of methodEdges) {
    if (edge.targetRelPath === callerRelPath || !isCertainEdge(edge)) continue;
    targets.add(edge.targetRelPath);
  }
  return [...targets].map((targetRelPath) => ({ targetRelPath, importText: null }));
}
