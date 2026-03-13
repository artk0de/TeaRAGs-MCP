/**
 * Deterministic chunk ID generation based on content and location.
 */

import { createHash } from "node:crypto";

import type { CodeChunk } from "../../../../../types.js";

/**
 * Generate deterministic chunk ID.
 * Format: chunk_{sha256(path:start:end:content)[:16]}
 */
export function generateChunkId(chunk: CodeChunk): string {
  const { metadata, startLine, endLine, content } = chunk;
  const combined = `${metadata.filePath}:${startLine}:${endLine}:${content}`;
  const hash = createHash("sha256").update(combined).digest("hex");
  return `chunk_${hash.substring(0, 16)}`;
}
