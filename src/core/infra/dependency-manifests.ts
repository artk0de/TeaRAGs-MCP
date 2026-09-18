/**
 * The run-start dependency-manifest walk (bd tea-rags-mcp-w205u.1).
 *
 * Ruby's gate reads ONE file at a known place, so the codegraph run state reads
 * it inline (`loadGemfile`). Python's does not exist at a known place: polar
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
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DependencyManifestSource, LanguageFactoryDescriptor } from "../contracts/types/language.js";

/**
 * Directories the walk never descends into. Vendored dependency trees
 * (`.venv`, `venv`, `site-packages`, `node_modules`), build output (`build`,
 * `dist`) and git's own store — none of them hold a manifest that says anything
 * about what the PROJECT declares.
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
 * Every registered language's dependency-manifest reader. Same aggregation shape
 * as `collectSchemaColumnSources`, and for the same reason: the engine must know
 * THAT a language declares dependencies somewhere, never which file or which
 * format. Omitting the factory (tests, fixtures) yields no sources, so the walk
 * answers `undefined` and every vocabulary stays active.
 */
export function collectDependencyManifestSources(
  languageFactory?: LanguageFactoryDescriptor,
): readonly DependencyManifestSource[] {
  if (!languageFactory) return [];
  const sources: DependencyManifestSource[] = [];
  for (const lang of languageFactory.supported()) {
    const source = languageFactory.create(lang).dependencyManifest;
    if (source !== undefined) sources.push(source);
  }
  return sources;
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
 * Total: an unreadable directory or file is skipped, never thrown. The result is
 * frozen because it is run-global data handed to every call context.
 */
export function readDeclaredDependencies(
  root: string,
  sources: readonly DependencyManifestSource[],
): ReadonlySet<string> | undefined {
  if (sources.length === 0) return undefined;
  const declared = new Set<string>();
  let found = false;

  walkManifestFiles(
    root,
    (fileName) => sources.some((s) => s.matchesManifestFile(fileName)),
    (dir, _relDir, fileName) => {
      const source = sources.find((s) => s.matchesManifestFile(fileName));
      if (source === undefined) return;
      found = true;
      let content: string;
      try {
        content = readFileSync(join(dir, fileName), "utf8");
      } catch {
        return;
      }
      for (const name of source.parseDeclaredDependencies(fileName, content)) declared.add(name);
    },
  );
  return found ? Object.freeze(declared) : undefined;
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
 * module. Total: an unreadable directory or file is skipped, never thrown.
 */
export function readManifestFiles(root: string, matchesManifestFile: (fileName: string) => boolean): ManifestFile[] {
  const found: ManifestFile[] = [];
  walkManifestFiles(root, matchesManifestFile, (dir, relDir, fileName) => {
    try {
      found.push({ relDir, fileName, content: readFileSync(join(dir, fileName), "utf8") });
    } catch {
      // unreadable: skipped, like every other failure of the walk
    }
  });
  return found;
}

/** The bounded, ignore-aware directory walk both readers share. */
function walkManifestFiles(
  root: string,
  matchesManifestFile: (fileName: string) => boolean,
  onManifest: (dir: string, relDir: string, fileName: string) => void,
): void {
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
        if (DEPENDENCY_MANIFEST_IGNORED_DIRS.has(entry.name)) continue;
        visit(join(dir, entry.name), relDir === "" ? entry.name : `${relDir}/${entry.name}`, depth + 1);
        continue;
      }
      if (!entry.isFile() || !matchesManifestFile(entry.name)) continue;
      onManifest(dir, relDir, entry.name);
    }
  };
  visit(root, "", 0);
}
