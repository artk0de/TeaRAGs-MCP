import type { GlobalSymbolTable, GraphDbClient } from "../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../contracts/types/collection-identity.js";

/**
 * Initialiser hook the pool calls once per newly-opened collection client, so
 * the codegraph domain can hydrate the symbol table — the pool does not import
 * the in-memory symbol-table implementation.
 */
export type CollectionInitHook = (args: {
  collectionName: PhysicalCollectionName;
  graphDb: GraphDbClient;
  symbolTable: GlobalSymbolTable;
}) => Promise<void>;

export type SymbolTableFactory = () => GlobalSymbolTable;
