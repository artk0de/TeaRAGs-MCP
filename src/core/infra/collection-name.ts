/**
 * Collection name resolution and path validation utilities.
 *
 * Foundation layer — stateless pure functions used by all layers.
 * Moved from ingest/collection.ts to fix layer violations.
 */

import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { resolve } from "node:path";

import { CollectionNotProvidedError, ProjectNotRegisteredError, StaleProjectAliasError } from "../api/errors.js";
import type { CollectionRegistry } from "./registry/collection-registry.js";

/**
 * Validate path — resolves to realpath if exists, absolute path otherwise.
 */
export async function validatePath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await fs.realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

/**
 * Generate deterministic collection name from codebase path.
 */
export function resolveCollectionName(path: string): string {
  const absolutePath = resolve(path);
  const hash = createHash("md5").update(absolutePath).digest("hex");
  return `code_${hash.substring(0, 8)}`;
}

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
