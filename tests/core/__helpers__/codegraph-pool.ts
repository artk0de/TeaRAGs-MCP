/**
 * Test helper — build a `GraphDbClientPool` shape backed by a single
 * pre-opened `DuckDbGraphClient`. Useful for unit tests that exercise
 * composition / facade wiring without actually touching multiple
 * collection files. The pool returns the same handle regardless of
 * `collectionName`, which mirrors the legacy single-DB shape but
 * satisfies the new `CodegraphDeps` contract that bootstrap consumes.
 */

import type { CollectionGraphHandle, GraphDbClientPool } from "../../../src/core/adapters/duckdb/pool.js";
import type { GlobalSymbolTable, GraphDbClient } from "../../../src/core/contracts/types/codegraph.js";

export function createStubPool(graphDb: GraphDbClient, symbolTable: GlobalSymbolTable): GraphDbClientPool {
  const handle: CollectionGraphHandle = { graphDb, symbolTable };
  // The read path (`GraphFacade`) calls `acquireRead` then `close()` on the
  // returned graphDb after each query. This stub wraps a SINGLE pre-opened
  // client reused across queries, so `acquireRead` hands back the shared
  // client wrapped with a no-op `close` — otherwise the first read would close
  // the client out from under the next one.
  const readHandle: CollectionGraphHandle = {
    graphDb: new Proxy(graphDb, {
      get(target, prop, receiver) {
        if (prop === "close") return async () => undefined;
        return Reflect.get(target, prop, receiver);
      },
    }),
    symbolTable,
  };
  // Cast the partial object to the public type — the unit tests never
  // exercise release/closeAll/pathFor on this stub, so omitting them
  // keeps the helper minimal. If a future test needs them, extend here.
  return {
    acquire: async () => handle,
    acquireRead: async () => readHandle,
    peek: () => handle,
    release: async () => true,
    closeAll: async () => undefined,
    pathFor: (name: string) => `:memory:${name}`,
  } as unknown as GraphDbClientPool;
}
