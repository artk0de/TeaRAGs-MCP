/**
 * Barrel for the TypeScript Program host: the compiler loader, Program cache,
 * module-resolution memo, parsed-source LRU, batch planner, heap admission,
 * import graph, path mapper and source-file store. A leaf below the resolver
 * root: nothing here imports the root or `strategies/`, and consumers outside
 * `program/` reach it only through this barrel.
 */
export { loadTypeScriptCompiler } from "./ts-compiler-loader.js";
export {
  createProjectFileProbe,
  mapImportToFile,
  type ProjectFileProbe,
  type TsCompilerOptions,
} from "./ts-path-mapper.js";
export {
  TS_PROGRAM_BATCH_CALL_SITES_DEFAULT,
  TS_PROGRAM_BATCH_TEXT_BYTES_DEFAULT,
  TS_PROGRAM_CACHE_MAX_DEFAULT,
  TS_PROGRAM_IMPORT_DEPTH_DEFAULT,
  TS_PROGRAM_PARSED_DEPENDENCY_FILES_MAX_DEFAULT,
  TS_PROGRAM_PARSED_FILES_MAX_DEFAULT,
  TS_PROGRAM_PARSED_TEXT_BYTES_MAX_DEFAULT,
  TS_PROGRAM_RETAINED_TEXT_BYTES_MAX_DEFAULT,
  TS_PROGRAM_ROOT_FILES_MAX_DEFAULT,
  TS_PROGRAM_STRATEGY_DEFAULT,
  TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT,
  TS_PROGRAM_WHOLE_ROOT_FILES_MAX_DEFAULT,
  TSProgramCache,
  type TSProgramCacheOptions,
  type TSProgramHandle,
  type TSProgramStrategy,
} from "./ts-program-cache.js";
export {
  TS_PROGRAM_HEAP_BASE_MB_DEFAULT,
  TS_PROGRAM_HEAP_PER_1K_CALL_SITES_MB_DEFAULT,
  TS_PROGRAM_HEAP_PER_1K_ROOTS_MB_DEFAULT,
  TS_PROGRAM_HEAP_PER_TEXT_MB_DEFAULT,
  TS_PROGRAM_HEAP_USABLE_PCT_DEFAULT,
  type TSProgramHeapBudget,
} from "./ts-program-heap-admission.js";
export {
  TS_SOURCE_FILE_STORE_TEXT_BYTES_DEFAULT,
  TSSourceFileStore,
  type TSSourceFileStoreUsage,
} from "./ts-source-file-store.js";
