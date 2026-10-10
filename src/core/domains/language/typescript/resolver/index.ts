export { TSCallResolver, type TSCallResolverOptions } from "./ts-resolver.js";
export {
  createProjectFileProbe,
  mapImportToFile,
  type ProjectFileProbe,
  TS_PROGRAM_CACHE_MAX_DEFAULT,
  TS_PROGRAM_IMPORT_DEPTH_DEFAULT,
  TS_PROGRAM_PARSED_FILES_MAX_DEFAULT,
  TS_PROGRAM_ROOT_FILES_MAX_DEFAULT,
  TS_PROGRAM_STRATEGY_DEFAULT,
  TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT,
  TS_PROGRAM_WHOLE_ROOT_FILES_MAX_DEFAULT,
  TS_SOURCE_FILE_STORE_TEXT_BYTES_DEFAULT,
  type TsCompilerOptions,
  TSProgramCache,
  type TSProgramCacheOptions,
  type TSProgramHandle,
  type TSProgramStrategy,
  TSSourceFileStore,
  type TSSourceFileStoreUsage,
} from "./program/index.js";
export { loadTsConfig, loadTsConfigFileNames } from "./ts-config-loader.js";
export {
  classifyTypeCheckerFallbackCase,
  TSTypeCheckerFallbackSymbolResolutionStrategy,
  type TSTypeCheckerFallbackCase,
} from "./strategies/ts-type-checker-fallback.js";
