import { isBuiltin } from "node:module";
import { posix } from "node:path";

import type { FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";

/** What the test-support exclusion takes out, named for a report (bd tea-rags-mcp-89k7k.35.3). */
export const TEST_SUPPORT_REASON =
  "test support: imported only by test files or by other test support, and named after a test importing it, importing a test-only dependency (one tests import and no production file does, or one the manifests declare for development only) or importing other test support";

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

/**
 * One import, by any indexed file, of a dependency the codegraph does not walk
 * (bd tea-rags-mcp-89k7k.35.3): a package, named as written up to its package
 * name (`msw/node` → `msw`, `@scope/pkg/x` → `@scope/pkg`), or an indexed file
 * outside the graph (a test file, a generated one), named by its path.
 */
export interface UnwalkedDependencyImport {
  sourceRelPath: RelPath;
  dependency: string;
  /** Whether the importer is a test file. */
  sourceIsTest: boolean;
}

/** The test-support files and the test-only dependencies they were judged against. */
export interface TestSupportClassification {
  files: ReadonlySet<RelPath>;
  /** What tests import and no production file does (`deriveTestOnlyDependencies`). */
  testOnlyDependencies: ReadonlySet<string>;
}

const RELATIVE_SPECIFIER = /^\.\.?(\/|$)/;

/** Walked file paths keyed by the module stems they answer to — exact, and by every segment-boundary suffix. */
interface ModulePathIndex {
  byExactStem: ReadonlyMap<string, RelPath[]>;
  bySuffixStem: ReadonlyMap<string, RelPath[]>;
}

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
  const index = indexModulePaths(walkedFiles);
  const edges: UnwalkedFileImportEdge[] = [];
  for (const [importer, { isTest, specifiers }] of importsByFile) {
    if (walked.has(importer)) continue;
    const seen = new Set<RelPath>();
    for (const specifier of specifiers) {
      const target = unique(matchSpecifier(importer, specifier, index));
      if (target === undefined || seen.has(target)) continue;
      seen.add(target);
      edges.push({ sourceRelPath: importer, targetRelPath: target, sourceIsTest: isTest });
    }
  }
  return edges;
}

/**
 * Every indexed file's imports of what the codegraph does NOT walk (bd
 * tea-rags-mcp-89k7k.35.3) — the vocabulary the test-only dependency set is
 * derived from. Walked and unwalked importers alike: a specifier naming a
 * walked file (by the same rules as `resolveUnwalkedImportEdges`, ambiguity
 * included) is the graph's and is skipped; one naming exactly one unwalked
 * indexed file yields that path; anything else non-relative is a package,
 * named by `packageNameOf`. A relative or absolute specifier that names no
 * indexed file, or escapes the repo, yields nothing.
 */
export function resolveExternalImports(
  importsByFile: ReadonlyMap<RelPath, IndexedFileImports>,
  walkedFiles: readonly RelPath[],
): UnwalkedDependencyImport[] {
  const walked = new Set(walkedFiles);
  const walkedIndex = indexModulePaths(walkedFiles);
  const unwalkedIndex = indexModulePaths([...importsByFile.keys()].filter((relPath) => !walked.has(relPath)));
  const imports: UnwalkedDependencyImport[] = [];
  for (const [importer, { isTest, specifiers }] of importsByFile) {
    const seen = new Set<string>();
    for (const specifier of specifiers) {
      const dependency = unwalkedDependencyOf(importer, specifier, walkedIndex, unwalkedIndex);
      if (dependency === undefined || seen.has(dependency)) continue;
      seen.add(dependency);
      imports.push({ sourceRelPath: importer, dependency, sourceIsTest: isTest });
    }
  }
  return imports;
}

function unwalkedDependencyOf(
  importer: RelPath,
  specifier: string,
  walkedIndex: ModulePathIndex,
  unwalkedIndex: ModulePathIndex,
): string | undefined {
  if (matchSpecifier(importer, specifier, walkedIndex).length > 0) return undefined;
  const unwalked = matchSpecifier(importer, specifier, unwalkedIndex);
  if (unwalked.length > 0) return unique(unwalked);
  return packageNameOf(specifier);
}

/**
 * The package a non-path specifier names: its first segment, or its first two
 * for a scoped name. A relative, dotted-relative or absolute specifier names
 * no package.
 */
function packageNameOf(specifier: string): string | undefined {
  if (specifier === "" || specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  const segments = specifier.split("/");
  return specifier.startsWith("@") && segments.length > 1 ? `${segments[0]}/${segments[1]}` : segments[0];
}

function indexModulePaths(files: readonly RelPath[]): ModulePathIndex {
  const byExactStem = new Map<string, RelPath[]>();
  const bySuffixStem = new Map<string, RelPath[]>();
  for (const relPath of files) {
    for (const stem of moduleStems(relPath)) {
      push(byExactStem, stem, relPath);
      const segments = stem.split("/");
      for (let i = 0; i < segments.length; i++) push(bySuffixStem, segments.slice(i).join("/"), relPath);
    }
  }
  return { byExactStem, bySuffixStem };
}

/** Every indexed path the specifier may name; empty when it names none or is not a path at all. */
function matchSpecifier(importer: RelPath, specifier: string, index: ModulePathIndex): RelPath[] {
  if (RELATIVE_SPECIFIER.test(specifier)) {
    const joined = posix.normalize(posix.join(posix.dirname(importer), specifier));
    if (joined === ".." || joined.startsWith("../")) return [];
    return distinct(candidateKeys(joined).flatMap((key) => index.byExactStem.get(key) ?? []));
  }
  if (!specifier.includes("/") || specifier.startsWith("/") || specifier.startsWith("@")) return [];
  const normalized = posix.normalize(specifier);
  if (normalized.startsWith("../")) return [];
  return distinct(candidateKeys(normalized).flatMap((key) => index.bySuffixStem.get(key) ?? []));
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

function distinct(candidates: readonly RelPath[]): RelPath[] {
  return [...new Set(candidates)];
}

function unique(candidates: readonly RelPath[]): RelPath | undefined {
  return candidates.length === 1 ? candidates[0] : undefined;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

/**
 * The test-only dependencies (bd tea-rags-mcp-89k7k.35.3): what at least one
 * test file imports and no production file does, plus what a test imports
 * and the manifests declare for development only (`declaredTestDependencies`,
 * whatever production imports). A production importer is any non-test file
 * outside `testSideFiles` — a walked one, or an unwalked one such as a
 * generated client. A Node core module (`node:fs`, bare `fs`) is never
 * test-only: every runtime ships it. Insertion order of the imports is kept.
 */
export function deriveTestOnlyDependencies(
  externalImports: readonly UnwalkedDependencyImport[],
  testSideFiles: ReadonlySet<RelPath>,
  declaredTestDependencies: ReadonlySet<string> = NO_DECLARED_TEST_DEPENDENCIES,
): Set<string> {
  const testImported = new Set<string>();
  const productionImported = new Set<string>();
  for (const { sourceRelPath, dependency, sourceIsTest } of externalImports) {
    if (sourceIsTest) testImported.add(dependency);
    else if (!testSideFiles.has(sourceRelPath)) productionImported.add(dependency);
  }
  return new Set(
    [...testImported].filter(
      (dependency) =>
        !isBuiltin(dependency) && (declaredTestDependencies.has(dependency) || !productionImported.has(dependency)),
    ),
  );
}

const NO_DECLARED_TEST_DEPENDENCIES: ReadonlySet<string> = new Set();

/**
 * Whether `candidate` is named after `test` (bd tea-rags-mcp-89k7k.35.3): its
 * basename without extension extends the test's, as a proper prefix followed
 * by a separator — `X.spec.presets.tsx` after `X.spec.tsx`. A relation between
 * two files, never a name pattern: `worker.ts` is not named after
 * `worker.test.ts`, whose name extends the worker's instead.
 */
function isNamedAfterTest(candidate: RelPath, test: RelPath): boolean {
  const name = stripExtension(posix.basename(candidate));
  const testName = stripExtension(posix.basename(test));
  return (
    testName !== "" &&
    name.length > testName.length &&
    name.startsWith(testName) &&
    SEPARATOR.test(name[testName.length])
  );
}

const SEPARATOR = /[^\p{L}\p{N}]/u;

/**
 * The walked files that exist only to serve tests (bd tea-rags-mcp-89k7k.35.3),
 * whatever they are named. A file is test support when, against the support
 * set S itself:
 *
 * - (a) it has an importer and every importer is a test file or in S;
 * - (g) a test reaches it through members of S (grounding);
 * - (b) it reaches, through imports staying inside S (itself included), a
 *   file that imports a test-only dependency (`deriveTestOnlyDependencies`)
 *   or is named after a test importing it (`isNamedAfterTest`:
 *   `X.spec.presets.tsx` imported by `X.spec.tsx`).
 *
 * The name relation is a root of the same reachability, so a member that
 * imports a companion is evidenced through it, as through any other member;
 * what the companion itself imports is not — evidence never flows down an
 * import, or a companion importing the production file it tests would vouch
 * for it. It also settles one absence: a walked file nothing imports that
 * imports a companion counts as non-production in (a), because its evidence
 * (the name relation) is independent of the test-only set and no entry point
 * loaded by module path imports a test's companion.
 *
 * `declaredTestDependencies` are what the repository's manifests declare for
 * development and tests only; one a test imports is test-only even when a
 * production file imports it too. A Node core module never is.
 *
 * (a) alone rests on ABSENCE of production importers, which a fixture shares
 * with an entry point loaded by module path (a worker), so (b) demands
 * POSITIVE evidence: a support file is tied to something only tests use. (b)
 * is reachability, i.e. the LEAST fixpoint of "imports a test-only dependency
 * or another member", so a cycle of helpers none of which touches a test-only
 * dependency is never its own evidence. S is the GREATEST set satisfying
 * (a), (g) and (b): each only gains members as S grows, so iterating down
 * from every imported file — drop what fails, until nothing is dropped —
 * reaches the one greatest fixpoint whatever the drop order.
 *
 * The test-only set is derived ONCE, before S, against the TEST SIDE: the
 * greatest grounded set closed under (a) alone, plus the walked files nothing
 * imports. A file nothing imports (an unused fixture, a tool config, an entry
 * point) is the very ambiguity (b) exists to settle, so its OWN imports
 * testify for neither side; it still counts as a production importer in (a),
 * so whatever it imports is outside the test side. Fixing the set before S
 * changes no verdict of the descent: a file dropped for lacking evidence
 * imports no test-only dependency, and nothing it imports is evidenced, or it
 * would be evidenced through it — so no drop can move a dependency out.
 * Treating a file nothing imports as neutral in (a) as well was measured and
 * refused: it moves every subtree only an entry point loaded by module path
 * reaches (a worker, a dynamically imported language module) to the test
 * side, and the packages only that subtree imports become test-only.
 *
 * A file with no importer at all always stays production. Importers are the
 * graph's edges plus `unwalkedImportEdges`; an unwalked importer that is not
 * a test (a generated file, say) counts as production.
 */
export function classifyTestSupportFiles(
  graph: FileDependencyGraph,
  unwalkedImportEdges: readonly UnwalkedFileImportEdge[],
  externalImports: readonly UnwalkedDependencyImport[],
  declaredTestDependencies: ReadonlySet<string> = NO_DECLARED_TEST_DEPENDENCIES,
): TestSupportClassification {
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
  const namedAfterTest = new Set<RelPath>();
  for (const { sourceRelPath, targetRelPath, sourceIsTest } of unwalkedImportEdges) {
    if (walked.has(sourceRelPath) || !walked.has(targetRelPath)) continue;
    addTo(importers, targetRelPath, sourceRelPath);
    if (!sourceIsTest) continue;
    testFiles.add(sourceRelPath);
    testReached.add(targetRelPath);
    if (isNamedAfterTest(targetRelPath, sourceRelPath)) namedAfterTest.add(targetRelPath);
  }
  const dependenciesOf = new Map<RelPath, Set<string>>();
  for (const { sourceRelPath, dependency } of externalImports) {
    if (walked.has(sourceRelPath)) addTo(dependenciesOf, sourceRelPath, dependency);
  }

  const unimported = new Set([...walked].filter((relPath) => !importers.has(relPath)));
  // A file nothing imports that imports a companion named after its test is
  // a leftover of that test's support, never production (89k7k.35.3): the
  // evidence is the name relation alone, independent of the test-only set,
  // so no entry point loaded by module path can earn it.
  const testSideOrphans = new Set(
    [...unimported].filter((relPath) => [...(imported.get(relPath) ?? [])].some((t) => namedAfterTest.has(t))),
  );
  const isNonProduction = (relPath: RelPath): boolean => testFiles.has(relPath) || testSideOrphans.has(relPath);
  const closeAndGround = (members: Set<RelPath>, isNonProduction: (relPath: RelPath) => boolean): Set<RelPath> => {
    for (;;) {
      closeOverImporters(members, importers, imported, isNonProduction);
      const grounded = reachableFrom(
        [...testReached].filter((f) => members.has(f)),
        imported,
        members,
      );
      if (grounded.size === members.size) return members;
      for (const relPath of members) if (!grounded.has(relPath)) members.delete(relPath);
    }
  };
  const testSide = closeAndGround(new Set(importers.keys()), isNonProduction);
  const testOnly = deriveTestOnlyDependencies(
    externalImports,
    new Set([...testSide, ...unimported]),
    declaredTestDependencies,
  );

  const support = new Set(importers.keys());
  for (;;) {
    closeAndGround(support, isNonProduction);
    const evidenced = reachableFrom(
      [...support].filter(
        (f) => namedAfterTest.has(f) || [...(dependenciesOf.get(f) ?? [])].some((d) => testOnly.has(d)),
      ),
      importers,
      support,
    );
    if (evidenced.size === support.size) return { files: support, testOnlyDependencies: testOnly };
    for (const relPath of support) if (!evidenced.has(relPath)) support.delete(relPath);
  }
}

/** Drops every member with an importer that is neither non-production nor a member, until none is left. */
function closeOverImporters(
  support: Set<RelPath>,
  importers: ReadonlyMap<RelPath, ReadonlySet<RelPath>>,
  imported: ReadonlyMap<RelPath, ReadonlySet<RelPath>>,
  isNonProduction: (relPath: RelPath) => boolean,
): void {
  const pending = [...support];
  while (pending.length > 0) {
    const relPath = pending.pop();
    if (relPath === undefined || !support.has(relPath)) continue;
    const production = [...(importers.get(relPath) ?? [])].some((i) => !isNonProduction(i) && !support.has(i));
    if (!production) continue;
    support.delete(relPath);
    for (const target of imported.get(relPath) ?? []) if (support.has(target)) pending.push(target);
  }
}

/** The members of `within` reachable from `roots` (themselves included) along `adjacency`. */
function reachableFrom(
  roots: readonly RelPath[],
  adjacency: ReadonlyMap<RelPath, ReadonlySet<RelPath>>,
  within: ReadonlySet<RelPath>,
): Set<RelPath> {
  const reached = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const relPath = pending.pop();
    if (relPath === undefined) continue;
    for (const next of adjacency.get(relPath) ?? []) {
      if (within.has(next) && !reached.has(next)) {
        reached.add(next);
        pending.push(next);
      }
    }
  }
  return reached;
}

function addTo<V>(map: Map<RelPath, Set<V>>, key: RelPath, value: V): void {
  const values = map.get(key);
  if (values) values.add(value);
  else map.set(key, new Set([value]));
}
