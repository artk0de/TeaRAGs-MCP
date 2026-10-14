import { isBuiltin } from "node:module";
import { posix } from "node:path";

import type { FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";

/** What the test-support exclusion takes out, named for a report (bd tea-rags-mcp-89k7k.35.3). */
export const TEST_SUPPORT_REASON =
  "test support: imported only by test files or by other test support, and named after a test importing it, importing a test-only dependency (one tests import and no production file does, or one the manifests declare for development only), importing other test support, or sitting in a directory that holds a test and nothing but tests and test support; also a file nothing imports that imports a dependency the manifests declare for development only (a story, a bundler config), or a file of a directory such a file or what only it reaches names by a path literal after its own name (a separate build's tree), with what only it reaches";

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
  /**
   * Walked files nothing imports that import a dependency the manifests
   * declare for development only (bd tea-rags-mcp-r8hme.52.14) — a story, a
   * bundler config. Members of `files`, as is what only they reach.
   */
  developmentRoots: ReadonlySet<RelPath>;
}

/**
 * A walked file's source text in the addressed tree (bd
 * tea-rags-mcp-r8hme.52.19); `undefined` when it cannot be read.
 */
export type TreeFileTextLookup = (relPath: RelPath) => string | undefined;

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

const NO_INDEXED_FILES: ReadonlyMap<RelPath, Pick<IndexedFileImports, "isTest">> = new Map();

/** The other files of each file's directory, over the given file set (duplicates collapse). */
function indexSiblingsByDirectory(files: readonly RelPath[]): (relPath: RelPath) => RelPath[] {
  const byDirectory = new Map<string, Set<RelPath>>();
  for (const relPath of files) addTo(byDirectory, posix.dirname(relPath), relPath);
  return (relPath) => [...(byDirectory.get(posix.dirname(relPath)) ?? [])].filter((s) => s !== relPath);
}

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
 *   file that imports a test-only dependency (`deriveTestOnlyDependencies`),
 *   is named after a test importing it (`isNamedAfterTest`:
 *   `X.spec.presets.tsx` imported by `X.spec.tsx`), or sits in a test
 *   directory (bd tea-rags-mcp-r8hme.52.14: `specs/mocks.ts` beside its
 *   spec): its directory holds a test, every other file there is a test or
 *   in S, and no test importing it is named after it — a file a test is
 *   named after is the code under test, whatever its directory. Siblings are
 *   read over the INDEX's file set: the walked files, the test importers,
 *   and every file `indexedFiles` lists (the indexed files declaring
 *   imports; an unwalked one that is not a test, a generated file say, is a
 *   production sibling). A file declaring no imports and walked by nothing
 *   (a JSON fixture) is not a sibling.
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
 * A file with no importer at all stays production unless it imports a
 * dependency the manifests declare for development only, value or type
 * import alike (bd tea-rags-mcp-r8hme.52.14: a story, a bundler config): then
 * it is a non-production root (`developmentRoots`), and every imported file
 * whose importers are all non-production, support or such a root's followers,
 * grounded in a root, follows it — the (a) closure with the root standing in
 * for the test, and its manifest evidence for (b). Importers are the
 * graph's edges plus `unwalkedImportEdges`; an unwalked importer that is not
 * a test (a generated file, say) counts as production.
 *
 * With `readTreeFileText`, a root or follower also names development roots by
 * a path literal (bd tea-rags-mcp-r8hme.52.19): a directory of walked files
 * whose basename is a segment of the holder's own name
 * (`indexNameRelatedDirectories` — a separate build's config naming its
 * tree) contributes every file under it that nothing outside it but a test
 * imports. A file production imports from outside stays production, and so,
 * through the closure, does what it reaches.
 */
export function classifyTestSupportFiles(
  graph: FileDependencyGraph,
  unwalkedImportEdges: readonly UnwalkedFileImportEdge[],
  externalImports: readonly UnwalkedDependencyImport[],
  declaredTestDependencies: ReadonlySet<string> = NO_DECLARED_TEST_DEPENDENCIES,
  indexedFiles: ReadonlyMap<RelPath, Pick<IndexedFileImports, "isTest">> = NO_INDEXED_FILES,
  readTreeFileText?: TreeFileTextLookup,
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
  // A file nothing imports that imports a dependency the manifests declare
  // for development only (a story, a bundler config) is a non-production
  // root (r8hme.52.14): the manifest, not the test-only set, is its evidence,
  // so no entry point loaded by module path earns it unless it imports
  // tooling no runtime ships.
  const developmentRoots = new Set(
    [...unimported].filter((relPath) =>
      [...(dependenciesOf.get(relPath) ?? [])].some((d) => declaredTestDependencies.has(d)),
    ),
  );
  const isNonProduction = (relPath: RelPath): boolean =>
    testFiles.has(relPath) || testSideOrphans.has(relPath) || developmentRoots.has(relPath);
  const closeAndGround = (
    members: Set<RelPath>,
    isNonProduction: (relPath: RelPath) => boolean,
    groundedBy: ReadonlySet<RelPath> = testReached,
  ): Set<RelPath> => {
    for (;;) {
      closeOverImporters(members, importers, imported, isNonProduction);
      const grounded = reachableFrom(
        [...groundedBy].filter((f) => members.has(f)),
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

  const isTestFile = (relPath: RelPath): boolean =>
    testFiles.has(relPath) || indexedFiles.get(relPath)?.isTest === true;
  const siblingsOf = indexSiblingsByDirectory([...walked, ...testFiles, ...indexedFiles.keys()]);
  // A file in a directory of tests and test support (r8hme.52.14 b) is
  // evidenced by the directory itself — unless a test importing it is named
  // after it, which makes it the code under test (89k7k.35.3 guard).
  const inTestDirectory = (relPath: RelPath, members: ReadonlySet<RelPath>): boolean => {
    const siblings = siblingsOf(relPath);
    return (
      siblings.some(isTestFile) &&
      siblings.every((s) => isTestFile(s) || members.has(s)) &&
      ![...(importers.get(relPath) ?? [])].some((i) => testFiles.has(i) && isNamedAfterTest(i, relPath))
    );
  };

  const support = new Set(importers.keys());
  for (;;) {
    closeAndGround(support, isNonProduction);
    const evidenced = reachableFrom(
      [...support].filter(
        (f) =>
          namedAfterTest.has(f) ||
          [...(dependenciesOf.get(f) ?? [])].some((d) => testOnly.has(d)) ||
          inTestDirectory(f, support),
      ),
      importers,
      support,
    );
    if (evidenced.size === support.size) break;
    for (const relPath of support) if (!evidenced.has(relPath)) support.delete(relPath);
  }

  // What only the development roots (with tests and support) reach follows
  // them through (a); their manifest evidence stands in for (b).
  const developmentFollowers = (): Set<RelPath> =>
    closeAndGround(
      new Set([...importers.keys()].filter((relPath) => !support.has(relPath) && !developmentRoots.has(relPath))),
      (relPath) => isNonProduction(relPath) || support.has(relPath),
      new Set([...developmentRoots].flatMap((root) => [...(imported.get(root) ?? [])])),
    );
  let followers = developmentFollowers();
  // A directory a root or follower names by a path literal related to its own
  // name (r8hme.52.19: vite.prototypes.config.ts → 'app/x/prototypes') is a
  // separate build's tree: its entries become roots, and the closure above
  // carries what only they reach. A root gained here may hold literals too.
  if (readTreeFileText !== undefined) {
    const namedDirectories = indexNameRelatedDirectories(walked, readTreeFileText, dependenciesOf);
    for (;;) {
      const fresh = [...developmentRoots, ...followers]
        .flatMap((holder) => namedDirectories.entriesNamedBy(holder, importers, isTestFile))
        .filter((relPath) => !developmentRoots.has(relPath) && !support.has(relPath));
      if (fresh.length === 0) break;
      for (const relPath of fresh) developmentRoots.add(relPath);
      followers = developmentFollowers();
    }
  }
  return {
    files: new Set([...support, ...developmentRoots, ...followers]),
    testOnlyDependencies: testOnly,
    developmentRoots,
  };
}

/** The directories holding walked files, and which of them a holder's path literals name after the holder. */
interface NameRelatedDirectoryIndex {
  /**
   * The walked files under each directory `holder` names (r8hme.52.19) that
   * nothing outside the directory imports but tests.
   */
  entriesNamedBy: (
    holder: RelPath,
    importers: ReadonlyMap<RelPath, ReadonlySet<RelPath>>,
    isTestFile: (relPath: RelPath) => boolean,
  ) => RelPath[];
}

/**
 * Indexes every directory holding a walked file (bd tea-rags-mcp-r8hme.52.19).
 * A holder names a directory when one of its path string literals — alone, or
 * a comma-separated run joined as `path.join` / `resolve(__dirname, …)`
 * would — resolves, against the holder's directory or the repo root, to such
 * a directory whose basename is a segment of the holder's own name split on
 * `.`, `-`, `_` (`vite.prototypes.config.ts` → vite, prototypes, config). The
 * name relation is what separates a separate build's tree from a tool's
 * scope: `vitest.config.ts` naming `app/javascript` names no part of itself.
 * A holder no directory basename matches is never read. A literal naming a
 * package or unwalked file the holder imports is a module specifier, not a
 * path (`'vite'` in `vite.config.ts` beside a repo's `vite/` directory).
 */
function indexNameRelatedDirectories(
  walked: ReadonlySet<RelPath>,
  readTreeFileText: TreeFileTextLookup,
  dependenciesOf: ReadonlyMap<RelPath, ReadonlySet<string>>,
): NameRelatedDirectoryIndex {
  const directories = new Set<string>();
  const directoryBasenames = new Set<string>();
  for (const relPath of walked) {
    for (let dir = posix.dirname(relPath); dir !== "." && !directories.has(dir); dir = posix.dirname(dir)) {
      directories.add(dir);
      directoryBasenames.add(posix.basename(dir));
    }
  }
  const namedBy = new Map<RelPath, string[]>();
  const directoriesNamedBy = (holder: RelPath): string[] => {
    const cached = namedBy.get(holder);
    if (cached !== undefined) return cached;
    const segments = new Set(stripExtension(posix.basename(holder)).split(NAME_SEGMENT_SEPARATOR));
    const named: string[] = [];
    if ([...segments].some((segment) => directoryBasenames.has(segment))) {
      const imports = dependenciesOf.get(holder);
      for (const literal of pathLiteralsOf(readTreeFileText(holder) ?? "")) {
        if (imports?.has(literal)) continue;
        for (const candidate of [posix.join(posix.dirname(holder), literal), literal]) {
          const dir = posix.normalize(candidate).replace(/\/+$/, "");
          if (directories.has(dir) && segments.has(posix.basename(dir)) && !named.includes(dir)) named.push(dir);
        }
      }
    }
    namedBy.set(holder, named);
    return named;
  };
  return {
    entriesNamedBy: (holder, importers, isTestFile) =>
      directoriesNamedBy(holder).flatMap((dir) =>
        [...walked].filter(
          (relPath) =>
            relPath.startsWith(`${dir}/`) &&
            [...(importers.get(relPath) ?? [])].every((i) => i.startsWith(`${dir}/`) || isTestFile(i)),
        ),
      ),
  };
}

const NAME_SEGMENT_SEPARATOR = /[.\-_]/;

const STRING_LITERAL = /'([^'\n]*)'|"([^"\n]*)"|`([^`$\n]*)`/g;

/**
 * The quoted strings of a source text, each alone and every comma-separated
 * run of them joined as a path (`resolve(ROOT, 'app', 'prototypes')`).
 */
function pathLiteralsOf(text: string): string[] {
  const literals: string[] = [];
  let run: string[] = [];
  let runEnd = -1;
  for (const match of text.matchAll(STRING_LITERAL)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    const start = match.index;
    if (runEnd < 0 || !/^\s*,\s*$/.test(text.slice(runEnd, start))) {
      if (run.length > 1) literals.push(posix.join(...run));
      run = [];
    }
    run.push(value);
    runEnd = start + match[0].length;
    if (value !== "") literals.push(value);
  }
  if (run.length > 1) literals.push(posix.join(...run));
  return literals;
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
