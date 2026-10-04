import type { RelPath } from "../../../../../contracts/types/codegraph.js";
import { resolveMajorityFlooredOtsuThreshold } from "../../../../../infra/graph/index.js";
import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
import type {
  DependencyNormFinding,
  DependencyNormsInput,
  DependencyNormsReport,
  DependencyNormsSummary,
  NormLedgers,
  NormLocality,
  NormPlannedEdge,
  PlannedEdgeVerdict,
} from "./types.js";

/**
 * The pair support below which a ledger never admits an edge, and the
 * population under which Otsu's split is not trusted — the majority floor
 * holds alone there. A pair with ONE edge is indistinguishable from noise;
 * the cut may only raise the bar.
 */
export const DEFAULT_NORMS_MIN_PAIR_SUPPORT = 1;
export const DEFAULT_NORMS_OTSU_MIN_POPULATION = 5;

/**
 * The edge count a ROLE must carry (as source or target, across ledgers)
 * before an unprecedented pair of it is a NEW_PATTERN rather than two roles
 * the corpus has barely observed.
 */
export const DEFAULT_NORMS_FREQUENT_ROLE_EDGES = 4;

/**
 * Empirical dependency norms (bd tea-rags-mcp-rpx0v, epic xb669.2): the
 * repository's own P(edge | roleSrc, roleDst, locality), read off the file
 * graph, and the verdict every precedent-less edge carries. The naming
 * lexicon's CONFORMS / MISFIT for dependencies: a heavy direct precedent
 * CONFORMS (and is not listed); a direct edge without one, whose roles
 * normally meet THROUGH a mid role, is a MISFIT carrying the expected path;
 * a pair the corpus has never seen between two roles it knows well is a
 * NEW_PATTERN.
 *
 * READ-TIME: the whole computation runs over the graph the report already
 * reads plus the role map naming's type-role layer derives — nothing is
 * persisted, so the norms are as fresh as the graph and cost no payload keys.
 *
 * ROLES are the caller's contract: the file's PRIMARY type's role, strong
 * (inheritance / directory evidence) only. Edges touching a weak or untyped
 * file never enter a ledger — a suffix never asserts a role, so it must not
 * misfit an edge either (naming's entry gate, bd tea-rags-mcp-vi0wx).
 */
/**
 * The ledgers the report walk and the write-time verdict share (bd
 * tea-rags-mcp-23iii): pair support per (roleSrc, roleDst, locality), each
 * role's edge activity, the adaptive cut with its live predicate. Built once
 * per input — `computeDependencyNorms` consumes it for every edge it walks,
 * `judgePlannedEdge` for one planned edge a writer is about to add.
 */
export function buildNormLedgers(input: DependencyNormsInput): NormLedgers {
  const { graph, fileRoles, componentOf } = input;
  const roleOf = (relPath: RelPath) => fileRoles.get(relPath);
  const pairs = new Map<string, number>();
  const activity = new Map<string, number>();
  const byLocality = new Map<NormLocality, Map<string, number>>();
  const localityOf = (sourceRelPath: RelPath, targetRelPath: RelPath): NormLocality => {
    if (directoryOf(sourceRelPath) === directoryOf(targetRelPath)) return "sameDirectory";
    if (componentOf) {
      const sourceComponent = componentOf.get(sourceRelPath);
      const targetComponent = componentOf.get(targetRelPath);
      if (sourceComponent !== undefined && sourceComponent === targetComponent) return "sameDomain";
    }
    return "crossDomain";
  };
  for (const edge of graph.edges) {
    const sourceRole = roleOf(edge.sourceRelPath);
    const targetRole = roleOf(edge.targetRelPath);
    if (sourceRole?.strong !== true || targetRole?.strong !== true) continue;
    const { role: roleSrc } = sourceRole;
    const { role: roleDst } = targetRole;
    const locality = localityOf(edge.sourceRelPath, edge.targetRelPath);
    const key = `${roleSrc}\u0000${roleDst}\u0000${locality}`;
    const support = (pairs.get(key) ?? 0) + 1;
    pairs.set(key, support);
    activity.set(roleSrc, (activity.get(roleSrc) ?? 0) + 1);
    activity.set(roleDst, (activity.get(roleDst) ?? 0) + 1);
    const local = byLocality.get(locality) ?? new Map<string, number>();
    local.set(`${roleSrc}\u0000${roleDst}`, support);
    byLocality.set(locality, local);
  }

  const threshold = resolveMajorityFlooredOtsuThreshold([...pairs.values()], {
    majority: DEFAULT_NORMS_MIN_PAIR_SUPPORT,
    minPopulation: DEFAULT_NORMS_OTSU_MIN_POPULATION,
  });
  return {
    pairs,
    activity,
    byLocality,
    threshold: {
      method: threshold.method,
      threshold: threshold.threshold,
      ...(threshold.separability === undefined ? {} : { separability: threshold.separability }),
    },
    admitsPairSupport: threshold.admits,
    pairCount: pairs.size,
  };
}

/** The write-time verdict (bd tea-rags-mcp-23iii): "I am about to add this edge — does the project do that?" */
export function judgePlannedEdge(ledgers: NormLedgers, planned: NormPlannedEdge): PlannedEdgeVerdict {
  const { roleSrc, roleDst, locality } = planned;
  const pairSupport = ledgers.pairs.get(`${roleSrc}\u0000${roleDst}\u0000${locality}`) ?? 0;
  if (ledgers.admitsPairSupport(pairSupport)) return { kind: "conforms", pairSupport };

  const local = ledgers.byLocality.get(locality) ?? new Map<string, number>();
  const midRoles = new Set<string>();
  for (const key of local.keys()) {
    const [from, to] = key.split("\u0000");
    midRoles.add(from);
    midRoles.add(to);
  }
  let via: string | undefined;
  let viaSupport = 0;
  for (const mid of midRoles) {
    if (mid === roleSrc || mid === roleDst) {
      continue;
    }
    const inLeg = local.get(`${roleSrc}\u0000${mid}`);
    const outLeg = local.get(`${mid}\u0000${roleDst}`);
    if (
      inLeg === undefined ||
      outLeg === undefined ||
      !ledgers.admitsPairSupport(inLeg) ||
      !ledgers.admitsPairSupport(outLeg)
    ) {
      continue;
    }
    const support = Math.min(inLeg, outLeg);
    if (support > viaSupport) {
      via = mid;
      viaSupport = support;
    }
  }
  if (via !== undefined) return { kind: "misfit", pairSupport, expectedPath: { via, support: viaSupport } };
  const frequent = (role: string) => (ledgers.activity.get(role) ?? 0) >= DEFAULT_NORMS_FREQUENT_ROLE_EDGES;
  if (frequent(roleSrc) && frequent(roleDst)) return { kind: "newPattern", pairSupport };
  return { kind: "insufficientSupport", pairSupport };
}

export function computeDependencyNorms(input: DependencyNormsInput): DependencyNormsReport {
  const { graph, fileRoles } = input;
  const roleOf = (relPath: RelPath) => fileRoles.get(relPath);

  let weakRoleFileCount = 0;
  let untypedFileCount = 0;
  for (const f of graph.files) {
    const role = fileRoles.get(f.relPath);
    if (role === undefined) untypedFileCount++;
    else if (!role.strong) weakRoleFileCount++;
  }

  const ledgers = buildNormLedgers(input);
  const localityOf = (sourceRelPath: RelPath, targetRelPath: RelPath): NormLocality => {
    if (directoryOf(sourceRelPath) === directoryOf(targetRelPath)) return "sameDirectory";
    if (input.componentOf) {
      const sourceComponent = input.componentOf.get(sourceRelPath);
      const targetComponent = input.componentOf.get(targetRelPath);
      if (sourceComponent !== undefined && sourceComponent === targetComponent) return "sameDomain";
    }
    return "crossDomain";
  };

  const findings: DependencyNormFinding[] = [];
  let lowRoleSupportEdgeCount = 0;
  let typedEdgeCount = 0;
  for (const edge of graph.edges) {
    const sourceRole = roleOf(edge.sourceRelPath);
    const targetRole = roleOf(edge.targetRelPath);
    if (sourceRole?.strong !== true || targetRole?.strong !== true) continue;
    typedEdgeCount++;
    const locality = localityOf(edge.sourceRelPath, edge.targetRelPath);
    const verdict = judgePlannedEdge(ledgers, {
      roleSrc: sourceRole.role,
      roleDst: targetRole.role,
      locality,
    });
    if (verdict.kind === "conforms") continue;
    if (verdict.kind === "insufficientSupport") {
      lowRoleSupportEdgeCount++;
    } else {
      findings.push(
        finding(
          verdict.kind,
          edge,
          sourceRole.role,
          targetRole.role,
          locality,
          verdict.pairSupport,
          verdict.expectedPath,
        ),
      );
    }
  }

  findings.sort(
    (a, b) =>
      (a.kind === "misfit" ? 0 : 1) - (b.kind === "misfit" ? 0 : 1) ||
      b.callWeight - a.callWeight ||
      compareCodePoints(a.sourceRelPath, b.sourceRelPath) ||
      compareCodePoints(a.targetRelPath, b.targetRelPath),
  );

  // bd tea-rags-mcp-mv8yv: the pattern scopes the FINDINGS by source, the way
  // every other detector scopes — ledgers, supports and the cut stay
  // whole-graph. Dropped findings are counted, never lost silently.
  const inScope = compilePathPatternMatcher(input.sourcePathPattern);
  const scopedFindings = inScope ? findings.filter((f) => inScope(f.sourceRelPath)) : findings;

  const summary: DependencyNormsSummary = {
    roleFileCount: [...new Set([...fileRoles].filter(([, r]) => r.strong).map(([p]) => p))].length,
    weakRoleFileCount,
    untypedFileCount,
    typedEdgeCount,
    judgedEdgeCount: typedEdgeCount,
    violationCount: scopedFindings.length,
    pairCount: ledgers.pairCount,
    ...(inScope ? { outOfScopeFindingCount: findings.length - scopedFindings.length } : {}),
    excluded: { lowRoleSupportEdgeCount },
  };
  return {
    summary,
    threshold: ledgers.threshold,
    findings: scopedFindings,
  };
}

function finding(
  kind: DependencyNormFinding["kind"],
  edge: { sourceRelPath: RelPath; targetRelPath: RelPath; callWeight: number },
  roleSrc: string,
  roleDst: string,
  locality: NormLocality,
  pairSupport: number,
  expectedPath?: DependencyNormFinding["expectedPath"],
): DependencyNormFinding {
  return {
    kind,
    sourceRelPath: edge.sourceRelPath,
    targetRelPath: edge.targetRelPath,
    roleSrc,
    roleDst,
    locality,
    callWeight: edge.callWeight,
    pairSupport,
    ...(expectedPath ? { expectedPath } : {}),
  };
}

function directoryOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
