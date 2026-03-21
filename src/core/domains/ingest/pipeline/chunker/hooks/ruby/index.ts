import type { ChunkingHook } from "../types.js";
import { rubyBodyChunkingHook } from "./class-body-chunker.js";
import { rubyCommentCaptureHook } from "./comment-capture.js";
import { rspecFilterHook } from "./rspec-filter.js";

export const rubyHooks: ChunkingHook[] = [
  rspecFilterHook, // filterNode: accepts RSpec DSL calls, rejects others
  rubyCommentCaptureHook, // Must run before body chunker (populates excludedRows)
  rubyBodyChunkingHook, // Reads excludedRows, classifies body by keyword (merges groups in spec files)
];
