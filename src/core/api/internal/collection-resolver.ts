/**
 * Request-to-collection resolution.
 *
 * Lives in `api/internal` rather than `infra` because it is input validation:
 * it consults the project registry and throws `InputValidationError` subclasses,
 * which `.claude/rules/typed-errors.md` places in the api layer ("facades
 * validate input"). The foundation keeps only the stateless helpers
 * (`validatePath`, `resolveCollectionName`) that every layer needs.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { resolveGitCommonDir } from "../../adapters/vcs/git/common-dir.js";
import type { CollectionEntry, PathCollectionResolver } from "../../contracts/types/registry.js";
import type { CollectionRegistry } from "../../domains/maintenance/registry/collection-registry.js";
import {
  collectionAliasOfRegistryEntry,
  resolveCollectionName,
  validatePathSync,
} from "../../infra/collection-name.js";
import {
  CollectionNotProvidedError,
  InvalidParameterError,
  ProjectNotRegisteredError,
  StaleProjectAliasError,
} from "../errors.js";

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
 * for an unregistered linked worktree is its repository's main checkout.
 */
export interface WorkingTree {
  /** realpath of the tree the caller stands in (git toplevel, not a subdir) */
  root: string;
  /** lower layer the tree is read against */
  baseIndex: { collectionName: string; root: string | undefined };
}

/**
 * Nearest ancestor (inclusive) holding `.git` — the tree's toplevel. Filesystem
 * only, for the reason `resolveGitCommonDir` is: this sits on the serving query
 * path, where a git spawn per request is the scarce resource. A linked worktree
 * holds a `.git` FILE, so `existsSync` covers both layouts.
 */
export function findWorkingTreeRoot(path: string): string | undefined {
  let dir = validatePathSync(path);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve a request to the {@link WorkingTree} it reads.
 *
 * An explicit `collection` / `project` names the index and keeps
 * {@link resolveCollection}'s rules; a `path` beside it only picks the tree,
 * and must be a checkout of the same repository — reading one repository's tree
 * against another's index would report every file as changed.
 *
 * `path` alone: the tree is its git toplevel, and the index is, in order, the
 * entry registered AT that tree (a worktree clone keeps its own index), the
 * repository's main-checkout entry, or its only entry. Several entries and none
 * at main is a question only the caller can answer, so it is refused rather
 * than guessed. A tree of no registered repository keeps the path-hash fallback.
 */
export function resolveWorkingTree(registry: CollectionRegistry, input: ResolveInput): WorkingTree {
  if (input.collection !== undefined || input.project !== undefined) {
    const resolved = resolveCollection(registry, input);
    const indexRoot =
      input.project !== undefined ? resolved.path : (registry.get?.(resolved.collectionName)?.path ?? undefined);
    const root = input.path === undefined ? indexRoot : requireSameRepositoryTree(input, input.path, indexRoot);
    return { root: root ?? "", baseIndex: { collectionName: resolved.collectionName, root: indexRoot } };
  }
  if (input.path === undefined) throw new CollectionNotProvidedError();

  const gitRoot = findWorkingTreeRoot(input.path);
  const treeRoot = gitRoot ?? validatePathSync(input.path);
  const entry =
    registry.findByPath?.(treeRoot) ?? (gitRoot === undefined ? null : selectSameRepositoryEntry(registry, gitRoot));
  if (entry) return { root: treeRoot, baseIndex: { collectionName: entry.collectionName, root: entry.path } };

  const resolved = resolveCollection(registry, { path: input.path });
  return { root: treeRoot, baseIndex: { collectionName: resolved.collectionName, root: resolved.path } };
}

/**
 * The tree `path` addresses, provided it is a checkout of the repository the
 * named index was built from. An index with no recorded root (an unregistered
 * collection, a recoverFromQdrant stub) has nothing to compare against, so the
 * path is taken at its word.
 */
function requireSameRepositoryTree(input: ResolveInput, path: string, indexRoot: string | undefined): string {
  const treeRoot = findWorkingTreeRoot(path) ?? validatePathSync(path);
  if (!indexRoot) return treeRoot;
  if (resolveGitCommonDir(treeRoot) !== commonDirOf(indexRoot)) {
    const index = input.project !== undefined ? `project "${input.project}"` : `collection "${input.collection}"`;
    throw new InvalidParameterError("path", `'${path}' is not a checkout of ${index} (${indexRoot})`);
  }
  return treeRoot;
}

/**
 * The registry entry indexing the repository behind `treeRoot`, when the tree
 * itself is not registered: the main checkout's entry, else the only one.
 * Entries with an empty `path` (recoverFromQdrant stubs) belong to no tree.
 */
function selectSameRepositoryEntry(registry: CollectionRegistry, treeRoot: string): CollectionEntry | null {
  const commonDir = resolveGitCommonDir(treeRoot);
  const candidates = registry.list().filter((entry) => entry.path && commonDirOf(entry.path) === commonDir);
  if (candidates.length === 0) return null;

  // The main checkout is the tree whose `.git` IS the shared dir; a bare
  // repository has none, and then only a single candidate is unambiguous.
  const mainCheckout = basename(commonDir) === ".git" ? dirname(commonDir) : undefined;
  const atMain = candidates.find((entry) => entry.path === mainCheckout);
  if (atMain) return atMain;
  if (candidates.length === 1) return candidates[0];

  const aliases = candidates.map((entry) => entry.name ?? entry.collectionName).join(", ");
  throw new InvalidParameterError(
    "path",
    `'${treeRoot}' belongs to a repository indexed under several projects: ${aliases} — pass project=<alias>`,
  );
}

/**
 * `resolveGitCommonDir` per registered root, memoised for the process: entry
 * roots are few and stable, and every path-addressed request scans them all.
 * The unreadable fallback (the root itself) is not memoised: a root that is not
 * a repository yet may become one.
 */
const commonDirByEntryRoot = new Map<string, string>();

function commonDirOf(entryRoot: string): string {
  const memoised = commonDirByEntryRoot.get(entryRoot);
  if (memoised !== undefined) return memoised;
  const commonDir = resolveGitCommonDir(entryRoot);
  if (commonDir !== entryRoot) commonDirByEntryRoot.set(entryRoot, commonDir);
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
