import type { DiffDetectorFinding, DiffDetectorStatus } from "../../../../contracts/types/diff-detector-finding.js";
import type { LayeringReading } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type { DiffFamilyDetector, DiffFamilyDetectorContext, OverlayEdge } from "./diff-family-detector.js";
import { detectorStatus, withRenderedSubject } from "./shared.js";

/** The layeringBackEdge family's verdict when no layering reading was injected. */
const NO_LAYERING_READING_REASON = "no layering reading";

/** A component pair a back-edge finding names, source first. */
interface LayeringBackEdgeComponentPair {
  sourceComponent: string;
  targetComponent: string;
}

/**
 * Back-edges against the inferred layering (bd tea-rags-mcp-89k7k.1.19.3,
 * spec D8): a diff-added edge whose source component sits at a LOWER level
 * than its target — the foundation side now depends on the stack above it.
 * Levels and knots are the whole-repo layering model's, read through the
 * injected `LayeringReading`; this family never re-levels. Only genuinely
 * added edges are judged (the 89k7k.14 subtraction). Same-level edges are
 * lateral, not back; members of one knot share its level, so a knot's
 * internal edges never fire. Composition (a directory and its own nested
 * directory) is never a back-edge — the model's own composition test. An end
 * without a component or a position is a silent skip. Absent reading =
 * built:false.
 */
export const layeringBackEdgeDetector: DiffFamilyDetector = {
  family: "layeringBackEdge",
  judge: (context) => {
    const { layering, addedEdges, catalog } = context;
    if (layering === undefined) {
      return {
        findings: [],
        status: Object.freeze({
          detector: "layeringBackEdge",
          built: false,
          reason: NO_LAYERING_READING_REASON,
          findingCount: 0,
        }) satisfies DiffDetectorStatus,
      };
    }
    const componentOf = (relPath: string): string | undefined => catalog.componentOf(relPath)?.name;
    const findings = judgeLayeringBackEdges({
      addedEdges,
      componentOf,
      layering,
      heldAtBase: (pair) => componentPairHeldBeforeChange(pair, context, layering, componentOf),
    });
    return { findings, status: detectorStatus("layeringBackEdge", findings.length) };
  },
};

/** The family's judgement over explicit inputs — one finding per added edge that runs up the layering. */
export function judgeLayeringBackEdges(input: {
  addedEdges: readonly OverlayEdge[];
  componentOf: (relPath: string) => string | undefined;
  layering: LayeringReading;
  heldAtBase: (pair: LayeringBackEdgeComponentPair) => boolean;
}): DiffDetectorFinding[] {
  const { addedEdges, componentOf, layering, heldAtBase } = input;
  const findings: DiffDetectorFinding[] = [];
  for (const edge of addedEdges) {
    const sourceComponent = componentOf(edge.source);
    const targetComponent = componentOf(edge.target);
    if (sourceComponent === undefined || targetComponent === undefined) continue;
    if (sourceComponent === targetComponent) continue;
    const sourceLevel = layering.positionOf(sourceComponent)?.level;
    const targetLevel = layering.positionOf(targetComponent)?.level;
    if (sourceLevel === undefined || targetLevel === undefined || sourceLevel >= targetLevel) continue;
    if (layering.isComposition(sourceComponent, targetComponent)) continue;
    const closesKnot = layering.knotClosedBy(sourceComponent, targetComponent);
    const preExisting = heldAtBase({ sourceComponent, targetComponent });
    findings.push(
      withRenderedSubject({
        detector: "layeringBackEdge",
        endpoints: {
          kind: "componentEdge",
          sourceComponent,
          targetComponent,
          sourceRelPath: edge.source,
          targetRelPath: edge.target,
        },
        evidence: { sourceLevel, targetLevel, ...(closesKnot !== undefined ? { closesKnot } : {}) },
        detail: [
          `the diff makes ${edge.source}'s component ${sourceComponent} (L${sourceLevel}) depend on ` +
            `${targetComponent} (L${targetLevel}) above it — a back-edge against the inferred layering`,
          ...(closesKnot !== undefined ? [`it closes a knot of ${closesKnot.join(", ")}`] : []),
          ...(preExisting
            ? [`another edge already carried ${sourceComponent} -> ${targetComponent} before the change`]
            : []),
        ].join("; "),
        ...(preExisting ? { preExisting: true as const } : {}),
      }),
    );
  }
  return findings;
}

/**
 * Whether some file of the source component already carried an edge into the
 * target component before the change — the pair check behind `preExisting`
 * (spec D9). Candidates are each source file's indexed and tree-read targets;
 * the run's `heldBeforeChange` decides each (the diff base where it answers,
 * else the index), so a fact nobody holds is never "already held".
 */
function componentPairHeldBeforeChange(
  pair: LayeringBackEdgeComponentPair,
  context: DiffFamilyDetectorContext,
  layering: LayeringReading,
  componentOf: (relPath: string) => string | undefined,
): boolean {
  const { graph, overlay, heldBeforeChange } = context;
  for (const source of layering.filesOf(pair.sourceComponent)) {
    const targets = new Set([
      ...(graph?.edgesFrom(source) ?? []).map((indexed) => indexed.target),
      ...overlay.edgesFrom(source).map((treeEdge) => treeEdge.targetRelPath),
    ]);
    for (const target of targets) {
      if (componentOf(target) !== pair.targetComponent) continue;
      if (heldBeforeChange({ source, target }) !== undefined) return true;
    }
  }
  return false;
}
