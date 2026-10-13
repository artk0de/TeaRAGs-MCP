import type { DiffDetectorFinding } from "../../../../contracts/types/diff-detector-finding.js";
import type { DiffDetectorGraphReader, DiffFamilyDetector } from "./diff-family-detector.js";
import { detectorStatus, HELD_BY_WORDING, HELD_IN_WORDING, withRenderedSubject } from "./shared.js";

/**
 * A cycle per NEW edge that closes one: BFS from the edge's target over the
 * indexed graph seeking its source, within the hop cap. Changed files'
 * nodes are never expanded (their stale rows are the overlay's to replace),
 * though the source remains reachable as the closing hop; the overlay
 * itself is never traversed. Each edge pair reports at most once — the
 * unique-pair iteration of the overlay's edges is the dedupe.
 */
export const cyclesDetector: DiffFamilyDetector = {
  family: "cycles",
  judge: ({ scope, overlayEdges, graph, maxTraceHops, heldBeforeChange }) => {
    const changed = new Set(scope.changedFiles);
    const findings: DiffDetectorFinding[] = [];
    for (const edge of overlayEdges) {
      const cyclePath = traceBackTo(graph, maxTraceHops, edge.target, edge.source, changed);
      if (cyclePath === undefined) continue;
      const heldBy = heldBeforeChange(edge);
      findings.push(
        withRenderedSubject({
          detector: "cycles",
          endpoints: { kind: "fileEdge", sourceRelPath: edge.source, targetRelPath: edge.target },
          evidence: { path: [...cyclePath] },
          detail:
            heldBy !== undefined
              ? `the edge ${edge.source} -> ${edge.target} pre-dates the diff (${HELD_BY_WORDING[heldBy]}): ` +
                `with the indexed path back to ${edge.source} the cycle is already ${HELD_IN_WORDING[heldBy]}, ` +
                `the diff touches a file on it`
              : `the diff closes a cycle: the new edge ${edge.source} -> ${edge.target} plus the indexed path ` +
                `back to ${edge.source}`,
          ...(heldBy !== undefined ? { preExisting: true as const } : {}),
        }),
      );
    }
    return { findings, status: detectorStatus("cycles", findings.length) };
  },
};

/**
 * BFS `from` → `goal` over indexed out-edges; returns the closed cycle path
 * `[goal, from, ..., goal]`, undefined when unreachable within the hop cap.
 */
function traceBackTo(
  graph: DiffDetectorGraphReader | undefined,
  maxTraceHops: number,
  from: string,
  goal: string,
  changed: ReadonlySet<string>,
): readonly string[] | undefined {
  // No indexed graph = no path back; a changed node's stale rows are never traversed.
  if (graph === undefined || changed.has(from)) return undefined;
  const visited = new Set<string>([from]);
  const queue: { node: string; path: readonly string[]; depth: number }[] = [{ node: from, path: [from], depth: 0 }];
  while (queue.length > 0) {
    const frame = queue.shift();
    if (frame === undefined) break;
    for (const indexed of graph.edgesFrom(frame.node)) {
      if (frame.depth + 1 > maxTraceHops) break; // every remaining edge of this frame is one hop too far
      if (indexed.target === goal) return [goal, ...frame.path, goal];
      if (changed.has(indexed.target) || visited.has(indexed.target)) continue;
      visited.add(indexed.target);
      queue.push({ node: indexed.target, path: [...frame.path, indexed.target], depth: frame.depth + 1 });
    }
  }
  return undefined;
}
