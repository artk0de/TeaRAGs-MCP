/**
 * Stable identity for an architecture finding (bd tea-rags-mcp-89k7k.35.18,
 * H3 T2) — the fingerprint 89k7k.1.7 diffs a base violation set against a
 * base-plus-overlay one by. A key names WHAT is violated and nothing the run
 * measured about it:
 *
 * - `<family>@<revision>:<endpoints>`, the endpoints a JSON array so no path
 *   character can merge two tuples.
 * - Never evidence, scores, ordering, counts or free text. The silent-coupling
 *   group `subject` embeds its partner count ("co-changes significantly with N
 *   files"), so a group keys by its shared `relPath` alone.
 * - A knot keys by `drillDown.knotOf` — the whole knot's first member by Ca,
 *   taken before the 20-member cap and any `pathPattern` projection — never by
 *   its member list; membership is the knot's delta, not its identity. A
 *   composition cycle keys by its least member, which is the parent directory
 *   the cycle nests under. A shotgun spread IS its component set, so it keys by
 *   the sorted set.
 * - Unordered pairs (a silent-coupling pair, a merge candidate) are sorted, so
 *   the diff's changed-side-first pair and the report's lexicographic pair key
 *   identically. Directed pairs keep their orientation: a→b and b→a are two
 *   violations.
 * - Every key carries its family's revision. Bump a family's revision when its
 *   detector's semantics change, so a stale fingerprint stops matching on
 *   purpose instead of reporting a silent "resolved + introduced" pair.
 *
 * Report ↔ diff overlap: `stableDependencies` (component edge — the diff names
 * the carrying file edge too, which the key drops), facade leaks
 * (`leakingAbstraction` file edge; bypass vs internal-reach is a
 * classification, not identity), `mainSequence` (component) and both
 * `silentCoupling` shapes. Diff-only families, with no report counterpart:
 * `cycles` (a file edge closing a file cycle), `facadeContract` (a facade file
 * dropping consumed names) and `splitCandidates` (split / merge verdicts, which
 * the report carries in its summary, not as violations). Report-only:
 * `conventionPrivacy` leaks, `shotgunSurgery`, `hubLikeDependency`, every
 * `layering` kind and `norms`.
 */

import type { ArchitectureViolation } from "./architecture-report.js";
import type { DiffDetectorFinding } from "./diff-detector-finding.js";

/** The identity family a key belongs to — one per detector × kind, merged where two shapes name one violation. */
export type ArchitectureFindingKeyFamily =
  | "stableDependencies"
  | "leakingAbstraction.facade"
  | "leakingAbstraction.conventionPrivacy"
  | "silentCoupling.pair"
  | "silentCoupling.group"
  | "shotgunSurgery"
  | "mainSequence"
  | "hubLikeDependency"
  | "layering.knot"
  | "layering.backEdge"
  | "layering.abstractionBypass"
  | "layering.compositionCycle"
  | "layering.island"
  | "norms.misfit"
  | "cycles"
  | "facadeContract"
  | "splitCandidates.split"
  | "splitCandidates.merge";

/** Per-family detector revision stamped into every key — bump one when that detector's semantics change. */
export const ARCHITECTURE_FINDING_KEY_REVISION: Readonly<Record<ArchitectureFindingKeyFamily, number>> = {
  stableDependencies: 1,
  "leakingAbstraction.facade": 1,
  "leakingAbstraction.conventionPrivacy": 1,
  "silentCoupling.pair": 1,
  "silentCoupling.group": 1,
  shotgunSurgery: 1,
  mainSequence: 1,
  hubLikeDependency: 1,
  "layering.knot": 1,
  "layering.backEdge": 1,
  "layering.abstractionBypass": 1,
  "layering.compositionCycle": 1,
  "layering.island": 1,
  "norms.misfit": 1,
  cycles: 1,
  facadeContract: 1,
  "splitCandidates.split": 1,
  "splitCandidates.merge": 1,
};

type ArchitectureViolationVariantOf<V> = V extends { detector: infer D extends string; kind: infer K extends string }
  ? `${D}/${K}`
  : V extends { detector: infer D extends string }
    ? D
    : never;

/** Every detector × kind shape `ArchitectureViolation` declares, as `detector` or `detector/kind`. */
export type ArchitectureViolationVariant = ArchitectureViolationVariantOf<ArchitectureViolation>;

/** The stable identity of a whole-repo architecture violation. */
export function architectureViolationKey(violation: ArchitectureViolation): string {
  switch (violation.detector) {
    case "stableDependencies":
      return findingKey("stableDependencies", [violation.sourceComponent, violation.targetComponent]);
    case "leakingAbstraction":
      switch (violation.kind) {
        case "bypass":
        case "internal-reach":
          return findingKey("leakingAbstraction.facade", [violation.sourceRelPath, violation.targetRelPath]);
        case "conventionPrivacy":
          return findingKey("leakingAbstraction.conventionPrivacy", [
            violation.sourceRelPath,
            violation.targetRelPath,
            violation.evidence.sourceSymbolId,
            violation.evidence.targetSymbolId,
          ]);
        default:
          return unkeyedArchitectureFinding(violation);
      }
    case "silentCoupling":
      if (!("kind" in violation)) {
        return findingKey("silentCoupling.pair", sortedEndpoints([violation.sourceRelPath, violation.targetRelPath]));
      }
      switch (violation.kind) {
        case "group":
          return findingKey("silentCoupling.group", [violation.relPath]);
        default:
          return unkeyedArchitectureFinding(violation);
      }
    case "shotgunSurgery":
      return findingKey("shotgunSurgery", sortedEndpoints(violation.components));
    case "mainSequence":
      return findingKey("mainSequence", [violation.component]);
    case "hubLikeDependency":
      return findingKey("hubLikeDependency", [violation.component]);
    case "layering":
      switch (violation.kind) {
        case "knot":
          return findingKey("layering.knot", [violation.evidence.drillDown.knotOf]);
        case "compositionCycle":
          return findingKey("layering.compositionCycle", sortedEndpoints(violation.components).slice(0, 1));
        case "island":
          return findingKey("layering.island", [violation.component]);
        case "backEdge":
        case "abstractionBypass":
          return findingKey(`layering.${violation.kind}`, [violation.sourceComponent, violation.targetComponent]);
        default:
          return unkeyedArchitectureFinding(violation);
      }
    case "norms":
      return findingKey("norms.misfit", [violation.sourceRelPath, violation.targetRelPath]);
    default:
      return unkeyedArchitectureFinding(violation);
  }
}

/**
 * The stable identity of a diff-scoped finding, read off its structured
 * endpoints. Where a family overlaps the whole-repo report, the key equals the
 * key of the report violation describing the same thing.
 */
export function diffDetectorFindingKey(finding: DiffDetectorFinding): string {
  switch (finding.detector) {
    case "stableDependencies":
      return findingKey("stableDependencies", [finding.endpoints.sourceComponent, finding.endpoints.targetComponent]);
    case "leakingAbstraction":
      return findingKey("leakingAbstraction.facade", [
        finding.endpoints.sourceRelPath,
        finding.endpoints.targetRelPath,
      ]);
    case "cycles":
      return findingKey("cycles", [finding.endpoints.sourceRelPath, finding.endpoints.targetRelPath]);
    case "mainSequence":
      return findingKey("mainSequence", [finding.endpoints.component]);
    case "silentCoupling":
      return finding.endpoints.kind === "fileGroup"
        ? findingKey("silentCoupling.group", [finding.endpoints.relPath])
        : findingKey(
            "silentCoupling.pair",
            sortedEndpoints([finding.endpoints.sourceRelPath, finding.endpoints.targetRelPath]),
          );
    case "facadeContract":
      return findingKey("facadeContract", [finding.endpoints.relPath]);
    case "splitCandidates":
      return finding.endpoints.kind === "component"
        ? findingKey("splitCandidates.split", [finding.endpoints.component])
        : findingKey(
            "splitCandidates.merge",
            sortedEndpoints([finding.endpoints.componentA, finding.endpoints.componentB]),
          );
    default:
      return unkeyedArchitectureFinding(finding);
  }
}

function findingKey(family: ArchitectureFindingKeyFamily, endpoints: readonly string[]): string {
  return `${family}@${ARCHITECTURE_FINDING_KEY_REVISION[family]}:${JSON.stringify(endpoints)}`;
}

/** Code-unit order — any total order works, the key only needs one fixed orientation. */
function sortedEndpoints(endpoints: readonly string[]): string[] {
  return [...endpoints].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Reached only by a shape the contract does not declare; a declared but unkeyed variant fails to compile here. */
function unkeyedArchitectureFinding(finding: never): never {
  throw new Error(`architecture finding has no identity key: ${JSON.stringify(finding)}`);
}
