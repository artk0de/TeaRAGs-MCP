import type { ChunkingHook } from "../types.js";
import { rubyBodyChunkingHook } from "./class-body-chunker.js";
import { rubyCommentCaptureHook } from "./comment-capture.js";

export const rubyHooks: ChunkingHook[] = [
  rubyCommentCaptureHook, // Must run first (populates excludedRows)
  rubyBodyChunkingHook, // Reads excludedRows
];
