/**
 * Worker thread entry point for AST parsing.
 *
 * Each worker thread creates its own TreeSitterChunker with independent
 * Parser instances (tree-sitter native bindings are per-thread).
 *
 * Protocol:
 *   Receives: { filePath, code, language, config }
 *   Returns:  { filePath, chunks }
 */

import { parentPort, workerData } from "node:worker_threads";
import { TreeSitterChunker } from "./tree-sitter-chunker.js";
import type { ChunkerConfig, CodeChunk } from "../types.js";

export interface WorkerRequest {
  filePath: string;
  code: string;
  language: string;
}

export interface WorkerResponse {
  filePath: string;
  chunks: CodeChunk[];
  error?: string;
}

if (parentPort) {
  const config = workerData as ChunkerConfig;
  const chunker = new TreeSitterChunker(config);

  parentPort.on("message", async (request: WorkerRequest) => {
    try {
      const chunks = await chunker.chunk(request.code, request.filePath, request.language);
      parentPort!.postMessage({
        filePath: request.filePath,
        chunks,
      } satisfies WorkerResponse);
    } catch (error) {
      parentPort!.postMessage({
        filePath: request.filePath,
        chunks: [],
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerResponse);
    }
  });
}
