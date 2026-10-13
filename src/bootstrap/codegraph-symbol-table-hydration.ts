/**
 * The one per-collection symbol-table hydration hook every codegraph pool runs
 * on first open — the main-thread pool (`createCodegraphGraphDbPool` in
 * `factory.ts`) and the worker pool (`createCodegraphWorkerPool`). Kept in its
 * own module so the worker pool factory, loaded by path in every worker, does
 * not load `factory.ts`.
 */

import type { CollectionInitHook } from "../core/adapters/duckdb/index.js";

/**
 * Hydrate the per-collection symbol table from disk on first open. Without
 * it an incremental reindex of file A cannot resolve calls into an unchanged
 * file B — the walker only touches changed files, so B's symbols would be
 * invisible. After hydration the in-memory table holds every persisted
 * definition; the streaming upsert path (sink.finish() → graphDb.upsertSymbols)
 * keeps it current. An empty result (fresh DB) is the no-op fast path.
 */
export const hydrateCodegraphSymbolTable: CollectionInitHook = async ({
  collectionName: physicalCollectionName,
  graphDb,
  symbolTable,
}) => {
  try {
    const persisted = await graphDb.listAllSymbols();
    if (persisted.length > 0) symbolTable.hydrate(persisted);
    // …and the files that persisted no symbol at all (bd tea-rags-mcp-o7ifx).
    // `cg_symbols` has no row for an empty `__init__.py`, so hydrating from
    // it alone leaves every package marker outside the project until some
    // later run happens to re-walk it. The file table is the full universe.
    const files = await graphDb.listFileContentHashes();
    if (files.length > 0) symbolTable.hydrateFiles?.(files.map((f) => f.relPath));
  } catch (err) {
    process.stderr.write(
      `[tea-rags] codegraph symbol-table hydration failed for ${physicalCollectionName}: ${(err as Error).message}\n`,
    );
  }
};
