import type { DiffDetectorFinding } from "../../../../contracts/types/diff-detector-finding.js";
import type {
  DiffDetectorCatalog,
  DiffFamilyDetector,
  DiffFamilyDetectorContext,
  OverlayEdge,
} from "./diff-family-detector.js";
import { detectorStatus, HELD_BY_WORDING, HELD_IN_WORDING, withRenderedSubject } from "./shared.js";

/**
 * Two ways an overlay edge A -> B leaks past a facade, judged in order, one
 * finding per edge:
 *
 * 1. B is internal to a component whose facade A ALREADY imports (the indexed
 *    A -> facade edge is the evidence — the pre-diff usage; see the masking
 *    contract in the run's module docblock).
 * 2. Otherwise, the whole-repo report's own facade-leak rule answers for the
 *    edge (`catalog.facadeLeakOf`, bd tea-rags-mcp-hv38q): B lies in an
 *    ADOPTED module A sits outside of — a first deep import from a file that
 *    never used the facade is the report's violation too. The evidence is the
 *    report's module facade.
 *
 * B being the facade itself is the adoption the report wants, never a
 * finding. Judges the overlay's edges AS READ, not the diff-added subset: an
 * edge held before the change is reported `preExisting`.
 */
export const leakingAbstractionDetector: DiffFamilyDetector = {
  family: "leakingAbstraction",
  judge: ({ overlayEdges, catalog, heldBeforeChange }) => {
    const findings: DiffDetectorFinding[] = [];
    for (const edge of overlayEdges) {
      const leak =
        leakPastUsedFacade(edge, catalog, heldBeforeChange) ?? leakPastAdoptedModule(edge.source, edge.target, catalog);
      if (leak === undefined) continue;
      const heldBy = heldBeforeChange(edge);
      findings.push(
        withRenderedSubject({
          detector: "leakingAbstraction",
          endpoints: { kind: "fileEdge", sourceRelPath: edge.source, targetRelPath: edge.target },
          evidence: { facadeRelPath: leak.facade },
          detail:
            heldBy !== undefined
              ? `the edge ${edge.source} -> ${edge.target} pre-dates the diff (${HELD_BY_WORDING[heldBy]}): ` +
                `${leak.wording}; the leak is already ${HELD_IN_WORDING[heldBy]}, the diff touches a file on it`
              : `${leak.diffWording}: ${leak.wording}`,
          ...(heldBy !== undefined ? { preExisting: true as const } : {}),
        }),
      );
    }
    return { findings, status: detectorStatus("leakingAbstraction", findings.length) };
  },
};

/** One edge's leak: the facade it walked past and how the detail words it. */
interface FacadeLeakReading {
  facade: string;
  wording: string;
  diffWording: string;
}

/** Branch 1: the facade the source already imports, held before the change. */
function leakPastUsedFacade(
  edge: OverlayEdge,
  catalog: DiffDetectorCatalog,
  heldBeforeChange: DiffFamilyDetectorContext["heldBeforeChange"],
): FacadeLeakReading | undefined {
  const targetComponent = catalog.componentOf(edge.target);
  if (targetComponent === undefined) return undefined;
  const facade = catalog.facadeOf(targetComponent.name);
  if (facade === undefined || facade === edge.target) return undefined;
  // The pre-diff facade usage, judged at the base when the base answers
  // (bd tea-rags-mcp-89k7k.1.16); absent evidence is silence.
  if (heldBeforeChange({ source: edge.source, target: facade }) === undefined) return undefined;
  return {
    facade,
    wording: `${edge.target} is internal to ${targetComponent.name}, whose facade ${facade} ${edge.source} imports`,
    diffWording: `the diff reached past the facade ${edge.source} already uses`,
  };
}

/** Branch 2: the report's facade-leak rule — an adopted module the source reaches into. */
function leakPastAdoptedModule(
  source: string,
  target: string,
  catalog: DiffDetectorCatalog,
): FacadeLeakReading | undefined {
  const verdict = catalog.facadeLeakOf?.(source, target);
  if (verdict === undefined) return undefined;
  return {
    facade: verdict.facadeRelPath,
    wording:
      `${target} is internal to the module ${verdict.moduleDir}, whose facade ${verdict.facadeRelPath} ` +
      `its importers adopted (${verdict.kind})`,
    diffWording: `the diff reached past the adopted facade ${verdict.facadeRelPath}`,
  };
}
