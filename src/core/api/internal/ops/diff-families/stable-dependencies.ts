import type { DiffDetectorFinding } from "../../../../contracts/types/diff-detector-finding.js";
import type { DiffFamilyDetector } from "./diff-family-detector.js";
import { componentPairViolatedAtBase } from "./pre-existing.js";
import { detectorStatus, format3, round3, withRenderedSubject } from "./shared.js";

/**
 * Stable Dependencies over what the diff GENUINELY adds: an edge A -> B
 * whose target end is markedly less stable than its source end. The edge
 * set is the subtraction's output (bd tea-rags-mcp-89k7k.14) — a pair the
 * indexed graph already holds is the diff NOT adding it. Both ends must map
 * to report components — the band predicate is the report's own, injected;
 * an end without component facts is a silent skip, not a clean verdict.
 *
 * `preExisting` (bd tea-rags-mcp-89k7k.1.19.2, spec D9): the diff BASE already
 * held another edge of the same component pair — read from the base edges
 * of the source component's changed files, and from the indexed graph for its
 * unchanged files (the index equals the base there).
 */
export const stableDependenciesDetector: DiffFamilyDetector = {
  family: "stableDependencies",
  judge: ({ scope, addedEdges, catalog, baseEdges, graph }) => {
    const componentNameOf = (relPath: string): string | undefined => catalog.componentOf(relPath)?.name;
    const changedFilesOf = (component: string): readonly string[] =>
      scope.changedFiles.filter((relPath) => componentNameOf(relPath) === component);
    const changed = new Set(scope.changedFiles);
    const unchanged = {
      filesOf: (component: string): readonly string[] =>
        catalog.filesOf(component).filter((file) => !changed.has(file)),
      graph,
    };
    const findings: DiffDetectorFinding[] = [];
    for (const edge of addedEdges) {
      const sourceComponent = catalog.componentOf(edge.source);
      const targetComponent = catalog.componentOf(edge.target);
      if (sourceComponent === undefined || targetComponent === undefined) continue;
      if (!catalog.isMarkedlyLessStable(targetComponent.instability, sourceComponent.instability)) continue;
      const preExisting = componentPairViolatedAtBase(
        { sourceComponent: sourceComponent.name, targetComponent: targetComponent.name },
        baseEdges,
        componentNameOf,
        changedFilesOf,
        unchanged,
      );
      findings.push(
        withRenderedSubject({
          detector: "stableDependencies",
          endpoints: {
            kind: "componentEdge",
            sourceComponent: sourceComponent.name,
            targetComponent: targetComponent.name,
            sourceRelPath: edge.source,
            targetRelPath: edge.target,
          },
          evidence: {
            sourceInstability: round3(sourceComponent.instability),
            targetInstability: round3(targetComponent.instability),
          },
          detail:
            `the diff leans on the markedly-less-stable side: ${edge.target}'s component ${targetComponent.name} ` +
            `(I=${format3(targetComponent.instability)}) is markedly less stable than ${edge.source}'s ` +
            `${sourceComponent.name} (I=${format3(sourceComponent.instability)})`,
          // The root assembling unstable concretes is the root's job; the root
          // is the measured entry-facade component: annotated, still reported.
          ...(sourceComponent.entryFacade ? { compositionRoot: true as const } : {}),
          // Measured composition evidence (bd tea-rags-mcp-r8hme.52.17): the
          // report's own flags, annotated, still reported.
          ...(catalog.isCompositionTable?.(edge.source) ? { compositionTable: true as const } : {}),
          ...(sourceComponent.parentSurface ? { parentSurface: true as const } : {}),
          ...(preExisting ? { preExisting: true as const } : {}),
        }),
      );
    }
    return { findings, status: detectorStatus("stableDependencies", findings.length) };
  },
};
