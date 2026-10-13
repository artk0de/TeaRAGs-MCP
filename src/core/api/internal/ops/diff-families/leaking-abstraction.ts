import type { DiffDetectorFinding } from "../../../../contracts/types/diff-detector-finding.js";
import type { DiffFamilyDetector } from "./diff-family-detector.js";
import { detectorStatus, HELD_BY_WORDING, HELD_IN_WORDING, withRenderedSubject } from "./shared.js";

/**
 * The most diff-native leak: the diff adds A -> B internal to a component
 * whose facade A ALREADY imports (the indexed A -> facade edge is the
 * evidence — the pre-diff usage; see the masking contract in the run's module
 * docblock). B being the facade itself is the adoption the report wants,
 * never a finding. Judges the overlay's edges AS READ, not the diff-added
 * subset: an edge held before the change is reported `preExisting`.
 */
export const leakingAbstractionDetector: DiffFamilyDetector = {
  family: "leakingAbstraction",
  judge: ({ overlayEdges, catalog, heldBeforeChange }) => {
    const findings: DiffDetectorFinding[] = [];
    for (const edge of overlayEdges) {
      const targetComponent = catalog.componentOf(edge.target);
      if (targetComponent === undefined) continue;
      const facade = catalog.facadeOf(targetComponent.name);
      if (facade === undefined || facade === edge.target) continue;
      // The pre-diff facade usage, judged at the base when the base answers
      // (bd tea-rags-mcp-89k7k.1.16); absent evidence is silence.
      const viaFacade = heldBeforeChange({ source: edge.source, target: facade }) !== undefined;
      if (!viaFacade) continue;
      const heldBy = heldBeforeChange(edge);
      const leak = `${edge.target} is internal to ${targetComponent.name}, whose facade ${facade} ${edge.source} imports`;
      findings.push(
        withRenderedSubject({
          detector: "leakingAbstraction",
          endpoints: { kind: "fileEdge", sourceRelPath: edge.source, targetRelPath: edge.target },
          evidence: { facadeRelPath: facade },
          detail:
            heldBy !== undefined
              ? `the edge ${edge.source} -> ${edge.target} pre-dates the diff (${HELD_BY_WORDING[heldBy]}): ` +
                `${leak}; the leak is already ${HELD_IN_WORDING[heldBy]}, the diff touches a file on it`
              : `the diff reached past the facade ${edge.source} already uses: ${leak}`,
          ...(heldBy !== undefined ? { preExisting: true as const } : {}),
        }),
      );
    }
    return { findings, status: detectorStatus("leakingAbstraction", findings.length) };
  },
};
