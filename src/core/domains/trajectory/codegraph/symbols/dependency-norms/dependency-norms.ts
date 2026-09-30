import type { RelPath } from "../../../../../contracts/types/codegraph.js";
import { resolveMajorityFlooredOtsuThreshold } from "../boundary-diagnostics/otsu-split.js";
import type {
  DependencyNormFinding,
  DependencyNormsInput,
  DependencyNormsReport,
  DependencyNormsSummary,
  NormLocality,
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
export function computeDependencyNorms(input: DependencyNormsInput): DependencyNormsReport {
  const { graph, fileRoles, componentOf } = input;
  const roleOf = (relPath: RelPath) => fileRoles.get(relPath);

  let weakRoleFileCount = 0;
  let untypedFileCount = 0;
  for (const f of graph.files) {
    const role = fileRoles.get(f.relPath);
    if (role === undefined) untypedFileCount++;
    else if (!role.strong) weakRoleFileCount++;
  }

  const ledgers = new Map<string, number>();
  const activity = new Map<string, number>();
  let typedEdgeCount = 0;
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
    typedEdgeCount++;
    const { role: roleSrc } = sourceRole;
    const { role: roleDst } = targetRole;
    const locality = localityOf(edge.sourceRelPath, edge.targetRelPath);
    const key = `${roleSrc}\u0000${roleDst}\u0000${locality}`;
    ledgers.set(key, (ledgers.get(key) ?? 0) + 1);
    activity.set(roleSrc, (activity.get(roleSrc) ?? 0) + 1);
    activity.set(roleDst, (activity.get(roleDst) ?? 0) + 1);
  }

  const threshold = resolveMajorityFlooredOtsuThreshold([...ledgers.values()], {
    majority: DEFAULT_NORMS_MIN_PAIR_SUPPORT,
    minPopulation: DEFAULT_NORMS_OTSU_MIN_POPULATION,
  });

  // Ledger lookup by (roleSrc, roleDst) within one locality, for the transit walk.
  const byLocality = new Map<NormLocality, Map<string, number>>();
  for (const [key, support] of ledgers) {
    const [roleSrc, roleDst, locality] = key.split("\u0000") as [string, string, NormLocality];
    const local = byLocality.get(locality) ?? new Map<string, number>();
    local.set(`${roleSrc}\u0000${roleDst}`, support);
    byLocality.set(locality, local);
  }

  const frequent = (role: string) => (activity.get(role) ?? 0) >= DEFAULT_NORMS_FREQUENT_ROLE_EDGES;
  const midRoles = (locality: NormLocality) => {
    const roles = new Set<string>();
    const local = byLocality.get(locality);
    if (!local) return roles;
    for (const key of local.keys()) {
      const [from, to] = key.split("\u0000");
      roles.add(from);
      roles.add(to);
    }
    return roles;
  };

  const findings: DependencyNormFinding[] = [];
  let lowRoleSupportEdgeCount = 0;
  for (const edge of graph.edges) {
    const sourceRole = roleOf(edge.sourceRelPath);
    const targetRole = roleOf(edge.targetRelPath);
    if (sourceRole?.strong !== true || targetRole?.strong !== true) continue;
    const { role: roleSrc } = sourceRole;
    const { role: roleDst } = targetRole;
    const locality = localityOf(edge.sourceRelPath, edge.targetRelPath);
    const pairSupport = ledgers.get(`${roleSrc}\u0000${roleDst}\u0000${locality}`) ?? 0;
    if (threshold.admits(pairSupport)) continue;

    // The edge's own ledger lives here, so the locality is always present.
    const local = byLocality.get(locality) ?? new Map<string, number>();
    let via: string | undefined;
    let viaSupport = 0;
    for (const mid of midRoles(locality)) {
      if (mid === roleSrc || mid === roleDst) {
        continue;
      }
      const inLeg = local.get(`${roleSrc}\u0000${mid}`);
      const outLeg = local.get(`${mid}\u0000${roleDst}`);
      if (inLeg === undefined || outLeg === undefined || !threshold.admits(inLeg) || !threshold.admits(outLeg)) {
        continue;
      }
      const support = Math.min(inLeg, outLeg);
      if (support > viaSupport) {
        via = mid;
        viaSupport = support;
      }
    }

    if (via !== undefined) {
      findings.push(finding("misfit", edge, roleSrc, roleDst, locality, pairSupport, { via, support: viaSupport }));
    } else if (frequent(roleSrc) && frequent(roleDst)) {
      findings.push(finding("newPattern", edge, roleSrc, roleDst, locality, pairSupport));
    } else {
      lowRoleSupportEdgeCount++;
    }
  }

  findings.sort(
    (a, b) =>
      (a.kind === "misfit" ? 0 : 1) - (b.kind === "misfit" ? 0 : 1) ||
      b.callWeight - a.callWeight ||
      compareCodePoints(a.sourceRelPath, b.sourceRelPath) ||
      compareCodePoints(a.targetRelPath, b.targetRelPath),
  );

  const summary: DependencyNormsSummary = {
    roleFileCount: [...new Set([...fileRoles].filter(([, r]) => r.strong).map(([p]) => p))].length,
    weakRoleFileCount,
    untypedFileCount,
    typedEdgeCount,
    judgedEdgeCount: typedEdgeCount,
    violationCount: findings.length,
    pairCount: ledgers.size,
    excluded: { lowRoleSupportEdgeCount },
  };
  return {
    summary,
    threshold: {
      method: threshold.method,
      threshold: threshold.threshold,
      ...(threshold.separability === undefined ? {} : { separability: threshold.separability }),
    },
    findings,
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
