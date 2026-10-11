/**
 * Path-matching rules — primitives layer (`core/primitives/`), I/O-free and
 * importable by every core layer: the `pathPattern` matcher
 * (`path-pattern.ts`), source/test scope detection (`scope-detection.ts`) and
 * the file classifier (`file-classification/`). They share one reason to
 * change: what a repo-relative path means. Consumers import this barrel, never
 * a file behind it.
 */

export { compilePathPatternMatcher, pathPatternLiteralPrefix, type PathPatternMatcher } from "./path-pattern.js";

export { detectScope, isTestPath, type ChunkScope, type ScopeDetectionConfig } from "./scope-detection.js";

export {
  COMMON_TEST_DIRECTORY_PATTERNS,
  DEFAULT_FILE_CLASSIFICATION_SETTINGS,
  DEFAULT_MINIFIED_LINE_LENGTH,
  GENERATED_CONTENT_MARKERS,
  GENERATED_PATTERNS,
  NON_PRODUCTION_PATTERNS,
  buildNonProductionPathFilter,
  buildTestPathFilter,
  classify,
  installFileClassificationSettings,
  installTestFileConventions,
  installedFileClassificationSettings,
  installedTestFileConventions,
  isCompiledJsContent,
  isJsFamilyPath,
  matchesTestFileConventions,
  maxLineLength,
  nonProductionPathPatterns,
  testPathPatterns,
  type ClassifyOptions,
  type FileClassification,
  type FileClassificationSettings,
  type PathFilter,
  type TestPathPatternSets,
} from "./file-classification/index.js";
