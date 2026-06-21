/**
 * Worker thread message protocol for the chunker pool.
 *
 * Pure structurally-cloneable types — no runtime, no `domains/language`
 * import — shared by the ingest-side `ChunkerPool` (which dispatches requests)
 * and the sibling worker ENTRY (`infra/worker.ts`, which constructs the engine
 * in-thread).
 *
 * The worker ENTRY lives next to this protocol in `domains/ingest`. It stays
 * free of any static `domains/language` import (eslint leaf-domain guard): the
 * concrete `LanguageFactory` / `DefaultSymbolIdComposer` and the native
 * language providers are loaded at runtime via a dynamic `import(path)` where
 * the path arrives as an injected string through `workerData`
 * (`ChunkerConfig.languageModulePath`). A runtime variable path is invisible to
 * the import guard, so no exemption is needed.
 */

import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type { CodeChunk } from "../../../../../types.js";

export interface WorkerRequest {
  filePath: string;
  code: string;
  language: string;
  /** yl9tv — when true, the worker also runs the codegraph walker on the same
   *  parse and returns `extraction`. Off by default (chunk-only requests). */
  emitExtraction?: boolean;
}

export interface WorkerResponse {
  filePath: string;
  chunks: CodeChunk[];
  /** yl9tv — codegraph FileExtraction from the SAME parse, present iff the
   *  request set emitExtraction and the language has a walker. */
  extraction?: FileExtraction;
  error?: string;
}
