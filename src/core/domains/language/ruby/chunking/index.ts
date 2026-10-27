import type { ChunkingHook } from "../../../../contracts/types/chunker.js";
import { rubyBodyChunkingHook } from "./class-body-chunker.js";
import { rubyCommentCaptureHook } from "./comment-capture.js";
import { rakeFilterHook } from "./rake-filter.js";
import { rakeScopeChunkerHook } from "./rake-scope-chunker.js";
import { rspecFilterHook } from "./rspec-filter.js";
import { rspecScopeChunkerHook } from "./rspec-scope-chunker.js";

export const rubyHooks: ChunkingHook[] = [
  rakeFilterHook, // filterNode: in .rake files accepts Rake DSL calls, rejects others — before RSpec, first verdict wins
  rspecFilterHook, // filterNode: accepts RSpec DSL calls, rejects others
  rubyCommentCaptureHook, // Must run before body chunker (populates excludedRows)
  rspecScopeChunkerHook, // Scope-centric chunking for spec files
  rakeScopeChunkerHook, // Scope-centric chunking for Rake namespaces (.rake files)
  rubyBodyChunkingHook, // Reads excludedRows, classifies body by keyword (Rails class bodies)
];

export {
  rubyBodyChunkingHook,
  extractBodyChunks,
  extractClassHeader,
  RubyClassBodyChunker,
} from "./class-body-chunker.js";
export { RubyChunkClassifier } from "./classifier.js";
export { rubyCommentCaptureHook, collectMethodCommentRows } from "./comment-capture.js";
export { isRubyModuleImport } from "./module-import.js";
export { isRakeFile, rakeFilterHook } from "./rake-filter.js";
export { rakeScopeChunkerHook } from "./rake-scope-chunker.js";
export { rspecFilterHook, isRspecFile } from "./rspec-filter.js";
export { rspecScopeChunkerHook, buildScopeTree, produceScopeChunks } from "./rspec-scope-chunker.js";
