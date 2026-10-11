/**
 * Collection name resolution — the collection identity rule.
 *
 * Primitives layer — stateless, I/O-free functions used by all layers. Path
 * canonicalization (realpath against the local disk) is NOT here: it is
 * filesystem I/O, so it lives in `adapters/filesystem/path-canonicalization.ts`.
 * Request resolution (registry lookup, input-validation errors) is NOT here
 * either: it needs the api-layer error classes, so it lives in
 * `api/internal/collection-resolver.ts`.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type {
  CollectionAlias,
  CollectionAliasEntry,
  PhysicalCollectionName,
} from "../../contracts/types/collection-identity.js";

// ── Collection identity (bd tea-rags-mcp-39xca.1) ──────────────────────────
//
// The ONLY module that brands a string as a `PhysicalCollectionName` or a
// `CollectionAlias`; lint rejects the cast anywhere else. A name earns the
// physical brand in exactly three ways, each a function below: by RESOLVING an
// unresolved name against Qdrant's aliases, by CONSTRUCTING a new generation, or
// by being READ BACK from the storage that is keyed by it. It lives in the
// foundation, not in `domains/ingest`, because the alias rule is needed by
// `adapters/qdrant` and `domains/maintenance` too — neither may import ingest,
// and a resolver per layer is the defect this module removes.

/**
 * The single producer of a `PhysicalCollectionName` from an unresolved name: the
 * collection an alias points at, or the name itself when it is not an alias.
 *
 * Qdrant resolves aliases server-side, so Qdrant calls work with either name.
 * Storage opened by literal name does not — above all the codegraph DuckDB file,
 * whose path `CodegraphDbFiles#pathFor` derives straight from the string it is
 * handed. Addressing it by the alias produced a shadow `<alias>.duckdb` that no
 * reader ever opened (bd tea-rags-mcp-6goqa).
 */
export function resolvePhysicalCollection(
  collectionName: string,
  aliases: readonly CollectionAliasEntry[],
): PhysicalCollectionName {
  return findAliasTarget(collectionName, aliases) ?? (collectionName as PhysicalCollectionName);
}

/**
 * The collection an alias points at, or `undefined` when the name is not an
 * alias. `undefined` is load-bearing and distinct from "points at itself": the
 * force path feeds it to `computeNewVersion` as the alias's previous target,
 * where absence means "no alias yet" and must not collapse to the base name.
 */
export function findAliasTarget(
  collectionName: string,
  aliases: readonly CollectionAliasEntry[],
): PhysicalCollectionName | undefined {
  return aliases.find((a) => a.aliasName === collectionName)?.collectionName;
}

/**
 * Generation `version` of a logical collection — `<alias>_v<N>`, the name a
 * new build is created under before the alias is switched onto it. Takes the
 * alias, not a string, so a physical name cannot be versioned again into
 * `<alias>_v3_v4`.
 */
export function versionedPhysicalCollectionName(
  aliasCollectionName: CollectionAlias,
  version: number,
): PhysicalCollectionName {
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError(`Collection generation must be a positive integer, got ${version} for ${aliasCollectionName}`);
  }
  return `${aliasCollectionName}_v${version}` as PhysicalCollectionName;
}

/** One alias exactly as Qdrant describes it — the only place alias names and targets are read back. */
export function collectionAliasEntryFromQdrant(description: {
  alias_name: string;
  collection_name: string;
}): CollectionAliasEntry {
  return {
    aliasName: description.alias_name as CollectionAlias,
    collectionName: description.collection_name as PhysicalCollectionName,
  };
}

/**
 * The collection a codegraph daemon request names. The client that sent it held
 * a `PhysicalCollectionName`; the wire erases the brand, so the daemon restores
 * it here — and rejects a request carrying none, which is a client bug.
 */
export function physicalCollectionNameFromDaemonRequest(value: unknown): PhysicalCollectionName {
  if (typeof value !== "string" || value.length === 0) {
    const got = typeof value === "string" ? "an empty string" : typeof value;
    throw new TypeError(`Codegraph daemon request carries no collection name (got ${got})`);
  }
  return value as PhysicalCollectionName;
}

/**
 * Names the storage itself reports as its own per-generation containers:
 * Qdrant's collection listing (aliases are listed separately and never appear
 * in it) and the `<name>.duckdb` stems in the codegraph directory. Read back,
 * not supplied by a caller — so there is nothing left to resolve.
 */
export function physicalCollectionNamesListedByStorage(names: readonly string[]): PhysicalCollectionName[] {
  return names.map((name) => name as PhysicalCollectionName);
}

/**
 * Generate deterministic collection name from codebase path — the project's
 * LOGICAL name, which becomes its alias once the collection is versioned.
 */
export function resolveCollectionName(path: string): CollectionAlias {
  const absolutePath = resolve(path);
  const hash = createHash("md5").update(absolutePath).digest("hex");
  return `code_${hash.substring(0, 8)}` as CollectionAlias;
}

/**
 * The logical name a registered project was recorded under. Registry entries
 * are written from the path rule above or from a project's first index, never
 * from a versioned generation, so the name an entry carries is an alias.
 */
export function collectionAliasOfRegistryEntry(entry: { collectionName: string }): CollectionAlias {
  return entry.collectionName as CollectionAlias;
}
