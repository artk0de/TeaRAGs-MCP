import type { DiffDetectorFinding, DiffDetectorStatus } from "../../../../contracts/types/diff-detector-finding.js";
import type { HubLikeDependencyReading } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type { DiffFamilyDetector, OverlayEdge } from "./diff-family-detector.js";
import { targetsBeforeChange, wasEfferentBeforeChange } from "./pre-existing.js";
import { detectorStatus, withRenderedSubject } from "./shared.js";

/** The hubLike family's verdict when no hub-like reading was injected. */
const NO_HUB_LIKE_READING_REASON = "no hub-like reading";

/** What the diff adds to one component's counts: the newly counted files per axis and the edges that carried them. */
interface HubLikeComponentMove {
  afferentFiles: Set<string>;
  efferentFiles: Set<string>;
  edges: OverlayEdge[];
}

/**
 * Hub-like dependency over what the diff GENUINELY adds (bd
 * tea-rags-mcp-89k7k.1.19.4, spec D8): a component the diff's own edges carry
 * across the whole-repo hub cuts. Counts, foundation and cuts are the
 * report's hub detector's (`HubLikeDependencyReading`); the cuts are drawn
 * over the whole graph and held fixed — one diff never redraws them.
 *
 * Both counts are DISTINCT FILES, as the detector reads them. A diff-added
 * edge `s -> t` between components S and T moves:
 * - S's Ce by one file when `t` is outside the measured foundation (bd
 *   tea-rags-mcp-g77p3) and `s` carried no edge out of S past the foundation
 *   before the change — a file already counted never counts twice; an edge
 *   onto a file declaring one of `s`'s supertypes moves no Ce and made `s`
 *   no Ce file before (bd tea-rags-mcp-r8hme.52.18);
 * - T's Ca by one file when `s` carried no edge into T before the change.
 * An edge between a component and one nested in it moves neither (bd
 * tea-rags-mcp-j5gti): containment is on neither axis of the detector.
 * "Before the change" is the diff base where it answers for `s`, else the
 * index (`targetsBeforeChange`); a missing fact counts the file. The counts
 * served are the index's, the same footing the mainSequence recompute stands
 * on.
 *
 * A finding names a component that is a hub AFTER the move. `preExisting`
 * (spec D9): it was a hub at its counts before. `compositionRoot` is the
 * detector's own stamp (the component's measured entry facade).
 */
export const hubLikeDetector: DiffFamilyDetector = {
  family: "hubLike",
  judge: ({ hubLike, addedEdges, catalog, baseEdges, graph }) => {
    if (hubLike === undefined) {
      return {
        findings: [],
        status: Object.freeze({
          detector: "hubLike",
          built: false,
          reason: NO_HUB_LIKE_READING_REASON,
          findingCount: 0,
        }) satisfies DiffDetectorStatus,
      };
    }
    const findings = judgeHubLike({
      addedEdges,
      componentOf: (relPath) => catalog.componentOf(relPath)?.name,
      hubLike,
      targetsBeforeChange: (relPath) => targetsBeforeChange(relPath, baseEdges, graph),
    });
    return { findings, status: detectorStatus("hubLike", findings.length) };
  },
};

/** The family's judgement over explicit inputs — one finding per component the diff carries into hub territory. */
export function judgeHubLike(input: {
  addedEdges: readonly OverlayEdge[];
  componentOf: (relPath: string) => string | undefined;
  hubLike: HubLikeDependencyReading;
  targetsBeforeChange: (relPath: string) => ReadonlySet<string> | undefined;
}): DiffDetectorFinding[] {
  const { addedEdges, componentOf, hubLike, targetsBeforeChange: before } = input;
  const moves = new Map<string, HubLikeComponentMove>();
  const moveOf = (component: string): HubLikeComponentMove => {
    let move = moves.get(component);
    if (move === undefined) {
      move = { afferentFiles: new Set(), efferentFiles: new Set(), edges: [] };
      moves.set(component, move);
    }
    return move;
  };
  const targetComponentsBefore = (relPath: string): Set<string | undefined> =>
    new Set([...(before(relPath) ?? [])].map(componentOf));

  for (const edge of addedEdges) {
    const sourceComponent = componentOf(edge.source);
    const targetComponent = componentOf(edge.target);
    if (sourceComponent === undefined || targetComponent === undefined) continue;
    if (sourceComponent === targetComponent) continue;
    // Containment is on neither axis (bd tea-rags-mcp-j5gti).
    if (hubLike.isContainment(sourceComponent, targetComponent)) continue;
    const reachedBefore = targetComponentsBefore(edge.source);
    // An edge onto a file declaring a supertype of the source's types is
    // inheritance, on the Ca axis only (bd tea-rags-mcp-r8hme.52.18).
    if (!hubLike.isFoundation(targetComponent) && !hubLike.isInheritance(edge.source, edge.target)) {
      const alreadyEfferent = wasEfferentBeforeChange(edge.source, sourceComponent, before, componentOf, {
        excludesTargetComponent: (component) =>
          hubLike.isFoundation(component) || hubLike.isContainment(sourceComponent, component),
        excludesTargetFile: (target) => hubLike.isInheritance(edge.source, target),
      });
      if (!alreadyEfferent) {
        const move = moveOf(sourceComponent);
        move.efferentFiles.add(edge.source);
        move.edges.push(edge);
      }
    }
    if (!reachedBefore.has(targetComponent)) {
      const move = moveOf(targetComponent);
      move.afferentFiles.add(edge.source);
      move.edges.push(edge);
    }
  }

  const findings: DiffDetectorFinding[] = [];
  for (const [component, move] of moves) {
    const fan = hubLike.fanCountsOf(component);
    if (fan === undefined) continue;
    const afferentAfter = fan.afferentCount + move.afferentFiles.size;
    const efferentAfter = fan.efferentCount + move.efferentFiles.size;
    const after = {
      afferentCount: afferentAfter,
      efferentCount: efferentAfter,
      connectionCount: fan.connectionCount + move.afferentFiles.size + move.efferentFiles.size,
    };
    if (!hubLike.isHub(after)) continue;
    const preExisting = hubLike.isHub(fan);
    findings.push(
      withRenderedSubject({
        detector: "hubLike",
        endpoints: { kind: "component", component },
        evidence: {
          afferentBefore: fan.afferentCount,
          efferentBefore: fan.efferentCount,
          afferentAfter,
          efferentAfter,
          edges: move.edges.map((edge) => ({ sourceRelPath: edge.source, targetRelPath: edge.target })),
        },
        detail: [
          `the diff makes ${component} a hub-like dependency: Ca ${fan.afferentCount} -> ${afferentAfter}, ` +
            `Ce ${fan.efferentCount} -> ${efferentAfter} (foundation edges excluded) past the report's cuts`,
          ...(preExisting ? [`${component} was already a hub before the change`] : []),
        ].join("; "),
        ...(fan.compositionRoot ? { compositionRoot: true as const } : {}),
        ...(preExisting ? { preExisting: true as const } : {}),
      }),
    );
  }
  return findings;
}
