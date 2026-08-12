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
 * **Which is why the cache is keyed by COVERAGE, not by entry file alone.** If
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

/** Max Programs retained before the least-recently-used one is dropped. */
export const TS_PROGRAM_CACHE_MAX_DEFAULT = 8;
/** Max root files (entry + closure) a single Program is built from. */
export const TS_PROGRAM_ROOT_FILES_MAX_DEFAULT = 200;
/** Max import hops walked outward from the entry file. */
export const TS_PROGRAM_IMPORT_DEPTH_DEFAULT = 2;
/** Max PROJECT sources retained in the shared parse cache (the lib is exempt). */
export const TS_PROGRAM_PARSED_FILES_MAX_DEFAULT = 2000;
/** Max DEPENDENCY declarations retained in the shared parse cache. */
export const TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX_DEFAULT = 2000;

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
   * Absolute names of the in-root files the Program actually CONTAINS, which is
   * a very different set from the root names it was handed —
   * `ts.createProgram` walks the transitive import graph itself, unbounded by
   * either closure cap.
   */
  covers: Set<string>;
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
    this.compilerOptions = buildCompilerOptions(this.repoRoot, this.tsOptions);
    this.inRootPrefix = `${sep === "/" ? this.repoRoot : this.repoRoot.split(sep).join("/")}/`;
    this.host = this.buildHost();
    // Read off the host rather than guessed: it is the same lookup the compiler
    // itself uses to find the lib, so the exempt directory is exactly the one
    // whose files `ts.createProgram` will ask this cache to parse.
    this.defaultLibDir = dirname(this.host.getDefaultLibFileName(this.compilerOptions));
  }

  /** Programs currently retained. */
  get size(): number {
    return this.entries.size;
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
   * The Program whose entry file is `relPath`, building it on a miss. Returns
   * `null` when the file is not on disk — the caller then has no type
   * information and must fall through rather than guess.
   */
  acquire(relPath: RelPath): TSProgramHandle | null {
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

    const cached = this.entries.get(relPath);
    if (cached?.entryMtimeMs === mtimeMs) {
      // Refresh recency: delete + set moves the key to the end of the Map's
      // insertion order, making the first key the least recently used.
      this.entries.delete(relPath);
      this.entries.set(relPath, cached);
      return cached.handle;
    }
    if (cached) this.invalidate(relPath);

    const covering = this.findCovering(this.toCompilerPath(absolute), absolute, mtimeMs);
    if (covering) return covering;

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
    for (const [key, entry] of this.entries) {
      if (!entry.covers.has(compilerPath) || entry.builtAtMs < mtimeMs) continue;
      const existing = entry.derived.get(compilerPath);
      if (existing) return this.touch(key, entry, existing);
      // Looked up by the NATIVE path: `getSourceFile` normalizes its argument,
      // and passing what the caller already computed keeps the two forms from
      // having to agree anywhere but in the membership test above.
      const sourceFile = entry.handle.program.getSourceFile(entryAbsolute);
      if (!sourceFile) continue;
      const handle: TSProgramHandle = {
        program: entry.handle.program,
        checker: entry.handle.checker,
        sourceFile,
        rootFiles: entry.handle.rootFiles,
      };
      entry.derived.set(compilerPath, handle);
      return this.touch(key, entry, handle);
    }
    return null;
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

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
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
   */
  private build(entryAbsolute: string): CacheEntry | null {
    const rootFiles = this.collectClosure(entryAbsolute);
    const program = ts.createProgram({ rootNames: [...rootFiles], options: this.compilerOptions, host: this.host });
    const builtAtMs = Date.now();
    const sourceFile = program.getSourceFile(entryAbsolute);
    if (!sourceFile) return null;
    const entryMtimeMs = entryMtime(entryAbsolute);
    if (entryMtimeMs === null) return null;
    const covers = new Set<string>();
    for (const file of program.getSourceFiles()) {
      if (file.fileName.startsWith(this.inRootPrefix)) covers.add(file.fileName);
    }
    return {
      handle: { program, checker: program.getTypeChecker(), sourceFile, rootFiles },
      entryMtimeMs,
      builtAtMs,
      covers,
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
