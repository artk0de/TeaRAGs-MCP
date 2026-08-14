/**
 * Lazy, bounded `ts.Program` provider for the TypeScript resolver's
 * type-checker fallback (bd tea-rags-mcp-uclbn).
 *
 * The ten tree-sitter `SymbolResolutionStrategy` passes in `./ts-resolver.ts`
 * carry no type information, so a family of call shapes — a receiver typed only
 * by inference, an ambiguous member name, an explicitly-instantiated generic —
 * is structurally out of their reach. Those need the real compiler. This cache
 * is what makes paying for it affordable.
 *
 * **A Program is built per entry file, but it is NOT bounded by the caps.**
 * Each build starts from `[entry file, …transitive import closure]`, walked by
 * `mapImportToFile` — the same tsconfig `paths`/`baseUrl` mapping the resolver
 * strategies resolve imports with, so a Program never disagrees with the rest of
 * the resolver about which file an import names — and capped on both axes
 * ({@link TSProgramCacheOptions.maxImportDepth},
 * {@link TSProgramCacheOptions.maxRootFiles}).
 *
 * Those caps bound the ROOT NAMES handed to `ts.createProgram` and nothing else.
 * The compiler then runs its OWN module-resolution walk over those roots, and
 * that walk answers to no cap here: it pulls in the full transitive closure of
 * everything reachable. Measured on a 405-file synthetic corpus whose features
 * re-export through barrels, the median Program was handed 6 root names and
 * contained all 405 project files (bd tea-rags-mcp-4m2vb). A depth-40 import
 * chain rooted at ONE file yields a Program holding all 40. So "a hub file
 * cannot drag the whole graph in" is false, and the cost of a build is set by
 * the entry's reachable closure, not by `maxRootFiles`.
 *
 * **At real scale the per-entry design loses to building the project once**
 * (bd tea-rags-mcp-6aytq). Measured over taxdome's 10,912 TypeScript files:
 * 1,147 builds, 83% of pass-2 wall clock inside `ts.createProgram`, and a rate
 * that DEGRADES with corpus position (14.6 ms/file over the first 2,200 files,
 * 71.6 over the last) because each later entry opens a subgraph no retained
 * Program covers. The union of those Programs parsed 12,798 project files —
 * the run was constructing the whole project anyway, one expensive slice at a
 * time. One Program over every file the tsconfig claims costs 10.1 s and then
 * nothing: 2.64 ms/file over the complete corpus, zero further builds, 467,308
 * acquires all served off coverage. What is saved is module resolution, which
 * `ts.createProgram` re-runs in full per call; the checker is under 1%.
 * {@link TSProgramCacheOptions.strategy} selects between the two, and `auto` —
 * the default — takes the whole Program whenever the project is small enough to
 * hold in memory.
 *
 * **The whole Program is SEGMENTED, and whether it runs at all is decided
 * against the isolate's actual heap.** A Program's build cost is paid once; its
 * CHECKER's is not — checker state is monotonic, and on taxdome it grows 1.69 GB
 * across the resolve, taking a 2.6 GB post-build live set to 4.31 GB by the last
 * file. So the whole strategy retires its Program every
 * {@link TSProgramCacheOptions.wholeSegmentFiles} files served and builds a
 * fresh one from the same roots, which caps that term at one segment's worth
 * (projected peak ~3.4 GB) for the cost of two extra builds on a 10,912-file
 * corpus. Parses are not re-read: the shared host hands the successor the same
 * SourceFiles. And before ANY build, {@link TSProgramCacheOptions.heapBudget}
 * projects the peak against `v8.getHeapStatistics().heap_size_limit` — a
 * projection that does not fit degrades to coverage, or, below coverage mode's
 * own floor, to no Program at all. The reason that is worth a gate rather than a
 * comment is the failure mode: a V8 heap OOM kills the worker isolate outright,
 * the `try/catch` in {@link TSProgramCache.buildFrom} never runs, and the run
 * loses every codegraph signal it had accumulated with no retry
 * (`./ts-program-heap-admission.ts` carries the measurements).
 *
 * **Which is why the per-entry path is keyed by COVERAGE, not by entry file
 * alone.** If
 * the Program built for `a.ts` already contains `b.ts`, building a second
 * Program for `b.ts` re-walks the same closure to reach the same types.
 * {@link TSProgramCache.acquire} therefore falls back to
 * {@link TSProgramCache.findCovering} before building, and on that corpus the
 * builds a full run performs drop from one per entry file to one, taking pass-2
 * from 11.3 s to 0.35 s over 805 files with a byte-identical edge set. The
 * entry-keyed LRU alone could not do this at any size: it missed on data it was
 * already holding, so raising `maxEntries` bought nothing.
 *
 * Parsing is shared further by a single `ts.CompilerHost` whose SourceFile cache
 * spans every Program the instance builds: the default lib and any file imported
 * by several entries are parsed once, not once per Program.
 *
 * That shared parse cache holds three populations, and each answers to its own
 * rule (bd tea-rags-mcp-8qf86). Project sources are bounded by
 * {@link TSProgramCacheOptions.maxParsedFiles}, dependency declarations by
 * {@link TSProgramCacheOptions.maxDependencyFiles}, and the default lib by
 * neither — it is the small fixed set whose re-parsing this cache exists to
 * avoid. Leaving dependencies unbounded alongside the lib is what let a real
 * indexing run climb ~1.8 MB per resolved file for as long as it lasted, with
 * the Program LRU and the project-source count both sitting at their caps.
 *
 * **Capacity eviction reads through to the Programs before re-parsing** (bd
 * tea-rags-mcp-5je8t). Once the reachable dependency surface exceeds
 * `maxDependencyFiles`, the map alone turned every later build into a private
 * re-parse of what a retained Program still pinned — eviction freed nothing
 * and duplication multiplied per-build heap 33x on the probe fixture
 * (`scripts/spikes/ts-program-cache-dependency-growth-probe.ts`), which is how
 * a live run passed 3.9 GB RSS. {@link TSProgramCache.pinnedParseOf} serves
 * the pinned parse instead, and
 * {@link TSProgramCacheOptions.maxRetainedSourceTextBytes} bounds what the
 * retained Programs may pin at all — LRU-evicted by size, the newest build
 * always kept, with one full closure as the floor no cache policy can lower.
 *
 * **The host memoizes probes, not just parses.** Before TypeScript asks for a
 * single SourceFile it runs module resolution, which probes the filesystem once
 * per candidate path it generates and re-runs in full per `ts.createProgram` —
 * so the syscalls, not the parses, are what a per-entry-file Program design
 * multiplies. {@link TSProgramCache.hostFileExists} and its two siblings hold
 * those answers for the run; on this repo's own `src` they take the probe count
 * from 2,634,551 to 8,691 over 900 entry files (bd tea-rags-mcp-e6yad). They
 * carry no eviction, and that is a measured asymmetry with the parse cache
 * above rather than an oversight — the reasoning is on the field.
 *
 * **Scoped to one indexing run.** A `LanguageProvider` outlives a single index
 * in the MCP server, and between two runs a dependency's `.d.ts` may have
 * changed — a stale Program is worse than a cold one, because it answers
 * confidently with last run's types. Three mechanisms keep it honest: every
 * `acquire` re-stats the entry file and rebuilds when its mtime moved (the
 * incremental-reindex case, where only changed files are re-resolved); a parse
 * older than the file's current mtime is dropped before anything reads it, which
 * the entry re-stat alone did NOT cover, because the shared parse map is filled
 * by closure walks as well as by entries and a file that has only ever been
 * somebody else's import carries no entry to re-stat; and
 * {@link TSProgramCache.reset} drops everything for a caller that owns a run
 * boundary. Coverage reuse answers to the same rule through
 * {@link CacheEntry.builtAtMs} — a Program cannot re-stat what it holds, so one
 * built before the file changed is refused rather than served.
 *
 * Changes confined to a transitive dependency of an unchanged entry are
 * deliberately NOT tracked — that file is not re-resolved either.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve as resolvePath, sep } from "node:path";

import ts from "typescript";

import type { RelPath } from "../../../../contracts/types/codegraph.js";
import {
  createProjectFileProbe,
  mapImportToFile,
  type ProjectFileProbe,
  type TsCompilerOptions,
} from "./ts-path-mapper.js";
import {
  assessTSProgramAdmission,
  describeTSProgramTypecheckerDowngrade,
  readHeapSizeLimitMb,
  TS_PROGRAM_HEAP_BASE_MB_DEFAULT,
  TS_PROGRAM_HEAP_CHECKER_PER_1K_FILES_MB_DEFAULT,
  TS_PROGRAM_HEAP_PER_1K_ROOTS_MB_DEFAULT,
  TS_PROGRAM_HEAP_USABLE_PCT_DEFAULT,
  type TSProgramAdmissionAssessment,
  type TSProgramHeapBudget,
} from "./ts-program-heap-admission.js";

/** Max Programs retained before the least-recently-used one is dropped. */
export const TS_PROGRAM_CACHE_MAX_DEFAULT = 8;
/** Max root files (entry + closure) a single Program is built from. */
export const TS_PROGRAM_ROOT_FILES_MAX_DEFAULT = 200;
/** Max import hops walked outward from the entry file. */
export const TS_PROGRAM_IMPORT_DEPTH_DEFAULT = 2;
/**
 * Max PROJECT sources retained in the shared parse cache (the lib is exempt).
 *
 * 20,000 rather than the original 2,000, measured (bd tea-rags-mcp-6aytq): on
 * taxdome the union of retained Programs parses 12,798 project files, so a
 * 2,000 cap kept under 16% of the working set and every build re-parsed what
 * eviction had just dropped. A parse map holding a tenth of what the run
 * touches is not a smaller cache, it is a thrash generator.
 */
export const TS_PROGRAM_PARSED_FILES_MAX_DEFAULT = 20000;
/**
 * Max DEPENDENCY declarations retained in the shared parse cache.
 *
 * 8,000 rather than the original 2,000: taxdome's reachable `.d.ts` surface
 * settles at 2,220 files and saturated the old cap around entry file 1,200,
 * at which point the `ts.createProgram` rate jumped 6x (0.08 → 0.48 builds per
 * file) and the rolling cost went 24 → 117 ms/file (bd tea-rags-mcp-6aytq).
 * The new default clears that surface ~3.6x over while staying a bound —
 * `node_modules` is discovered one import at a time and the population is not
 * self-limiting (bd tea-rags-mcp-8qf86).
 */
export const TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX_DEFAULT = 8000;
/**
 * Max non-lib source text (bytes) the retained Programs may pin, union-counted.
 * Default {@link TSProgramCacheOptions.maxRetainedSourceTextBytes} rationale.
 *
 * 256 MiB rather than the original 16 MiB: taxdome's whole-project Program
 * pins 70 MB of non-lib text on its own, and the eight-Program coverage LRU
 * reached 40-48 MB — so a 16 MiB budget evicted down to the one-Program floor
 * on every build, discarding Programs the very next file was going to hit.
 */
export const TS_PROGRAM_RETAINED_TEXT_BYTES_MAX_DEFAULT = 256 * 1024 * 1024;
/**
 * How the cache gets its Programs.
 *
 * - `coverage` — one `ts.createProgram` per entry file whose closure no
 *   retained Program already covers. The original behaviour.
 * - `whole` — ONE Program over every file the project's tsconfig claims,
 *   built on first use and serving every acquire that lands inside it.
 * - `auto` — `whole` when the root set fits
 *   {@link TSProgramCacheOptions.wholeRootFilesMax}, `coverage` otherwise.
 */
export type TSProgramStrategy = "coverage" | "whole" | "auto";
/** Strategy when none is configured. */
export const TS_PROGRAM_STRATEGY_DEFAULT: TSProgramStrategy = "auto";
/**
 * Root files `auto` will build a whole-project Program from before falling
 * back to per-entry coverage.
 *
 * Sized off measured heap, not off taste (bd tea-rags-mcp-6aytq). taxdome's
 * 12,335-file tsconfig root set produced a Program holding 16,313 files at
 * 2.4 GB heap after the build and 3.97 GB at the peak of the resolve — about
 * 0.32 MB of heap per root. 20,000 roots therefore projects to ~6.4 GB, which
 * is the largest project that still fits a workstation-class worker; past it
 * the per-entry strategy's bounded working set is the safer trade even though
 * it is 17x slower per file.
 */
export const TS_PROGRAM_WHOLE_ROOT_FILES_MAX_DEFAULT = 20000;
/**
 * Distinct entry files `auto` waits for before it builds the whole-project
 * Program.
 *
 * Without a warm-up gate `auto` would pay taxdome's 10.1 s build and ~4 GB of
 * heap to re-resolve the three files an incremental reindex touched, where the
 * per-entry path costs about a second and forgets it. The gate is what makes
 * `auto` read the WORKLOAD rather than only the project: a run that has already
 * asked about 200 distinct files is a bulk pass, and the warm-up it pays is
 * measured at 5.7 s of a 58.8 s full-corpus run (66 per-entry builds before the
 * gate opens) — a rounding error against the 900 s it avoids. An operator who
 * wants the whole Program from the first acquire sets the gate to 1.
 */
export const TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT = 200;
/**
 * Files ONE whole-project Program serves before it is rebuilt from the same
 * roots and the old one released.
 *
 * The Program's own cost is paid once; its CHECKER's is not. Checker state is
 * monotonic — every type it computes, every symbol link it caches, stays for
 * the life of that checker — and measured on taxdome it grows 1.69 GB across
 * the resolve, taking a 2.6 GB post-build live set to 4.31 GB by the last file.
 * That growth is what kills a 4096-declared worker at about file 6,500.
 *
 * None of it is needed across independent files: file 9,000 does not read the
 * types file 12 asked for. So the run is cut into segments — after 5,000
 * DISTINCT files the cache drops every Program it holds and rebuilds the
 * whole-project one from the same roots, which caps the checker term at one
 * segment's worth and takes the projected peak from ~4.3 GB to ~3.4 GB. Parses
 * are NOT re-read: the shared `ts.CompilerHost` hands the new Programs the same
 * SourceFiles, so what a boundary pays for is module resolution, not the AST.
 *
 * Every Program goes, not only the whole one, and the reason is that the
 * per-entry LRU is not empty even under the whole strategy: the tsconfig's
 * world and the indexed corpus are different sets, so files outside the
 * project's declared root set still opened per-entry Programs. The root union
 * (see {@link TSProgramCache.wholeRootSet}) closes most of that gap, and what
 * survives it is exactly the population a retirement keyed on the whole Program
 * alone would leave growing.
 *
 * A counter is deliberately the whole mechanism: checker state cannot be
 * shared, migrated or partially evicted across Programs, so there is nothing
 * cleverer to be done than to decide when to start over. Raising it past the
 * corpus size disables segmentation, which is what an operator with a large
 * heap and no interest in the rebuilds should do.
 */
export const TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT = 5000;

export interface TSProgramCacheOptions {
  /** Absolute project root every `RelPath` is resolved against. */
  repoRoot: string;
  /** tsconfig `baseUrl` / `paths`, as parsed by `loadTsConfig`. */
  tsOptions: TsCompilerOptions;
  /**
   * Extension oracle for the closure walk's path mapping (bd
   * tea-rags-mcp-f3zcy). Pass the resolver's instance so both share one
   * memoized cache; defaults to a fresh probe rooted at `repoRoot`.
   */
  fileExists?: ProjectFileProbe;
  /** LRU capacity. Default {@link TS_PROGRAM_CACHE_MAX_DEFAULT}. */
  maxEntries?: number;
  /** Root-file cap per Program. Default {@link TS_PROGRAM_ROOT_FILES_MAX_DEFAULT}. */
  maxRootFiles?: number;
  /** Import-closure depth cap. Default {@link TS_PROGRAM_IMPORT_DEPTH_DEFAULT}. */
  maxImportDepth?: number;
  /**
   * Project sources retained in the shared parse cache before the oldest are
   * dropped. Default {@link TS_PROGRAM_PARSED_FILES_MAX_DEFAULT}. Counts the
   * project's OWN sources only — dependency declarations answer to
   * {@link maxDependencyFiles}, and the default lib to neither.
   */
  maxParsedFiles?: number;
  /**
   * Dependency declarations retained in the shared parse cache before the
   * oldest are dropped. Default
   * {@link TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX_DEFAULT}.
   *
   * Bounded for the same reason project sources are, and the reasoning that
   * once exempted them does not survive contact with a large repository (bd
   * tea-rags-mcp-8qf86). "Bounded by the dependency set, not by how long the
   * process has been alive" is true only in the limit: `node_modules` is
   * discovered incrementally, one import at a time, as the resolve walk reaches
   * new corners of the project — so across a run of thousands of files the map
   * climbs steadily and reaches that limit only at the very end, if at all.
   *
   * The DEFAULT LIB stays exempt from both bounds, which is what bd
   * tea-rags-mcp-qb2s3 actually needed: it is a small fixed set, and re-parsing
   * `lib.es2022.full.d.ts` per Program is the single cost this map was built to
   * avoid. A dependency `.d.ts` is neither small nor fixed.
   */
  maxDependencyFiles?: number;
  /**
   * Total non-lib source text, in bytes and union-counted across every
   * retained Program, before the least-recently-used Programs are dropped.
   * Default {@link TS_PROGRAM_RETAINED_TEXT_BYTES_MAX_DEFAULT}.
   *
   * The count-based LRU (`maxEntries`) bounds how MANY Programs are retained
   * and nothing about how big each one is, and a Program's size is set by the
   * compiler's own resolution walk, not by any cap here — on a dependency-laden
   * repository each closure carries the reachable `node_modules` declaration
   * surface (bd tea-rags-mcp-5je8t). Union-counted because retained Programs
   * SHARE parses through the host: text held by two Programs is one AST, and
   * summing it twice would evict Programs that cost nothing to keep.
   *
   * Text bytes are a proxy for retained heap, and the multiplier is shape-
   * dependent — measured on the probe fixture, declaration-dense `.d.ts` text
   * expands ~60x into AST + binder state, ordinary project code nearer 10-20x.
   * The default (16 MiB) puts the worst case comfortably under the enrichment
   * worker's 2 GiB heap ceiling.
   *
   * The NEWEST Program is always kept, however far over budget it alone sits:
   * an entry whose own closure exceeds the budget still needs that Program to
   * resolve, and dropping it would re-run `ts.createProgram` per file of its
   * closure — the exact cost bd tea-rags-mcp-4m2vb removed. The floor this
   * budget cannot lower is therefore one full closure; nothing cache-side can
   * shrink what the compiler pulls in.
   */
  maxRetainedSourceTextBytes?: number;
  /**
   * How Programs are obtained. Default {@link TS_PROGRAM_STRATEGY_DEFAULT}.
   *
   * The per-entry default was never cheap, it was merely bounded: measured over
   * taxdome's 10,912 TypeScript files (bd tea-rags-mcp-6aytq), 83% of pass-2
   * wall clock sat inside `ts.createProgram`, and the rate got WORSE with
   * corpus position — 14.6 ms/file over the first 2,200 files, 71.6 ms/file
   * over the last, because each later entry opens a subgraph no retained
   * Program covers and pays a fresh ~320 ms build for it. The union of those
   * Programs parsed 12,798 project files: the run was piecewise-constructing
   * the whole project anyway, one expensive slice at a time.
   *
   * Building it in ONE piece costs 10.1 s and then nothing — 2.64 ms/file over
   * the complete corpus, 0 further builds, 467,308 acquires all served off
   * coverage, against a 452-900 s projection for the per-entry strategy. The
   * saving is module resolution, not type checking: the compiler re-runs its
   * full path canonicalization and `node_modules` probe walk per
   * `createProgram`, and one Program runs it once per module.
   */
  strategy?: TSProgramStrategy;
  /**
   * Root-file ceiling for the `auto` strategy's whole-Program choice. Default
   * {@link TS_PROGRAM_WHOLE_ROOT_FILES_MAX_DEFAULT}. Ignored by an explicit
   * `whole`, which is an operator stating the trade deliberately.
   */
  wholeRootFilesMax?: number;
  /**
   * Distinct entry files `auto` waits for before building the whole-project
   * Program. Default {@link TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT}; ignored by
   * an explicit `whole`, which primes on the first acquire.
   */
  wholeMinEntries?: number;
  /**
   * Files one whole-project Program serves before it is replaced. Default
   * {@link TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT}, whose docblock carries the
   * measurement; a value past the project's size disables segmentation.
   */
  wholeSegmentFiles?: number;
  /**
   * Terms of the heap projection admission is decided on. Default
   * {@link TS_PROGRAM_HEAP_BASE_MB_DEFAULT} and friends.
   */
  heapBudget?: TSProgramHeapBudget;
  /**
   * This isolate's V8 old-generation ceiling, in MB. Defaults to
   * {@link readHeapSizeLimitMb} — a direct `v8.getHeapStatistics()` read, taken
   * HERE rather than handed down from the pool, because the reading is
   * per-isolate and the pool lives in a different one. Injectable so the
   * admission matrix is testable without spawning a thread per row.
   */
  readHeapSizeLimitMb?: () => number;
  /**
   * Absolute names of every file the project claims — the root set a
   * whole-project Program is built from. Called at most ONCE, lazily, and only
   * when a whole build is actually going to happen.
   *
   * Injected rather than discovered here, and the production supplier is
   * `loadTsConfigFileNames` (see `TSCallResolver`): the tsconfig's own
   * `include`/`exclude` expansion is the most faithful answer available to
   * "which files are this project", because it is literally the set `tsc`
   * compiles. Deliberately NOT a second filesystem walk, and deliberately not
   * accumulated from the files acquired so far — a root set that grows as the
   * run proceeds would rebuild the Program repeatedly, which is the cost this
   * strategy exists to remove.
   *
   * Defaults to an empty set, which reads as "this project has no whole-project
   * root set" and keeps the cache on `coverage` however the strategy is
   * configured.
   *
   * NOT the whole root set on its own — {@link TSProgramCache.primeForExpectedEntries}
   * unions the RUN's own corpus into it, and the reason is measured
   * (bd tea-rags-mcp-6aytq). On taxdome the two sets overlap but neither
   * contains the other: 9,976 of the run's 10,912 TypeScript files are among
   * the tsconfig's 12,335 names, 936 are not, and 2,359 tsconfig names are
   * files the run never resolves. The 936 are what a whole-Program run still
   * paid `ts.createProgram` for — 42 builds, 10.2 s, 22% of a 46.4 s pass.
   */
  projectRoots?: () => readonly string[];
}

/**
 * Everything a caller needs from one built Program. Handed out whole so a
 * consumer never re-derives the checker or re-looks-up the entry SourceFile —
 * both are cheap to hold and expensive to recompute.
 */
export interface TSProgramHandle {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** The entry file's parsed SourceFile — the one the call site lives in. */
  readonly sourceFile: ts.SourceFile;
  /** Absolute root files, entry first, then closure in discovery order. */
  readonly rootFiles: readonly string[];
}

interface CacheEntry {
  handle: TSProgramHandle;
  /** mtime of the entry file when the Program was built (staleness check). */
  entryMtimeMs: number;
  /**
   * Wall clock at which `ts.createProgram` returned — the instant this Program's
   * view of every file it holds was taken. A file whose mtime is NEWER than this
   * was changed after the Program read it, so the Program's copy is stale and
   * must not be served (see {@link TSProgramCache.acquire}).
   */
  builtAtMs: number;
  /**
   * Absolute names of every non-lib file the Program actually CONTAINS, each
   * mapped to its source text length — a very different set from the root
   * names it was handed, because `ts.createProgram` walks the transitive
   * import graph itself, unbounded by either closure cap.
   *
   * One structure answers two questions: membership is the
   * {@link TSProgramCache.findCovering} test, and the values sum into the
   * retention weight {@link TSProgramCacheOptions.maxRetainedSourceTextBytes}
   * bounds. Deliberately NOT limited to files under the repo root: module
   * resolution realpaths its targets, so under a symlinked layout — pnpm's
   * store, macOS's `/tmp` — the dependency surface lands OUTSIDE the root
   * prefix, and an in-root weight would be blind to exactly the population
   * that made the live run unbounded. Membership stays unaffected: only
   * project files are ever asked about, and those keep the path form the
   * closure walk handed in. The default lib alone is excluded — it is never
   * an entry, so membership cannot ask about it, and it is one shared fixed
   * set, so charging it to every Program would spend the whole budget on
   * files no eviction can free.
   */
  coveredTextBytes: Map<string, number>;
  /**
   * Handles already derived for covered files, so a file served off this
   * Program gets the same handle identity on every acquire — matching what the
   * entry-keyed path has always done, and saving a lookup on a path the
   * resolver hits several times per call site.
   */
  derived: Map<string, TSProgramHandle>;
}

/**
 * Compiler options for the isolated per-file Programs. Deliberately minimal:
 * `noEmit` (nothing is written), `skipLibCheck` (diagnostics are never read),
 * and `types: []` so an ambient `@types/*` sweep never runs — resolution only
 * needs the project's own declarations plus the default lib.
 *
 * `jsx` is not cosmetic here even though nothing is emitted: with the option
 * unset, module resolution refuses to consider the `.tsx` extension at all, so
 * `import Button from "./button.js"` finds no file and every symbol in a React
 * codebase resolves to `unknown` with zero declarations. `Preserve` is the
 * cheapest setting that turns the extension back on — it neither requires a
 * `react/jsx-runtime` declaration to exist nor cares which runtime the project
 * targets, and the checker resolves tag names identically under all of them
 * (bd tea-rags-mcp-b4pvp).
 */
function buildCompilerOptions(repoRoot: string, tsOptions: TsCompilerOptions): ts.CompilerOptions {
  return {
    allowJs: true,
    noEmit: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    baseUrl: resolvePath(repoRoot, tsOptions.baseUrl || "."),
    paths: tsOptions.paths,
    types: [],
  };
}

export class TSProgramCache {
  /** Absolute, realpath-normalized project root. */
  readonly repoRoot: string;
  private readonly tsOptions: TsCompilerOptions;
  private readonly fileExists: ProjectFileProbe;
  private readonly maxEntries: number;
  private readonly maxRootFiles: number;
  private readonly maxImportDepth: number;
  private readonly maxParsedFiles: number;
  private readonly maxDependencyFiles: number;
  private readonly maxRetainedSourceTextBytes: number;
  private readonly strategy: TSProgramStrategy;
  private readonly wholeRootFilesMax: number;
  private readonly wholeMinEntries: number;
  private readonly wholeSegmentFiles: number;
  private readonly heapBudget: TSProgramHeapBudget;
  private readonly readHeapSizeLimitMb: () => number;
  private readonly projectRoots: () => readonly string[];
  /**
   * The RUN's own TypeScript corpus, absolute and in the compiler's path form,
   * as declared by {@link primeForExpectedEntries} (bd tea-rags-mcp-6aytq).
   *
   * The second half of the whole-Program root set. `projectRoots` answers "what
   * does this project claim", which is not the same question as "what is this
   * pass about to resolve" — and the difference is not noise: measured on
   * taxdome, 936 of the run's 10,912 files sit outside the tsconfig's
   * include/exclude expansion, and every one of them fell through to a
   * per-entry `ts.createProgram` that the whole strategy exists to remove.
   *
   * Held rather than re-derived because it must survive both entry points: the
   * eager prime that declares it, and the lazy warm-up gate that may build much
   * later on a run whose declared volume was below the threshold. Empty when
   * nothing declared one, which is exactly the pre-union behaviour.
   */
  private corpusRoots: readonly string[] = [];
  /**
   * Whole-project builds this instance has performed — the first and every
   * segment rebuild after it. The observable that says segmentation ran.
   */
  private wholeBuilds = 0;
  /** `acquire` calls this instance has answered — the diagnostics denominator. */
  private acquires = 0;
  /** Acquires served off the whole-project Program. */
  private wholeHits = 0;
  /** Acquires served off a per-entry Program's coverage, whole one excluded. */
  private coverageHits = 0;
  /** Per-entry `ts.createProgram` calls — what the whole strategy exists to drive to zero. */
  private entryBuilds = 0;
  /**
   * Distinct files acquired since the current segment began — what
   * {@link TSProgramCacheOptions.wholeSegmentFiles} counts.
   *
   * Run-wide rather than per-Program: what checker state tracks is how far the
   * RUN has got, whichever Program is answering, and under the per-entry
   * strategy — or in the stretch before a whole build — that is not the whole
   * Program's own served set. A counter keyed on `wholeEntry.derived` would
   * measure only one of the several Programs whose checkers are growing.
   *
   * A Set rather than a counter because production acquires ~43 times per file
   * (467,308 over 10,912) — counting acquires would rotate every ~116 files.
   */
  private readonly segmentFiles = new Set<RelPath>();
  /**
   * Has admission refused every Program for the rest of this run? Latched
   * rather than re-decided, because the verdict is a heap projection over the
   * PROJECT, not a per-file condition — and re-deciding would cost a
   * `v8.getHeapStatistics()` per call site.
   */
  private typecheckerOff = false;
  /** Has the downgrade already been reported? One line per run, not per acquire. */
  private downgradeReported = false;
  /**
   * Distinct entries acquired so far, until `auto` has made its decision —
   * then dropped, because nothing reads it afterwards and it would otherwise
   * retain a string per file of the corpus for the life of the resolver.
   */
  private entriesSeen: Set<RelPath> | null = new Set();
  /**
   * The whole-project Program, once built — held OUTSIDE {@link entries} on
   * purpose.
   *
   * It answers to neither retention bound. The count LRU would rotate it out
   * after `maxEntries` per-entry misses, and the byte budget would evict it
   * first (it is the largest thing the cache holds, and the least recently
   * INSERTED), which in both cases discards the one Program every remaining
   * file of the run is about to be served off. That is the same reasoning
   * {@link evictOverflow} already applies to the newest build, one level up:
   * a cache policy must not evict the thing that makes the next thousand
   * lookups free.
   */
  private wholeEntry: CacheEntry | null = null;
  /**
   * Has the whole-project build been decided? Set before the attempt, not
   * after, so a strategy that declines — or a build that fails — costs one
   * decision for the run rather than one per acquire.
   */
  private wholeAttempted = false;
  private readonly compilerOptions: ts.CompilerOptions;
  /** Parsed-SourceFile cache shared by every Program this instance builds. */
  private readonly sourceFiles = new Map<string, ts.SourceFile | undefined>();
  /**
   * The PROJECT-source keys of {@link sourceFiles}, in insertion order — the
   * population {@link TSProgramCacheOptions.maxParsedFiles} bounds, indexed
   * rather than recomputed (bd tea-rags-mcp-ajvnq).
   *
   * Kept as a set beside the map, not as a bare integer, because
   * {@link evictParsedOverflow} needs BOTH facts a scan used to produce: how
   * many project sources are held, and which ones to drop first. A counter
   * answers only the first, leaving the eviction walk to re-scan the whole map
   * — including the dependency entries that are never eligible and, after
   * bd tea-rags-mcp-qb2s3, outnumber the project sources.
   *
   * Insertion order is the eviction order, and matches the map's, because both
   * are written in the same breath by {@link rememberParse}.
   */
  private readonly parsedProjectSources = new Set<string>();
  /**
   * The DEPENDENCY keys of {@link sourceFiles}, in insertion order — the second
   * bounded population, kept beside {@link parsedProjectSources} rather than
   * merged into it because the two answer to different caps and a merged
   * counter could not tell the eviction walk which names it may drop.
   *
   * The default lib belongs to neither set, so it is reachable by no eviction
   * walk at all — see {@link TSProgramCacheOptions.maxDependencyFiles}.
   */
  private readonly parsedDependencySources = new Set<string>();
  /**
   * Wall clock at which each entry of {@link sourceFiles} was read, so a parse
   * can be told stale without re-reading the file to compare contents.
   *
   * Needed because the parse map is shared and populated from TWO directions:
   * an `acquire` of the file itself, and the closure walk of some other entry
   * that imports it. Only the first leaves a `CacheEntry` carrying an mtime, so
   * the entry-keyed staleness check cannot see a change to a file that has so
   * far only ever been somebody else's import — it would be handed the stale
   * parse out of the host the first time it becomes an entry in its own right.
   */
  private readonly parsedAtMs = new Map<string, number>();
  /**
   * The host's `fileExists` answers, memoized across every Program this
   * instance builds (bd tea-rags-mcp-e6yad).
   *
   * TypeScript runs its own module resolution BEFORE it ever calls
   * {@link sourceFiles}'s `getSourceFile`, probing each candidate the algorithm
   * generates — `.ts`, `.tsx`, `.d.ts`, `/index.ts`, then every `node_modules`
   * ancestor — and it repeats that search in full for every `ts.createProgram`.
   * `ts.createCompilerHost` leaves the probe pointing straight at `ts.sys`, so
   * without this each repeat is a fresh `fs.statSync`.
   *
   * This is the idiom `createProjectFileProbe` (bd tea-rags-mcp-f3zcy) already
   * established one layer out, deliberately rather than coincidentally: that
   * probe is an unbounded per-path existence memo on this same resolver, held
   * for the same reason ("an index run reads a fixed snapshot of the tree, so a
   * path's answer cannot change underneath the run that asked"). The resolver
   * instance, one per `repoRoot`, is the real lifetime bound on both —
   * {@link TSProgramCache.reset} clears these maps but has no caller in `src`,
   * so do not read it as the thing that keeps them fresh.
   *
   * Unlike the parse cache beside it these three maps are NOT bounded, and the
   * asymmetry is measured rather than assumed. Walking this repo's own `src`:
   * going from 300 to 900 entry files took the probes from 1,095,830 calls to
   * 2,634,551 while the DISTINCT path set moved from 8,688 to 8,691 — three
   * paths — and the retained key bytes stayed at 1.05 MiB. The probe set is
   * bounded by the repo's directory tree and saturates within a few hundred
   * files, which is exactly what the dependency parse population turned out NOT
   * to do (bd tea-rags-mcp-8qf86): `node_modules` `.d.ts` are discovered one
   * import at a time and each retains a whole AST. A path string and a boolean
   * are a different order of object, and evicting them would thrash hardest on
   * the hottest population — see {@link hostDirectoryExists}.
   */
  private readonly hostFileExists = new Map<string, boolean>();
  /**
   * The host's `directoryExists` answers, memoized on the same terms as
   * {@link hostFileExists} and by far the largest win of the three: over 900
   * entry files it took 2,354,923 calls over 1,468 distinct directories, a
   * 1604x repeat rate.
   *
   * The concentration is structural, not incidental. Module resolution walks
   * the `node_modules` ancestor chain for every bare specifier in every root
   * file of every Program, and that chain is the same handful of directories
   * every time. `ts.createCompilerHost` does keep a directory memo, but it is
   * private to its `writeFile` path and records POSITIVE answers only — under
   * `noEmit` nothing reaches it, and the misses (the ancestors that do not
   * exist) are the ones being re-asked.
   */
  private readonly hostDirectoryExists = new Map<string, boolean>();
  /** The host's `realpath` answers, memoized on the same terms as {@link hostFileExists}. */
  private readonly hostRealpath = new Map<string, string>();
  private readonly host: ts.CompilerHost;
  /**
   * `repoRoot` as a directory prefix, in the separator the COMPILER reports.
   * `ts` normalizes every `SourceFile.fileName` to forward slashes whatever the
   * platform, so the membership test in {@link build} compares like with like
   * without paying `node:path.relative` per file of every Program.
   */
  private readonly inRootPrefix: string;
  /**
   * Directory the running compiler's default lib files sit in. Every
   * `lib.*.d.ts` shares it, so one string identifies the whole exempt set.
   */
  private readonly defaultLibDir: string;
  /** {@link defaultLibDir} in the forward-slash form the COMPILER reports. */
  private readonly defaultLibCompilerDir: string;
  /** Insertion-ordered LRU — the first key is the least recently used. */
  private readonly entries = new Map<RelPath, CacheEntry>();

  constructor(options: TSProgramCacheOptions) {
    this.repoRoot = options.repoRoot;
    this.tsOptions = options.tsOptions;
    this.fileExists = options.fileExists ?? createProjectFileProbe(this.repoRoot);
    this.maxEntries = options.maxEntries ?? TS_PROGRAM_CACHE_MAX_DEFAULT;
    this.maxRootFiles = options.maxRootFiles ?? TS_PROGRAM_ROOT_FILES_MAX_DEFAULT;
    this.maxImportDepth = options.maxImportDepth ?? TS_PROGRAM_IMPORT_DEPTH_DEFAULT;
    this.maxParsedFiles = options.maxParsedFiles ?? TS_PROGRAM_PARSED_FILES_MAX_DEFAULT;
    this.maxDependencyFiles = options.maxDependencyFiles ?? TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX_DEFAULT;
    this.maxRetainedSourceTextBytes = options.maxRetainedSourceTextBytes ?? TS_PROGRAM_RETAINED_TEXT_BYTES_MAX_DEFAULT;
    this.strategy = options.strategy ?? TS_PROGRAM_STRATEGY_DEFAULT;
    this.wholeRootFilesMax = options.wholeRootFilesMax ?? TS_PROGRAM_WHOLE_ROOT_FILES_MAX_DEFAULT;
    this.wholeMinEntries = options.wholeMinEntries ?? TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT;
    this.wholeSegmentFiles = options.wholeSegmentFiles ?? TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT;
    this.heapBudget = options.heapBudget ?? {
      baseMb: TS_PROGRAM_HEAP_BASE_MB_DEFAULT,
      perThousandRootsMb: TS_PROGRAM_HEAP_PER_1K_ROOTS_MB_DEFAULT,
      checkerPerThousandFilesMb: TS_PROGRAM_HEAP_CHECKER_PER_1K_FILES_MB_DEFAULT,
      usableHeapPct: TS_PROGRAM_HEAP_USABLE_PCT_DEFAULT,
    };
    this.readHeapSizeLimitMb = options.readHeapSizeLimitMb ?? readHeapSizeLimitMb;
    this.projectRoots = options.projectRoots ?? ((): readonly string[] => []);
    this.compilerOptions = buildCompilerOptions(this.repoRoot, this.tsOptions);
    this.inRootPrefix = `${sep === "/" ? this.repoRoot : this.repoRoot.split(sep).join("/")}/`;
    this.host = this.buildHost();
    // Read off the host rather than guessed: it is the same lookup the compiler
    // itself uses to find the lib, so the exempt directory is exactly the one
    // whose files `ts.createProgram` will ask this cache to parse.
    this.defaultLibDir = dirname(this.host.getDefaultLibFileName(this.compilerOptions));
    this.defaultLibCompilerDir = this.toCompilerPath(this.defaultLibDir);
  }

  /**
   * Programs currently retained — the per-entry LRU plus the whole-project
   * Program when one has been built. Both are things `acquire` can be served
   * off, which is what this count is read for.
   */
  get size(): number {
    return this.entries.size + (this.wholeEntry === null ? 0 : 1);
  }

  /**
   * Non-lib files the whole-project Program holds, or `0` when the cache is on
   * the per-entry strategy. The observable that says which strategy a run
   * actually took.
   */
  get wholeProgramFileCount(): number {
    return this.wholeEntry?.coveredTextBytes.size ?? 0;
  }

  /**
   * Whole-project builds performed so far: one per segment. `0` on the
   * per-entry strategy, `1` when segmentation never triggered.
   */
  get wholeProgramBuildCount(): number {
    return this.wholeBuilds;
  }

  /**
   * Distinct files acquired since the current segment began — the counter
   * {@link TSProgramCacheOptions.wholeSegmentFiles} bounds. Exposed because a
   * build count alone cannot say whether a run is approaching a rotation.
   */
  get segmentFileCount(): number {
    return this.segmentFiles.size;
  }

  /**
   * Has admission refused this isolate every `ts.Program`? While true
   * {@link acquire} answers `null` unconditionally, which every consumer
   * already reads as "no type information, fall through" — the same state
   * `CODEGRAPH_TS_TYPECHECKER=0` configures, reached from measurement instead.
   */
  get typeCheckerDisabled(): boolean {
    return this.typecheckerOff;
  }

  /**
   * Project sources currently held in the shared parse cache — the quantity
   * {@link TSProgramCacheOptions.maxParsedFiles} bounds. Dependencies and the
   * default lib are excluded, matching what the bound counts.
   *
   * Read off the maintained index rather than derived, because
   * {@link evictParsedOverflow} reads this on every parse and deriving it cost
   * a `node:path.relative` per map entry — see {@link parsedProjectSources}.
   */
  get parsedProjectFileCount(): number {
    return this.parsedProjectSources.size;
  }

  /**
   * Dependency declarations currently held in the shared parse cache — the
   * quantity {@link TSProgramCacheOptions.maxDependencyFiles} bounds. The
   * default lib is excluded, matching what that bound counts.
   */
  get parsedDependencyFileCount(): number {
    return this.parsedDependencySources.size;
  }

  /**
   * Non-lib source text the retained Programs currently pin, in bytes — the
   * quantity {@link TSProgramCacheOptions.maxRetainedSourceTextBytes} bounds.
   *
   * Union-counted, not summed per Program: retained Programs share parses
   * through the host, so a file held by several of them is one AST, and the
   * weight says so. Recomputed on demand rather than maintained — it is read
   * once per build and per budget-eviction round, against at most `maxEntries`
   * maps, which is noise next to the `ts.createProgram` it follows.
   *
   * The whole-project Program is NOT counted, because it is not evictable: this
   * number exists to drive {@link evictOverflow}, and including a weight no
   * eviction can free would simply empty the LRU on every build (taxdome's
   * whole Program pins 70 MB on its own). It is the same exemption the newest
   * build already has, made permanent for the one Program the strategy is
   * built around.
   */
  get retainedSourceTextBytes(): number {
    const counted = new Set<string>();
    let total = 0;
    for (const entry of this.entries.values()) {
      for (const [fileName, textBytes] of entry.coveredTextBytes) {
        if (counted.has(fileName)) continue;
        counted.add(fileName);
        total += textBytes;
      }
    }
    return total;
  }

  /**
   * The Program whose entry file is `relPath`, building it on a miss. Returns
   * `null` when the file is not on disk — the caller then has no type
   * information and must fall through rather than guess.
   */
  acquire(relPath: RelPath): TSProgramHandle | null {
    this.acquires += 1;
    // A run admission has refused stays refused for its whole length — see
    // {@link typecheckerOff}. Checked before the stat so a refused run costs
    // one comparison per call site rather than a syscall.
    if (this.typecheckerOff) return null;
    const absolute = this.toAbsolute(relPath);
    const mtimeMs = entryMtime(absolute);
    if (mtimeMs === null) return null;

    // A parse taken before the file's current mtime is stale whoever asks for
    // it. This has to run ahead of every branch below, because the shared parse
    // map is populated by CLOSURE walks as much as by entries: a file first read
    // as somebody else's import carries no cache entry of its own, so the
    // entry-keyed check under it never sees the change, and `ts.createProgram`
    // would be handed the previous revision out of the host.
    this.forgetStaleParse(absolute, mtimeMs);
    // Before anything is looked up, so the file that opens a new segment is
    // served off the fresh Programs rather than the ones being retired.
    this.rotateSegmentWhenFull(relPath);

    const cached = this.entries.get(relPath);
    if (cached?.entryMtimeMs === mtimeMs) {
      // Refresh recency: delete + set moves the key to the end of the Map's
      // insertion order, making the first key the least recently used.
      this.entries.delete(relPath);
      this.entries.set(relPath, cached);
      return cached.handle;
    }
    if (cached) this.invalidate(relPath);

    // Runs before the coverage lookup rather than as a miss handler: the whole
    // Program exists to make that lookup hit, so priming it after a miss would
    // build it for a file that then paid a per-entry build anyway.
    this.ensureWholeProgram(relPath);
    // That call is also where admission is assessed, and its verdict can be
    // "no Program at all" — do not fall through to a per-entry build the
    // projection has just refused.
    if (this.typecheckerOff) return null;

    const covering = this.findCovering(this.toCompilerPath(absolute), absolute, mtimeMs);
    if (covering) return covering;

    this.entryBuilds += 1;
    const built = this.build(absolute);
    if (!built) return null;
    this.entries.set(relPath, built);
    this.evictOverflow();
    return built.handle;
  }

  /**
   * A retained Program that already contains `entryAbsolute`, as a handle
   * pointing at that file — or `null` when none does.
   *
   * This is the lookup the entry-keyed cache was missing (bd
   * tea-rags-mcp-4m2vb). Each Program is built from `[entry, …closure]`, but
   * `ts.createProgram` then runs its OWN transitive walk over those roots and
   * pulls in everything reachable, so the Program built for one file routinely
   * contains hundreds of others — measured on a 405-file synthetic corpus with
   * barrel re-exports, the median Program held all 405 while being handed 6 root
   * names. Rebuilding for a file already sitting inside a retained Program
   * re-walks that whole closure to arrive at the same types, which is why an
   * entry-keyed miss cost one `createProgram` per file of the run.
   *
   * `builtAtMs` is the guard that keeps this honest. Reuse is only sound while
   * the Program's copy of the file matches the disk, and a Program cannot
   * re-stat what it holds — so a file modified after the Program was
   * constructed is refused here and rebuilt, the coverage-wide form of the
   * entry mtime check above.
   */
  private findCovering(compilerPath: string, entryAbsolute: string, mtimeMs: number): TSProgramHandle | null {
    // The whole-project Program first: when one exists it covers essentially
    // every acquire, so asking it first turns the common case into one map
    // lookup instead of a walk over the per-entry LRU that will miss.
    if (this.wholeEntry !== null) {
      const served = this.serveFrom(this.wholeEntry, compilerPath, entryAbsolute, mtimeMs);
      if (served) {
        this.wholeHits += 1;
        return served;
      }
    }
    for (const [key, entry] of this.entries) {
      const served = this.serveFrom(entry, compilerPath, entryAbsolute, mtimeMs);
      if (served) {
        this.coverageHits += 1;
        return this.touch(key, entry, served);
      }
    }
    return null;
  }

  /**
   * `entry` as a handle pointing at `entryAbsolute`, or `null` when it does not
   * hold a usable copy of that file.
   *
   * Shared by the per-entry LRU and the whole-project Program because the three
   * conditions are identical for both: membership in `coveredTextBytes`, a
   * `builtAtMs` no older than the file, and an actual `SourceFile` in the
   * Program. Only the LRU bookkeeping differs, and that stays with the caller.
   */
  private serveFrom(
    entry: CacheEntry,
    compilerPath: string,
    entryAbsolute: string,
    mtimeMs: number,
  ): TSProgramHandle | null {
    if (!entry.coveredTextBytes.has(compilerPath) || entry.builtAtMs < mtimeMs) return null;
    const existing = entry.derived.get(compilerPath);
    if (existing) return existing;
    // Looked up by the NATIVE path: `getSourceFile` normalizes its argument,
    // and passing what the caller already computed keeps the two forms from
    // having to agree anywhere but in the membership test above.
    const sourceFile = entry.handle.program.getSourceFile(entryAbsolute);
    if (!sourceFile) return null;
    const handle: TSProgramHandle = {
      program: entry.handle.program,
      checker: entry.handle.checker,
      sourceFile,
      rootFiles: entry.handle.rootFiles,
    };
    entry.derived.set(compilerPath, handle);
    return handle;
  }

  /**
   * Build the whole-project Program, once, if the configured strategy and the
   * project's size both call for it — the ACQUIRE-side entry, where the only
   * evidence available is the run's own history.
   *
   * The warm-up gate is the one non-terminal exit here: it is waiting for
   * evidence, not deciding, so it deliberately leaves {@link wholeAttempted}
   * unset and re-asks on the next acquire. Every terminal exit belongs to
   * {@link buildWholeProgram}. A caller that knows the run's size up front
   * skips the wait entirely — {@link primeForExpectedEntries}.
   */
  private ensureWholeProgram(relPath: RelPath): void {
    if (this.wholeAttempted || this.strategy === "coverage") return;
    if (this.strategy === "auto" && !this.warmedUp(relPath)) return;
    this.buildWholeProgram();
  }

  /**
   * Build the whole-project Program NOW, on a caller that already knows this
   * run is a bulk pass — skipping the warm-up gate, which exists only to infer
   * exactly that (bd tea-rags-mcp-6aytq).
   *
   * `expectedEntries` is measured against the SAME threshold the gate waits
   * for, so this can only make the decision EARLIER, never different: a
   * declared volume below `wholeMinEntries` returns without recording an
   * attempt, leaving the per-acquire gate in charge and an incremental reindex
   * behaving exactly as it did before this method existed. Every other
   * eligibility rule — strategy, root-set size, one attempt per run,
   * fall-back-to-coverage on failure — is
   * {@link buildWholeProgram}'s and applies unchanged.
   *
   * What it saves is the warm-up itself. On a full taxdome run the gate opens
   * only after 200 distinct entry files, and reaching them costs 66 per-entry
   * `ts.createProgram` builds — 9-13 s of a 58.8 s pass plus their allocation
   * churn — spent constructing slices of the very Program that is about to
   * replace them.
   */
  primeForExpectedEntries(expectedEntries: number, corpusRelPaths?: readonly RelPath[]): void {
    if (this.typecheckerOff) return;
    // Recorded before any early return, because the corpus is a FACT about the
    // run and not a consequence of the decision below it: a volume under the
    // gate leaves the lazy warm-up in charge, and when that eventually fires it
    // must build the same union this call declared.
    if (corpusRelPaths !== undefined) {
      this.corpusRoots = corpusRelPaths.map((relPath) => this.toCompilerPath(this.toAbsolute(relPath)));
    }
    if (this.strategy === "coverage") {
      // No whole build to decide, but coverage mode has a floor of its own —
      // one covering Program over the main connectivity component, which a
      // 2048-declared worker died building on taxdome. A BULK run is the only
      // shape that reaches it, and the declared volume is what says so: it is
      // the run's own count, and asking the tsconfig walk (~750 ms) purely to
      // refuse a build would pay for a number this one already supports.
      if (expectedEntries >= this.wholeMinEntries) this.admit(expectedEntries);
      return;
    }
    if (this.wholeAttempted) return;
    // An explicit `whole` primes on first use however small the run, and this
    // is that first use — the gate is documented as ignored for it.
    if (this.strategy === "auto" && expectedEntries < this.wholeMinEntries) return;
    this.buildWholeProgram();
  }

  /**
   * The whole-project build proper, once per run whoever asked for it.
   *
   * {@link wholeAttempted} is set BEFORE the attempt, so an empty root set, an
   * over-cap project and a failed build each cost one decision per run rather
   * than one per acquire — and a failure degrades to the per-entry path rather
   * than retrying a build that just returned null, matching {@link build}'s
   * contract.
   */
  private buildWholeProgram(): void {
    this.wholeAttempted = true;
    this.entriesSeen = null;

    const roots = this.wholeRootSet();
    if (roots.length === 0) return;
    // `auto` is the size-aware choice; an explicit `whole` is an operator who
    // has already made it, and is not second-guessed.
    if (this.strategy === "auto" && roots.length > this.wholeRootFilesMax) return;
    // Admission IS second-guessed for an explicit `whole`, and the asymmetry is
    // deliberate: the root ceiling above encodes a preference between two
    // working strategies, while this one says the build does not fit the
    // isolate. An operator can prefer a slower trade; nobody can opt into
    // ERR_WORKER_OUT_OF_MEMORY and the loss of the run's whole graph.
    if (this.admit(roots.length) !== "whole") return;

    this.wholeEntry = this.buildFrom(roots, roots[0]);
    if (this.wholeEntry !== null) this.wholeBuilds += 1;
  }

  /**
   * The root set a whole-project Program is built from: what the project
   * CLAIMS, unioned with what this run will actually RESOLVE
   * (bd tea-rags-mcp-6aytq).
   *
   * Neither half contains the other on a real repository, and the half that was
   * missing is the expensive one. Measured on taxdome: the tsconfig expansion
   * names 12,335 files, the run resolves 10,912, they share 9,976 — so 936 of
   * the files the pass is about to ask for are not roots, and each opens a
   * subgraph no retained Program covers. A whole-Program run still paid 42
   * `ts.createProgram` calls for them, 10.2 s, 22% of a 46.4 s pass. Adding
   * them as roots costs the compiler nothing it was not going to do anyway:
   * `ts.createProgram` accepts arbitrary root names, and a file the tsconfig
   * EXCLUDES still parses — exclusion governs what `tsc` compiles, not what the
   * compiler can be handed.
   *
   * Both halves are normalized to the compiler's forward-slash form, which is
   * also the key {@link serveFrom}'s membership test reads, so a corpus file is
   * a coverage HIT by construction rather than by coincidence. The union is
   * de-duplicated for the same reason the count matters: it is the number
   * {@link admit} and {@link wholeRootFilesMax} are measured against, and
   * counting the 9,976 shared files twice would refuse builds that fit.
   */
  private wholeRootSet(): readonly string[] {
    const union = new Set<string>();
    for (const root of this.projectRoots()) union.add(this.toCompilerPath(root));
    for (const root of this.corpusRoots) union.add(root);
    return [...union];
  }

  /**
   * What this cache did over the run, as a JSON-able record — the observable a
   * production log carries so the strategy question is answered by the run
   * rather than by re-deriving it from wall clock (bd tea-rags-mcp-6aytq).
   *
   * Every field is already maintained for another purpose; nothing here is
   * computed on the resolve path. Read once per progress line.
   */
  diagnostics(): Record<string, number | string | boolean> {
    return {
      strategy: this.strategy,
      wholeProgramFiles: this.wholeProgramFileCount,
      wholeProgramBuilds: this.wholeBuilds,
      wholeRoots: this.wholeEntry?.handle.rootFiles.length ?? 0,
      corpusRoots: this.corpusRoots.length,
      segmentFiles: this.segmentFiles.size,
      acquires: this.acquires,
      wholeHits: this.wholeHits,
      coverageHits: this.coverageHits,
      entryBuilds: this.entryBuilds,
      retainedPrograms: this.entries.size,
      parsedProjectFiles: this.parsedProjectSources.size,
      parsedDependencyFiles: this.parsedDependencySources.size,
      typeCheckerDisabled: this.typecheckerOff,
    };
  }

  /**
   * Start a new segment when `relPath` is the file that overflows the current
   * one — releasing every checker the cache holds and rebuilding the
   * whole-project Program from the same roots. The bound described by
   * {@link TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT}.
   *
   * EVERY retained Program goes, not just the whole one. Checker state is
   * monotonic in whichever Program answers, and on this corpus the per-entry
   * LRU answers most acquires (see {@link segmentFiles}) — retiring only the
   * whole Program would leave eight growing checkers behind and bound nothing.
   * The parses survive in the shared host map, so what a segment boundary costs
   * is module resolution: one whole build plus however many per-entry closures
   * the next stretch re-opens, measured at ~42 builds per 5,000 files.
   *
   * The retiring entries are dropped BEFORE the new build starts. Holding both
   * generations across `ts.createProgram` would put the segment boundary at the
   * very peak this exists to remove; the outgoing Programs survive only as long
   * as the handles already handed out, which callers release as they finish
   * their files. A rebuild that fails leaves no whole Program and the run
   * degrades to per-entry coverage, exactly as a failed first build does.
   */
  private rotateSegmentWhenFull(relPath: RelPath): void {
    if (this.segmentFiles.size < this.wholeSegmentFiles || this.segmentFiles.has(relPath)) {
      this.segmentFiles.add(relPath);
      return;
    }
    this.segmentFiles.clear();
    this.segmentFiles.add(relPath);

    const retiring = this.wholeEntry;
    this.entries.clear();
    this.wholeEntry = null;
    if (retiring === null) return;
    const roots = retiring.handle.rootFiles;
    this.wholeEntry = this.buildFrom(roots, roots[0]);
    if (this.wholeEntry !== null) this.wholeBuilds += 1;
  }

  /**
   * Which Program strategy this isolate's heap admits, latching the refusal
   * when the answer is none.
   *
   * Assessed at most once per run, at the same point the whole-project
   * decision is made, because both need the root count and neither may be
   * re-derived per acquire. The verdict is returned as well as latched so the
   * caller can tell "build the whole Program" from "fall through to per-entry
   * coverage" without re-reading state.
   */
  private admit(rootCount: number): TSProgramAdmissionAssessment["verdict"] {
    const assessment = assessTSProgramAdmission({
      rootCount,
      segmentFiles: this.wholeSegmentFiles,
      heapSizeLimitMb: this.readHeapSizeLimitMb(),
      budget: this.heapBudget,
    });
    if (assessment.verdict === "typecheckerOff") this.disableTypeChecker(assessment);
    return assessment.verdict;
  }

  /**
   * Refuse every Program for the rest of the run, drop what is already
   * retained, and say so once.
   *
   * The retained Programs go too. They are the memory the verdict just called
   * unaffordable, and a run that will build no more of them has no use for the
   * ones a warm-up happened to build first.
   *
   * The emit mirrors `enrichment/infra/heap-ceiling-enforcement.ts`'s idiom —
   * one `[enrichment-worker]` line on stderr — because this is the same class
   * of fact reported from the same isolate: a memory bound that changes what
   * the worker can do, and that nothing else in the run will mention.
   */
  private disableTypeChecker(assessment: TSProgramAdmissionAssessment): void {
    this.typecheckerOff = true;
    this.wholeAttempted = true;
    this.entriesSeen = null;
    this.wholeEntry = null;
    this.entries.clear();
    if (this.downgradeReported) return;
    this.downgradeReported = true;
    const warning = describeTSProgramTypecheckerDowngrade(assessment);
    if (warning) process.stderr.write(`[enrichment-worker] ${warning}\n`);
  }

  /**
   * Has this run asked about enough distinct files to look like a bulk pass?
   *
   * The count is the workload signal {@link TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT}
   * describes: an incremental reindex re-resolves a handful of files and must
   * not pay a whole-project build for them, while a full pass crosses the gate
   * within its first few seconds.
   */
  private warmedUp(relPath: RelPath): boolean {
    const seen = this.entriesSeen;
    if (seen === null) return true;
    seen.add(relPath);
    return seen.size >= this.wholeMinEntries;
  }

  /** An absolute path in the forward-slash form `ts` reports file names in. */
  private toCompilerPath(absolutePath: string): string {
    return sep === "/" ? absolutePath : absolutePath.split(sep).join("/");
  }

  /** Move `key` to the most-recently-used end and hand `handle` back. */
  private touch(key: RelPath, entry: CacheEntry, handle: TSProgramHandle): TSProgramHandle {
    this.entries.delete(key);
    this.entries.set(key, entry);
    return handle;
  }

  /** Drop `absolute`'s parse when the file changed after it was read. */
  private forgetStaleParse(absolute: string, mtimeMs: number): void {
    const parsedAt = this.parsedAtMs.get(absolute);
    if (parsedAt !== undefined && parsedAt < mtimeMs) this.forgetParse(absolute);
  }

  /** Drop every retained Program — the run-boundary reset. */
  reset(): void {
    this.entries.clear();
    // Including the whole-project one, and the decision that produced it: a
    // reset means the tree may have moved underneath the run, and the root set
    // is as re-derivable as the parses are.
    this.wholeEntry = null;
    this.wholeAttempted = false;
    this.wholeBuilds = 0;
    this.segmentFiles.clear();
    this.entriesSeen = new Set();
    // The corpus belonged to ONE pass. A reset means the next pass declares its
    // own, and carrying the previous one over would root the next Program at
    // files that run is not going to resolve.
    this.corpusRoots = [];
    this.acquires = 0;
    this.wholeHits = 0;
    this.coverageHits = 0;
    this.entryBuilds = 0;
    // The admission verdict is re-armed with everything else: it was decided
    // against ONE run's root count on ONE isolate reading, and a reset means a
    // new run is about to declare its own.
    this.typecheckerOff = false;
    this.downgradeReported = false;
    this.sourceFiles.clear();
    this.parsedAtMs.clear();
    this.parsedProjectSources.clear();
    this.parsedDependencySources.clear();
    // The probe answers are run-scoped for the same reason the parses are: a
    // file may have appeared or been deleted since, and a memoized "no" is
    // exactly as stale as a memoized AST.
    this.hostFileExists.clear();
    this.hostDirectoryExists.clear();
    this.hostRealpath.clear();
  }

  /**
   * Repo-relative POSIX path for an absolute compiler file name, or `null` when
   * it lies outside the repo DIRECTORY.
   *
   * Read the boundary literally: it is the repo directory, not the project's
   * sources. `node_modules` is inside the repo root, so a dependency's `.d.ts`
   * gets an ordinary `RelPath` here — and where the running compiler resolves
   * under that root, so does every default-lib file. This docblock used to
   * promise the opposite ("`null` … a `node_modules` dependency, the default
   * lib") and five call sites were written against that promise
   * (bd tea-rags-mcp-otm6n).
   *
   * Deciding whether a declaration may be an EDGE TARGET, or whether a type
   * belongs to this project, needs {@link toProjectSourceRelPath} /
   * {@link isProjectSourceFile} instead.
   */
  toRelPath(absolutePath: string): RelPath | null {
    const rel = relative(this.repoRoot, absolutePath);
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
    return sep === "/" ? rel : rel.split(sep).join("/");
  }

  /**
   * Is `absolutePath` one of the project's OWN sources?
   *
   * {@link toRelPath} answers a narrower question than most of its callers
   * need. It reports whether a path lies inside the repo DIRECTORY — and
   * `node_modules` lies inside it, so a dependency's `.d.ts` maps to a perfectly
   * ordinary `RelPath` and reads as project code (bd tea-rags-mcp-otm6n).
   *
   * That is not a hypothetical. Whether it bites depends on where the running
   * `typescript` resolves from, which is why it stayed hidden: with the compiler
   * installed under the indexed root, the DEFAULT LIB maps to
   * `node_modules/typescript/lib/lib.*.d.ts` and every builtin — `Map`, `Promise`,
   * `Array` — reports as declared in-project. A guard asking "is this type
   * declared outside the project" then answers `false` for every type there is.
   *
   * So the test consumers actually want is this one: inside the repo root AND
   * not inside any `node_modules`, nested workspace copies included. A path
   * merely NAMED like a dependency (`src/node_modules_helper.ts`) is project
   * code — the segment has to be whole.
   */
  isProjectSourceFile(absolutePath: string): boolean {
    return this.toProjectSourceRelPath(absolutePath) !== null;
  }

  /**
   * Repo-relative path for an absolute compiler file name, but ONLY when it
   * names one of the project's own sources — the answer every consumer deciding
   * "may an edge point here" actually wants. `null` for a dependency, for the
   * default lib, and for anything outside the root.
   *
   * Kept separate from {@link toRelPath} rather than folded into it because the
   * two answer different questions and both are needed: the closure walk maps
   * an import against the CALLER's position in the repo directory, while an
   * EDGE may only ever land on a file the index contains. Pointing one at
   * `node_modules` produces an edge whose target is not in the symbol table at
   * all, and simultaneously keeps the call out of the external classification
   * it deserves (bd tea-rags-mcp-otm6n).
   */
  toProjectSourceRelPath(absolutePath: string): RelPath | null {
    const relPath = this.toRelPath(absolutePath);
    return relPath !== null && !isDependencyPath(relPath) ? relPath : null;
  }

  /** Absolute path for a repo-relative one, POSIX separators normalized. */
  private toAbsolute(relPath: RelPath): string {
    return resolvePath(this.repoRoot, relPath);
  }

  private invalidate(relPath: RelPath): void {
    this.entries.delete(relPath);
    // The changed file's parse is stale in the shared host cache too — a later
    // Program that imports it must not be handed the previous revision.
    this.forgetParse(this.toAbsolute(relPath));
  }

  /**
   * Record a parse in the shared map and in the bounded population it belongs
   * to, if any — {@link populationOf} decides which, and answers `null` for the
   * default lib.
   *
   * The writes are colocated here, and {@link forgetParse} is the only other
   * place any of these collections is mutated, because an index's whole cost is
   * that it CAN disagree with the map — a derived count could not. Keeping both
   * edges of that risk in one pair of methods is what makes the disagreement
   * testable instead of scattered across four call sites.
   *
   * A parse that produced nothing is still recorded, exactly as the derived
   * count treated it: the map key exists, so the slot is held.
   */
  private rememberParse(fileName: string, parsed: ts.SourceFile | undefined): void {
    this.sourceFiles.set(fileName, parsed);
    this.parsedAtMs.set(fileName, Date.now());
    this.populationOf(fileName)?.add(fileName);
  }

  /**
   * A still-fresh parse of `fileName` that a retained Program pins, or
   * `undefined` when none does — the read-through behind the shared map (bd
   * tea-rags-mcp-5je8t).
   *
   * Capacity eviction and Program retention used to be independent, and their
   * blind spot compounded: evicting a parse a retained Program pins frees
   * NOTHING (the Program keeps its AST alive), while the next build re-parses
   * the file into a fresh PRIVATE copy — so once the reachable dependency
   * surface exceeded `maxDependencyFiles`, the Program LRU degraded from eight
   * views of one shared AST pool into eight private pools. Measured on the
   * probe fixture: 4.6 MB heap per build with sharing intact, 153 MB once the
   * churn broke it, and a live run past 3.9 GB RSS. Serving the pinned parse
   * instead costs one map lookup per retained Program plus one stat — and only
   * on a shared-map MISS, the path that previously paid a full re-parse.
   *
   * The stat is the staleness guard, and it deliberately does NOT memoize: a
   * Program built before the file's current mtime holds the previous revision,
   * and dependencies never surface through `forgetStaleParse` (they are never
   * entries), so this comparison is the only thing standing between a changed
   * `.d.ts` and a confident stale answer. Same `builtAtMs` rule
   * {@link findCovering} applies to whole Programs, applied per file.
   */
  private pinnedParseOf(fileName: string): ts.SourceFile | undefined {
    // The whole-project Program pins by far the largest population, so it is
    // the likeliest holder of any parse the shared map has evicted.
    const candidates = this.wholeEntry === null ? this.entries.values() : [this.wholeEntry, ...this.entries.values()];
    for (const entry of candidates) {
      const pinned = entry.handle.program.getSourceFile(fileName);
      if (!pinned) continue;
      const mtimeMs = entryMtime(fileName);
      if (mtimeMs === null || entry.builtAtMs < mtimeMs) continue;
      return pinned;
    }
    return undefined;
  }

  /** Drop a parse from the shared map and from whichever index holds it. */
  private forgetParse(fileName: string): void {
    this.sourceFiles.delete(fileName);
    this.parsedAtMs.delete(fileName);
    this.parsedProjectSources.delete(fileName);
    this.parsedDependencySources.delete(fileName);
  }

  /**
   * The bounded population `fileName` belongs to, or `null` when it belongs to
   * none — the default lib, the one set no eviction walk may reach.
   *
   * Order matters: with the compiler installed under the indexed root the lib
   * lives inside `node_modules`, so it would read as an ordinary dependency and
   * become evictable if the dependency test ran first.
   */
  private populationOf(fileName: string): Set<string> | null {
    if (dirname(fileName) === this.defaultLibDir) return null;
    return this.isProjectSourceFile(fileName) ? this.parsedProjectSources : this.parsedDependencySources;
  }

  /**
   * Enforce both retention bounds, least-recently-used first: the count cap
   * exactly as it always ran, then the byte budget over what survives.
   *
   * The byte loop stops at ONE retained Program no matter the budget. The
   * newest build is the Program its entry is about to be resolved through, and
   * every file of its closure is a pending coverage hit — dropping it would
   * re-run `ts.createProgram` once per file of that closure, the cost bd
   * tea-rags-mcp-4m2vb removed. So a budget smaller than a single closure
   * degrades to "retain the newest alone", and the memory floor is one
   * closure — see {@link TSProgramCacheOptions.maxRetainedSourceTextBytes}.
   */
  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const lru = this.entries.keys().next();
      if (lru.done) return;
      this.entries.delete(lru.value);
    }
    while (this.entries.size > 1 && this.retainedSourceTextBytes > this.maxRetainedSourceTextBytes) {
      const lru = this.entries.keys().next();
      if (lru.done) return;
      this.entries.delete(lru.value);
    }
  }

  /**
   * A compiler host that memoizes parsed SourceFiles across every Program this
   * cache builds. Without it each Program re-parses the default lib — the
   * single largest fixed cost in `ts.createProgram`.
   *
   * The same treatment covers the three filesystem probes MODULE RESOLUTION
   * runs, which happen before any parse and dominate the syscall count — see
   * {@link hostFileExists}. Memoizing them is safe on exactly the terms this
   * cache already documents at the top of the file: it is scoped to one
   * indexing run, and within a run a file does not appear or vanish for the
   * purposes these checks serve — the same assumption `createProjectFileProbe`
   * runs on. {@link reset} drops them alongside the parses for a caller that
   * owns a run boundary, though nothing in `src` is such a caller today.
   */
  private buildHost(): ts.CompilerHost {
    const base = ts.createCompilerHost(this.compilerOptions, true);
    const getSourceFile = base.getSourceFile.bind(base);
    base.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
      if (this.sourceFiles.has(fileName)) return this.sourceFiles.get(fileName);
      const pinned = this.pinnedParseOf(fileName);
      if (pinned) return pinned;
      const parsed = getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
      this.rememberParse(fileName, parsed);
      this.evictParsedOverflow();
      return parsed;
    };
    base.fileExists = memoizeHostProbe(base.fileExists.bind(base), this.hostFileExists);
    // Both are optional on `ts.CompilerHost`. `createCompilerHost` supplies
    // them on Node, but the type is the contract — wrap what is there rather
    // than asserting it into existence.
    if (base.directoryExists) {
      base.directoryExists = memoizeHostProbe(base.directoryExists.bind(base), this.hostDirectoryExists);
    }
    if (base.realpath) {
      base.realpath = memoizeHostProbe(base.realpath.bind(base), this.hostRealpath);
    }
    return base;
  }

  /**
   * Trim each bounded population back to its cap, oldest insertion first.
   * Without this the map is append-only for the life of the process — a
   * `LanguageProvider` outlives any single indexing run, so every file of every
   * project ever indexed would stay parsed in memory.
   *
   * Only the DEFAULT LIB is skipped. It is what the map exists to hold:
   * re-parsing `lib.es2022.full.d.ts` is the single largest fixed cost in
   * `ts.createProgram`, and it really is a small fixed set. Dependencies were
   * skipped on the same reasoning and should not have been (bd
   * tea-rags-mcp-8qf86) — a repository's reachable `.d.ts` surface is neither
   * small nor known up front, and it is discovered gradually as the resolve
   * walk spreads, which is why the growth reads as a leak rather than as a
   * warm-up.
   *
   * Both walks read the population indexes rather than the parse map, which is
   * what keeps this affordable on the hot path — it runs on EVERY parse, and
   * against the map both the count and the walk were O(map size) with a
   * `node:path.relative` per entry (bd tea-rags-mcp-ajvnq). Now the common case
   * — under the bound, nothing to do — is a size comparison per population, and
   * the overflow case iterates only eviction candidates.
   */
  private evictParsedOverflow(): void {
    this.trimPopulation(this.parsedProjectSources, this.maxParsedFiles);
    this.trimPopulation(this.parsedDependencySources, this.maxDependencyFiles);
  }

  /**
   * Drop the oldest parses of one population until it fits `max`.
   *
   * Deleting the entry the iterator is standing on is well-defined for a Set,
   * and insertion order means the oldest parse is always the one it reaches
   * first — the same order the map walk produced.
   */
  private trimPopulation(population: Set<string>, max: number): void {
    let over = population.size - max;
    if (over <= 0) return;
    for (const fileName of population) {
      this.forgetParse(fileName);
      if (--over === 0) return;
    }
  }

  /**
   * Build the Program for one entry, packaged as the cache entry that retains
   * it — the handle plus what {@link findCovering} needs to serve OTHER files
   * off it.
   *
   * The coverage set is read back off the finished Program rather than derived
   * from `rootFiles`, because the two are not the same set and the difference is
   * the whole point: the compiler resolves and pulls in the transitive closure
   * of every root, so what the Program holds is routinely two orders of
   * magnitude larger than what it was handed.
   *
   * Only files under the repo root are recorded. Everything else — the default
   * lib above all — is never an entry file, so indexing it would grow the set by
   * the largest population in the Program for a lookup that cannot happen.
   *
   * `ts.createProgram`'s own module-resolution walk (the transitive closure
   * discussed above) is a recursive implementation with no depth bound of its
   * own, and a deep enough barrel-chained closure can overflow the call stack
   * (bd tea-rags-mcp-2j8s1 — reproduced at taxdome's real scale, ~10k files,
   * via scripts/spikes/ts-resolve-path-profile.ts). `acquire`'s contract is
   * already "null means no type info, fall through" for the file-not-on-disk
   * case below; a Program that can't be built degrades the same way instead of
   * crashing whichever worker thread is running the resolve.
   */
  private build(entryAbsolute: string): CacheEntry | null {
    return this.buildFrom(this.collectClosure(entryAbsolute), entryAbsolute);
  }

  /**
   * One `ts.createProgram` over `rootFiles`, packaged as the cache entry that
   * retains it and pointed at `entryAbsolute`.
   *
   * Shared by the per-entry path — where `rootFiles` is one entry's bounded
   * import closure — and the whole-project one, where it is every file the
   * project claims. Nothing below distinguishes the two: the coverage set is
   * read back off the finished Program either way, precisely because the roots
   * never predict what the compiler pulls in.
   */
  private buildFrom(rootFiles: readonly string[], entryAbsolute: string): CacheEntry | null {
    let program: ts.Program;
    try {
      program = ts.createProgram({ rootNames: [...rootFiles], options: this.compilerOptions, host: this.host });
    } catch {
      return null;
    }
    const builtAtMs = Date.now();
    const sourceFile = program.getSourceFile(entryAbsolute);
    if (!sourceFile) return null;
    const entryMtimeMs = entryMtime(entryAbsolute);
    if (entryMtimeMs === null) return null;
    const coveredTextBytes = new Map<string, number>();
    for (const file of program.getSourceFiles()) {
      // The default lib is one shared fixed set — never an entry, so excluding
      // it costs no coverage lookup, and counting it would charge the same
      // unevictable bytes to every Program. Everything else counts, wherever
      // resolution's realpathing landed it — see {@link CacheEntry.coveredTextBytes}.
      if (posix.dirname(file.fileName) === this.defaultLibCompilerDir) continue;
      coveredTextBytes.set(file.fileName, file.text.length);
    }
    return {
      handle: { program, checker: program.getTypeChecker(), sourceFile, rootFiles },
      entryMtimeMs,
      builtAtMs,
      coveredTextBytes,
      derived: new Map(),
    };
  }

  /**
   * Breadth-first import closure from `entryAbsolute`, entry first. Bounded by
   * `maxImportDepth` hops and `maxRootFiles` files; bare npm specifiers map to
   * `null` through `mapImportToFile` and are skipped, so a Program never pulls
   * `node_modules` in as a root.
   */
  private collectClosure(entryAbsolute: string): string[] {
    const roots: string[] = [entryAbsolute];
    const seen = new Set<string>([entryAbsolute]);
    let frontier: string[] = [entryAbsolute];

    for (let depth = 0; depth < this.maxImportDepth && roots.length < this.maxRootFiles; depth++) {
      const next: string[] = [];
      for (const file of frontier) {
        for (const imported of this.importedFilesOf(file)) {
          if (seen.has(imported)) continue;
          seen.add(imported);
          if (!existsSync(imported)) continue;
          roots.push(imported);
          next.push(imported);
          if (roots.length >= this.maxRootFiles) return roots;
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    return roots;
  }

  /**
   * In-project files `file` imports, as absolute paths. `ts.preProcessFile` is
   * the cheap scanner the compiler itself uses for this — a full parse is not
   * needed to read import specifiers.
   */
  private importedFilesOf(file: string): string[] {
    const callerRel = this.toRelPath(file);
    if (callerRel === null) return [];
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const ref of ts.preProcessFile(source, true, true).importedFiles) {
      const targetRel = mapImportToFile(ref.fileName, callerRel, this.tsOptions, this.fileExists);
      if (targetRel === null) continue;
      out.push(resolvePath(this.repoRoot, posix.normalize(targetRel)));
    }
    return out;
  }
}

/**
 * Wrap one path-keyed `ts.CompilerHost` probe so each path costs one syscall
 * per run instead of one per `ts.createProgram` (bd tea-rags-mcp-e6yad).
 *
 * `undefined` is read as "not asked yet" rather than paying a `Map.has` on
 * every hit, which is sound for the three probes this wraps and only those:
 * `fileExists` and `directoryExists` answer `boolean`, `realpath` answers
 * `string`, so none of them can store `undefined` as a real answer. `false`
 * memoizes correctly — it is a value, not an absence — and it is the answer
 * that matters most, since the repeated probes are dominated by candidate paths
 * that do not exist.
 */
function memoizeHostProbe<T>(probe: (path: string) => T, answers: Map<string, T>): (path: string) => T {
  return (path: string): T => {
    const memoized = answers.get(path);
    if (memoized !== undefined) return memoized;
    const answer = probe(path);
    answers.set(path, answer);
    return answer;
  };
}

/**
 * Does a repo-relative path lead into an installed dependency? Matches whole
 * segments only, at the root or in a nested workspace — `toRelPath` has already
 * normalized separators to POSIX, so `/` is the only one to look for.
 */
function isDependencyPath(relPath: RelPath): boolean {
  return relPath === "node_modules" || relPath.startsWith("node_modules/") || relPath.includes("/node_modules/");
}

/** Entry-file mtime, or `null` when the path is not a readable file. */
function entryMtime(absolutePath: string): number | null {
  try {
    const stats = statSync(absolutePath);
    return stats.isFile() ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}
