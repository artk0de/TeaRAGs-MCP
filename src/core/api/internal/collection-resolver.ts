/**
 * Request-to-collection resolution.
 *
 * Lives in `api/internal` rather than `infra` because it is input validation:
 * it consults the project registry and throws `InputValidationError` subclasses,
 * which `.claude/rules/typed-errors.md` places in the api layer ("facades
 * validate input"). The foundation keeps only the stateless helpers
 * (`validatePath`, `resolveCollectionName`) that every layer needs.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { resolveGitCommonDir } from "../../adapters/vcs/git/common-dir.js";
import type { CollectionEntry, PathCollectionResolver } from "../../contracts/types/registry.js";
import type { WorkingTree } from "../../contracts/types/working-tree.js";
import { CollectionNotFoundError } from "../../domains/explore/index.js";
import type { CollectionRegistry } from "../../domains/maintenance/registry/collection-registry.js";
import {
  collectionAliasOfRegistryEntry,
  resolveCollectionName,
  validatePathSync,
} from "../../infra/collection-name.js";
import { findGitToplevel } from "../../infra/repo-git-state.js";
import {
  CollectionNotProvidedError,
  InvalidParameterError,
  ProjectNotRegisteredError,
  StaleProjectAliasError,
  SubmoduleNotIndexedError,
} from "../public/index.js";

/**
 * Input for resolveCollection — 3-priority resolution:
 *   collection > project > path > error.
 */
export interface ResolveInput {
  collection?: string;
  project?: string;
  path?: string;
}

/**
 * Resolve a collection identifier from a request.
 *
 * Priority:
 *   1. `collection` — explicit Qdrant collection name, used as-is.
 *   2. `project` — registry lookup by sticky name; throws if unknown.
 *   3. `path` — deterministic hash of the absolute path.
 *   4. none — CollectionNotProvidedError.
 */
export function resolveCollection(
  registry: CollectionRegistry,
  input: ResolveInput,
): { collectionName: string; path?: string } {
  if (input.collection) {
    return { collectionName: input.collection, path: input.path };
  }
  if (input.project) {
    const entry = registry.findByName(input.project);
    if (!entry) {
      const available = registry
        .list()
        .map((e) => e.name)
        .filter((n): n is string => n !== null);
      throw new ProjectNotRegisteredError(input.project, available);
    }
    // Stale-alias guard: registry retains entries from removed worktrees /
    // moved repos. Without this check, callers operate on a phantom path
    // (resolving the alias silently to a deleted directory) and either
    // index 0/0 files or read stale stats from the surviving Qdrant
    // collection. Empty path means recoverFromQdrant stub — handled by
    // ProjectPathMissingError downstream, NOT a stale alias.
    if (entry.path && !existsSync(resolve(entry.path))) {
      throw new StaleProjectAliasError(input.project, entry.path);
    }
    return { collectionName: entry.collectionName, path: entry.path };
  }
  if (input.path) {
    // Registry-aware path lookup: when a project alias was moved (its
    // worktree relocated; `register_project` re-pointed the existing entry
    // at the new path), the original `collectionName` stays with the
    // entry. Path-based callers must honor that mapping — otherwise they
    // would derive a fresh `code_<newhash>` and operate on a brand-new
    // empty collection while the actual indexed data still lives under
    // the old `collectionName`. Fallback to the deterministic hash only
    // when the path is not yet registered.
    //
    // CANONICALIZE ON A MISS (bd tea-rags-mcp-dxa9w). Entries are recorded
    // realpath'd and `findByPath` is an exact string compare, so a trailing
    // slash, a `..` segment or a symlinked ancestor would miss the entry and
    // fall through to the hash — this function's own defect, at its own door.
    // Callers hand over raw request paths (the MCP auto-update hint passes the
    // tool argument verbatim), so the rule belongs here rather than in each
    // caller's discipline. It also pins the HASH to the canonical spelling, so
    // an unregistered path resolves to the same name a later index writes it
    // under.
    //
    // The plain `resolve` is tried FIRST, and it is not only about sparing this
    // function — which sits on the serving query path — a blocking realpath per
    // request. `resolve` already normalizes a trailing slash and a `..`, and an
    // entry written by a pre-canonicalization writer (the old worktree
    // provisioner recorded a bare `resolve`) is findable ONLY by this spelling.
    // A hit is canonical by construction: it equals the entry's own path.
    //
    // The optional-chain guards against test stubs that predate
    // findByPath — those stubs imply no rename ever happened, so the
    // hash fallback is correct for their fixture.
    const resolvedPath = resolve(input.path);
    const direct = registry?.findByPath?.(resolvedPath);
    if (direct) return { collectionName: direct.collectionName, path: resolvedPath };

    const canonicalPath = validatePathSync(input.path);
    const entry = canonicalPath === resolvedPath ? undefined : registry?.findByPath?.(canonicalPath);
    return {
      collectionName: entry?.collectionName ?? resolveCollectionName(canonicalPath),
      path: canonicalPath,
    };
  }
  throw new CollectionNotProvidedError();
}

/**
 * The working tree a request reads, and the index it reads that tree against
 * (bd tea-rags-mcp-xi2r9).
 *
 * One MCP server serves every subagent, and only the agent knows which tree it
 * stands in — so its working directory alone has to address both. The tree is
 * the caller's; the index is the lower layer the tree is compared with, which
 * for an unregistered linked worktree is its repository's main checkout. The
 * shape is declared in contracts, where the explore overlay can name it.
 */
export type { WorkingTree };

/**
 * Nearest ancestor (inclusive) holding `.git` — the tree's toplevel. Filesystem
 * only, for the reason `resolveGitCommonDir` is: this sits on the serving query
 * path, where a git spawn per request is the scarce resource. A linked worktree
 * holds a `.git` FILE, so `existsSync` covers both layouts.
 */
export function findWorkingTreeRoot(path: string): string | undefined {
  return findGitToplevel(validatePathSync(path));
}

/**
 * Resolve a request to the {@link WorkingTree} it reads.
 *
 * An explicit `collection` / `project` names the index and keeps
 * {@link resolveCollection}'s rules; a `path` beside it only picks the tree,
 * and must be a checkout of the same repository — reading one repository's tree
 * against another's index would report every file as changed.
 *
 * `path` alone: the index is, in order of preference, an entry registered in
 * the caller's own tree (a worktree clone keeps its own index), one registered
 * in the repository's main checkout, or any entry of the repository; within the
 * preferred group the deepest entry containing `path` wins, and a group with
 * several and none containing `path` is a question only the caller can answer,
 * so it is refused rather than guessed. A tree of no registered repository keeps
 * the path-hash fallback — unless it is a submodule of an indexed superproject,
 * which is refused by name instead of hashing to a collection nobody created.
 *
 * Either way the tree root is the tree's counterpart of the index root (see
 * {@link WorkingTree.root}): an index registered at `<repo>/sub` reads
 * `<tree toplevel>/sub`, not the toplevel (live P2-2).
 *
 * A `path` that does not exist inside a git working tree is refused: walking up
 * from it would silently answer for whatever repository encloses the typo (live
 * P2-9). Outside every repository a missing path keeps the path-hash rule, which
 * addresses an index by the path it was built at and needs no tree on disk. A
 * relative `path` resolves against the process's working directory, which the
 * CLI relies on.
 */
/** Whether the index a request resolved to exists (Qdrant, by its addressed name). */
export type IndexExistenceCheck = (collectionName: string) => Promise<boolean>;

/**
 * {@link resolveWorkingTree} for a READ: the index the tree resolved to must
 * exist, or the read is refused with the typed not-found error every search
 * tool answers (live round-3 D3, bd tea-rags-mcp-xi2r9). Checked before the
 * overlay measures anything, so no marker is ever made for an index nobody
 * created — the graph tools used to answer `[]` with a degraded marker naming
 * a reindex of that phantom collection. An index that exists but carries no
 * commit stamp passes, and the overlay degrades its marker as before. No
 * check wired (unit wiring) → the tree as resolved.
 */
export async function resolveIndexedWorkingTree(
  registry: CollectionRegistry,
  input: ResolveInput,
  indexExists: IndexExistenceCheck | undefined,
): Promise<WorkingTree> {
  const workingTree = resolveWorkingTree(registry, input);
  const { collectionName } = workingTree.baseIndex;
  if (indexExists && !(await indexExists(collectionName))) throw new CollectionNotFoundError(collectionName);
  return workingTree;
}

export function resolveWorkingTree(registry: CollectionRegistry, input: ResolveInput): WorkingTree {
  if (input.path !== undefined) {
    const absolutePath = resolve(input.path);
    if (!existsSync(absolutePath) && findGitToplevel(dirname(absolutePath)) !== undefined) {
      throw new InvalidParameterError("path", `'${input.path}' does not exist`);
    }
  }
  if (input.collection !== undefined || input.project !== undefined) {
    const resolved = resolveCollection(registry, input);
    const indexRoot =
      input.project !== undefined ? resolved.path : (registry?.get?.(resolved.collectionName)?.path ?? undefined);
    const root = input.path === undefined ? indexRoot : requireSameRepositoryTree(input, input.path, indexRoot);
    return { root: root ?? "", baseIndex: { collectionName: resolved.collectionName, root: indexRoot } };
  }
  if (input.path === undefined) throw new CollectionNotProvidedError();

  const requestPath = validatePathSync(input.path);
  const gitRoot = findGitToplevel(requestPath);
  if (gitRoot === undefined) {
    const entry = registry?.findByPath?.(requestPath);
    if (entry) return { root: requestPath, baseIndex: { collectionName: entry.collectionName, root: entry.path } };
    const resolved = resolveCollection(registry, { path: input.path });
    return { root: requestPath, baseIndex: { collectionName: resolved.collectionName, root: resolved.path } };
  }

  const selected = selectSameRepositoryEntry(registry, gitRoot, requestPath);
  if (selected) {
    return {
      root: selected.root,
      baseIndex: { collectionName: selected.entry.collectionName, root: selected.entry.path },
    };
  }
  const atToplevel = registry?.findByPath?.(gitRoot);
  if (atToplevel) {
    return { root: gitRoot, baseIndex: { collectionName: atToplevel.collectionName, root: atToplevel.path } };
  }
  rejectUnindexedSubmodule(registry, input.path, gitRoot);

  const resolved = resolveCollection(registry, { path: input.path });
  return { root: gitRoot, baseIndex: { collectionName: resolved.collectionName, root: resolved.path } };
}

/**
 * The registry entry whose index a read addressed by `path` alone is served
 * from — {@link resolveWorkingTree}'s `baseIndex`, as an entry. A linked
 * worktree nobody registered resolves to its repository's entry, so a
 * collaborator that replays a project's registry env (the `call` CLI) seeds
 * the env of the index the server will actually read. Null when that index is
 * the hash of a path no entry claims.
 *
 * @throws the {@link resolveWorkingTree} validation errors for a bad path.
 */
export function resolveBaseIndexEntry(registry: CollectionRegistry, path: string): CollectionEntry | null {
  return registry.get(resolveWorkingTree(registry, { path }).baseIndex.collectionName);
}

/**
 * The tree `path` addresses — the counterpart of the index root in the tree's
 * toplevel — provided it is a checkout of the repository the named index was
 * built from. An index with no recorded root (an unregistered collection, a
 * recoverFromQdrant stub) has nothing to compare against, so the path's
 * toplevel is taken at its word.
 */
function requireSameRepositoryTree(input: ResolveInput, path: string, indexRoot: string | undefined): string {
  const treeRoot = findWorkingTreeRoot(path) ?? validatePathSync(path);
  if (!indexRoot) return treeRoot;
  if (resolveGitCommonDir(treeRoot) !== commonDirOf(indexRoot)) {
    const index = input.project !== undefined ? `project "${input.project}"` : `collection "${input.collection}"`;
    const nested = findEnclosingNestedRepository(treeRoot);
    const insideIndexRepository =
      nested !== undefined && resolveGitCommonDir(nested.superproject) === commonDirOf(indexRoot);
    const detail = insideIndexRepository
      ? `'${path}' is inside ${nested.kind} '${relative(nested.superproject, nested.root)}' of ${index} (${indexRoot}) — ` +
        "a separate repository, not a checkout of it; address the superproject or index the submodule"
      : `'${path}' is not a checkout of ${index} (${indexRoot})`;
    throw new InvalidParameterError("path", detail);
  }
  return counterpartRoot(treeRoot, indexRoot);
}

/**
 * The index root's counterpart in the tree whose toplevel is `treeToplevel`:
 * the same path below the toplevel that the index root has below its own.
 */
function counterpartRoot(treeToplevel: string, indexRoot: string): string {
  const indexToplevel = toplevelOf(indexRoot);
  if (indexToplevel === undefined) return treeToplevel;
  const below = relative(indexToplevel, indexRoot);
  return below === "" ? treeToplevel : join(treeToplevel, below);
}

function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

interface SameRepositoryCandidate {
  entry: CollectionEntry;
  /** the entry root's counterpart in the requesting tree */
  root: string;
}

/**
 * The registry entry indexing the repository behind `treeToplevel`, and the
 * tree root it is read at. Groups in order: entries registered inside this very
 * tree, entries inside the main checkout, any entry of the repository; the first
 * non-empty group decides. Inside it, the deepest counterpart containing
 * `requestPath` wins; none containing it leaves only a group of one unambiguous.
 * Entries with an empty `path` (recoverFromQdrant stubs) belong to no tree.
 */
function selectSameRepositoryEntry(
  registry: CollectionRegistry,
  treeToplevel: string,
  requestPath: string,
): SameRepositoryCandidate | null {
  const commonDir = resolveGitCommonDir(treeToplevel);
  const candidates = (registry?.list?.() ?? [])
    .filter((entry) => entry.path && commonDirOf(entry.path) === commonDir)
    .map((entry) => ({ entry, toplevel: toplevelOf(entry.path), root: counterpartRoot(treeToplevel, entry.path) }));
  if (candidates.length === 0) return null;

  // The main checkout is the tree whose `.git` IS the shared dir; a bare
  // repository has none.
  const mainCheckout = basename(commonDir) === ".git" ? dirname(commonDir) : undefined;
  const groups = [
    candidates.filter((candidate) => candidate.toplevel === treeToplevel),
    candidates.filter((candidate) => mainCheckout !== undefined && candidate.toplevel === mainCheckout),
    candidates,
  ];
  const group = groups.find((members) => members.length > 0) ?? candidates;

  const containing = group.filter((candidate) => contains(candidate.root, requestPath));
  if (containing.length === 0 && group.length === 1) return group[0];
  const deepest = Math.max(...containing.map((candidate) => candidate.root.length));
  const winners = containing.filter((candidate) => candidate.root.length === deepest);
  if (winners.length === 1) return winners[0];

  const aliases = (winners.length > 0 ? winners : group)
    .map((candidate) => candidate.entry.name ?? candidate.entry.collectionName)
    .join(", ");
  throw new InvalidParameterError(
    "path",
    `'${requestPath}' belongs to a repository indexed under several projects: ${aliases} — pass project=<alias>`,
  );
}

/**
 * The repository `treeToplevel` is nested in, when it is one: a submodule (the
 * superproject's `.gitmodules` lists it) or a plain nested repository.
 */
function findEnclosingNestedRepository(
  treeToplevel: string,
): { kind: "submodule" | "nested repository"; root: string; superproject: string } | undefined {
  const superproject = findGitToplevel(dirname(treeToplevel));
  if (superproject === undefined) return undefined;
  const below = relative(superproject, treeToplevel).split(sep).join("/");
  let gitmodules = "";
  try {
    gitmodules = readFileSync(join(superproject, ".gitmodules"), "utf8");
  } catch {
    // No .gitmodules: a nested repository, not a submodule.
  }
  const listed = gitmodules
    .split("\n")
    .some((line) => /^\s*path\s*=/.test(line) && line.split("=")[1]?.trim() === below);
  return { kind: listed ? "submodule" : "nested repository", root: treeToplevel, superproject };
}

/**
 * Refuse a path inside a submodule (or nested repository) whose superproject is
 * indexed while the submodule is not (live P2-8). The submodule is a separate
 * repository, so the superproject's index cannot answer for it, and the
 * path-hash fallback would name a collection nobody created.
 */
function rejectUnindexedSubmodule(registry: CollectionRegistry, path: string, treeToplevel: string): void {
  const nested = findEnclosingNestedRepository(treeToplevel);
  if (nested === undefined) return;
  const superCommonDir = resolveGitCommonDir(nested.superproject);
  const superIndexed = (registry?.list?.() ?? []).some(
    (entry) => entry.path && commonDirOf(entry.path) === superCommonDir,
  );
  if (superIndexed) throw new SubmoduleNotIndexedError(path, nested);
}

/**
 * Toplevel and `resolveGitCommonDir` per registered root, memoised for the
 * process: entry roots are few and stable, and every path-addressed request
 * scans them all. A root may sit BELOW its toplevel (a project registered at a
 * subdirectory), so the common dir is resolved from the toplevel — the
 * subdirectory has no `.git` to read (live P2-2). The unreadable fallback (the
 * root itself) is not memoised: a root that is not a repository yet may become
 * one.
 */
const commonDirByEntryRoot = new Map<string, string>();
const toplevelByEntryRoot = new Map<string, string>();

function toplevelOf(entryRoot: string): string | undefined {
  const memoised = toplevelByEntryRoot.get(entryRoot);
  if (memoised !== undefined) return memoised;
  const toplevel = findGitToplevel(entryRoot);
  if (toplevel !== undefined) toplevelByEntryRoot.set(entryRoot, toplevel);
  return toplevel;
}

function commonDirOf(entryRoot: string): string {
  const memoised = commonDirByEntryRoot.get(entryRoot);
  if (memoised !== undefined) return memoised;
  const toplevel = toplevelOf(entryRoot) ?? entryRoot;
  const commonDir = resolveGitCommonDir(toplevel);
  if (commonDir !== toplevel) commonDirByEntryRoot.set(entryRoot, commonDir);
  return commonDir;
}

/**
 * What a collaborator is handed instead of the registry itself. Declared in
 * `contracts/types/registry.ts` so the domain modules that receive it can name
 * the same type instead of redeclaring its shape; re-exported here because this
 * file is where the rule it stands for lives.
 */
export type { PathCollectionResolver };

/**
 * The path → collection rule of {@link resolveCollection}, packaged for
 * collaborators that hold a path and no request: the drift reporter, and the
 * stamp / reset sites of an index run (bd tea-rags-mcp-waj6k).
 *
 * They must not carry a second rule. Deriving the hash themselves sends a
 * relocated project's report, its consumption reset and its language-version
 * stamp to a collection no search ever resolves — the drift is reported against
 * a name nobody queries, and re-armed on a key nothing consumed.
 *
 * The spelling is canonicalized by {@link resolveCollection} itself, which is
 * the spelling entries are recorded under (`CollectionRegistry#record` and
 * `#updatePath` are both fed `validatePath` output), so a caller handing over a
 * relative, symlinked or trailing-slash path still finds the entry it belongs
 * to. Async only because its collaborators hold it as one.
 */
export function createPathCollectionResolver(registry: CollectionRegistry): PathCollectionResolver {
  // A path resolves to the entry that claims it or to the path hash — a project's
  // LOGICAL name either way, never one of its versioned generations.
  return async (path) => collectionAliasOfRegistryEntry(resolveCollection(registry, { path }));
}
