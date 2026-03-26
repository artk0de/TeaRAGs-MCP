import type { ChunkingHook } from "../types.js";
import { rubyBodyChunkingHook } from "./class-body-chunker.js";
import { rubyCommentCaptureHook } from "./comment-capture.js";
import { rspecFilterHook } from "./rspec-filter.js";
import { rspecScopeChunkerHook } from "./rspec-scope-chunker.js";

export const rubyHooks: ChunkingHook[] = [
  rspecFilterHook, // filterNode: accepts RSpec DSL calls, rejects others
  rubyCommentCaptureHook, // Must run before body chunker (populates excludedRows)
  rspecScopeChunkerHook, // Scope-centric chunking for spec files
  rubyBodyChunkingHook, // Reads excludedRows, classifies body by keyword (Rails class bodies)
];
