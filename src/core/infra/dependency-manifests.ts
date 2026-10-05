/**
 * The run-start dependency-manifest walk (bd tea-rags-mcp-w205u.1).
 *
 * Ruby's gate reads ONE file at a known place (`rootOnly`, the root `Gemfile`).
 * Python's does not exist at a known place: polar
 * declares its dependencies in `server/pyproject.toml`, ugnest in a root
 * `pyproject.toml` plus two `requirements*.txt`, netbox in `requirements.txt`
 * while its `pyproject.toml` marks them dynamic. The answer is therefore a
 * recursive walk and a UNION, and it lives here rather than in either consumer
 * because both need it and neither may import the other: the codegraph run state
 * reads it once per run, and the chunker worker — a second composition root that
 * runs the same walker on its own parse — reads it once per worker.
 *
 * The split of duty mirrors `schemaColumnAccessors`: `domains/language` says
 * which files are manifests and what a manifest declares, infra does the I/O.
 *
 * The ignore list is the difference between a gate and a rubber stamp. A
 * checked-in virtualenv or `site-packages` tree holds a manifest for every
 * transitively installed distribution, so walking into one would declare the
 * whole resolved world and activate every vocabulary — precisely the failure
 * that makes Ruby prefer the Gemfile over Gemfile.lock.
 *
 * At a git work tree's top the declared-dependency read lists the tree with
 * `git ls-files` (tracked plus untracked-unignored) instead of walking every
 * directory — once per call, shared by every language — and applies the walk's
 * own bounds (ignored directories, depth cap) to the listed paths. A manifest
 * the tree ignores is then no declaration of the project's, the same reason the
 * vendored trees are skipped. Any other root, or a failed listing, walks.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  DeclaredDependenciesByLanguage,
  DependencyManifestSource,
  LanguageFactoryDescriptor,
} from "../contracts/types/language.js";
import { buildGitChildProcessEnv, resolveGitExecutable } from "./git-executable.js";

/**
 * Directories the walk never descends into. Vendored dependency trees
 * (`.venv`, `venv`, `site-packages`, `node_modules`), build output (`build`,
 * `dist`) and git's own store — none of them hold a manifest that says anything
 * about what the PROJECT declares.
 *
 * A directory only ONE consumer must skip is that consumer's to name
 * ({@link readManifestFiles}' `extraIgnoredDirs`), never an entry here: this
 * set is shared by every language's walk, so growing it moves a language's
 * output with no version axis of that language moving (bd tea-rags-mcp-e6xx —
 * Go's `vendor/` briefly lived here and changed Python's walk).
 */
export const DEPENDENCY_MANIFEST_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".venv",
  "venv",
  "node_modules",
  "build",
  "dist",
  "site-packages",
]);

const NO_EXTRA_IGNORED_DIRS: ReadonlySet<string> = new Set();

/**
 * How far below the root the walk descends, root itself being depth 0.
 *
 * A project declares its dependencies near its own root: measured across the
 * five python corpora the deepest real manifest is at depth 2 (polar's
 * `sdk/generator/pyproject.toml`, flask's `examples/tutorial/pyproject.toml`),
 * so 4 clears every one of them with room to spare.
 *
 * The cap is not a tuning knob, it is a SAFETY bound. `buildFileSignals` takes
 * the root as an argument and a caller may hand it `/` — the provider's own test
 * suite does — and an unbounded recursion from there walks the whole disk and
 * never returns. A bound makes the worst case finite whatever it is handed.
 */
const MAX_MANIFEST_WALK_DEPTH = 4;

/**
 * Every registered language's dependency-manifest reader, keyed by language.
 * Same aggregation shape as `collectSchemaColumnSources`, and for the same
 * reason: the engine must know THAT a language declares dependencies somewhere,
 * never which file or which format. Omitting the factory (tests, fixtures)
 * yields no sources, so every language keeps every vocabulary active.
 */
export function collectDependencyManifestSources(
  languageFactory?: LanguageFactoryDescriptor,
): ReadonlyMap<string, DependencyManifestSource> {
  const sources = new Map<string, DependencyManifestSource>();
  if (!languageFactory) return sources;
  for (const lang of languageFactory.supported()) {
    const source = languageFactory.create(lang).dependencyManifest;
    if (source !== undefined) sources.set(lang, source);
  }
  return sources;
}

/**
 * Each language's declared dependencies, read from that language's OWN
 * manifests only (bd tea-rags-mcp-m99j1.1.8). Kept apart rather than unioned:
 * Ruby gates on its root `Gemfile` alone, Python on every manifest the walk
 * finds, and a union would let one language's manifest turn the other's "no
 * manifest → every vocabulary" answer into a gate. A language with no manifest
 * gets no key.
 */
export function readDeclaredDependenciesByLanguage(
  root: string,
  sources: ReadonlyMap<string, DependencyManifestSource>,
): DeclaredDependenciesByLanguage {
  const byLanguage = new Map<string, ReadonlySet<string>>();
  const listing = workTreeListingOnce(root);
  for (const [language, source] of sources) {
    const declared = readDeclaredDependenciesListed(root, [source], listing);
    if (declared !== undefined) byLanguage.set(language, declared);
  }
  return byLanguage;
}

/**
 * The union of every dependency declared by every manifest under `root`, or
 * `undefined` when the walk found no manifest at all.
 *
 * The two answers are NOT interchangeable. `undefined` is absence of evidence and
 * leaves every framework vocabulary active — a fixture directory, a spike corpus
 * or an un-packaged script must keep the typing it has. An empty set is a project
 * that declares nothing, which gates every conditional vocabulary off.
 *
 * A `rootOnly` source is read from the root directory alone and counts only
 * when its file reads. Total: an unreadable directory or file is skipped, never
 * thrown. The result is frozen because it is run-global data handed to every
 * call context.
 */
export function readDeclaredDependencies(
  root: string,
  sources: readonly DependencyManifestSource[],
): ReadonlySet<string> | undefined {
  return readDeclaredDependenciesListed(root, sources, workTreeListingOnce(root));
}

/** {@link readDeclaredDependencies} over a work-tree listing its caller may share between reads. */
function readDeclaredDependenciesListed(
  root: string,
  sources: readonly DependencyManifestSource[],
  listing: WorkTreeListing,
): ReadonlySet<string> | undefined {
  if (sources.length === 0) return undefined;
  const declared = new Set<string>();
  let found = false;

  const rootOnly = sources.filter((s) => s.rootOnly === true);
  const walked = sources.filter((s) => s.rootOnly !== true);
  for (const fileName of rootOnly.length > 0 ? readRootFileNames(root) : []) {
    const source = rootOnly.find((s) => s.matchesManifestFile(fileName));
    if (source === undefined) continue;
    let content: string;
    try {
      content = readFileSync(join(root, fileName), "utf8");
    } catch {
      continue;
    }
    found = true;
    for (const name of source.parseDeclaredDependencies(fileName, content)) declared.add(name);
  }
  const selfPackages: string[] = [];
  if (walked.length > 0) {
    const declaresSelf = (s: DependencyManifestSource, fileName: string): boolean =>
      s.matchesSelfPackageFile?.(fileName) === true;
    walkManifestFiles(
      root,
      (fileName) => walked.some((s) => s.matchesManifestFile(fileName) || declaresSelf(s, fileName)),
      (dir, _relDir, fileName) => {
        const source = walked.find((s) => s.matchesManifestFile(fileName));
        const selfSource = walked.find((s) => declaresSelf(s, fileName));
        if (source !== undefined) found = true;
        let content: string;
        try {
          content = readFileSync(join(dir, fileName), "utf8");
        } catch {
          return;
        }
        if (source !== undefined) {
          for (const name of source.parseDeclaredDependencies(fileName, content)) declared.add(name);
        }
        const self = selfSource?.parseSelfPackageName?.(fileName, content);
        if (self !== undefined) selfPackages.push(self);
      },
      NO_EXTRA_IGNORED_DIRS,
      listing(),
    );
  }
  // The self-package rule (bd tea-rags-mcp-m99j1.1.21): a project activates its
  // OWN vocabulary — joining a found set, never creating one.
  if (found) for (const name of selfPackages) declared.add(name);
  return found ? Object.freeze(declared) : undefined;
}

/** Non-directory entry names at `root` (symlinks included — the read follows them). */
function readRootFileNames(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** One manifest file the walk found: where it sits, and what it says. */
export interface ManifestFile {
  /** Repo-relative directory holding the file, `/`-separated; `""` is the root. */
  readonly relDir: string;
  readonly fileName: string;
  readonly content: string;
}

/**
 * Every file under `root` that `matchesManifestFile` accepts, with its location
 * — the same walk, bounds and ignore list as {@link readDeclaredDependencies}.
 *
 * For a manifest whose meaning depends on WHERE it sits rather than on a union
 * of names (bd tea-rags-mcp-e6xx): a Go `go.mod` declares the module path of
 * its own directory tree, and a multi-module repository has one per nested
 * module. `extraIgnoredDirs` are directory names THIS caller also skips, on
 * top of the shared set — Go's module map names `vendor/`, where `go mod
 * vendor` leaves dependencies' go.mod files. Total: an unreadable directory or
 * file is skipped, never thrown.
 */
export function readManifestFiles(
  root: string,
  matchesManifestFile: (fileName: string) => boolean,
  extraIgnoredDirs: ReadonlySet<string> = NO_EXTRA_IGNORED_DIRS,
): ManifestFile[] {
  const found: ManifestFile[] = [];
  walkManifestFiles(
    root,
    matchesManifestFile,
    (dir, relDir, fileName) => {
      try {
        found.push({ relDir, fileName, content: readFileSync(join(dir, fileName), "utf8") });
      } catch {
        // unreadable: skipped, like every other failure of the walk
      }
    },
    extraIgnoredDirs,
  );
  return found;
}

/**
 * A root's work-tree file list, read at most once and only when first asked:
 * root-relative `/`-separated paths, or `undefined` when the root is no git
 * work tree's top or git cannot list it — the caller then walks.
 */
type WorkTreeListing = () => readonly string[] | undefined;

const WORK_TREE_LISTING_TIMEOUT_MS = 30_000;
const WORK_TREE_LISTING_MAX_BUFFER = 512 * 1024 * 1024;

function workTreeListingOnce(root: string): WorkTreeListing {
  let listed: { paths: readonly string[] | undefined } | undefined;
  return () => (listed ??= { paths: listWorkTreeFiles(root) }).paths;
}

/**
 * Tracked plus untracked-unignored files under `root`, when `root` is a git
 * work tree's top (it holds `.git` — a repository, a linked worktree or a
 * submodule). A root below the top is walked instead: the tree may ignore the
 * root itself (a scratch corpus), and its manifests are still its own.
 */
function listWorkTreeFiles(root: string): readonly string[] | undefined {
  if (!existsSync(join(root, ".git"))) return undefined;
  try {
    const out = execFileSync(
      resolveGitExecutable(),
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        encoding: "utf8",
        env: buildGitChildProcessEnv(),
        timeout: WORK_TREE_LISTING_TIMEOUT_MS,
        maxBuffer: WORK_TREE_LISTING_MAX_BUFFER,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    // An unmerged path is listed once per stage.
    return [...new Set(out.split("\0").filter((path) => path.length > 0))];
  } catch {
    return undefined;
  }
}

/**
 * The listed files the walk would reach and `matchesManifestFile` accepts —
 * the walk's bounds applied to each path: no directory segment in the ignore
 * sets, no deeper than {@link MAX_MANIFEST_WALK_DEPTH}, and a regular file on
 * disk now (the walk follows no symlink; a tracked file may be deleted).
 */
function visitListedManifests(
  root: string,
  paths: readonly string[],
  matchesManifestFile: (fileName: string) => boolean,
  onManifest: (dir: string, relDir: string, fileName: string) => void,
  extraIgnoredDirs: ReadonlySet<string>,
): void {
  for (const path of paths) {
    const segments = path.split("/");
    const fileName = segments.pop() ?? "";
    if (segments.length > MAX_MANIFEST_WALK_DEPTH || !matchesManifestFile(fileName)) continue;
    if (segments.some((dir) => DEPENDENCY_MANIFEST_IGNORED_DIRS.has(dir) || extraIgnoredDirs.has(dir))) continue;
    const dir = join(root, ...segments);
    try {
      if (!lstatSync(join(dir, fileName)).isFile()) continue;
    } catch {
      continue;
    }
    onManifest(dir, segments.join("/"), fileName);
  }
}

/**
 * The bounded, ignore-aware directory walk both readers share; given a
 * work-tree listing, the same bounds over the listed paths instead.
 */
function walkManifestFiles(
  root: string,
  matchesManifestFile: (fileName: string) => boolean,
  onManifest: (dir: string, relDir: string, fileName: string) => void,
  extraIgnoredDirs: ReadonlySet<string> = NO_EXTRA_IGNORED_DIRS,
  listed?: readonly string[],
): void {
  if (listed !== undefined) {
    visitListedManifests(root, listed, matchesManifestFile, onManifest, extraIgnoredDirs);
    return;
  }
  const visit = (dir: string, relDir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth >= MAX_MANIFEST_WALK_DEPTH) continue;
        if (DEPENDENCY_MANIFEST_IGNORED_DIRS.has(entry.name) || extraIgnoredDirs.has(entry.name)) continue;
        visit(join(dir, entry.name), relDir === "" ? entry.name : `${relDir}/${entry.name}`, depth + 1);
        continue;
      }
      if (!entry.isFile() || !matchesManifestFile(entry.name)) continue;
      onManifest(dir, relDir, entry.name);
    }
  };
  visit(root, "", 0);
}
