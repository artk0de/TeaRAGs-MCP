import type { ChunkingHook } from "../types.js";
import { typescriptBodyChunkingHook } from "./class-body-chunker.js";
import { typescriptCommentCaptureHook } from "./comment-capture.js";

export const typescriptHooks: ChunkingHook[] = [
  typescriptCommentCaptureHook, // Must run first (populates excludedRows)
  typescriptBodyChunkingHook, // Reads excludedRows
];
