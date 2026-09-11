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
import { resolve } from "node:path";

import type { CollectionRegistry } from "../../domains/maintenance/registry/collection-registry.js";
import { resolveCollectionName, validatePath } from "../../infra/collection-name.js";
import { CollectionNotProvidedError, ProjectNotRegisteredError, StaleProjectAliasError } from "../errors.js";

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
    // The optional-chain guards against test stubs that predate
    // findByPath — those stubs imply no rename ever happened, so the
    // hash fallback is correct for their fixture.
    const entry = registry?.findByPath?.(input.path);
    return {
      collectionName: entry?.collectionName ?? resolveCollectionName(input.path),
      path: input.path,
    };
  }
  throw new CollectionNotProvidedError();
}

/** What a collaborator is handed instead of the registry itself. */
export type PathCollectionResolver = (path: string) => Promise<string>;

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
 * The lookup uses the VALIDATED path because that is the spelling entries are
 * recorded under (`CollectionRegistry#record` and `#updatePath` are both fed
 * `validatePath` output), so a caller handing over a relative or symlinked path
 * still finds the entry it belongs to.
 */
export function createPathCollectionResolver(registry: CollectionRegistry): PathCollectionResolver {
  return async (path: string): Promise<string> =>
    resolveCollection(registry, { path: await validatePath(path) }).collectionName;
}
