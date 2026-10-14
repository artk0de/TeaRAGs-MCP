import type { DiffDetectorFinding } from "../../../../contracts/types/diff-detector-finding.js";
import type { ReviewEdgeOverlay } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type { DiffDetectorGraphReader, DiffFamilyDetector } from "./diff-family-detector.js";
import { detectorStatus, HELD_BY_WORDING, HELD_IN_WORDING, withRenderedSubject } from "./shared.js";

/**
 * A cycle per overlay edge that closes one: BFS from the edge's target over
 * the TREE graph seeking its source, within the hop cap (bd
 * tea-rags-mcp-ah66x). The tree graph is the indexed graph with every
 * re-read changed file's out-edges swapped for its overlay edges — so a cycle
 * closing through ANOTHER changed file's new edge is found, and a closing
 * edge a re-read removed is never walked. A changed file whose re-read was
 * skipped keeps its indexed edges (a missing read is never an edge-free
 * file); a deleted file has no edge in or out. The base side is `heldBeforeChange`, unchanged. Each edge pair
 * reports at most once — the unique-pair iteration of the overlay's edges is
 * the dedupe.
 */
export const cyclesDetector: DiffFamilyDetector = {
  family: "cycles",
  judge: ({ overlayEdges, overlay, graph, maxTraceHops, heldBeforeChange }) => {
    const treeTargetsOf = treeGraphOf(graph, overlay);
    const findings: DiffDetectorFinding[] = [];
    for (const edge of overlayEdges) {
      const cyclePath = traceBackTo(treeTargetsOf, maxTraceHops, edge.target, edge.source);
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
                `with the path back to ${edge.source} the cycle is already ${HELD_IN_WORDING[heldBy]}, ` +
                `the diff touches a file on it`
              : `the diff closes a cycle: the new edge ${edge.source} -> ${edge.target} plus the path ` +
                `back to ${edge.source}`,
          ...(heldBy !== undefined ? { preExisting: true as const } : {}),
        }),
      );
    }
    return { findings, status: detectorStatus("cycles", findings.length) };
  },
};

/**
 * The tree graph's out-targets of one file, by the overlay's single tree-edge
 * rule (`ReviewEdgeOverlay#treeEdgesFrom`); the indexed side is empty when the
 * graph port is absent.
 */
function treeGraphOf(
  graph: DiffDetectorGraphReader | undefined,
  overlay: ReviewEdgeOverlay,
): (relPath: string) => readonly string[] {
  const indexedEdgesFrom = (relPath: string): readonly { targetRelPath: string }[] =>
    (graph?.edgesFrom(relPath) ?? []).map((indexed) => ({ targetRelPath: indexed.target }));
  return (relPath) => overlay.treeEdgesFrom(relPath, indexedEdgesFrom).map((edge) => edge.targetRelPath);
}

/**
 * BFS `from` → `goal` over the tree graph; returns the closed cycle path
 * `[goal, from, ..., goal]`, undefined when unreachable within the hop cap.
 */
function traceBackTo(
  treeTargetsOf: (relPath: string) => readonly string[],
  maxTraceHops: number,
  from: string,
  goal: string,
): readonly string[] | undefined {
  const visited = new Set<string>([from]);
  const queue: { node: string; path: readonly string[]; depth: number }[] = [{ node: from, path: [from], depth: 0 }];
  while (queue.length > 0) {
    const frame = queue.shift();
    if (frame === undefined) break;
    for (const target of treeTargetsOf(frame.node)) {
      if (frame.depth + 1 > maxTraceHops) break; // every remaining edge of this frame is one hop too far
      if (target === goal) return [goal, ...frame.path, goal];
      if (visited.has(target)) continue;
      visited.add(target);
      queue.push({ node: target, path: [...frame.path, target], depth: frame.depth + 1 });
    }
  }
  return undefined;
}
