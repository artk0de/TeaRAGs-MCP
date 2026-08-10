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
 * **One Program per entry file, not one per repository.** `ts.createProgram`
 * over a whole monorepo costs minutes of construction and gigabytes of retained
 * AST; on the resolve path that is not a trade-off, it is a stall. Each entry
 * here is instead built from `[entry file, …transitive import closure]`, with
 * the closure capped on BOTH axes ({@link TSProgramCacheOptions.maxImportDepth},
 * {@link TSProgramCacheOptions.maxRootFiles}) so a hub file cannot drag the
 * whole graph in. The closure walk reuses `mapImportToFile` — the same tsconfig
 * `paths`/`baseUrl` mapping the resolver strategies already resolve imports
 * with — so a Program never disagrees with the rest of the resolver about which
 * file an import names.
 *
 * **Bounded by entry count, not by time.** A run has a deterministic file
 * count, and `CallEdgeResolutionRunner` resolves a file's calls together, so
 * per-file locality is near-perfect and a small LRU absorbs it. Parsing is
 * shared further by a single `ts.CompilerHost` whose SourceFile cache spans
 * every Program the instance builds: the default lib and any file imported by
 * several entries are parsed once, not once per Program.
 *
 * **Scoped to one indexing run.** A `LanguageProvider` outlives a single index
 * in the MCP server, and between two runs a dependency's `.d.ts` may have
 * changed — a stale Program is worse than a cold one, because it answers
 * confidently with last run's types. Two mechanisms keep it honest: every
 * `acquire` re-stats the entry file and rebuilds when its mtime moved (the
 * incremental-reindex case, where only changed files are re-resolved), and
 * {@link TSProgramCache.reset} drops everything for a caller that owns a run
 * boundary. Changes confined to a transitive dependency of an unchanged entry
 * are deliberately NOT tracked — that file is not re-resolved either.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, posix, relative, resolve as resolvePath, sep } from "node:path";

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
/** Max PROJECT sources retained in the shared parse cache (libs are exempt). */
export const TS_PROGRAM_PARSED_FILES_MAX_DEFAULT = 2000;

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
   * dropped. Default {@link TS_PROGRAM_PARSED_FILES_MAX_DEFAULT}. Files outside
   * the repo root (the default lib, `node_modules` declarations) do not count
   * and are never evicted — re-parsing those is the cost the map exists to
   * avoid, and their number is bounded by the dependency set rather than by how
   * long the process has been alive.
   */
  maxParsedFiles?: number;
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
  private readonly host: ts.CompilerHost;
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
    this.compilerOptions = buildCompilerOptions(this.repoRoot, this.tsOptions);
    this.host = this.buildHost();
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
   * The Program whose entry file is `relPath`, building it on a miss. Returns
   * `null` when the file is not on disk — the caller then has no type
   * information and must fall through rather than guess.
   */
  acquire(relPath: RelPath): TSProgramHandle | null {
    const absolute = this.toAbsolute(relPath);
    const mtimeMs = entryMtime(absolute);
    if (mtimeMs === null) return null;

    const cached = this.entries.get(relPath);
    if (cached?.entryMtimeMs === mtimeMs) {
      // Refresh recency: delete + set moves the key to the end of the Map's
      // insertion order, making the first key the least recently used.
      this.entries.delete(relPath);
      this.entries.set(relPath, cached);
      return cached.handle;
    }
    if (cached) this.invalidate(relPath);

    const handle = this.build(absolute);
    if (!handle) return null;
    this.entries.set(relPath, { handle, entryMtimeMs: mtimeMs });
    this.evictOverflow();
    return handle;
  }

  /** Drop every retained Program — the run-boundary reset. */
  reset(): void {
    this.entries.clear();
    this.sourceFiles.clear();
    this.parsedProjectSources.clear();
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
   * Record a parse in the shared map and, when the file is one of the
   * project's own sources, in the index that bounds them.
   *
   * The two writes are colocated here, and {@link forgetParse} is the only
   * other place either collection is mutated, because the index's whole cost
   * is that it CAN disagree with the map — a derived count could not. Keeping
   * both edges of that risk in one pair of methods is what makes the
   * disagreement testable instead of scattered across four call sites.
   *
   * A parse that produced nothing is still recorded, exactly as the derived
   * count treated it: the map key exists, so the slot is held.
   */
  private rememberParse(fileName: string, parsed: ts.SourceFile | undefined): void {
    this.sourceFiles.set(fileName, parsed);
    if (this.isProjectSourceFile(fileName)) this.parsedProjectSources.add(fileName);
  }

  /** Drop a parse from the shared map and from the project-source index. */
  private forgetParse(fileName: string): void {
    this.sourceFiles.delete(fileName);
    this.parsedProjectSources.delete(fileName);
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
    return base;
  }

  /**
   * Trim the shared parse cache back to `maxParsedFiles` PROJECT sources,
   * oldest insertion first. Without this the map is append-only for the life of
   * the process — a `LanguageProvider` outlives any single indexing run, so
   * every file of every project ever indexed would stay parsed in memory.
   *
   * Dependencies are skipped rather than trimmed. They are what the map exists
   * to hold: re-parsing `lib.es2022.full.d.ts` is the single largest fixed cost
   * in `ts.createProgram`, and the set is bounded by what the project depends
   * on rather than by how long the process has been alive.
   *
   * Both halves read {@link parsedProjectSources} rather than the parse map,
   * which is what keeps this affordable on the hot path — it runs on EVERY
   * parse, and against the map both the count and the walk were O(map size)
   * with a `node:path.relative` per entry (bd tea-rags-mcp-ajvnq). The walk was
   * the worse half on a real dependency tree: it also had to step over every
   * dependency parse to find the project sources among them, and those are the
   * majority. Now the common case — under the bound, nothing to do — is a size
   * comparison, and the overflow case iterates only eviction candidates.
   */
  private evictParsedOverflow(): void {
    let over = this.parsedProjectSources.size - this.maxParsedFiles;
    if (over <= 0) return;
    // Deleting the entry the iterator is standing on is well-defined for a Set,
    // and insertion order means the oldest parse is always the one it reaches
    // first — the same order the map walk produced.
    for (const fileName of this.parsedProjectSources) {
      this.forgetParse(fileName);
      if (--over === 0) return;
    }
  }

  private build(entryAbsolute: string): TSProgramHandle | null {
    const rootFiles = this.collectClosure(entryAbsolute);
    const program = ts.createProgram({ rootNames: [...rootFiles], options: this.compilerOptions, host: this.host });
    const sourceFile = program.getSourceFile(entryAbsolute);
    if (!sourceFile) return null;
    return { program, checker: program.getTypeChecker(), sourceFile, rootFiles };
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
