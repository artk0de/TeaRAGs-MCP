import { posix } from "node:path";

import type { FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";

/** What the test-support exclusion takes out, named for a report (bd tea-rags-mcp-89k7k.35.3). */
export const TEST_SUPPORT_REASON =
  "test support: imported only by test files or by other test support (presets, builders, spec helpers)";

/** The module specifiers one indexed file declares (`payload.imports`), and whether it is a test file. */
export interface IndexedFileImports {
  isTest: boolean;
  specifiers: readonly string[];
}

/**
 * One import a file the codegraph does NOT walk declares — a test, a generated
 * file, a policy-excluded one — resolved to a walked file.
 */
export interface UnwalkedFileImportEdge {
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  /** Whether the importer is a test file; any other unwalked importer counts as production. */
  sourceIsTest: boolean;
}

const RELATIVE_SPECIFIER = /^\.\.?(\/|$)/;

/**
 * Resolves the module specifiers of every indexed file the codegraph does not
 * walk to walked files (bd tea-rags-mcp-89k7k.35.3). The graph holds no edge
 * out of a test, a generated file or a policy-excluded one, so their imports
 * survive only as payload specifiers; this maps them back without any
 * language's resolver. A WALKED importer is skipped — its edges are the
 * graph's, and the payload is never a second source for them.
 *
 * - a relative specifier is joined to the importer's directory and must name
 *   a walked file's path exactly, its extension (or a `/index` file) aside;
 * - a non-relative specifier with a `/` (a path alias such as
 *   `react-app/modules/x/Y`) must name exactly ONE walked file by path suffix
 *   on a segment boundary — an ambiguous suffix resolves to nothing;
 * - a bare name (`react`), a scoped package (`@scope/pkg`) and a specifier
 *   escaping the repo root resolve to nothing.
 *
 * An unresolved TEST import is the conservative direction (its target can
 * only stay production); an unresolved non-test import is not, and is the
 * classification's known blind spot.
 */
export function resolveUnwalkedImportEdges(
  importsByFile: ReadonlyMap<RelPath, IndexedFileImports>,
  walkedFiles: readonly RelPath[],
): UnwalkedFileImportEdge[] {
  const walked = new Set(walkedFiles);
  const byExactStem = new Map<string, RelPath[]>();
  const bySuffixStem = new Map<string, RelPath[]>();
  for (const relPath of walkedFiles) {
    for (const stem of moduleStems(relPath)) {
      push(byExactStem, stem, relPath);
      const segments = stem.split("/");
      for (let i = 0; i < segments.length; i++) push(bySuffixStem, segments.slice(i).join("/"), relPath);
    }
  }
  const edges: UnwalkedFileImportEdge[] = [];
  for (const [importer, { isTest, specifiers }] of importsByFile) {
    if (walked.has(importer)) continue;
    const seen = new Set<RelPath>();
    for (const specifier of specifiers) {
      const target = resolveSpecifier(importer, specifier, byExactStem, bySuffixStem);
      if (target === undefined || seen.has(target)) continue;
      seen.add(target);
      edges.push({ sourceRelPath: importer, targetRelPath: target, sourceIsTest: isTest });
    }
  }
  return edges;
}

function resolveSpecifier(
  importer: RelPath,
  specifier: string,
  byExactStem: ReadonlyMap<string, RelPath[]>,
  bySuffixStem: ReadonlyMap<string, RelPath[]>,
): RelPath | undefined {
  if (RELATIVE_SPECIFIER.test(specifier)) {
    const joined = posix.normalize(posix.join(posix.dirname(importer), specifier));
    if (joined === ".." || joined.startsWith("../")) return undefined;
    return unique(candidateKeys(joined).flatMap((key) => byExactStem.get(key) ?? []));
  }
  if (!specifier.includes("/") || specifier.startsWith("/") || specifier.startsWith("@")) return undefined;
  const normalized = posix.normalize(specifier);
  if (normalized.startsWith("../")) return undefined;
  return unique(candidateKeys(normalized).flatMap((key) => bySuffixStem.get(key) ?? []));
}

/** The keys a specifier may name a file by: as written, without its own extension (`./a.js` names `a.ts`). */
function candidateKeys(path: string): string[] {
  const withoutExtension = stripExtension(path);
  return withoutExtension === path ? [path] : [path, withoutExtension];
}

/** The stems a file answers to: its path without extension, and its directory when it is an `index` file. */
function moduleStems(relPath: RelPath): string[] {
  const stem = stripExtension(relPath);
  const stems = [stem];
  if (posix.basename(stem) === "index" && stem.includes("/")) stems.push(posix.dirname(stem));
  return stems;
}

function stripExtension(path: string): string {
  const extension = posix.extname(path);
  return extension === "" ? path : path.slice(0, -extension.length);
}

function unique(candidates: readonly RelPath[]): RelPath | undefined {
  const distinct = new Set(candidates);
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

/**
 * The walked files that exist only to serve tests (bd tea-rags-mcp-89k7k.35.3):
 * a file is test support when it has at least one importer and every importer
 * is a test file or test support — whatever the file is named. Importers are
 * the graph's edges plus `unwalkedImportEdges`; an unwalked importer that is
 * not a test (a generated file, say) counts as production.
 *
 * Computed as the greatest set closed under that rule (start from every file
 * with an importer, drop any file with a production importer until stable), so
 * a helper chain and a cycle of helpers both qualify; then GROUNDED: a member
 * no test reaches through other members is dropped and the closure re-run,
 * because importers alone cannot tell a cycle of helpers from a cycle of
 * production modules nothing imports (`main` ↔ `app`). A file with no
 * importer at all — an entry point — always stays production.
 */
export function classifyTestSupportFiles(
  graph: FileDependencyGraph,
  unwalkedImportEdges: readonly UnwalkedFileImportEdge[],
): ReadonlySet<RelPath> {
  const walked = new Set(graph.files.map((f) => f.relPath));
  const importers = new Map<RelPath, Set<RelPath>>();
  const imported = new Map<RelPath, Set<RelPath>>();
  for (const { sourceRelPath, targetRelPath } of graph.edges) {
    if (sourceRelPath === targetRelPath || !walked.has(targetRelPath)) continue;
    addTo(importers, targetRelPath, sourceRelPath);
    addTo(imported, sourceRelPath, targetRelPath);
  }
  const testFiles = new Set<RelPath>();
  const testReached = new Set<RelPath>();
  for (const { sourceRelPath, targetRelPath, sourceIsTest } of unwalkedImportEdges) {
    if (walked.has(sourceRelPath) || !walked.has(targetRelPath)) continue;
    addTo(importers, targetRelPath, sourceRelPath);
    if (!sourceIsTest) continue;
    testFiles.add(sourceRelPath);
    testReached.add(targetRelPath);
  }

  const support = new Set([...importers.keys()]);
  for (;;) {
    closeOverImporters(support, importers, imported, testFiles);
    const grounded = reachableFrom(
      [...testReached].filter((f) => support.has(f)),
      imported,
      support,
    );
    if (grounded.size === support.size) return support;
    for (const relPath of support) if (!grounded.has(relPath)) support.delete(relPath);
  }
}

/** Drops every member with an importer that is neither a test file nor a member, until none is left. */
function closeOverImporters(
  support: Set<RelPath>,
  importers: ReadonlyMap<RelPath, ReadonlySet<RelPath>>,
  imported: ReadonlyMap<RelPath, ReadonlySet<RelPath>>,
  testFiles: ReadonlySet<RelPath>,
): void {
  const pending = [...support];
  while (pending.length > 0) {
    const relPath = pending.pop();
    if (relPath === undefined || !support.has(relPath)) continue;
    const production = [...(importers.get(relPath) ?? [])].some((i) => !testFiles.has(i) && !support.has(i));
    if (!production) continue;
    support.delete(relPath);
    for (const target of imported.get(relPath) ?? []) if (support.has(target)) pending.push(target);
  }
}

function reachableFrom(
  roots: readonly RelPath[],
  imported: ReadonlyMap<RelPath, ReadonlySet<RelPath>>,
  within: ReadonlySet<RelPath>,
): Set<RelPath> {
  const reached = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const relPath = pending.pop();
    if (relPath === undefined) continue;
    for (const target of imported.get(relPath) ?? []) {
      if (within.has(target) && !reached.has(target)) {
        reached.add(target);
        pending.push(target);
      }
    }
  }
  return reached;
}

function addTo(map: Map<RelPath, Set<RelPath>>, key: RelPath, value: RelPath): void {
  const values = map.get(key);
  if (values) values.add(value);
  else map.set(key, new Set([value]));
}
