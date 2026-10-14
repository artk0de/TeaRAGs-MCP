/**
 * The read handle's whole-graph reads, held across handles per database write
 * stamp (bd tea-rags-mcp-lnor0). Every base-index graph read of the api layer —
 * review_changes and its sections, get_naming_lexicon, get_architecture_report
 * and the restructure/planned-edge ops, find_co_changed, the ontology report —
 * opens its handle through `GraphDbClientPool#acquireReader`, so decorating that
 * handle serves every tool from one cache: a second review of an unchanged
 * index reads none of these from DuckDB again.
 *
 * Held: the reads whose answer depends only on the database — no argument, or
 * an argument that is part of the key. `readTypeNameRows` is held only for a
 * whole-project query (no `pathPrefixes`); a path-scoped one is an index
 * lookup, cheap and keyed by the diff, so holding it would only crowd the
 * cache. Held values are deep-frozen: every caller receives the same object.
 * The working-tree graph (`acquireFileReader`) is never decorated.
 */

import type { GraphDbClient, TypeNameQuery } from "../../contracts/types/codegraph.js";
import { deepFreeze, type StampKeyedReadCache } from "../../primitives/collections/index.js";

/** The `GraphDbClient` reads served from the cache. */
type StampKeyedGraphRead =
  | "readFileDependencyGraph"
  | "readFileReexportEdges"
  | "readTemporalCochangeGraph"
  | "readNonPublicMemberEdges"
  | "loadHierarchySnapshot"
  | "readTypeNameRows"
  | "listAllSymbols"
  | "listFileContentHashes";

/**
 * `graphDb` with its whole-graph reads served from `cache` under `scope` (the
 * physical collection), valid while `stampOf()` — taken at each call, before
 * the read — is unchanged. Every other member reaches `graphDb` itself.
 */
export function withStampKeyedGraphReads(
  graphDb: GraphDbClient,
  scope: string,
  stampOf: () => string | undefined,
  cache: StampKeyedReadCache,
): GraphDbClient {
  const hold = async <T>(kind: StampKeyedGraphRead, key: string | undefined, load: () => Promise<T>): Promise<T> =>
    cache.read({ scope, kind, ...(key !== undefined ? { key } : {}) }, stampOf(), async () => deepFreeze(await load()));
  const held: Pick<GraphDbClient, StampKeyedGraphRead> = {
    readFileDependencyGraph: async () =>
      hold("readFileDependencyGraph", undefined, async () => graphDb.readFileDependencyGraph()),
    readFileReexportEdges: async () =>
      hold("readFileReexportEdges", undefined, async () => graphDb.readFileReexportEdges()),
    readTemporalCochangeGraph: async () =>
      hold("readTemporalCochangeGraph", undefined, async () => graphDb.readTemporalCochangeGraph()),
    readNonPublicMemberEdges: async (languages) =>
      hold("readNonPublicMemberEdges", JSON.stringify(languages), async () =>
        graphDb.readNonPublicMemberEdges(languages),
      ),
    loadHierarchySnapshot: async () =>
      hold("loadHierarchySnapshot", undefined, async () => graphDb.loadHierarchySnapshot()),
    readTypeNameRows: async (q: TypeNameQuery) =>
      q.pathPrefixes.length > 0
        ? graphDb.readTypeNameRows(q)
        : hold("readTypeNameRows", JSON.stringify(q), async () => graphDb.readTypeNameRows(q)),
    listAllSymbols: async () => hold("listAllSymbols", undefined, async () => graphDb.listAllSymbols()),
    listFileContentHashes: async () =>
      hold("listFileContentHashes", undefined, async () => graphDb.listFileContentHashes()),
  };
  return new Proxy(graphDb, {
    get(target, property) {
      // A client without the read (an optional member) keeps answering `undefined`.
      if (Object.hasOwn(held, property) && typeof Reflect.get(target, property) === "function") {
        return held[property as StampKeyedGraphRead];
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
