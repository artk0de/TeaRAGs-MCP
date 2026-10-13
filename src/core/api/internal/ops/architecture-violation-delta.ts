/**
 * What a change does to the repository's architecture violations (bd
 * tea-rags-mcp-89k7k.1.7): the full detector set judged twice over one review
 * — the index's facts (the base) and the same facts with the working tree's
 * edges overlaid — and the two violation sets compared by their stable keys
 * (`architectureViolationKey`). A key only the overlaid run holds is
 * INTRODUCED, one only the base holds is RESOLVED, one both hold PERSISTS.
 * Non-local effects are in scope: instability is a property of all of a
 * component's edges, so a diff can introduce an SDP violation between two
 * components it never touched.
 *
 * The keyed comparison is shared with `get_architecture_report` restructure
 * mode (bd tea-rags-mcp-r8hme.21), which diffs base facts against relabelled
 * ones — hence its home beside the report ops, not inside review-sections.
 *
 * Renames: the diff's rename detection (`DiffScopeRead.renamedFrom`, new path
 * → old path) canonicalizes every file-keyed endpoint of the OVERLAID side to
 * its old path before keying, so a `git mv` reads as persisting, never as
 * resolved + introduced. The key functions stay untouched; the delta layer
 * owns the canonicalization. Component-keyed families key by component name,
 * and a DIRECTORY rename moves the component name itself — out of scope here:
 * such a move still reads as resolved + introduced.
 *
 * Owner decision 2026-10-13 ("collapse persisting"): the diff run's findings
 * keep only what the change introduced, plus any finding that carries a
 * cheap `remedy`; every other finding moves to a compact `{family, subject}`
 * list. A report family's finding whose key either run holds is introduced
 * when the key is and persists when both runs hold it; the diff-only families
 * (cycles, facadeContract, splitCandidates — no report counterpart), and a
 * report-family finding whose key neither run holds, are introduced when the
 * run did not mark them `preExisting`. Families an edge overlay cannot move (silent coupling and
 * shotgun surgery read git history, norms read the indexed type rows — see
 * `ARCHITECTURE_FACTS_NOT_REFRESHED_BY_EDGE_OVERLAY`) are never introduced,
 * so they persist by construction. So do splitCandidates MERGE verdicts (key
 * family `splitCandidates.merge`): pure co-change history, which a diff cannot
 * move. SPLIT verdicts stay — a diff-added inter-cluster edge gates them.
 */

import {
  ARCHITECTURE_FINDING_KEY_REVISION,
  architectureViolationKey,
  diffDetectorFindingKey,
  type ArchitectureFindingKeyFamily,
} from "../../../contracts/types/architecture-finding-key.js";
import type { ArchitectureViolation } from "../../../contracts/types/architecture-report.js";
import type { DiffDetectorFamily, DiffDetectorFinding } from "../../../contracts/types/diff-detector-finding.js";
import type { ArchitectureChangeSubject } from "../../public/dto/review.js";

/** The keyed comparison of a base and an overlaid violation set. */
export interface ArchitectureViolationDelta {
  /** Keys only the overlaid run holds, each with its overlaid violation. */
  introduced: ReadonlyMap<string, ArchitectureViolation>;
  /** Keys only the base run holds, each with its base violation. */
  resolved: ReadonlyMap<string, ArchitectureViolation>;
  /** Keys both runs hold. */
  persisting: ReadonlySet<string>;
}

/**
 * Compare two UNCAPPED violation sets by key. A capped set would fabricate
 * deltas: a violation cut from one side and listed on the other reads as
 * introduced or resolved.
 */
export function measureArchitectureViolationDelta(
  baseViolations: readonly ArchitectureViolation[],
  overlaidViolations: readonly ArchitectureViolation[],
  renamedFrom?: ReadonlyMap<string, string>,
): ArchitectureViolationDelta {
  const baseByKey = keyedViolations(baseViolations);
  const overlaidByKey = keyedViolations(
    overlaidViolations.map((violation) => withCanonicalPaths(violation, renamedFrom)),
  );
  const introduced = new Map<string, ArchitectureViolation>();
  const persisting = new Set<string>();
  for (const [key, violation] of overlaidByKey) {
    if (baseByKey.has(key)) persisting.add(key);
    else introduced.set(key, violation);
  }
  const resolved = new Map([...baseByKey].filter(([key]) => !overlaidByKey.has(key)));
  return { introduced, resolved, persisting };
}

/** The diff run's findings split by the delta, plus the compact lists the section reports. */
export interface CollapsedArchitectureFindings {
  /** Introduced findings and any finding carrying a remedy, in the run's order. */
  kept: DiffDetectorFinding[];
  /** One entry per key of the findings that left `kept`. */
  persisting: ArchitectureChangeSubject[];
  /** Findings that left `kept`, counted per detector row. */
  persistingByDetector: ReadonlyMap<DiffDetectorFamily, number>;
  /** Introduced report violations no kept finding carries — the change's non-local effects. */
  nonLocal: ArchitectureChangeSubject[];
  /** Distinct introduced keys: the delta's plus the diff-only families' introduced findings. */
  introducedCount: number;
}

/** Families with no whole-repo report counterpart: their own `preExisting` flag decides. */
const DIFF_ONLY_FAMILIES: ReadonlySet<DiffDetectorFamily> = new Set(["cycles", "facadeContract", "splitCandidates"]);

/**
 * Families judged from co-change history an edge overlay cannot move. The diff
 * run judges their pairs under the query significance family and a scoped
 * asset-import rescue the report runs lack, so a diff finding's key need not
 * appear in either run — the delta cannot speak for them; they persist.
 */
const GIT_DRIVEN_FAMILIES: ReadonlySet<DiffDetectorFamily> = new Set(["silentCoupling"]);

/**
 * Co-change-history verdicts of a detector that also emits diff-gated ones, so
 * the detector name cannot classify them: a splitCandidates MERGE verdict is
 * pure co-change history, while a SPLIT verdict is gated by a diff-added
 * inter-cluster edge (s2nes) and stays judged by its own `preExisting` flag.
 */
const GIT_DRIVEN_KEY_FAMILIES: ReadonlySet<ArchitectureFindingKeyFamily> = new Set(["splitCandidates.merge"]);

/** Collapse every finding the change did not introduce out of the findings list. */
export function collapsePersistingFindings(
  findings: readonly DiffDetectorFinding[],
  delta: ArchitectureViolationDelta,
  renamedFrom?: ReadonlyMap<string, string>,
): CollapsedArchitectureFindings {
  const keptFindings: DiffDetectorFinding[] = [];
  const persisting = new Map<string, ArchitectureChangeSubject>();
  const persistingByDetector = new Map<DiffDetectorFamily, number>();
  const introducedKeys = new Set(delta.introduced.keys());
  const carriedKeys = new Set<string>();
  for (const finding of findings) {
    const key = diffDetectorFindingKey({
      ...finding,
      endpoints: withCanonicalPaths(finding.endpoints, renamedFrom),
    } as DiffDetectorFinding);
    const introduced = isIntroducedFinding(finding, key, delta);
    if (introduced) introducedKeys.add(key);
    if (introduced || finding.remedy !== undefined) {
      keptFindings.push(finding);
      carriedKeys.add(key);
      continue;
    }
    if (!persisting.has(key)) {
      persisting.set(key, {
        family: findingKeyFamily(key),
        subject: finding.subject,
        ...(finding.tier === undefined ? {} : { tier: finding.tier }),
      });
    }
    persistingByDetector.set(finding.detector, (persistingByDetector.get(finding.detector) ?? 0) + 1);
  }
  const nonLocal = [...delta.introduced]
    .filter(([key]) => !carriedKeys.has(key))
    .map(([key, violation]) => violationChangeSubject(key, violation));
  return {
    kept: keptFindings,
    persisting: [...persisting.values()],
    persistingByDetector,
    nonLocal,
    introducedCount: introducedKeys.size,
  };
}

/**
 * Whether the change introduced `finding`. A git-driven family never is; a
 * report family's key either run holds is decided by the delta; the rest —
 * diff-only families, and a key neither run holds — by the run's own flag.
 */
function isIntroducedFinding(finding: DiffDetectorFinding, key: string, delta: ArchitectureViolationDelta): boolean {
  if (GIT_DRIVEN_FAMILIES.has(finding.detector) || GIT_DRIVEN_KEY_FAMILIES.has(findingKeyFamily(key))) return false;
  const judgedByDelta =
    !DIFF_ONLY_FAMILIES.has(finding.detector) && (delta.introduced.has(key) || delta.persisting.has(key));
  return judgedByDelta ? delta.introduced.has(key) : finding.preExisting !== true;
}

/** The resolved side of a delta, as the compact list the section reports. */
export function resolvedChangeSubjects(delta: ArchitectureViolationDelta): ArchitectureChangeSubject[] {
  return [...delta.resolved].map(([key, violation]) => violationChangeSubject(key, violation));
}

function keyedViolations(violations: readonly ArchitectureViolation[]): Map<string, ArchitectureViolation> {
  const byKey = new Map<string, ArchitectureViolation>();
  for (const violation of violations) {
    const key = architectureViolationKey(violation);
    if (!byKey.has(key)) byKey.set(key, violation);
  }
  return byKey;
}

/** The file-keyed endpoint fields a key reads; component names are never paths. */
const FILE_ENDPOINT_FIELDS = ["sourceRelPath", "targetRelPath", "relPath"] as const;

/** `value` with every renamed file endpoint replaced by its pre-rename path. */
export function withCanonicalPaths<T extends object>(
  value: T,
  renamedFrom: ReadonlyMap<string, string> | undefined,
): T {
  if (renamedFrom === undefined) return value;
  let canonical = value;
  for (const field of FILE_ENDPOINT_FIELDS) {
    const path: unknown = (value as Partial<Record<(typeof FILE_ENDPOINT_FIELDS)[number], unknown>>)[field];
    const oldPath = typeof path === "string" ? renamedFrom.get(path) : undefined;
    if (oldPath !== undefined) canonical = { ...canonical, [field]: oldPath };
  }
  return canonical;
}

/**
 * A report violation's compact entry: its own subject when it renders one,
 * else its key's endpoints — with the violation's impact tier when it carries one.
 */
export function violationChangeSubject(key: string, violation: ArchitectureViolation): ArchitectureChangeSubject {
  const family = findingKeyFamily(key);
  const tier = violation.tier === undefined ? {} : { tier: violation.tier };
  if ("subject" in violation && typeof violation.subject === "string") {
    return { family, subject: violation.subject, ...tier };
  }
  const endpoints = JSON.parse(key.slice(key.indexOf(":") + 1)) as string[];
  return { family, subject: endpoints.join(UNORDERED_KEY_FAMILIES.has(family) ? " ~ " : " → "), ...tier };
}

/** Families whose key endpoints are a sorted set, not a direction. */
const UNORDERED_KEY_FAMILIES: ReadonlySet<ArchitectureFindingKeyFamily> = new Set([
  "silentCoupling.pair",
  "splitCandidates.merge",
  "shotgunSurgery",
]);

/** The family a key names — the prefix before its `@<revision>`. */
function findingKeyFamily(key: string): ArchitectureFindingKeyFamily {
  const family = key.slice(0, key.indexOf("@"));
  if (!isFindingKeyFamily(family)) throw new Error(`architecture finding key names no known family: ${key}`);
  return family;
}

function isFindingKeyFamily(family: string): family is ArchitectureFindingKeyFamily {
  return Object.hasOwn(ARCHITECTURE_FINDING_KEY_REVISION, family);
}
