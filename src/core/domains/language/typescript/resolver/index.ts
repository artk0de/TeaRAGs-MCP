export { TSCallResolver } from "./ts-resolver.js";
export { loadTsConfig, loadTsConfigFileNames } from "./ts-config-loader.js";
export {
  createProjectFileProbe,
  mapImportToFile,
  type ProjectFileProbe,
  type TsCompilerOptions,
} from "./ts-path-mapper.js";
export {
  TSProgramCache,
  TS_PROGRAM_CACHE_MAX_DEFAULT,
  TS_PROGRAM_IMPORT_DEPTH_DEFAULT,
  TS_PROGRAM_PARSED_FILES_MAX_DEFAULT,
  TS_PROGRAM_ROOT_FILES_MAX_DEFAULT,
  TS_PROGRAM_STRATEGY_DEFAULT,
  TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT,
  TS_PROGRAM_WHOLE_ROOT_FILES_MAX_DEFAULT,
  type TSProgramCacheOptions,
  type TSProgramHandle,
  type TSProgramStrategy,
} from "./ts-program-cache.js";
export {
  classifyTypeCheckerFallbackCase,
  TSTypeCheckerFallbackSymbolResolutionStrategy,
  type TSTypeCheckerFallbackCase,
} from "./strategies/ts-type-checker-fallback.js";
