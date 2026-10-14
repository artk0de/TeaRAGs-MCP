import type { DiffDetectorFinding } from "../../../../contracts/types/diff-detector-finding.js";
import type { ReviewEdgeOverlay } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import { tarjanScc, type AdjacencyMap } from "../../../../primitives/graph/index.js";
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
    const mayCloseCycle = cycleClosingCandidates(treeTargetsOf, overlayEdges);
    const findings: DiffDetectorFinding[] = [];
    for (const edge of overlayEdges) {
      if (!mayCloseCycle(edge)) continue;
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
 * graph port is absent. Each file is read once per judge (bd
 * tea-rags-mcp-h2zwo): the overlay is immutable for the judge's lifetime, and
 * the remedy dry-run re-judges once per proposed remedy, so a per-step read
 * multiplied into findings × overlay edges × reachable files.
 */
function treeGraphOf(
  graph: DiffDetectorGraphReader | undefined,
  overlay: ReviewEdgeOverlay,
): (relPath: string) => readonly string[] {
  const indexedEdgesFrom = (relPath: string): readonly { targetRelPath: string }[] =>
    (graph?.edgesFrom(relPath) ?? []).map((indexed) => ({ targetRelPath: indexed.target }));
  const targetsByFile = new Map<string, readonly string[]>();
  return (relPath) => {
    let targets = targetsByFile.get(relPath);
    if (targets === undefined) {
      targets = overlay.treeEdgesFrom(relPath, indexedEdgesFrom).map((edge) => edge.targetRelPath);
      targetsByFile.set(relPath, targets);
    }
    return targets;
  };
}

/**
 * The overlay edges a cycle CAN close through — a sound pre-filter for the
 * per-edge BFS (bd tea-rags-mcp-h2zwo). Over the tree graph plus every overlay
 * edge, `source -> target` lies on a cycle iff both ends share one strongly
 * connected component; that graph only ADDS edges to the tree graph the BFS
 * walks, so an edge whose ends it separates has no path back in the tree
 * either. One Tarjan pass over the files reachable from the overlay's ends
 * replaces a full reachable-set BFS per cycle-free edge; the BFS still decides
 * every candidate, hop cap and reported path included.
 */
function cycleClosingCandidates(
  treeTargetsOf: (relPath: string) => readonly string[],
  overlayEdges: readonly { source: string; target: string }[],
): (edge: { source: string; target: string }) => boolean {
  const overlayTargetsBySource = new Map<string, string[]>();
  for (const { source, target } of overlayEdges) {
    const targets = overlayTargetsBySource.get(source) ?? [];
    targets.push(target);
    overlayTargetsBySource.set(source, targets);
  }
  const adjacency: AdjacencyMap = new Map();
  const pending = overlayEdges.flatMap((edge) => [edge.source, edge.target]);
  for (let relPath = pending.pop(); relPath !== undefined; relPath = pending.pop()) {
    if (adjacency.has(relPath)) continue;
    const targets = [...treeTargetsOf(relPath), ...(overlayTargetsBySource.get(relPath) ?? [])];
    adjacency.set(relPath, targets);
    for (const target of targets) if (!adjacency.has(target)) pending.push(target);
  }
  const componentOf = new Map<string, number>();
  tarjanScc(adjacency).forEach((component, index) => {
    for (const relPath of component) componentOf.set(relPath, index);
  });
  return (edge) => {
    const component = componentOf.get(edge.source);
    return component !== undefined && componentOf.get(edge.target) === component;
  };
}

/**
 * BFS `from` → `goal` over the tree graph; returns the closed cycle path
 * `[goal, from, ..., goal]`, undefined when unreachable within the hop cap.
 * Frames keep a parent link, not a copied path — the path is rebuilt once,
 * for the frame that reaches `goal`.
 */
function traceBackTo(
  treeTargetsOf: (relPath: string) => readonly string[],
  maxTraceHops: number,
  from: string,
  goal: string,
): readonly string[] | undefined {
  const visited = new Set<string>([from]);
  const frames: TraceFrame[] = [{ node: from, parent: undefined, depth: 0 }];
  // The array iterator re-reads the length each step, so frames pushed below are walked in FIFO order.
  for (const frame of frames) {
    for (const target of treeTargetsOf(frame.node)) {
      if (frame.depth + 1 > maxTraceHops) break; // every remaining edge of this frame is one hop too far
      if (target === goal) return [goal, ...pathTo(frame), goal];
      if (visited.has(target)) continue;
      visited.add(target);
      frames.push({ node: target, parent: frame, depth: frame.depth + 1 });
    }
  }
  return undefined;
}

interface TraceFrame {
  node: string;
  parent: TraceFrame | undefined;
  depth: number;
}

/** The BFS path `[from, ..., frame.node]` read back through the parent links. */
function pathTo(frame: TraceFrame): string[] {
  const path: string[] = [];
  for (let at: TraceFrame | undefined = frame; at !== undefined; at = at.parent) path.push(at.node);
  return path.reverse();
}
