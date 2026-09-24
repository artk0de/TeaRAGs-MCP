import type { FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";
import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
import { otsuSplit } from "./otsu-split.js";
import type {
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
export interface FacadeAdoptionThresholdPolicy {
  method: "otsu" | "majority";
  /** The Otsu cut when `method` is `otsu`; {@link FACADE_ADOPTION_MAJORITY} otherwise. */
  threshold: number;
  /** η of the Otsu cut; absent under `majority`. */
  separability?: number;
  /** Whether an adoption value clears the threshold — `>= threshold` AND `> majority`. */
  admits: (adoption: number) => boolean;
}

/**
 * Resolve the adoption threshold over `population` — the adoption of every
 * candidate module meeting {@link FACADE_MIN_EXTERNAL_IMPORTERS}. Otsu's split
 * ({@link otsuSplit}) when the population holds at least
 * {@link FACADE_OTSU_MIN_POPULATION} values and two distinct ones, the strict
 * majority otherwise. Under either method a value at or below
 * {@link FACADE_ADOPTION_MAJORITY} is never admitted.
 */
export function resolveFacadeAdoptionThreshold(population: readonly number[]): FacadeAdoptionThresholdPolicy {
  const aboveMajority = (adoption: number) => adoption > FACADE_ADOPTION_MAJORITY;
  const split = population.length >= FACADE_OTSU_MIN_POPULATION ? otsuSplit(population) : null;
  if (split === null) {
    return { method: "majority", threshold: FACADE_ADOPTION_MAJORITY, admits: aboveMajority };
  }
  return {
    method: "otsu",
    threshold: split.threshold,
    separability: split.separability,
    admits: (adoption) => adoption >= split.threshold && aboveMajority(adoption),
  };
}

/**
 * Entry-file vocabulary per language — the file that makes its directory a
 * module with a facade. The single source: no language capability declares
 * it. Go is absent on purpose: a Go package boundary is compiler-enforced, so
 * its directories are assessed as `language-enforced` instead.
 */
export const MODULE_ENTRY_FILE_NAMES: Readonly<Record<string, readonly string[]>> = {
  typescript: ["index.ts", "index.tsx"],
  javascript: ["index.js"],
  python: ["__init__.py"],
  rust: ["mod.rs", "lib.rs"],
};

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
 * outside it with a file edge into any file inside it (at any depth); each is a
 * FACADE importer when every such edge targets the entry file and a DEEP
 * importer otherwise. `adoption = facade / (facade + deep)`. The boundary is
 * ACTIVE when there are at least {@link FACADE_MIN_EXTERNAL_IMPORTERS} external
 * importers and adoption clears the codebase's adaptive threshold
 * ({@link resolveFacadeAdoptionThreshold} over the adoption of every module
 * meeting the importer floor); otherwise the module is reported with the
 * reason it is not judged.
 *
 * A VIOLATION is an edge `src → x` where `x` lies inside an active module,
 * `src` outside it, and `x` is not that module's entry. Each edge is reported
 * once, against the INNERMOST module it qualifies for. Its kind is `bypass`
 * when the module's entry file itself has a file edge to `x` (the facade
 * re-exports or uses it), `internal-reach` otherwise.
 *
 * Diagnosis, not prescription: a violation says the importer walked past a
 * surface its peers use, not how the module should be drawn.
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
  const edgeKeys = new Set(graph.edges.map((e) => edgeKey(e.sourceRelPath, e.targetRelPath)));

  for (const edge of graph.edges) {
    if (edge.sourceRelPath === edge.targetRelPath) continue;
    for (const module of enclosingModules(candidates, edge.targetRelPath)) {
      if (isInside(edge.sourceRelPath, module.moduleDir)) continue;
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

  const violations: FacadeLeakViolation[] = [];
  let judgedEdgeCount = 0;
  for (const edge of graph.edges) {
    if (scope && inScope && !inScope(edge.sourceRelPath)) {
      scope.outOfScopeEdgeCount++;
      continue;
    }
    if (edge.sourceRelPath === edge.targetRelPath) continue;
    let judged = false;
    // Innermost first: the first module the edge leaks past owns it.
    for (const module of enclosingModules(candidates, edge.targetRelPath)) {
      const assessment = assessments.get(module.moduleDir);
      if (assessment?.status !== "active" || isInside(edge.sourceRelPath, module.moduleDir)) continue;
      judged = true;
      if (module.entries.has(edge.targetRelPath)) continue;
      const facadeRelPath = assessment.facadeRelPath as RelPath;
      const reExported = [...module.entries].some((entry) => edgeKeys.has(edgeKey(entry, edge.targetRelPath)));
      violations.push({
        kind: reExported ? "bypass" : "internal-reach",
        sourceRelPath: edge.sourceRelPath,
        targetRelPath: edge.targetRelPath,
        moduleDir: module.moduleDir,
        facadeRelPath,
        adoption: assessment.adoption,
        facadeImporterCount: assessment.facadeImporterCount,
        deepImporterCount: assessment.deepImporterCount,
        callWeight: edge.callWeight,
      });
      break;
    }
    if (judged) judgedEdgeCount++;
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
      },
      ...(scope ? { scope } : {}),
    },
  };
}

/** Group `violations` by module — see {@link FacadeLeakRootCause}. */
function groupRootCauses(violations: readonly FacadeLeakViolation[]): FacadeLeakRootCause[] {
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
