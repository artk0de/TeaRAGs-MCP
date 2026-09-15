/**
 * Collection identity — the two names one project's Qdrant collections go by
 * (bd tea-rags-mcp-39xca.1).
 *
 * A project is addressed by a stable LOGICAL name (`code_8b243ffe`). Once
 * versioned, that name is a Qdrant alias pointing at a PHYSICAL collection
 * (`code_8b243ffe_v3`). Qdrant resolves the alias server-side, so every Qdrant
 * call works with either — which is exactly why the difference hid. Storage
 * opened by literal name does not: the codegraph DuckDB file, its run state and
 * spills are per generation, and handing them the alias opened a shadow file no
 * reader ever read (6goqa, snbzk, xjkvw, dxa9w, uebug).
 *
 * The rule used to live in comments and navigators, and every new entry point
 * had to remember it. These brands make it a compile error instead: a bare
 * `string` is neither, and neither is assignable to the other. Both are minted
 * ONLY in `infra/collection-name.ts`, and a lint rule rejects the cast anywhere
 * else — so a name reaches a physical-storage boundary only by being resolved,
 * constructed as a new generation, or read back from the storage it names.
 *
 * Logical keys stay logical on purpose: the snapshot, stats cache, quarantine
 * store and indexing lock survive a version bump precisely because they are NOT
 * keyed by the physical name.
 */

declare const physicalCollectionNameBrand: unique symbol;
declare const collectionAliasBrand: unique symbol;

/**
 * A concrete Qdrant collection — never an alias — and therefore the key of every
 * per-generation artifact: the codegraph DuckDB file and what is derived from it.
 */
export type PhysicalCollectionName = string & { readonly [physicalCollectionNameBrand]: "PhysicalCollectionName" };

/**
 * A project's stable logical collection name: what its Qdrant alias is called
 * once the collection is versioned, and the base every `<name>_v<N>` generation
 * is built from.
 */
export type CollectionAlias = string & { readonly [collectionAliasBrand]: "CollectionAlias" };

/** One alias as Qdrant reports it: a logical name and the physical collection it points at. */
export interface CollectionAliasEntry {
  aliasName: CollectionAlias;
  collectionName: PhysicalCollectionName;
}
