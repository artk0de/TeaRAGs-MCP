import type { FileDependencyEdge, FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";
import {
  resolveMajorityFlooredOtsuThreshold,
  type MajorityFlooredOtsuThreshold,
} from "../../../../../infra/graph/index.js";
import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
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
 * How many files the re-export-cycle evidence path may hold — the facade plus
 * at most 7 import hops (bd tea-rags-mcp-89k7k.3). The path IS the evidence: a
 * facade→…→source chain longer than this says nothing actionable, so
 * reachability beyond the cap counts as absent and carries no flag. Not an env
 * knob.
 */
export const RE_EXPORT_CYCLE_PATH_CAP = 8;

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
 * once, against the INNERMOST module it qualifies for. Its kind is decided by
 * {@link classifyFacadeLeak}: by the export names both edges carry when they
 * do, by whether the entry file has an edge to `x` at all otherwise.
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
      const cyclePath = firstImportPath(importsFrom, facadeRelPath, edge.sourceRelPath);
      violations.push({
        ...classifyFacadeLeak(edge, module.entries, edgesByKey),
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

/** Name of the whole-module import / re-export on a file edge. */
const WHOLE_MODULE_EXPORT_NAME = "*";

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
