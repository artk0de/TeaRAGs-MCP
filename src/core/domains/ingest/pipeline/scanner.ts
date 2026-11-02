// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * FileScanner - Discovers code files in a directory while respecting ignore patterns
 */

import { existsSync, promises as fs, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import ignore, { type Ignore } from "ignore";

import type { IgnoredDirectoryMarker } from "../../../contracts/types/ingest-config.js";
import { isDebug } from "../../../primitives/diagnostics/index.js";
import type { ScannerConfig } from "../../../types.js";
import { globalGitIgnorePath, readGlobalExcludesFileSetting, repoInfoExcludePath } from "./git-excludes.js";
import { BUILTIN_IGNORE_PATTERNS, BUILTIN_IGNORED_DIRECTORY_MARKERS } from "./ignore-defaults.js";
import { pipelineLog } from "./infra/debug-log/index.js";
import { isMigrationPath } from "./migration-files.js";

/**
 * DEBUG scan cadence. A multi-minute `readdir` must show up without a line per
 * file: name the directory on entry when a heartbeat is due, keep naming it
 * while that one `readdir` is still in flight, and record the entry count when
 * a slow read returns.
 */
const SCAN_DEBUG_HEARTBEAT_MS = 3_000;
const SCAN_DEBUG_EVERY_DIRS = 100;
const SCAN_DEBUG_SLOW_READDIR_MS = 1_000;

export class FileScanner {
  private ig: Ignore = ignore();
  private readonly supportedExts: Set<string>;
  /** Root the markers are probed under — set by `loadIgnorePatterns`. */
  private markerRoot: string | undefined;
  private directoryMarkers: readonly IgnoredDirectoryMarker[] = BUILTIN_IGNORED_DIRECTORY_MARKERS;
  /** Repo-relative POSIX directory → whether it holds a full marker set; shared by the walk and `accepts`. */
  private readonly markedDirectoryVerdicts = new Map<string, boolean>();
  /** Wall clock of the current `scanDirectory`, for DEBUG elapsed ms. */
  private scanStartedAt = 0;
  private dirsSeen = 0;
  private dirsSinceLog = 0;
  private lastScanLogAt = 0;

  constructor(private readonly config: ScannerConfig) {
    this.supportedExts = new Set(config.supportedExtensions);
  }

  /**
   * Load ignore patterns from .gitignore, .dockerignore, .npmignore, .contextignore, and .contextignore.local.
   *
   * Recreates the underlying ignore matcher on every call so reloads after
   * an ignore file is removed drop the now-stale patterns. Long-running
   * indexers (MCP server) reuse a single FileScanner across many syncs.
   *
   * Order, lowest precedence first (a later file can re-include with `!`):
   *   1. BUILTIN_IGNORE_PATTERNS (universal framework artefacts, minified
   *      bundles, language caches — see ignore-defaults.ts), then the
   *      patterns of `config.ignoreContributions` (the languages' own).
   *   2. Git's global excludes (`core.excludesfile`, else `~/.config/git/ignore`)
   *      and `$GIT_DIR/info/exclude`. These are not the repo `.gitignore`; a
   *      worktree dir such as `external-worktrees/` is often only listed here.
   *   3. Project ignore files (.gitignore / .dockerignore / .npmignore /
   *      .contextignore / .contextignore.local), in declared order.
   *   4. config.ignorePatterns / config.customIgnorePatterns from bootstrap.
   *
   * Users can re-include any baseline pattern via explicit `!pattern`
   * negation in their own .contextignore — the `ignore` package honors
   * later negations.
   *
   * Directories recognised by their contents — {@link BUILTIN_IGNORED_DIRECTORY_MARKERS}
   * plus every contribution's `markedDirectories` — are probed under
   * `rootPath`, which is never itself pruned. A pattern cannot express them, so
   * a `!pattern` does not re-include them.
   */
  async loadIgnorePatterns(rootPath: string): Promise<void> {
    this.ig = ignore();
    // Baseline patterns always applied first — keep framework build dirs
    // (_nuxt/, .next/, target/), minified bundles (*.min.js), and language
    // caches (__pycache__/, .venv/) out of the index regardless of whether
    // the project ships a .contextignore covering them.
    this.ig.add(BUILTIN_IGNORE_PATTERNS);
    const contributions = this.config.ignoreContributions ?? [];
    for (const contribution of contributions) {
      if (contribution.patterns && contribution.patterns.length > 0) this.ig.add([...contribution.patterns]);
    }
    this.markerRoot = resolve(rootPath);
    this.directoryMarkers = [
      ...BUILTIN_IGNORED_DIRECTORY_MARKERS,
      ...contributions.flatMap((contribution) => contribution.markedDirectories ?? []),
    ];
    this.markedDirectoryVerdicts.clear();
    const globalExcludes = globalGitIgnorePath(process.env, homedir(), readGlobalExcludesFileSetting());
    const infoExclude = await repoInfoExcludePath(rootPath);
    for (const excludePath of [globalExcludes, infoExclude]) {
      if (excludePath) await this.addIgnoreFile(excludePath);
    }
    const ignoreFiles = [".gitignore", ".dockerignore", ".npmignore", ".contextignore", ".contextignore.local"];

    for (const ignoreFile of ignoreFiles) {
      const ignorePath = join(rootPath, ignoreFile);
      if (await this.fileExists(ignorePath)) {
        try {
          const content = await fs.readFile(ignorePath, "utf-8");
          this.ig.add(content);
        } catch (_error) {
          // Silently skip if file can't be read
        }
      }
    }

    // Add default patterns from config
    if (this.config.ignorePatterns && this.config.ignorePatterns.length > 0) {
      this.ig.add(this.config.ignorePatterns);
    }

    // Add custom patterns
    if (this.config.customIgnorePatterns && this.config.customIgnorePatterns.length > 0) {
      this.ig.add(this.config.customIgnorePatterns);
    }
  }

  /**
   * Scan directory recursively and return all code files
   */
  async scanDirectory(rootPath: string): Promise<string[]> {
    const absoluteRoot = resolve(rootPath);
    const files: string[] = [];
    this.scanStartedAt = Date.now();
    this.dirsSeen = 0;
    this.dirsSinceLog = 0;
    this.lastScanLogAt = 0;

    await this.walkDirectory(absoluteRoot, absoluteRoot, files);

    return files;
  }

  /**
   * Check if a file should be ignored based on patterns
   */
  shouldIgnore(filePath: string, rootPath: string): boolean {
    const relativePath = relative(rootPath, filePath);
    return this.ig.ignores(relativePath);
  }

  /**
   * The one ingest admission rule for a repo-relative file path: a supported
   * extension and not ignored. `scanDirectory` admits exactly the files this
   * accepts, and the working-tree overlay asks it about single paths. The
   * `ignore` matcher tests every ancestor as a trailing-slash directory probe
   * (`dir/`) before the file itself, so a pruned directory rejects its files
   * here exactly as `walkDirectory` prunes it. A directory pruned by its
   * contents (a marker set) rejects its files the same way: every ancestor is
   * probed against the markers the walk checks before descending. Call after
   * `loadIgnorePatterns`.
   */
  accepts(relativePath: string): boolean {
    const posixPath = relativePath.split(sep).join("/");
    if (posixPath.length === 0 || isAbsolute(posixPath) || posixPath.split("/").includes("..")) return false;
    return (
      this.supportedExts.has(extname(posixPath)) &&
      !isMigrationPath(posixPath) &&
      !this.ig.ignores(posixPath) &&
      !this.hasMarkedAncestor(posixPath)
    );
  }

  /**
   * Why ingest leaves a repo-relative path out, when it does (bd
   * tea-rags-mcp-d9w4o): `ignoreRule` = the pattern that ignores it or an
   * ancestor directory; no rule when a marker set prunes it or — a file — its
   * extension is not indexed. Undefined when `accepts` takes the file, or
   * nothing prunes the directory. Call after `loadIgnorePatterns`.
   */
  exclusionOf(relativePath: string, isDirectory: boolean): { ignoreRule?: string } | undefined {
    const posixPath = relativePath.split(sep).join("/").replace(/\/+$/, "");
    if (posixPath.length === 0 || isAbsolute(posixPath) || posixPath.split("/").includes("..")) return undefined;
    const verdict = this.ig.test(isDirectory ? `${posixPath}/` : posixPath);
    if (verdict.ignored) return verdict.rule ? { ignoreRule: verdict.rule.pattern } : {};
    if (this.hasMarkedAncestor(isDirectory ? `${posixPath}/.` : posixPath)) return {};
    if (!isDirectory && !this.supportedExts.has(extname(posixPath))) return {};
    return undefined;
  }

  /**
   * Get the configured ignore filter instance.
   * Used by enrichment module to filter git log results.
   */
  getIgnoreFilter(): Ignore {
    return this.ig;
  }

  /**
   * Get list of supported file extensions
   */
  getSupportedExtensions(): string[] {
    return Array.from(this.supportedExts);
  }

  /**
   * Recursively walk directory tree
   */
  private async walkDirectory(currentPath: string, rootPath: string, files: string[]): Promise<void> {
    const entries = await this.readDirectory(currentPath, files);
    if (!entries) return;

    try {
      for (const entry of entries) {
        if (isDebug()) this.maybeLogScanProgress(currentPath, files.length);
        const fullPath = join(currentPath, entry.name);
        const relativePath = relative(rootPath, fullPath);
        const isDirectory = entry.isDirectory();

        // Probe directories with a trailing slash so gitignore directory
        // patterns apply — the `ignore` package only honors directory-scoped
        // patterns (the `!*/` whitelist re-include AND builtin `dir/` rules)
        // when the candidate path is explicitly marked as a directory.
        // Without it, a `*` catch-all matches the bare directory name while
        // `!*/` cannot re-include it, so every dir is pruned at entry and a
        // keep-only whitelist returns zero nested files (kgjzq).
        const ignoreProbe = isDirectory ? `${relativePath}/` : relativePath;
        if (this.ig.ignores(ignoreProbe)) {
          continue;
        }

        // Handle symbolic links safely to avoid infinite loops
        if (entry.isSymbolicLink()) {
          continue;
        }

        if (isDirectory) {
          if (this.isMarkedDirectory(relativePath.split(sep).join("/"))) continue;
          await this.walkDirectory(fullPath, rootPath, files);
        } else if (entry.isFile() && this.accepts(relativePath)) {
          files.push(fullPath);
        }
      }
    } catch (_error) {
      // Skip entries that can't be classified (permission errors, etc.)
    }
  }

  /**
   * Read one directory. Permission errors skip it, matching the previous
   * walk. Under DEBUG, a hung `readdir` logs the path before the call and
   * again every few seconds until it returns; a slow return logs the entry count.
   */
  private async readDirectory(currentPath: string, files: string[]): Promise<Dirent[] | null> {
    if (!isDebug()) {
      try {
        return await fs.readdir(currentPath, { withFileTypes: true });
      } catch {
        return null;
      }
    }
    return this.readDirectoryDebug(currentPath, files);
  }

  private async readDirectoryDebug(currentPath: string, files: string[]): Promise<Dirent[] | null> {
    this.dirsSeen += 1;
    this.dirsSinceLog += 1;
    const started = Date.now();
    const dueByTime = this.lastScanLogAt > 0 && started - this.lastScanLogAt >= SCAN_DEBUG_HEARTBEAT_MS;
    const announce = this.dirsSeen === 1 || this.dirsSinceLog >= SCAN_DEBUG_EVERY_DIRS || dueByTime;
    if (announce) {
      this.logScan("SCAN_READDIR", currentPath, files.length);
    }

    let heartbeats = 0;
    const timer = setInterval(() => {
      heartbeats += 1;
      this.logScan("SCAN_READDIR", currentPath, files.length, { waiting: "readdir" });
    }, SCAN_DEBUG_HEARTBEAT_MS);
    if (typeof timer.unref === "function") timer.unref();

    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      const readdirMs = Date.now() - started;
      if (announce || heartbeats > 0 || readdirMs >= SCAN_DEBUG_SLOW_READDIR_MS) {
        this.logScan("SCAN_READDIR_DONE", currentPath, files.length, {
          entries: entries.length,
          readdirMs,
        });
      }
      return entries;
    } catch {
      return null;
    } finally {
      clearInterval(timer);
    }
  }

  /** Heartbeat while classifying a directory's entries, not once per file. */
  private maybeLogScanProgress(dir: string, filesSeen: number): void {
    const now = Date.now();
    if (this.lastScanLogAt > 0 && now - this.lastScanLogAt < SCAN_DEBUG_HEARTBEAT_MS) return;
    this.logScan("SCAN_PROGRESS", dir, filesSeen);
  }

  private logScan(message: string, dir: string, filesSeen: number, extra?: Record<string, unknown>): void {
    const now = Date.now();
    this.lastScanLogAt = now;
    this.dirsSinceLog = 0;
    pipelineLog.step({ component: "IndexRun" }, message, {
      dir,
      files: filesSeen,
      dirs: this.dirsSeen,
      elapsedMs: now - this.scanStartedAt,
      ...extra,
    });
  }

  private async addIgnoreFile(path: string): Promise<void> {
    if (!(await this.fileExists(path))) return;
    try {
      this.ig.add(await fs.readFile(path, "utf-8"));
    } catch {
      // A missing or unreadable excludes file leaves the other sources in place.
    }
  }

  /** Whether a proper ancestor directory of the repo-relative POSIX `posixPath` is marked. */
  private hasMarkedAncestor(posixPath: string): boolean {
    const segments = posixPath.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      if (this.isMarkedDirectory(segments.slice(0, depth).join("/"))) return true;
    }
    return false;
  }

  /**
   * Whether the repo-relative POSIX directory holds every entry of some marker
   * set. The root (`""`) never is; before `loadIgnorePatterns` nothing is.
   */
  private isMarkedDirectory(relativeDirectory: string): boolean {
    if (this.markerRoot === undefined || relativeDirectory.length === 0) return false;
    let verdict = this.markedDirectoryVerdicts.get(relativeDirectory);
    if (verdict === undefined) {
      const absoluteDir = join(this.markerRoot, relativeDirectory);
      verdict = this.directoryMarkers.some((marker) =>
        marker.entries.every((markerEntry) => existsSync(join(absoluteDir, markerEntry))),
      );
      this.markedDirectoryVerdicts.set(relativeDirectory, verdict);
    }
    return verdict;
  }

  /**
   * Check if a file exists
   */
  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
}
