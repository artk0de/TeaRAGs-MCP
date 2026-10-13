/**
 * Facade of the diff-scoped detector families (bd tea-rags-mcp-89k7k.1.19.10):
 * the registry `DiffDetectorRun#run` iterates and the contract its members
 * implement. Registry order IS the run's observable output order — findings
 * concatenate and status rows list in this order. A new family = one module +
 * one entry here.
 */

import { cyclesDetector } from "./cycles.js";
import type { DiffFamilyDetector } from "./diff-family-detector.js";
import { facadeContractDetector } from "./facade-contract.js";
import { hubLikeDetector } from "./hub-like.js";
import { layeringBackEdgeDetector } from "./layering-back-edge.js";
import { leakingAbstractionDetector } from "./leaking-abstraction.js";
import { mainSequenceDetector } from "./main-sequence.js";
import { silentCouplingDetector } from "./silent-coupling.js";
import { splitCandidatesDetector } from "./split-candidates.js";
import { stableDependenciesDetector } from "./stable-dependencies.js";

export type {
  DiffDetectorBaseEdgeReader,
  DiffDetectorCatalog,
  DiffDetectorContractReader,
  DiffDetectorGraphReader,
  DiffDetectorScope,
  DiffDetectorSilentCouplingFacts,
  DiffDetectorSplitMergeReader,
  DiffEdgeEdit,
  DiffFamilyDetector,
  DiffFamilyDetectorContext,
  DiffRejudge,
  ExportTableReader,
  HeldBeforeChangeEvidence,
  OverlayEdge,
} from "./diff-family-detector.js";
export { targetsBeforeChange } from "./pre-existing.js";
export { DiffFindingRemedyResolver, stampDiffFindingRemedies } from "./remedy-resolver.js";
export { WHOLE_MODULE_EXPORT_NAME } from "./shared.js";

export const DIFF_FAMILY_DETECTORS: readonly DiffFamilyDetector[] = Object.freeze([
  stableDependenciesDetector,
  leakingAbstractionDetector,
  cyclesDetector,
  mainSequenceDetector,
  silentCouplingDetector,
  facadeContractDetector,
  splitCandidatesDetector,
  layeringBackEdgeDetector,
  hubLikeDetector,
]);
