import type {
  DiffDetectorFinding,
  DiffDetectorStatus,
  DiffFindingChangedFiles,
} from "../../../../contracts/types/diff-detector-finding.js";
import type { DiffFamilyDetector } from "./diff-family-detector.js";
import { detectorStatus, round3, withRenderedSubject } from "./shared.js";

/**
 * Changed files listed per split-cluster / merge-side evidence line — exemplars
 * a reviewer can open, not the full census; the line's count ("N of M changed
 * files") keeps the total honest past the cap.
 */
const SPLIT_MERGE_EVIDENCE_FILE_CAP = 4;

/**
 * The diff judged against the phase-1 split/merge verdicts — never a
 * re-draw. SPLIT: changed files land in ≥ 2 clusters of one split candidate,
 * so the change works across the seam history already draws inside that
 * component; one cluster touched is the history's own grouping, never a
 * finding. Cluster membership is the verdict's own per-cluster file list,
 * so "N of M" counts against that list. MERGE: changed files on both sides
 * of a merge candidate — the diff bridges two components whose bundles
 * already move as one. A changed file the partition does not hold is
 * silence, never a verdict. Absent port = built:false with the wiring's
 * reason, passed through uninterpreted.
 */
export const splitCandidatesDetector: DiffFamilyDetector = {
  family: "splitCandidates",
  judge: ({ scope, splitMerge, splitMergeAbsentReason }) => {
    if (splitMerge === undefined) {
      return {
        findings: [],
        status: Object.freeze({
          detector: "splitCandidates",
          built: false,
          reason: splitMergeAbsentReason,
          findingCount: 0,
        }) satisfies DiffDetectorStatus,
      };
    }
    const { verdicts, componentOf } = splitMerge;
    const changedInOrder = [...new Set(scope.changedFiles)];
    const findings: DiffDetectorFinding[] = [];
    for (const candidate of verdicts.splitCandidates) {
      const touched = candidate.files
        .map((files, index) => {
          const members = new Set(files);
          return { index, size: files.length, hit: changedInOrder.filter((relPath) => members.has(relPath)) };
        })
        .filter((cluster) => cluster.hit.length > 0);
      if (touched.length < 2) continue;
      findings.push(
        withRenderedSubject({
          detector: "splitCandidates",
          endpoints: { kind: "component", component: candidate.component },
          evidence: {
            clusterCount: candidate.clusters,
            touchedClusters: touched.map((cluster) => ({
              cluster: cluster.index + 1,
              fileCount: cluster.size,
              ...cappedChangedFiles(cluster.hit),
            })),
          },
          detail:
            `the diff works across the seam of ${candidate.component}, a component whose history already splits ` +
            `into ${candidate.clusters} co-change groups`,
        }),
      );
    }

    const changedByComponent = new Map<string, string[]>();
    for (const relPath of changedInOrder) {
      const component = componentOf(relPath);
      if (component !== undefined) pushTo(changedByComponent, component, relPath);
    }
    for (const candidate of verdicts.mergeCandidates) {
      const sideA = changedByComponent.get(candidate.componentA);
      const sideB = changedByComponent.get(candidate.componentB);
      if (sideA === undefined || sideB === undefined) continue;
      findings.push(
        withRenderedSubject({
          detector: "splitCandidates",
          endpoints: { kind: "componentPair", componentA: candidate.componentA, componentB: candidate.componentB },
          evidence: {
            strength: round3(candidate.strength),
            sideA: cappedChangedFiles(sideA),
            sideB: cappedChangedFiles(sideB),
          },
          detail:
            `the diff bridges ${candidate.componentA} and ${candidate.componentB}, two components whose admitted ` +
            `bundles already move them as one unit`,
        }),
      );
    }
    return { findings, status: detectorStatus("splitCandidates", findings.length) };
  },
};

/**
 * Changed files capped at {@link SPLIT_MERGE_EVIDENCE_FILE_CAP} exemplars;
 * the count stays whole, so the overflow is counted instead of silently
 * dropped.
 */
function cappedChangedFiles(files: readonly string[]): DiffFindingChangedFiles {
  return { changedFileCount: files.length, changedFiles: files.slice(0, SPLIT_MERGE_EVIDENCE_FILE_CAP) };
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
