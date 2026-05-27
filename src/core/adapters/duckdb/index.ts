export { DuckDbGraphClient, type DuckDbGraphClientOptions } from "./client.js";
export { DuckDbOpenFailedError } from "./errors.js";
export {
  GraphDbClientPool,
  type CollectionGraphHandle,
  type CollectionInitHook,
  type GraphDbClientPoolOptions,
  type SymbolTableFactory,
} from "./pool.js";
