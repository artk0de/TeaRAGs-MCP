/**
 * Module-resolution memo shared by the import-graph walk and every batch
 * `ts.Program` of a run (bd tea-rags-mcp-vtuu4).
 *
 * It replaces a shared `ts.ModuleResolutionCache`. That cache holds the full
 * `ResolvedModuleWithFailedLookupLocations` of every lookup, including the
 * `failedLookupLocations` trail: every candidate path probed on the way. The
 * trail exists for watch mode, which nothing here runs. On taxdome the cache
 * held ~545 MB after the graph walk (619 MB live, 61 MB after `clear()`), on
 * a 2 GB target.
 *
 * The memo keeps the resolved module only. The key is the containing
 * DIRECTORY, the specifier and the resolution mode: the same key
 * `ts.ModuleResolutionCache` resolves per directory under. The options are
 * fixed per instance, and a call with another options object or a redirected
 * project reference bypasses the memo, so one options set never answers for
 * another.
 *
 * The compiler still computes each miss through a real
 * `ts.ModuleResolutionCache`, so misses in one stretch share package.json
 * reads and node_modules walks. {@link releaseLookups} empties that cache,
 * package.json info aside, and the owner calls it at points it chooses (after
 * the graph walk, after each Program build). The trail is therefore never
 * retained beyond one stretch.
 */

import { dirname } from "node:path";

import ts from "typescript";

/** What the memo holds per key — nothing a Program does not read. */
type MemoizedResolution = ts.ResolvedModuleWithFailedLookupLocations;

export class TSModuleResolutionMemo {
  private readonly answers = new Map<string, MemoizedResolution>();
  private lookups: ts.ModuleResolutionCache;
  /** package.json reads, kept across {@link releaseLookups}: small, and shared by every lookup. */
  private readonly packageJsonInfo: ts.PackageJsonInfoCache;

  constructor(
    private readonly options: ts.CompilerOptions,
    private readonly host: ts.ModuleResolutionHost,
  ) {
    this.lookups = this.createLookups();
    this.packageJsonInfo = this.lookups.getPackageJsonInfoCache();
  }

  private createLookups(packageJsonInfo?: ts.PackageJsonInfoCache): ts.ModuleResolutionCache {
    return ts.createModuleResolutionCache(
      process.cwd(),
      (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
      this.options,
      packageJsonInfo,
    );
  }

  /** Memoized resolutions held. */
  get size(): number {
    return this.answers.size;
  }

  /**
   * `specifier` from `containingFile`, as `ts.resolveModuleName` answers it,
   * minus the lookup trail.
   */
  resolve(
    specifier: string,
    containingFile: string,
    mode: ts.ResolutionMode,
    options: ts.CompilerOptions = this.options,
    redirectedReference?: ts.ResolvedProjectReference,
  ): MemoizedResolution {
    if (options !== this.options || redirectedReference !== undefined) {
      return ts.resolveModuleName(specifier, containingFile, options, this.host, undefined, redirectedReference, mode);
    }
    const key = `${dirname(containingFile)}\0${specifier}\0${mode ?? ""}`;
    const held = this.answers.get(key);
    if (held !== undefined) return held;
    const { resolvedModule } = ts.resolveModuleName(
      specifier,
      containingFile,
      options,
      this.host,
      this.lookups,
      undefined,
      mode,
    );
    const answer: MemoizedResolution = {
      resolvedModule: resolvedModule === undefined ? undefined : { ...resolvedModule },
    };
    this.answers.set(key, answer);
    return answer;
  }

  /** Drop the compiler's lookup trail, keeping every answer and the package.json info. */
  releaseLookups(): void {
    this.lookups = this.createLookups(this.packageJsonInfo);
  }

  /** Drop everything — the run-boundary reset. */
  clear(): void {
    this.answers.clear();
    this.packageJsonInfo.clear();
    this.lookups = this.createLookups(this.packageJsonInfo);
  }
}
