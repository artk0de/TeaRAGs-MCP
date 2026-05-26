import type { GlobalSymbolTable, RelPath, SymbolDefinition } from "../../../contracts/types/codegraph.js";

/**
 * No-op `GlobalSymbolTable` for the codegraph daemon process.
 *
 * The daemon NEVER resolves call edges — resolution (which needs a populated
 * symbol table) runs in the MCP client process; the daemon only persists
 * already-resolved edges through `pool.acquire(...).graphDb`. So the pool's
 * `symbolTableFactory` for the daemon can hand back a table that stores nothing
 * and answers every lookup empty.
 *
 * Lives in the adapter (adapters->contracts is legal) so the daemon no longer
 * imports `InMemoryGlobalSymbolTable` from the codegraph trajectory domain
 * (which would be an adapter->domain layer violation).
 */
export class NoopGlobalSymbolTable implements GlobalSymbolTable {
  upsertFile(_relPath: RelPath, _definitions: SymbolDefinition[]): void {
    /* no-op — the daemon never resolves, so nothing to index */
  }

  removeFile(_relPath: RelPath): void {
    /* no-op */
  }

  lookup(_fqName: string): SymbolDefinition[] {
    return [];
  }

  lookupByShortName(_name: string): SymbolDefinition[] {
    return [];
  }

  size(): number {
    return 0;
  }

  hydrate(_definitions: SymbolDefinition[]): void {
    /* no-op — daemon does not hydrate; persistence is the DuckDB file itself */
  }
}
