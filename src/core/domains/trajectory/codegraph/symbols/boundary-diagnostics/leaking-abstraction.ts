import {
  WHOLE_MODULE_EXPORT_NAME,
  type FileDependencyEdge,
  type FileDependencyGraph,
  type RelPath,
} from "../../../../../contracts/types/codegraph.js";
import {
  resolveMajorityFlooredOtsuThreshold,
  type MajorityFlooredOtsuThreshold,
} from "../../../../../primitives/graph/index.js";
import {
  benjaminiHochbergRejectionCount,
  binomialUpperTail,
  CONVENTIONAL_FDR_Q,
} from "../../../../../primitives/math/index.js";
import { compilePathPatternMatcher, type PathFilter } from "../../../../../primitives/paths/index.js";
import { MODULE_ENTRY_FILE_NAMES, RE_EXPORT_CYCLE_PATH_CAP } from "../../component-geometry/index.js";
import type {
  FacadeDeFactoSurface,
  FacadeLeakEdgeJudge,
  FacadeLeakKind,
  FacadeLeakRootCause,
  FacadeLeakViolation,
  FacadeModuleAssessment,
  FacadeModuleExclusionReason,
  FacadeModuleStatus,
  LeakingAbstractionOptions,
  LeakingAbstractionReport,
  StableDependenciesScope,
} from "./types.js";

/**
 * The majority floor on facade adoption: a boundary is judged only when
 * adoption is STRICTLY above it — a facade used by at most half its importers
 * is never a boundary, whatever the codebase's own split says. From the
 * owner-approved A4 definition (bd tea-rags-mcp-jetrd, 2026-09-24/25); the
 * comparison is strict by contract, not by an epsilon. Not an env knob.
 */
export const FACADE_ADOPTION_MAJORITY = 0.5;

/**
 * Minimum distinct external importers for a module's adoption to be trusted,
 * and for the module to enter the population the adaptive threshold is drawn
 * over — same owner-approved definition as {@link FACADE_ADOPTION_MAJORITY}.
 * With one or two importers a single file flips adoption between 0 and 1.
 */
export const FACADE_MIN_EXTERNAL_IMPORTERS = 3;

/**
 * Smallest adoption population Otsu's split is trusted on (owner decision
 * 2026-09-25). Below it — or with fewer than two distinct adoption values —
 * the threshold is the strict majority alone.
 */
export const FACADE_OTSU_MIN_POPULATION = 8;

/**
 * The adoption threshold a codebase gets: ADAPTIVE, drawn from the adoption
 * values of the modules themselves rather than fixed, because how much of a
 * codebase goes through its facades is a property of that codebase.
 */
export type FacadeAdoptionThresholdPolicy = MajorityFlooredOtsuThreshold;

/**
 * Resolve the adoption threshold over `population` — the adoption of every
 * candidate module meeting {@link FACADE_MIN_EXTERNAL_IMPORTERS}. Otsu's split
 * (via {@link resolveMajorityFlooredOtsuThreshold}) when the population holds
 * at least {@link FACADE_OTSU_MIN_POPULATION} values, two distinct ones, and a
 * cut bimodal enough to trust (the shared η separability gate), the strict
 * majority otherwise. Under either method a value at or below
 * {@link FACADE_ADOPTION_MAJORITY} is never admitted.
 */
export function resolveFacadeAdoptionThreshold(population: readonly number[]): FacadeAdoptionThresholdPolicy {
  return resolveMajorityFlooredOtsuThreshold(population, {
    majority: FACADE_ADOPTION_MAJORITY,
    minPopulation: FACADE_OTSU_MIN_POPULATION,
  });
}

/** What each module exclusion means, named for a report. */
export const FACADE_MODULE_EXCLUSION_REASONS: Readonly<Record<FacadeModuleExclusionReason, string>> = {
  "facade-not-adopted":
    "facade not adopted: adoption below the codebase's adaptive threshold, or at most half the importers use the entry file",
  "too-few-importers": `too few importers: fewer than ${FACADE_MIN_EXTERNAL_IMPORTERS} external importers, adoption is not trusted`,
  "language-enforced": "language-enforced: the compiler enforces the package boundary (Go)",
};

/** `cg_symbols_files.language` of a file whose directory is a compiler-enforced package. */
const LANGUAGE_ENFORCED_PACKAGE_LANGUAGE = "go";

const ENTRY_FILE_NAMES: ReadonlySet<string> = new Set(Object.values(MODULE_ENTRY_FILE_NAMES).flat());

interface ModuleCandidate {
  moduleDir: string;
  entries: Set<RelPath>;
  languageEnforced: boolean;
  /** External importer → did it reach a non-entry file. */
  importers: Map<RelPath, boolean>;
}

/**
 * Leaking-abstraction check, file level (A4, bd tea-rags-mcp-jetrd).
 *
 * A MODULE is a directory holding a language entry file
 * ({@link MODULE_ENTRY_FILE_NAMES}). Its external importers are the files
 * outside its PARENT directory component — the parent being one that declares
 * its own assembly barrel (an entry file; see {@link isIntraParentConsumer}) —
 * with a file edge into any file inside it (at any depth); each is a FACADE
 * importer when every such edge targets the
 * entry file and a DEEP importer otherwise. A consumer inside the parent
 * component — a sibling of the module, or the parent's own assembly files — is
 * INTERNAL, not external (bd tea-rags-mcp-yo3ue, two-seam model per bd
 * tea-rags-mcp-89k7k.22): `api/internal` importing `api/public/errors.ts`
 * directly is the parent's assembly consuming its contract's vocabulary, and
 * routing it through `api/public/index.ts` would make internal code import the
 * parent's assembly barrel, which re-exports the internal app-factory — a real
 * cycle. Such consumers leave the adoption denominators and the violation
 * candidates, and are counted in `summary.excludedModules.intraParentConsumers`
 * — distinct module + importer pairs, never silently dropped. The repository
 * root is not a parent component, so a module directly under it has none.
 * `adoption = facade / (facade + deep)`. The boundary is
 * ACTIVE when there are at least {@link FACADE_MIN_EXTERNAL_IMPORTERS} external
 * importers and adoption clears the codebase's adaptive threshold
 * ({@link resolveFacadeAdoptionThreshold} over the adoption of every module
 * meeting the importer floor); otherwise the module is reported with the
 * reason it is not judged.
 *
 * A VIOLATION is an edge `src → x` where `x` lies inside an active module,
 * `src` outside the module's parent directory component, and `x` is not that
 * module's entry. Each edge is reported
 * once, against the INNERMOST module it qualifies for. Its kind is decided by
 * {@link classifyFacadeLeak}: by the export names both edges carry when they
 * do, by whether the entry file has an edge to `x` at all otherwise.
 *
 * An edge into exactly the entry file of a directory that declares its own
 * entry strictly inside the module is that inner module's facade edge (bd
 * tea-rags-mcp-n8shz): not a violation of the outer module and no deep
 * importer in its adoption, counted in `summary.excludedModules.nestedEntryEdges`
 * ({@link isNestedEntryFacadeEdge}). A bypass into it stays a violation.
 *
 * A module may have a SECOND surface its importers adopted beside the facade —
 * a child they reach directly far above the module's background deep-import
 * rate ({@link measureDeFactoSurfaces}, bd tea-rags-mcp-r8hme.52.16). An
 * internal-reach edge into such a child is not a violation; it is counted in
 * `summary.excludedModules.deFactoSurfaceEdges` and the child is listed in
 * `summary.deFactoSurfaces`. A bypass into it stays a violation.
 *
 * Diagnosis, not prescription: a violation says the importer walked past a
 * surface its peers use, not how the module should be drawn. One repair caveat
 * IS measured (bd tea-rags-mcp-89k7k.3, endpoint per bd tea-rags-mcp-89k7k.17):
 * the re-export recipe — export the leaked names from the facade, point the
 * importer at it — adds source → facade, which closes an import cycle exactly
 * when the facade's own import graph already reaches the violating importer,
 * so every violation carries `reExportUnsafe` and, when true, the first found
 * facade→…→source path capped at {@link RE_EXPORT_CYCLE_PATH_CAP} files.
 * Reachability of the leaked target alone proves nothing and does not flag.
 */
export function detectLeakingAbstractions(
  graph: FileDependencyGraph,
  options: LeakingAbstractionOptions = {},
): LeakingAbstractionReport {
  const inScope = compilePathPatternMatcher(options.sourcePathPattern);
  const scope: StableDependenciesScope | undefined =
    inScope && options.sourcePathPattern
      ? { sourcePathPattern: options.sourcePathPattern, outOfScopeEdgeCount: 0 }
      : undefined;
  const candidates = collectModuleCandidates(graph);
  const edgesByKey = new Map(graph.edges.map((e) => [edgeKey(e.sourceRelPath, e.targetRelPath), e]));
  const importsFrom = importsAdjacency(graph);

  const intraParentConsumerKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.sourceRelPath === edge.targetRelPath) continue;
    for (const module of enclosingModules(candidates, edge.targetRelPath)) {
      if (isInside(edge.sourceRelPath, module.moduleDir)) continue;
      if (isIntraParentConsumer(edge.sourceRelPath, module.moduleDir, candidates)) {
        intraParentConsumerKeys.add(edgeKey(module.moduleDir, edge.sourceRelPath));
        continue;
      }
      if (isNestedEntryFacadeEdge(edge, module, candidates, edgesByKey)) continue;
      const deep = !module.entries.has(edge.targetRelPath);
      module.importers.set(edge.sourceRelPath, (module.importers.get(edge.sourceRelPath) ?? false) || deep);
    }
  }

  const measured = [...candidates.values()].map(measure);
  const policy = resolveFacadeAdoptionThreshold(measured.filter((m) => m.status === "active").map((m) => m.adoption));
  const assessments = new Map<string, FacadeModuleAssessment>();
  for (const m of measured) {
    const status: FacadeModuleStatus =
      m.status === "active" && !policy.admits(m.adoption) ? "facade-not-adopted" : m.status;
    assessments.set(m.moduleDir, { ...m, status });
  }

  const deFactoSurfaces = measureDeFactoSurfaces(graph, candidates, assessments, edgesByKey);
  const rule: FacadeLeakRule = {
    candidates,
    assessments,
    edgesByKey,
    surfaceKeys: new Set(deFactoSurfaces.map((s) => edgeKey(s.moduleDir, s.child))),
  };

  const violations: FacadeLeakViolation[] = [];
  let judgedEdgeCount = 0;
  let deFactoSurfaceEdges = 0;
  let nestedEntryEdges = 0;
  for (const edge of graph.edges) {
    if (scope && inScope && !inScope(edge.sourceRelPath)) {
      scope.outOfScopeEdgeCount++;
      continue;
    }
    if (edge.sourceRelPath === edge.targetRelPath) continue;
    const { judged, leak, spared, nestedEntry } = judgeFacadeLeak(edge, rule);
    if (judged) judgedEdgeCount++;
    if (spared) deFactoSurfaceEdges++;
    if (nestedEntry) nestedEntryEdges++;
    if (!leak) continue;
    const { owner, classification } = leak;
    const { module, assessment } = owner;
    const facadeRelPath = assessment.facadeRelPath as RelPath;
    const cyclePath = firstImportPath(importsFrom, facadeRelPath, edge.sourceRelPath);
    violations.push({
      ...classification,
      sourceRelPath: edge.sourceRelPath,
      targetRelPath: edge.targetRelPath,
      moduleDir: module.moduleDir,
      facadeRelPath,
      adoption: assessment.adoption,
      facadeImporterCount: assessment.facadeImporterCount,
      deepImporterCount: assessment.deepImporterCount,
      callWeight: edge.callWeight,
      reExportUnsafe: cyclePath !== undefined,
      ...(cyclePath ? { reExportCyclePath: cyclePath } : {}),
    });
  }

  violations.sort(bySeverity);
  const modules = [...assessments.values()].sort((a, b) => compareCodePoints(a.moduleDir, b.moduleDir));
  const countStatus = (status: FacadeModuleStatus) => modules.filter((m) => m.status === status).length;
  const countKind = (kind: FacadeLeakKind) => violations.filter((v) => v.kind === kind).length;
  return {
    violations,
    rootCauses: groupRootCauses(violations),
    modules,
    summary: {
      adoptionThreshold: policy.threshold,
      adoptionThresholdMethod: policy.method,
      ...(policy.separability === undefined ? {} : { adoptionSeparability: policy.separability }),
      minExternalImporters: FACADE_MIN_EXTERNAL_IMPORTERS,
      edgeCount: graph.edges.length,
      judgedEdgeCount,
      violationCount: violations.length,
      violationsByKind: { bypass: countKind("bypass"), internalReach: countKind("internal-reach") },
      moduleCount: modules.length,
      activeModuleCount: countStatus("active"),
      excludedModules: {
        facadeNotAdopted: countStatus("facade-not-adopted"),
        tooFewImporters: countStatus("too-few-importers"),
        languageEnforced: countStatus("language-enforced"),
        intraParentConsumers: intraParentConsumerKeys.size,
        deFactoSurfaceEdges,
        nestedEntryEdges,
      },
      deFactoSurfaces,
      ...(scope ? { scope } : {}),
    },
  };
}

/** The module a judged edge leaks past, with its assessment. */
interface FacadeLeakOwner {
  module: ModuleCandidate;
  assessment: FacadeModuleAssessment;
}

/**
 * Whether `edge` is judged by some active module, and the module it leaks
 * past: innermost first, the first active module whose non-entry file the edge
 * reaches from outside its parent component owns it. An edge into an inner
 * module's entry is that inner module's facade edge and leaks past no outer
 * one ({@link isNestedEntryFacadeEdge}) — `nestedEntry`, unless the outer
 * facade already exposes it (a bypass).
 */
function judgeFacadeEdge(
  edge: FileDependencyEdge,
  candidates: Map<string, ModuleCandidate>,
  assessments: ReadonlyMap<string, FacadeModuleAssessment>,
  edgesByKey: ReadonlyMap<string, FileDependencyEdge>,
): { judged: boolean; nestedEntry: boolean; owner?: FacadeLeakOwner } {
  let judged = false;
  for (const module of enclosingModules(candidates, edge.targetRelPath)) {
    const assessment = assessments.get(module.moduleDir);
    if (assessment?.status !== "active" || isInside(edge.sourceRelPath, module.moduleDir)) continue;
    // An intra-parent consumer is internal to the parent component — never a
    // bypass / internal-reach candidate (bd tea-rags-mcp-yo3ue).
    if (isIntraParentConsumer(edge.sourceRelPath, module.moduleDir, candidates)) continue;
    judged = true;
    if (module.entries.has(edge.targetRelPath)) continue;
    if (isNestedEntryFacadeEdge(edge, module, candidates, edgesByKey)) return { judged, nestedEntry: true };
    return { judged, nestedEntry: false, owner: { module, assessment } };
  }
  return { judged, nestedEntry: false };
}

/**
 * `edge` targets exactly the entry file of a directory that declares its own
 * entry and lies strictly inside `module` (bd tea-rags-mcp-n8shz): a DECLARED
 * surface — the same declaration {@link isIntraParentConsumer} honours — so
 * the edge is that inner module's facade edge, judged there or not at all
 * (an inner module with too few importers is not judged), never an internal
 * reach of `module`. A bypass stays: when {@link classifyFacadeLeak} says
 * `module`'s facade already exposes what the edge takes, the importer walked
 * past an outer surface that offers it — the de-facto surface rule draws the
 * same line.
 */
function isNestedEntryFacadeEdge(
  edge: FileDependencyEdge,
  module: ModuleCandidate,
  candidates: ReadonlyMap<string, ModuleCandidate>,
  edgesByKey: ReadonlyMap<string, FileDependencyEdge>,
): boolean {
  const declaring = candidates.get(directoryOf(edge.targetRelPath));
  if (declaring === undefined || declaring === module || !declaring.entries.has(edge.targetRelPath)) return false;
  return classifyFacadeLeak(edge, module.entries, edgesByKey).kind === "internal-reach";
}

/** What the facade-leak rule reads beside the edge: the modules, their statuses, the graph's edges and de-facto surfaces. */
interface FacadeLeakRule {
  candidates: Map<string, ModuleCandidate>;
  assessments: ReadonlyMap<string, FacadeModuleAssessment>;
  edgesByKey: ReadonlyMap<string, FileDependencyEdge>;
  /** `edgeKey(moduleDir, child)` of every measured de-facto surface. */
  surfaceKeys: ReadonlySet<string>;
}

/**
 * The facade-leak rule over one edge — the ONE copy both the report and
 * {@link createFacadeLeakEdgeJudge} run: the owning module
 * ({@link judgeFacadeEdge}), the kind ({@link classifyFacadeLeak}), and the
 * de-facto surface exemption. Reaching a measured de-facto surface is how the
 * module is used, not a leak — `spared`, counted by the report, never silently
 * dropped (bd tea-rags-mcp-r8hme.52.16). A bypass stays: the facade already
 * offers what the edge takes.
 */
function judgeFacadeLeak(
  edge: FileDependencyEdge,
  rule: FacadeLeakRule,
): {
  judged: boolean;
  spared: boolean;
  nestedEntry: boolean;
  leak?: { owner: FacadeLeakOwner; classification: FacadeLeakClassification };
} {
  const { judged, nestedEntry, owner } = judgeFacadeEdge(edge, rule.candidates, rule.assessments, rule.edgesByKey);
  if (!owner) return { judged, spared: false, nestedEntry };
  const { moduleDir } = owner.module;
  const classification = classifyFacadeLeak(edge, owner.module.entries, rule.edgesByKey);
  if (
    classification.kind === "internal-reach" &&
    rule.surfaceKeys.has(edgeKey(moduleDir, childSegment(moduleDir, edge.targetRelPath)))
  ) {
    return { judged, spared: true, nestedEntry };
  }
  return { judged, spared: false, nestedEntry, leak: { owner, classification } };
}

/**
 * The report's facade-leak rule as an edge predicate (bd tea-rags-mcp-hv38q):
 * the diff-scoped review judges edges the indexed graph may not hold yet, and
 * must name exactly what the report would. Module statuses come from
 * `report.modules` and the de-facto surfaces from `summary.deFactoSurfaces` —
 * the report over the SAME `graph` — so adoption is never re-measured; the
 * edge is judged by {@link judgeFacadeLeak}, the report's own rule. An edge
 * the graph holds is classified with its recorded export names; one it does
 * not hold has none, so its kind falls to the file rule. Parity: over the
 * graph's edges the judge answers exactly where `report.violations` lists one
 * (a report built with `sourcePathPattern` scopes its violations; the judge
 * does not). `excludedFromGraph` names the files the graph was cut down by —
 * tests, test support, tooling: an edge with such an endpoint is never in the
 * report's graph, so the judge never answers for it either; a file merely
 * absent (new in a diff) is judged.
 */
export function createFacadeLeakEdgeJudge(
  graph: FileDependencyGraph,
  report: Pick<LeakingAbstractionReport, "modules" | "summary">,
  excludedFromGraph?: PathFilter,
): FacadeLeakEdgeJudge {
  const rule: FacadeLeakRule = {
    candidates: collectModuleCandidates(graph),
    assessments: new Map(report.modules.map((m) => [m.moduleDir, m])),
    edgesByKey: new Map(graph.edges.map((e) => [edgeKey(e.sourceRelPath, e.targetRelPath), e])),
    surfaceKeys: new Set(report.summary.deFactoSurfaces.map((s) => edgeKey(s.moduleDir, s.child))),
  };
  return (source, target) => {
    if (source === target) return undefined;
    if (excludedFromGraph?.ignores(source) || excludedFromGraph?.ignores(target)) return undefined;
    const edge = rule.edgesByKey.get(edgeKey(source, target)) ?? {
      sourceRelPath: source,
      targetRelPath: target,
      callWeight: 0,
    };
    const { leak } = judgeFacadeLeak(edge, rule);
    if (!leak) return undefined;
    return {
      moduleDir: leak.owner.module.moduleDir,
      facadeRelPath: leak.owner.assessment.facadeRelPath as RelPath,
      kind: leak.classification.kind,
    };
  };
}

/** One (module, child) unit of the de-facto surface test. */
interface SurfaceUnit {
  moduleDir: string;
  child: string;
  /** d(S): distinct importers with a leak edge into the child. */
  directImporterCount: number;
  /** only(S): those whose leak edges into the module all land in this child. */
  exclusiveImporterCount: number;
  externalImporterCount: number;
  deepImporterCount: number;
}

/**
 * De-facto surface children (bd tea-rags-mcp-r8hme.52.16, rule R3b). A child S
 * of an active module M is the first path segment under M on the target of a
 * leak edge M owns ({@link judgeFacadeEdge}); entry files are never targets, so
 * never children. Each (M, S) is tested against M's own background:
 * p = P(X ≥ d(S)), X ~ Bin(ext(M), q), q = (deep(M) − out + ½) / (ext(M) − out
 * + 1), where `out` is the exclusive-importer mass of S and of every surface
 * already detected in M — a child must stand out against the deep imports that
 * are NOT already explained by a surface, and the Jeffreys ½ keeps q off zero
 * so a tiny module's lone deep import is never a surface. Benjamini–Hochberg at
 * {@link CONVENTIONAL_FDR_Q} over every unit as one family; detected surfaces
 * then leave the background and the test repeats until no new unit is
 * rejected. Growing `out` lowers every q, so every p and with it the BH
 * rejection set only grow: the loop terminates within units-many rounds, and
 * the reported q and p are those of the final round. Direct file edges only.
 */
function measureDeFactoSurfaces(
  graph: FileDependencyGraph,
  candidates: Map<string, ModuleCandidate>,
  assessments: ReadonlyMap<string, FacadeModuleAssessment>,
  edgesByKey: ReadonlyMap<string, FileDependencyEdge>,
): FacadeDeFactoSurface[] {
  const childImporters = new Map<string, Map<string, Set<RelPath>>>();
  const importerChildren = new Map<string, Map<RelPath, Set<string>>>();
  for (const edge of graph.edges) {
    if (edge.sourceRelPath === edge.targetRelPath) continue;
    const { owner } = judgeFacadeEdge(edge, candidates, assessments, edgesByKey);
    if (!owner) continue;
    const { moduleDir } = owner.module;
    const child = childSegment(moduleDir, edge.targetRelPath);
    const byChild = getOrCreate(childImporters, moduleDir, () => new Map<string, Set<RelPath>>());
    getOrCreate(byChild, child, () => new Set<RelPath>()).add(edge.sourceRelPath);
    const byImporter = getOrCreate(importerChildren, moduleDir, () => new Map<RelPath, Set<string>>());
    getOrCreate(byImporter, edge.sourceRelPath, () => new Set<string>()).add(child);
  }

  const units: SurfaceUnit[] = [];
  for (const [moduleDir, byChild] of childImporters) {
    const assessment = assessments.get(moduleDir) as FacadeModuleAssessment;
    const reach = importerChildren.get(moduleDir) as Map<RelPath, Set<string>>;
    for (const [child, importers] of byChild) {
      let exclusiveImporterCount = 0;
      for (const importer of importers) if (reach.get(importer)?.size === 1) exclusiveImporterCount++;
      units.push({
        moduleDir,
        child,
        directImporterCount: importers.size,
        exclusiveImporterCount,
        externalImporterCount: assessment.externalImporterCount,
        deepImporterCount: assessment.deepImporterCount,
      });
    }
  }

  const surfaces = new Set<SurfaceUnit>();
  let tested = testSurfaceUnits(units, surfaces);
  for (;;) {
    const ascending = tested.map((t) => t.pValue).sort((a, b) => a - b);
    const rejected = benjaminiHochbergRejectionCount(ascending, units.length, CONVENTIONAL_FDR_Q);
    if (rejected === 0) break;
    const cut = ascending[rejected - 1];
    const fresh = tested.filter((t) => t.pValue <= cut && !surfaces.has(t.unit));
    if (fresh.length === 0) break;
    for (const t of fresh) surfaces.add(t.unit);
    tested = testSurfaceUnits(units, surfaces);
  }
  return tested
    .filter((t) => surfaces.has(t.unit))
    .map(({ unit, backgroundRate, pValue }) => ({
      moduleDir: unit.moduleDir,
      child: unit.child,
      directImporterCount: unit.directImporterCount,
      backgroundRate,
      pValue,
    }))
    .sort(
      (a, b) =>
        a.pValue - b.pValue || compareCodePoints(a.moduleDir, b.moduleDir) || compareCodePoints(a.child, b.child),
    );
}

/**
 * One round of the surface test: each unit's background rate with its own and
 * every detected surface's exclusive importers left out, and its p-value.
 */
function testSurfaceUnits(
  units: readonly SurfaceUnit[],
  surfaces: ReadonlySet<SurfaceUnit>,
): { unit: SurfaceUnit; backgroundRate: number; pValue: number }[] {
  const surfaceMass = new Map<string, number>();
  for (const s of surfaces) {
    surfaceMass.set(s.moduleDir, (surfaceMass.get(s.moduleDir) ?? 0) + s.exclusiveImporterCount);
  }
  return units.map((unit) => {
    const out = (surfaceMass.get(unit.moduleDir) ?? 0) + (surfaces.has(unit) ? 0 : unit.exclusiveImporterCount);
    const backgroundRate = (unit.deepImporterCount - out + 1 / 2) / (unit.externalImporterCount - out + 1);
    return {
      unit,
      backgroundRate,
      pValue: binomialUpperTail(unit.directImporterCount, unit.externalImporterCount, backgroundRate),
    };
  });
}

/** First path segment of `relPath` under `moduleDir` — a directory or a file name. */
function childSegment(moduleDir: string, relPath: RelPath): string {
  const rest = moduleDir === "" ? relPath : relPath.slice(moduleDir.length + 1);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

/** Entry files whose imported names ARE the module's exports (Python has no re-export syntax). */
const IMPORTS_ARE_EXPORTS_ENTRY_NAMES: ReadonlySet<string> = new Set(MODULE_ENTRY_FILE_NAMES.python);

type FacadeLeakClassification = Pick<FacadeLeakViolation, "kind" | "kindBasis" | "importedNames" | "nonExportedNames">;

/** Every name an edge takes from its target, imported or forwarded; `undefined` when none was recorded. */
function namesTakenBy(edge: FileDependencyEdge): string[] | undefined {
  const names = [...(edge.importedExportNames ?? []), ...(edge.reexportedExportNames ?? [])];
  return names.length > 0 ? [...new Set(names)] : undefined;
}

/**
 * Kind of a deep edge into a module's non-entry file `x` (bd tea-rags-mcp-r8hme.2),
 * and HOW it was decided (bd tea-rags-mcp-r8hme.43).
 *
 * With names on BOTH sides — the deep edge's, and the entry file's edge to `x`
 * — it is `bypass` when the facade exposes every name the deep import takes
 * (or exposes all of `x`), `internal-reach` when it does not, listing the names
 * it does not; the kind is `names`-decided. The facade exposes what it
 * re-exports; a Python `__init__.py` also exposes what it imports. An entry
 * file with no edge to `x` exposes nothing of it. Where either side recorded no
 * names the file-level rule stands — `bypass` iff the entry file has an edge to
 * `x` — and the kind is `file-rule`-decided: a `file-rule` bypass is NOT
 * certification that the facade already exposes the imported names.
 */
function classifyFacadeLeak(
  edge: FileDependencyEdge,
  entries: ReadonlySet<RelPath>,
  edgesByKey: ReadonlyMap<string, FileDependencyEdge>,
): FacadeLeakClassification {
  const importedNames = namesTakenBy(edge);
  const named = importedNames ? { importedNames } : {};
  const facadeEdges = [...entries]
    .map((entry) => ({ entry, facadeEdge: edgesByKey.get(edgeKey(entry, edge.targetRelPath)) }))
    .filter((f): f is { entry: RelPath; facadeEdge: FileDependencyEdge } => f.facadeEdge !== undefined);
  if (facadeEdges.length === 0) {
    // No facade edge to compare against — the file rule decided (bd tea-rags-mcp-r8hme.43).
    return {
      kind: "internal-reach",
      kindBasis: "file-rule",
      ...named,
      ...(importedNames ? { nonExportedNames: importedNames } : {}),
    };
  }
  const exposed = new Set<string>();
  let facadeNamesRecorded = false;
  for (const { entry, facadeEdge } of facadeEdges) {
    if (facadeEdge.importedExportNames || facadeEdge.reexportedExportNames) facadeNamesRecorded = true;
    for (const name of facadeEdge.reexportedExportNames ?? []) exposed.add(name);
    if (IMPORTS_ARE_EXPORTS_ENTRY_NAMES.has(baseName(entry))) {
      for (const name of facadeEdge.importedExportNames ?? []) exposed.add(name);
    }
  }
  if (!importedNames || !facadeNamesRecorded) {
    return { kind: "bypass", kindBasis: "file-rule", ...named };
  }
  if (exposed.has(WHOLE_MODULE_EXPORT_NAME)) {
    // The `*` re-export is names evidence: the facade exposes all of `x`.
    return { kind: "bypass", kindBasis: "names", ...named };
  }
  const nonExportedNames = importedNames.filter((name) => !exposed.has(name));
  return nonExportedNames.length === 0
    ? { kind: "bypass", kindBasis: "names", ...named }
    : { kind: "internal-reach", kindBasis: "names", ...named, nonExportedNames };
}

/**
 * The file import graph as source → direct targets, in edge order so the
 * reachability walk below is deterministic.
 */
function importsAdjacency(graph: FileDependencyGraph): Map<RelPath, RelPath[]> {
  const adjacency = new Map<RelPath, RelPath[]>();
  for (const e of graph.edges) {
    if (e.sourceRelPath === e.targetRelPath) continue;
    const targets = adjacency.get(e.sourceRelPath);
    if (targets) targets.push(e.targetRelPath);
    else adjacency.set(e.sourceRelPath, [e.targetRelPath]);
  }
  return adjacency;
}

/**
 * First found import path `from → … → to` over the file graph, breadth-first,
 * deterministic in edge order; `undefined` when `to` is not reachable within
 * {@link RE_EXPORT_CYCLE_PATH_CAP} files. The parent map keeps the whole walk
 * O(files + edges) per call.
 */
function firstImportPath(
  importsFrom: ReadonlyMap<RelPath, readonly RelPath[]>,
  from: RelPath,
  to: RelPath,
): RelPath[] | undefined {
  const parents = new Map<RelPath, RelPath | null>([[from, null]]);
  let frontier = [from];
  for (let depth = 1; depth < RE_EXPORT_CYCLE_PATH_CAP && frontier.length > 0; depth++) {
    const nextFrontier: RelPath[] = [];
    for (const file of frontier) {
      for (const next of importsFrom.get(file) ?? []) {
        if (parents.has(next)) continue;
        parents.set(next, file);
        if (next === to) {
          const path = [next];
          let at: RelPath | null = file;
          while (at !== null) {
            path.unshift(at);
            at = parents.get(at) ?? null;
          }
          return path;
        }
        nextFrontier.push(next);
      }
    }
    frontier = nextFrontier;
  }
  return undefined;
}

/** Group `violations` by module — see {@link FacadeLeakRootCause}. */ function groupRootCauses(
  violations: readonly FacadeLeakViolation[],
): FacadeLeakRootCause[] {
  const byModule = new Map<string, FacadeLeakViolation[]>();
  for (const v of violations) {
    const group = byModule.get(v.moduleDir);
    if (group) group.push(v);
    else byModule.set(v.moduleDir, [v]);
  }
  const rootCauses: FacadeLeakRootCause[] = [];
  for (const [moduleDir, group] of byModule) {
    const [first] = group;
    const bypassCount = group.filter((v) => v.kind === "bypass").length;
    rootCauses.push({
      moduleDir,
      facadeRelPath: first.facadeRelPath,
      adoption: first.adoption,
      facadeImporterCount: first.facadeImporterCount,
      deepImporterCount: first.deepImporterCount,
      violationCount: group.length,
      bypassCount,
      internalReachCount: group.length - bypassCount,
      sources: [...new Set(group.map((v) => v.sourceRelPath))].sort(compareCodePoints),
    });
  }
  return rootCauses.sort((a, b) => b.violationCount - a.violationCount || compareCodePoints(a.moduleDir, b.moduleDir));
}

/** Directories with an entry file, then Go package directories that have none. */
function collectModuleCandidates(graph: FileDependencyGraph): Map<string, ModuleCandidate> {
  const candidates = new Map<string, ModuleCandidate>();
  const candidate = (moduleDir: string, languageEnforced: boolean): ModuleCandidate => {
    let module = candidates.get(moduleDir);
    if (!module) {
      module = { moduleDir, entries: new Set(), languageEnforced, importers: new Map() };
      candidates.set(moduleDir, module);
    }
    return module;
  };
  for (const file of graph.files) {
    if (ENTRY_FILE_NAMES.has(baseName(file.relPath))) {
      const module = candidate(directoryOf(file.relPath), false);
      module.entries.add(file.relPath);
    }
  }
  for (const file of graph.files) {
    if (file.language === LANGUAGE_ENFORCED_PACKAGE_LANGUAGE && !candidates.has(directoryOf(file.relPath))) {
      candidate(directoryOf(file.relPath), true);
    }
  }
  return candidates;
}

/**
 * A module's counts and its status BEFORE the adoption threshold: `active`
 * here means "meets the importer floor", the population the threshold is
 * drawn over; the threshold then demotes the ones it does not admit.
 */
function measure(module: ModuleCandidate): FacadeModuleAssessment {
  const externalImporterCount = module.importers.size;
  if (module.languageEnforced) {
    return {
      moduleDir: module.moduleDir,
      facadeRelPath: null,
      externalImporterCount,
      facadeImporterCount: 0,
      deepImporterCount: 0,
      adoption: 0,
      status: "language-enforced",
    };
  }
  let deepImporterCount = 0;
  for (const deep of module.importers.values()) if (deep) deepImporterCount++;
  const facadeImporterCount = externalImporterCount - deepImporterCount;
  const adoption = externalImporterCount === 0 ? 0 : facadeImporterCount / externalImporterCount;
  let status: FacadeModuleStatus = "active";
  if (externalImporterCount < FACADE_MIN_EXTERNAL_IMPORTERS) status = "too-few-importers";
  return {
    moduleDir: module.moduleDir,
    facadeRelPath: [...module.entries].sort(compareCodePoints)[0],
    externalImporterCount,
    facadeImporterCount,
    deepImporterCount,
    adoption,
    status,
  };
}

/** Candidate modules containing `relPath` at any depth, innermost first. */
function* enclosingModules(candidates: Map<string, ModuleCandidate>, relPath: RelPath): Generator<ModuleCandidate> {
  let dir = directoryOf(relPath);
  for (;;) {
    const module = candidates.get(dir);
    if (module) yield module;
    if (dir === "") return;
    dir = directoryOf(dir);
  }
}

/** `relPath` lies below `dir` at any depth; everything lies below the root `""`. */
function isInside(relPath: RelPath, dir: string): boolean {
  return dir === "" || relPath.startsWith(`${dir}/`);
}

/**
 * `sourceRelPath` is a consumer inside the module's PARENT directory component
 * — a sibling of the module or the parent's own assembly files, i.e. inside
 * `directoryOf(moduleDir)` but outside the module itself (the caller already
 * excluded that). The parent counts as a component only where it DECLARES one:
 * it holds an entry file, its assembly barrel — the two-seam shape of bd
 * tea-rags-mcp-89k7k.22 (`api/internal` + `api/index.ts` around
 * `api/public`). A bare parent directory namespaces its children but assembles
 * nothing, so its files stay ordinary external consumers — without this the
 * rule would blind every depth-2 module (`src/lib` consumed by `src/app`).
 * Segment-compared via {@link isInside}: `api-clone/x.ts` is NOT inside the
 * parent `api`. The repository root (`""`) is not a parent component, so a
 * module directly under it has no intra-parent consumers.
 */
function isIntraParentConsumer(
  sourceRelPath: RelPath,
  moduleDir: string,
  candidates: ReadonlyMap<string, ModuleCandidate>,
): boolean {
  const parentDir = directoryOf(moduleDir);
  if (parentDir === "") return false;
  const parent = candidates.get(parentDir);
  if (parent === undefined || parent.entries.size === 0) return false;
  return isInside(sourceRelPath, parentDir);
}

function directoryOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}

function edgeKey(source: RelPath, target: RelPath): string {
  return `${source}\u0000${target}`;
}

const KIND_ORDER: Readonly<Record<FacadeLeakKind, number>> = { "internal-reach": 0, bypass: 1 };

function bySeverity(a: FacadeLeakViolation, b: FacadeLeakViolation): number {
  return (
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    b.callWeight - a.callWeight ||
    compareCodePoints(a.sourceRelPath, b.sourceRelPath) ||
    compareCodePoints(a.targetRelPath, b.targetRelPath)
  );
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
